/**
 * `dshsa-ingress`: the GitHub App webhook endpoint (parent design §1, §5 Ingress; child design 11-01-sa-ingress §6–7). Owner: 95.
 *
 * Exposure: `POST /github/webhook` is reachable from the internet because GitHub (an anonymous caller) delivers to it. The
 * endpoint authenticates every delivery with GitHub's own mechanism: the HMAC-SHA256 `X-Hub-Signature-256` over the raw
 * body, using `webhookSecret` from `dshsa/github-app`. The Lambda verifies it fail-closed: a missing or placeholder secret
 * refuses every request (503), a bad signature gets 401, and nothing is parsed or enqueued before verification. The API has
 * no other route (anything else is 404 from API Gateway) and stage throttling caps abuse. The Feishu Connector needs no
 * endpoint: it dials out over a long connection from the host.
 *
 * Logging needs no account-level API Gateway CloudWatch role (`AWS::ApiGateway::Account` / `cloudWatchRole`): HTTP API access
 * logs are delivered to the log group through CloudWatch Logs log delivery, set up with the deployer's permissions. That role
 * is a region-wide setting of the shared account and stays unset.
 */
import { fileURLToPath } from 'node:url'
import { Secrets, Tables } from '@dshsa/contracts'
import {
  CfnOutput, Duration, RemovalPolicy, Stack,
  aws_apigatewayv2 as apigw, aws_apigatewayv2_integrations as integrations, aws_iam as iam, aws_lambda as lambda,
  aws_lambda_nodejs as nodejs, aws_logs as logs,
} from 'aws-cdk-lib'
import { NagSuppressions } from 'cdk-nag'
import { Construct } from 'constructs'
import type { ModuleProps } from '../shared-resources.ts'

const repoPath = (rel: string): string => fileURLToPath(new URL(`../../../${rel}`, import.meta.url))
export const WEBHOOK_PATH = '/github/webhook'

export interface IngressThrottle { rateLimit: number; burstLimit: number }
export interface IngressModuleProps extends ModuleProps { throttle?: IngressThrottle }

export class IngressModule extends Construct {
  /** The URL to enter as the GitHub App's webhook URL. */
  readonly webhookUrl: string
  readonly function: lambda.IFunction
  constructor(scope: Construct, id: string, props: IngressModuleProps) {
    super(scope, id)
    const { shared } = props
    const stack = Stack.of(this)
    const throttle = props.throttle ?? { rateLimit: 20, burstLimit: 40 }

    const fnLogs = new logs.LogGroup(this, 'WebhookLogs', {
      logGroupName: '/dshsa/ingress-github-webhook', retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY,
    })
    // A dedicated role with inline, resource-scoped permissions only (no managed policies).
    const role = new iam.Role(this, 'WebhookRole', {
      roleName: 'dshsa-ingress-github-webhook', assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'dshsa ingress webhook: read the webhook secret, look up routes/cells, send to cell FIFO queues',
    })
    role.addToPolicy(new iam.PolicyStatement({ actions: ['logs:CreateLogStream', 'logs:PutLogEvents'], resources: [`${fnLogs.logGroupArn}:*`] }))
    role.addToPolicy(new iam.PolicyStatement({ actions: ['dynamodb:GetItem'], resources: [shared.tables.routes.tableArn, shared.tables.cells.tableArn] }))
    // Cell queues are created at runtime by `dshsa-admin cell add`, so the grant is the `dshsa-cell-*.fifo` pattern.
    role.addToPolicy(new iam.PolicyStatement({ actions: ['sqs:SendMessage'], resources: [shared.cellQueueArnPattern] }))
    shared.secrets.githubApp.grantRead(role)

    const fn = new nodejs.NodejsFunction(this, 'WebhookFn', {
      functionName: 'dshsa-ingress-github-webhook', description: 'dshsa GitHub App webhook: verify HMAC, route by installation+repo, enqueue to cell',
      entry: repoPath('packages/sources/src/webhook/handler.ts'), handler: 'handler',
      projectRoot: repoPath(''), depsLockFilePath: repoPath('pnpm-lock.yaml'),
      runtime: lambda.Runtime.NODEJS_24_X, architecture: lambda.Architecture.ARM_64, memorySize: 256, timeout: Duration.seconds(10),
      role, logGroup: fnLogs,
      bundling: { format: nodejs.OutputFormat.ESM, target: 'node24', minify: true, sourceMap: true,
        banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
      environment: {
        SECRET_ID: shared.secrets.githubApp.secretArn, ROUTES_TABLE: Tables.routes, CELLS_TABLE: Tables.cells,
        NODE_OPTIONS: '--enable-source-maps',
      },
    })
    this.function = fn

    const api = new apigw.HttpApi(this, 'Api', {
      apiName: 'dshsa-ingress', description: 'dshsa ingress: GitHub App webhook (HMAC-verified in the Lambda)', createDefaultStage: true,
    })
    api.addRoutes({ path: WEBHOOK_PATH, methods: [apigw.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration('WebhookIntegration', fn) })
    const accessLogs = new logs.LogGroup(this, 'AccessLogs', {
      logGroupName: '/dshsa/ingress-access', retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY,
    })
    const stage = api.defaultStage!.node.defaultChild as apigw.CfnStage
    stage.defaultRouteSettings = { throttlingRateLimit: throttle.rateLimit, throttlingBurstLimit: throttle.burstLimit }
    stage.accessLogSettings = {
      destinationArn: accessLogs.logGroupArn,
      // HTTP API context variables only ($context.requestOverride is REST-only); the Lambda logs the GitHub delivery id.
      format: JSON.stringify({ requestId: '$context.requestId', ip: '$context.identity.sourceIp', method: '$context.httpMethod',
        routeKey: '$context.routeKey', path: '$context.path', status: '$context.status', latency: '$context.responseLatency',
        error: '$context.integrationErrorMessage' }),
    }
    this.webhookUrl = `${api.apiEndpoint}${WEBHOOK_PATH}`

    new CfnOutput(stack, 'GithubWebhookUrl', { value: this.webhookUrl, description: 'Webhook URL of the dshsa GitHub App' })
    new CfnOutput(stack, 'GithubAppSecretName', { value: Secrets.githubApp, description: 'Secret holding appId, slug, privateKey, webhookSecret' })

    NagSuppressions.addResourceSuppressionsByPath(stack, `${api.node.path}/POST--github--webhook/Resource`, [
      { id: 'AwsSolutions-APIG4', reason: 'GitHub is the caller: each delivery is authenticated by its HMAC X-Hub-Signature-256, verified fail-closed in the Lambda before anything is parsed or enqueued.' },
    ])
    NagSuppressions.addResourceSuppressionsByPath(stack, `${api.node.path}/DefaultStage/Resource`, [
      { id: 'AwsSolutions-APIG1', reason: 'Access logging is configured through CfnStage.accessLogSettings.' },
    ])
    NagSuppressions.addResourceSuppressions(role, [
      { id: 'AwsSolutions-IAM5', reason: 'Log-stream wildcard of its own log group, and the dshsa-cell-*.fifo pattern of queues created at runtime per cell.' },
    ], true)
  }
}
