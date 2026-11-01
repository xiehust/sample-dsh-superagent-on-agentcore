/** `dshsa-shared`: network, tables, KMS ticket-token key, buckets, secrets, Cognito pool (design §2). Owner: dd. */
import { Buckets, CellsByTenantIndex, CognitoGroups, Models, OnboardingByTenantIndex, RoutesByTenantIndex, Secrets, Tables, TicketTokenKeyAlias } from '@dshsa/contracts'
import {
  Duration, RemovalPolicy, Stack, type StackProps,
  aws_cognito as cognito, aws_dynamodb as dynamodb, aws_ec2 as ec2, aws_iam as iam, aws_kms as kms, aws_logs as logs,
  aws_s3 as s3, aws_secretsmanager as secretsmanager,
} from 'aws-cdk-lib'
import { NagSuppressions } from 'cdk-nag'
import type { Construct } from 'constructs'
import type { SharedResources } from './shared-resources.ts'

export interface SharedStackProps extends StackProps {
  /** Import this VPC instead of creating `dshsa-vpc` (the account's VPC quota may be exhausted). */
  vpcId?: string
  /** AZ names that map to AgentCore-supported AZ IDs in this account (apne1-az4 = ap-northeast-1a, apne1-az1 = ap-northeast-1c). */
  availabilityZones: string[]
  /** RETAIN tables, buckets and the user pool on stack deletion. */
  retain: boolean
}

export class SharedStack extends Stack {
  readonly resources: SharedResources

  constructor(scope: Construct, id: string, props: SharedStackProps) {
    super(scope, id, props)
    const removalPolicy = props.retain ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY
    const account = this.account

    // ---- Network -------------------------------------------------------------------------------------------------
    const imported = !!props.vpcId
    const vpc: ec2.IVpc = imported
      ? ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: props.vpcId })
      : this.createVpc(props.availabilityZones)
    const privateSubnets: ec2.SubnetSelection = {
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, availabilityZones: props.availabilityZones,
    }

    const endpointSg = new ec2.SecurityGroup(this, 'EndpointSg', {
      vpc, securityGroupName: 'dshsa-vpce', description: 'dshsa interface endpoints: HTTPS from the VPC', allowAllOutbound: false,
    })
    endpointSg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(443), 'HTTPS from VPC')
    // Private DNS would reroute every execute-api call in a shared, imported VPC, so it is on only for our own VPC.
    const executeApiEndpoint = new ec2.InterfaceVpcEndpoint(this, 'ExecuteApiEndpoint', {
      vpc, service: ec2.InterfaceVpcEndpointAwsService.APIGATEWAY, subnets: privateSubnets,
      securityGroups: [endpointSg], privateDnsEnabled: !imported, open: false,
    })

    const panelApiSg = new ec2.SecurityGroup(this, 'PanelApiSg', {
      vpc, securityGroupName: 'dshsa-panel-api', description: 'dshsa panel-api Lambda (egress to host 8080 and AWS APIs)',
      allowAllOutbound: true,
    })

    // ---- Tables (design §4.2) --------------------------------------------------------------------------------------
    const table = (cid: string, tableName: string, pk: string, byTenant?: string, timeToLiveAttribute?: string): dynamodb.Table => {
      const t = new dynamodb.Table(this, cid, {
        tableName, partitionKey: { name: pk, type: dynamodb.AttributeType.STRING }, timeToLiveAttribute,
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, encryption: dynamodb.TableEncryption.AWS_MANAGED,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true }, removalPolicy,
      })
      if (byTenant) t.addGlobalSecondaryIndex({ indexName: byTenant, partitionKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING } })
      return t
    }
    const tables = {
      tenants: table('Tenants', Tables.tenants, 'tenantId'),
      cells: table('Cells', Tables.cells, 'cellId', CellsByTenantIndex),
      routes: table('Routes', Tables.routes, 'routeKey', RoutesByTenantIndex),
      leases: table('Leases', Tables.leases, 'leaseKey'),
      ticketStorage: table('TicketStorage', Tables.ticketStorage, 'ticketKey'),
      // v6 onboarding: installation claims `ghinst#<id>` and single-use OAuth state nonces `ghstate#<nonce>` (TTL `ttl`).
      onboarding: table('Onboarding', Tables.onboarding, 'key', OnboardingByTenantIndex, 'ttl'),
    }

    // ---- Ticket token key (design §4.3) ----------------------------------------------------------------------------
    const ticketTokenKey = new kms.Key(this, 'TicketTokenKey', {
      alias: TicketTokenKeyAlias, description: 'dshsa ticket token signing (ES256)',
      keySpec: kms.KeySpec.ECC_NIST_P256, keyUsage: kms.KeyUsage.SIGN_VERIFY,
      removalPolicy, pendingWindow: Duration.days(7),
    })

    // ---- Buckets (design §4.9) -------------------------------------------------------------------------------------
    const logBucket = new s3.Bucket(this, 'LogBucket', {
      bucketName: `dshsa-logs-${account}`, ...privateBucket(removalPolicy),
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED, // CloudFront standard logs need ACLs
      lifecycleRules: [{ expiration: Duration.days(90) }],
    })
    const data = new s3.Bucket(this, 'DataBucket', {
      bucketName: Buckets.data(account), ...privateBucket(removalPolicy), versioned: true,
      serverAccessLogsBucket: logBucket, serverAccessLogsPrefix: 'data/',
    })
    const state = new s3.Bucket(this, 'StateBucket', {
      bucketName: Buckets.state(account), ...privateBucket(removalPolicy), versioned: true,
      serverAccessLogsBucket: logBucket, serverAccessLogsPrefix: 'state/',
      lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(7) }],
    })

    // S3 Files service role: syncs the file system with the data bucket (copied from the reference S3FilesRole).
    const s3filesRole = new iam.Role(this, 'S3FilesRole', {
      roleName: 'dshsa-s3files', description: 'S3 Files service role for the dshsa data bucket',
      assumedBy: new iam.ServicePrincipal('elasticfilesystem.amazonaws.com', { conditions: {
        StringEquals: { 'aws:SourceAccount': account },
        ArnLike: { 'aws:SourceArn': `arn:aws:s3files:${this.region}:${account}:file-system/*` },
      } }),
    })
    const sameAccount = { StringEquals: { 'aws:ResourceAccount': account } }
    s3filesRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket', 's3:ListBucketVersions'], resources: [data.bucketArn], conditions: sameAccount,
    }))
    s3filesRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:AbortMultipartUpload', 's3:DeleteObject*', 's3:GetObject*', 's3:List*', 's3:PutObject*'],
      resources: [data.arnForObjects('*')], conditions: sameAccount,
    }))
    s3filesRole.addToPolicy(new iam.PolicyStatement({
      actions: ['events:DeleteRule', 'events:DisableRule', 'events:EnableRule', 'events:PutRule', 'events:PutTargets', 'events:RemoveTargets'],
      resources: ['arn:aws:events:*:*:rule/DO-NOT-DELETE-S3-Files*'],
      conditions: { StringEquals: { 'events:ManagedBy': 'elasticfilesystem.amazonaws.com' } },
    }))
    s3filesRole.addToPolicy(new iam.PolicyStatement({
      actions: ['events:DescribeRule', 'events:ListRuleNamesByTarget', 'events:ListRules', 'events:ListTargetsByRule'],
      resources: ['arn:aws:events:*:*:rule/*'],
    }))

    // ---- Secrets ---------------------------------------------------------------------------------------------------
    const githubApp = new secretsmanager.Secret(this, 'GithubAppSecret', {
      secretName: Secrets.githubApp, description: 'dshsa GitHub App {appId, slug, privateKey, webhookSecret}; set with dshsa-admin github app-set',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ appId: '', slug: '', privateKey: '' }), generateStringKey: 'webhookSecret',
        passwordLength: 40, excludePunctuation: true,
      },
      removalPolicy: RemovalPolicy.DESTROY,
    })
    // v6: the App's OAuth client, kept apart from the private key so the tenant setup Lambda can read it without the key.
    // Placeholder (empty clientId/clientSecret = not set) until a platform admin sets it in the panel.
    const githubOauth = new secretsmanager.Secret(this, 'GithubOauthSecret', {
      secretName: Secrets.githubOauth, description: 'dshsa GitHub App OAuth client {clientId, clientSecret, appId, slug}; set in panel Platform → GitHub App',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ clientId: '', clientSecret: '' }), generateStringKey: 'placeholder',
        passwordLength: 16, excludePunctuation: true,
      },
      removalPolicy: RemovalPolicy.DESTROY,
    })

    // ---- Cognito ---------------------------------------------------------------------------------------------------
    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'dshsa-users', selfSignUpEnabled: false, signInCaseSensitive: false,
      signInAliases: { email: true }, autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      passwordPolicy: { minLength: 12, requireDigits: true, requireLowercase: true, requireUppercase: true, requireSymbols: true,
        tempPasswordValidity: Duration.days(3) },
      mfa: cognito.Mfa.OPTIONAL, mfaSecondFactor: { otp: true, sms: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      deletionProtection: props.retain, removalPolicy,
    })
    new cognito.CfnUserPoolGroup(this, 'PlatformAdminGroup', {
      userPoolId: userPool.userPoolId, groupName: CognitoGroups.platformAdmin, description: 'dshsa platform administrators (all tenants)',
    })

    this.resources = {
      account, region: this.region,
      network: { vpc, privateSubnets, executeApiEndpoint, executeApiPrivateDns: !imported, panelApiSg },
      tables, ticketTokenKey, buckets: { data, state, logs: logBucket }, dataBucketS3FilesRole: s3filesRole,
      secrets: { githubApp, githubOauth, feishuSecretArnPattern: `arn:aws:secretsmanager:${this.region}:${account}:secret:dshsa/feishu/*` },
      userPool,
      cellQueueArnPattern: `arn:aws:sqs:${this.region}:${account}:dshsa-cell-*`,
      models: { eval: Models.eval, worker: Models.worker },
    }

    NagSuppressions.addResourceSuppressions(ticketTokenKey, [
      { id: 'AwsSolutions-KMS5', reason: 'Asymmetric SIGN_VERIFY keys do not support automatic rotation; rotate by re-keying the alias.' },
    ])
    NagSuppressions.addResourceSuppressions(endpointSg, [
      { id: 'CdkNagValidationFailure', reason: 'EC23 cannot resolve the VPC CIDR token; ingress is HTTPS from the VPC CIDR only.' },
    ])
    NagSuppressions.addResourceSuppressions(logBucket, [
      { id: 'AwsSolutions-S1', reason: 'This is the access-log destination bucket itself.' },
    ])
    NagSuppressions.addResourceSuppressions(githubApp, [
      { id: 'AwsSolutions-SMG4', reason: 'The GitHub App key is rotated in GitHub, then set via dshsa-admin github app-set.' },
    ])
    NagSuppressions.addResourceSuppressions(githubOauth, [
      { id: 'AwsSolutions-SMG4', reason: 'The OAuth client secret is rotated in GitHub, then set in the panel (Platform → GitHub App).' },
    ])
    NagSuppressions.addResourceSuppressions(userPool, [
      { id: 'AwsSolutions-COG2', reason: 'MFA is optional (TOTP) in the dev platform; enforce via Cognito once tenants onboard.' },
      { id: 'AwsSolutions-COG8', reason: 'Essentials feature plan in the dev platform (cost); Plus tier is a production follow-up.' },
      { id: 'AwsSolutions-COG3', reason: 'Advanced security (Plus plan) is not enabled in the dev platform for cost; revisit for production.' },
    ])
    NagSuppressions.addResourceSuppressions(s3filesRole, [
      { id: 'AwsSolutions-IAM5', reason: 'Object-level wildcard on the single data bucket and S3 Files-managed EventBridge rules, as in the reference architecture.' },
    ], true)
  }

  private createVpc(availabilityZones: string[]): ec2.Vpc {
    const vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: 'dshsa-vpc', ipAddresses: ec2.IpAddresses.cidr('10.40.0.0/16'), availabilityZones, natGateways: 1,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 20 },
      ],
      gatewayEndpoints: {
        S3: { service: ec2.GatewayVpcEndpointAwsService.S3 },
        DynamoDB: { service: ec2.GatewayVpcEndpointAwsService.DYNAMODB },
      },
    })
    vpc.addFlowLog('FlowLog', {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(new logs.LogGroup(this, 'FlowLogGroup', {
        logGroupName: '/dshsa/vpc-flow', retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY,
      })),
      trafficType: ec2.FlowLogTrafficType.REJECT,
    })
    return vpc
  }
}

function privateBucket(removalPolicy: RemovalPolicy): s3.BucketProps {
  return {
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, encryption: s3.BucketEncryption.S3_MANAGED, enforceSSL: true,
    removalPolicy, autoDeleteObjects: removalPolicy === RemovalPolicy.DESTROY,
  }
}
