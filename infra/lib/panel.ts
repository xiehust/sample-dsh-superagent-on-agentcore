/** `dshsa-panel`: SPA on CloudFront (OAC), Cognito app client + hosted UI, panel-api HTTP API + Lambda (design §3). Owner: dd. */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Buckets, PanelAuditLogGroup, Tables } from '@dshsa/contracts'
import {
  CfnOutput, Duration, RemovalPolicy, Stack, type StackProps,
  aws_apigatewayv2 as apigw, aws_apigatewayv2_authorizers as authorizers, aws_apigatewayv2_integrations as integrations,
  aws_cloudfront as cloudfront, aws_cloudfront_origins as origins, aws_cognito as cognito, aws_iam as iam, aws_lambda as lambda,
  aws_lambda_nodejs as nodejs, aws_logs as logs, aws_s3 as s3, aws_s3_deployment as s3deploy,
} from 'aws-cdk-lib'
import { NagSuppressions } from 'cdk-nag'
import type { Construct } from 'constructs'
import type { SharedResources } from './shared-resources.ts'

export interface PanelStackProps extends StackProps {
  shared: SharedResources
  /** Also allow `http://localhost:5173/` as callback / CORS origin (local `vite dev` against the deployed API). */
  devCallback: boolean
}

const repoPath = (rel: string): string => fileURLToPath(new URL(`../../${rel}`, import.meta.url))
const LOCAL_ORIGIN = 'http://localhost:5173'
/** Must equal HostModule's `panelApiRoleName` (default `dshsa-panel-api`). */
export const PANEL_API_ROLE_NAME = 'dshsa-panel-api'
/** Must equal the host's PANEL_TENANT_ROLE_NAME (default `dshsa-panel-tenant`): the only caller of host `/tenants/*` routes. */
export const PANEL_TENANT_ROLE_NAME = 'dshsa-panel-tenant'
export const PANEL_PLATFORM_ROLE_NAME = 'dshsa-panel-platform'

/** ESM bundle with the AWS SDK inside (externalModules: []): the deployed code runs the SDK versions it was tested with. */
const bundling: nodejs.BundlingOptions = { format: nodejs.OutputFormat.ESM, target: 'node24', minify: true, sourceMap: true, externalModules: [],
  banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" }

export class PanelStack extends Stack {
  constructor(scope: Construct, id: string, props: PanelStackProps) {
    super(scope, id, props)
    const { shared } = props
    const account = this.account
    // Hosted UI prefix: lowercase letters, digits and hyphens, without "aws", "amazon" or "cognito".
    const domainPrefix = `dshsa-${account}`

    // ---- SPA hosting ---------------------------------------------------------------------------------------------
    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      bucketName: Buckets.panel(account), blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true, removalPolicy: RemovalPolicy.DESTROY, autoDeleteObjects: true,
      serverAccessLogsBucket: shared.buckets.logs, serverAccessLogsPrefix: 'panel/',
    })

    // ---- panel-api Lambda ----------------------------------------------------------------------------------------
    const fnLogs = new logs.LogGroup(this, 'PanelApiLogs', {
      logGroupName: '/dshsa/panel-api', retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY,
    })
    // The host admits `/api/*` only from `assumed-role/dshsa-panel-api/*` (PANEL_API_ROLE_NAME), so the name is fixed.
    const role = new iam.Role(this, 'PanelApiRole', {
      roleName: PANEL_API_ROLE_NAME, description: 'dshsa panel-api Lambda',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole')],
    })
    const fn = new nodejs.NodejsFunction(this, 'PanelApiFn', { role,
      functionName: 'dshsa-panel-api', description: 'dshsa panel-api: tenant authz + forward to cell lease owner',
      entry: repoPath('packages/control-api/src/lambda.ts'), handler: 'handler',
      projectRoot: repoPath(''), depsLockFilePath: repoPath('pnpm-lock.yaml'),
      runtime: lambda.Runtime.NODEJS_24_X, architecture: lambda.Architecture.ARM_64, memorySize: 512, timeout: Duration.seconds(15),
      vpc: shared.network.vpc, vpcSubnets: shared.network.privateSubnets, securityGroups: [shared.network.panelApiSg],
      logGroup: fnLogs, tracing: lambda.Tracing.ACTIVE, bundling,
      environment: {
        TABLE_TENANTS: Tables.tenants, TABLE_CELLS: Tables.cells, TABLE_ROUTES: Tables.routes, TABLE_LEASES: Tables.leases,
        TABLE_TICKET_STORAGE: Tables.ticketStorage,
        DATA_BUCKET: shared.buckets.data.bucketName, NODE_OPTIONS: '--enable-source-maps',
      },
    })
    const t = shared.tables
    for (const table of [t.tenants, t.cells, t.leases]) table.grantReadData(fn)
    t.routes.grantReadWriteData(fn)
    // Host internal HTTP auth (contracts v3 §4.7) is a presigned sts:GetCallerIdentity of this role: no permission needed.
    // [P2, accepted narrowed] Read-only transcript access: only the agent's `.claude/` tree of each ticket AP; tenant authz is
    // enforced in code before each read.
    const transcripts = 'tenants/*/*/*/.claude/*' // contracts v4: /tenants/<tenantId>/<cellId>/<ticketKey>
    fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [shared.buckets.data.arnForObjects(transcripts)] }))
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'], resources: [shared.buckets.data.bucketArn], conditions: { StringLike: { 's3:prefix': [transcripts] } },
    }))

    // ---- CloudFront ----------------------------------------------------------------------------------------------
    // The SPA is public static code (login shell); every byte of tenant data sits behind the JWT authorizer below.
    // CSP `connect-src` names the API and the hosted UI by static pattern: referencing the HttpApi here would cycle with the
    // API's CORS origin, which references this distribution.
    const csp = [
      "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "font-src 'self'",
      `connect-src 'self' https://*.execute-api.${this.region}.amazonaws.com https://${domainPrefix}.auth.${this.region}.amazoncognito.com`,
      "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
    ].join('; ')
    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      responseHeadersPolicyName: 'dshsa-panel-security', comment: 'dshsa panel: CSP, HSTS, no framing, no referrer',
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: csp, override: true },
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: true, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true },
        xssProtection: { protection: true, modeBlock: true, override: true },
      },
    })
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'dshsa panel', defaultRootObject: 'index.html', priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      enableLogging: true, logBucket: shared.buckets.logs, logFilePrefix: 'cloudfront/',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeaders,
      },
      // SPA fallback: deep links render index.html (the bucket stays private, so a miss is 403).
      errorResponses: [403, 404].map(httpStatus => ({ httpStatus, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.seconds(0) })),
    })
    const siteOrigin = `https://${distribution.distributionDomainName}`

    // ---- Setup Lambdas (onboarding design §2): one per role, each holding only what its routes need ----------------------
    // Both write their audit lines (contracts v6 AuditEntry) to one log group.
    const auditLogs = new logs.LogGroup(this, 'PanelAdminLogs', {
      logGroupName: PanelAuditLogGroup, retention: logs.RetentionDays.ONE_YEAR, removalPolicy: RemovalPolicy.DESTROY,
    })
    const setupFn = (cid: string, name: string, roleName: string, entry: string, description: string, inVpc: boolean, environment: Record<string, string>) => {
      const fnRole = new iam.Role(this, `${cid}Role`, {
        roleName, description, assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName(inVpc ? 'service-role/AWSLambdaVPCAccessExecutionRole' : 'service-role/AWSLambdaBasicExecutionRole')],
      })
      const f = new nodejs.NodejsFunction(this, cid, { role: fnRole,
        functionName: name, description, entry: repoPath(`packages/control-api/src/${entry}`), handler: 'handler',
        projectRoot: repoPath(''), depsLockFilePath: repoPath('pnpm-lock.yaml'),
        runtime: lambda.Runtime.NODEJS_24_X, architecture: lambda.Architecture.ARM_64, memorySize: 512, timeout: Duration.seconds(20),
        ...(inVpc ? { vpc: shared.network.vpc, vpcSubnets: shared.network.privateSubnets, securityGroups: [shared.network.panelApiSg] } : {}),
        logGroup: auditLogs, tracing: lambda.Tracing.ACTIVE, bundling,
        environment: { TABLE_TENANTS: Tables.tenants, TABLE_CELLS: Tables.cells, TABLE_ROUTES: Tables.routes, TABLE_LEASES: Tables.leases,
          TABLE_TICKET_STORAGE: Tables.ticketStorage, TABLE_ONBOARDING: Tables.onboarding, USER_POOL_ID: shared.userPool.userPoolId,
          PANEL_URL: siteOrigin, NODE_OPTIONS: '--enable-source-maps', ...environment },
      })
      const allow = (sid: string, actions: string[], resources: string[], conditions?: Record<string, Record<string, unknown>>) =>
        fnRole.addToPolicy(new iam.PolicyStatement({ sid, actions, resources, conditions }))
      return { fn: f, role: fnRole, allow }
    }
    const idx = (table: { tableArn: string }) => `${table.tableArn}/index/*`
    const cognitoUsers = ['cognito-idp:AdminCreateUser', 'cognito-idp:AdminGetUser', 'cognito-idp:AdminAddUserToGroup',
      'cognito-idp:AdminRemoveUserFromGroup', 'cognito-idp:ListUsersInGroup']

    // panel-tenant: in the VPC with the panel-api SG (the host admits 8080 from it); the host checks its role name.
    const tenant = setupFn('PanelTenantFn', 'dshsa-panel-tenant', PANEL_TENANT_ROLE_NAME, 'lambda-tenant.ts',
      'dshsa panel-tenant: team setup (repos, Feishu bot, chats, users) for tenant admins', true, { STATE_BUCKET: shared.buckets.state.bucketName })
    tenant.allow('TenantRead', ['dynamodb:GetItem'], [t.tenants.tableArn])
    // Only the `feishu` attribute of a tenant (ops.feishuSet: `SET feishu = :f` if `attribute_exists(tenantId)`); never status, name
    // or group. `dynamodb:Attributes` lists every top-level attribute the request writes or evaluates in its condition, and must
    // include the key (`tenantId`; the table has no index). UpdateItem always carries ReturnValues (default NONE), so StringEquals
    // (not IfExists) is the documented form and also stops ALL_OLD/ALL_NEW from reading other attributes back.
    tenant.allow('TenantFeishu', ['dynamodb:UpdateItem'], [t.tenants.tableArn], {
      'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['tenantId', 'feishu'] }, StringEquals: { 'dynamodb:ReturnValues': 'NONE' },
    })
    tenant.allow('Cells', ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:PutItem', 'dynamodb:UpdateItem'], [t.cells.tableArn, idx(t.cells)])
    tenant.allow('Routes', ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:PutItem', 'dynamodb:DeleteItem'], [t.routes.tableArn, idx(t.routes)])
    tenant.allow('Onboarding', ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:PutItem'], [t.onboarding.tableArn, idx(t.onboarding)])
    // Deletes: the single-use OAuth state consume (`ghstate#`), and unlinking the tenant's own installation claim (`ghinst#`).
    // LeadingKeys cannot express "this tenant's claim": the code conditions the delete on `tenantId = :t` (DynamoOnboarding.releaseClaim).
    tenant.allow('OnboardingConsumeState', ['dynamodb:DeleteItem'], [t.onboarding.tableArn], { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['ghstate#*'] } })
    tenant.allow('OnboardingUnlinkClaim', ['dynamodb:DeleteItem'], [t.onboarding.tableArn], { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['ghinst#*'] } })
    tenant.allow('LeasesRead', ['dynamodb:Scan', 'dynamodb:GetItem'], [t.leases.tableArn])
    tenant.allow('CellQueues', ['sqs:CreateQueue', 'sqs:GetQueueAttributes', 'sqs:SetQueueAttributes', 'sqs:TagQueue'], [shared.cellQueueArnPattern])
    // Feishu bot secrets are write-only from the panel: no GetSecretValue on dshsa/feishu/*.
    tenant.allow('FeishuSecretsWrite', ['secretsmanager:CreateSecret', 'secretsmanager:PutSecretValue', 'secretsmanager:TagResource'], [shared.secrets.feishuSecretArnPattern])
    tenant.allow('GithubOauthRead', ['secretsmanager:GetSecretValue'], [shared.secrets.githubOauth.secretArn])
    tenant.allow('TenantUsers', cognitoUsers, [shared.userPool.userPoolArn])
    tenant.allow('ConnectorState', ['s3:GetObject'], [shared.buckets.state.arnForObjects('connectors/*/kv.json')])

    // panel-platform: no VPC (GitHub + AWS APIs only).
    const platform = setupFn('PanelPlatformFn', 'dshsa-panel-platform', PANEL_PLATFORM_ROLE_NAME, 'lambda-platform.ts',
      'dshsa panel-platform: tenants, users, GitHub App for platform admins', false, {})
    platform.allow('Tenants', ['dynamodb:GetItem', 'dynamodb:Scan', 'dynamodb:PutItem', 'dynamodb:UpdateItem'], [t.tenants.tableArn])
    // Claims only (v6.2): approve (UpdateItem) or reject/release (DeleteItem) a `ghinst#` claim; never a `ghstate#` nonce.
    platform.allow('OnboardingClaims', ['dynamodb:DeleteItem', 'dynamodb:UpdateItem'], [t.onboarding.tableArn], { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['ghinst#*'] } })
    // The pending-claims list scans the (small) table; nonces it may also read are single-use and bound to tenant + sub.
    platform.allow('OnboardingList', ['dynamodb:Scan'], [t.onboarding.tableArn])
    platform.allow('OnboardingClaimRead', ['dynamodb:GetItem'], [t.onboarding.tableArn], { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['ghinst#*'] } })
    // Release checks which of the claim tenant's cells still use the installation (read only: cells are never changed here).
    platform.allow('CellsRead', ['dynamodb:Query'], [idx(t.cells)])
    platform.allow('Users', ['cognito-idp:CreateGroup', ...cognitoUsers], [shared.userPool.userPoolArn])
    platform.allow('GithubSecrets', ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue'], [shared.secrets.githubApp.secretArn, shared.secrets.githubOauth.secretArn])

    // ---- Cognito app client + hosted UI ----------------------------------------------------------------------------
    const callbacks = [`${siteOrigin}/`, ...(props.devCallback ? [`${LOCAL_ORIGIN}/`] : [])]
    const client = new cognito.UserPoolClient(this, 'PanelClient', {
      userPool: shared.userPool, userPoolClientName: 'dshsa-panel', generateSecret: false,
      authFlows: { userSrp: true, adminUserPassword: true }, preventUserExistenceErrors: true, enableTokenRevocation: true,
      oAuth: {
        flows: { authorizationCodeGrant: true }, scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: callbacks, logoutUrls: callbacks,
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      accessTokenValidity: Duration.minutes(60), idTokenValidity: Duration.minutes(60), refreshTokenValidity: Duration.days(1),
    })
    const domain = new cognito.UserPoolDomain(this, 'HostedUi', {
      userPool: shared.userPool, cognitoDomain: { domainPrefix },
    })
    const hostedUi = domain.baseUrl()

    // ---- HTTP API --------------------------------------------------------------------------------------------------
    const issuer = `https://cognito-idp.${this.region}.amazonaws.com/${shared.userPool.userPoolId}`
    const api = new apigw.HttpApi(this, 'PanelApi', {
      apiName: 'dshsa-panel-api', description: 'dshsa panel API (Cognito JWT)', createDefaultStage: true,
      corsPreflight: {
        allowOrigins: [siteOrigin, ...(props.devCallback ? [LOCAL_ORIGIN] : [])],
        allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.POST, apigw.CorsHttpMethod.PUT, apigw.CorsHttpMethod.DELETE],
        allowHeaders: ['authorization', 'content-type', 'x-orchestrator-request'], maxAge: Duration.minutes(10),
      },
      // The panel sends the ID token: its `aud` is the app client and it carries `email` and `cognito:groups`.
      defaultAuthorizer: new authorizers.HttpJwtAuthorizer('CognitoJwt', issuer, { jwtAudience: [client.userPoolClientId] }),
    })
    const methods = [apigw.HttpMethod.GET, apigw.HttpMethod.POST, apigw.HttpMethod.PUT, apigw.HttpMethod.DELETE]
    api.addRoutes({ path: '/v1/{proxy+}', methods, integration: new integrations.HttpLambdaIntegration('PanelApiIntegration', fn) })
    // More specific routes win in HTTP API, so setup and admin paths never reach panel-api (and panel-api 404s them anyway).
    const tenantIntegration = new integrations.HttpLambdaIntegration('PanelTenantIntegration', tenant.fn)
    api.addRoutes({ path: '/v1/tenants/{tenantId}/setup', methods, integration: tenantIntegration })
    api.addRoutes({ path: '/v1/tenants/{tenantId}/setup/{proxy+}', methods, integration: tenantIntegration })
    api.addRoutes({ path: '/v1/admin/{proxy+}', methods, integration: new integrations.HttpLambdaIntegration('PanelPlatformIntegration', platform.fn) })
    const accessLogs = new logs.LogGroup(this, 'PanelApiAccessLogs', {
      logGroupName: '/dshsa/panel-api-access', retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY,
    })
    const stage = api.defaultStage!.node.defaultChild as apigw.CfnStage
    stage.defaultRouteSettings = { throttlingRateLimit: 20, throttlingBurstLimit: 40 }
    stage.accessLogSettings = {
      destinationArn: accessLogs.logGroupArn,
      format: JSON.stringify({ requestId: '$context.requestId', ip: '$context.identity.sourceIp', method: '$context.httpMethod',
        path: '$context.path', status: '$context.status', sub: '$context.authorizer.claims.sub', error: '$context.authorizer.error' }),
    }
    const apiUrl = api.apiEndpoint

    // ---- Site content ----------------------------------------------------------------------------------------------
    const dist = repoPath('packages/panel/dist')
    const config = { region: this.region, userPoolId: shared.userPool.userPoolId, clientId: client.userPoolClientId, domain: hostedUi, apiUrl }
    const deployment = new s3deploy.BucketDeployment(this, 'SiteDeployment', {
      destinationBucket: siteBucket, distribution, distributionPaths: ['/*'], memoryLimit: 256,
      sources: [...(existsSync(dist) ? [s3deploy.Source.asset(dist)] : []), s3deploy.Source.jsonData('config.json', config)],
      prune: true, exclude: ['config.example.json'],
    })

    new CfnOutput(this, 'PanelUrl', { value: siteOrigin })
    new CfnOutput(this, 'PanelApiUrl', { value: apiUrl })
    new CfnOutput(this, 'UserPoolClientId', { value: client.userPoolClientId })
    new CfnOutput(this, 'HostedUiDomain', { value: hostedUi })

    // ---- cdk-nag ---------------------------------------------------------------------------------------------------
    NagSuppressions.addResourceSuppressions(distribution, [
      { id: 'AwsSolutions-CFR1', reason: 'No geo restriction: tenants are global teams; access is enforced by Cognito.' },
      { id: 'AwsSolutions-CFR2', reason: 'WAF is out of scope for phase 1 (parent prd.md); API is JWT-gated and throttled.' },
      { id: 'AwsSolutions-CFR4', reason: 'Default CloudFront certificate (*.cloudfront.net) enforces TLS1.2+ viewer side when no custom domain is set.' },
    ])
    NagSuppressions.addResourceSuppressions([fn, role], [
      { id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole / VPCAccessExecutionRole are the standard Lambda managed policies.' },
      { id: 'AwsSolutions-IAM5', reason: 'Object wildcard is the per-ticket .claude/ tree of the data bucket (read-only); X-Ray and DynamoDB index ARNs.' },
    ], true)
    NagSuppressions.addResourceSuppressions([tenant.fn, tenant.role, platform.fn, platform.role], [
      { id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole / VPCAccessExecutionRole are the standard Lambda managed policies.' },
      { id: 'AwsSolutions-IAM5', reason: 'Wildcards are dshsa-scoped name patterns created at runtime (dshsa-cell-* queues, dshsa/feishu/* secrets, connectors/*/kv.json), DynamoDB index ARNs and X-Ray.' },
    ], true)
    NagSuppressions.addResourceSuppressions(client, [
      { id: 'AwsSolutions-COG7', reason: 'Not an identity pool.' },
    ])
    NagSuppressions.addResourceSuppressionsByPath(this, `/${this.stackName}/PanelApi/DefaultStage/Resource`, [
      { id: 'AwsSolutions-APIG1', reason: 'Access logging is configured through CfnStage.accessLogSettings.' },
    ])
    // The BucketDeployment provider is a stack-level singleton (`Custom::CDKBucketDeployment…`), not a child of `deployment`.
    const providers = this.node.children.filter(c => c.node.id.startsWith('Custom::CDKBucketDeployment'))
    NagSuppressions.addResourceSuppressions([deployment, ...providers], [
      { id: 'AwsSolutions-IAM4', reason: 'CDK BucketDeployment provider uses the Lambda basic execution managed policy.' },
      { id: 'AwsSolutions-IAM5', reason: 'CDK BucketDeployment needs object wildcards on the asset and site buckets.' },
      { id: 'AwsSolutions-L1', reason: 'CDK-managed BucketDeployment runtime.' },
    ], true)
    NagSuppressions.addStackSuppressions(this, [
      { id: 'AwsSolutions-IAM4', reason: 'CDK custom resource providers (S3 auto-delete, BucketDeployment) use AWSLambdaBasicExecutionRole.', appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'] },
      { id: 'AwsSolutions-L1', reason: 'CDK-managed custom resource provider runtimes.' },
    ])
  }
}
