/**
 * Spike S3 vantage in ap-northeast-1: one Lambda that runs probe.py (no VPC, no inbound). Temporary; destroy after the run:
 *   cd infra && pnpm exec cdk --app "pnpm exec tsx ../spikes/S3-feishu-ws/app.ts" deploy|destroy dshsa-spike-s3
 */
import { App, Duration, RemovalPolicy, Stack, aws_iam as iam, aws_lambda as lambda, aws_logs as logs } from 'aws-cdk-lib'
import { fileURLToPath } from 'node:url'

const app = new App()
const stack = new Stack(app, 'dshsa-spike-s3', { env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'ap-northeast-1' }, stackName: 'dshsa-spike-s3',
  description: 'dshsa spike S3: Feishu/Lark connectivity probe (temporary)' })
const role = new iam.Role(stack, 'Role', { roleName: 'dshsa-spike-s3-probe', assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') })
const logGroup = new logs.LogGroup(stack, 'Logs', { logGroupName: '/aws/lambda/dshsa-spike-s3-probe', retention: logs.RetentionDays.ONE_DAY,
  removalPolicy: RemovalPolicy.DESTROY })
logGroup.grantWrite(role)
new lambda.Function(stack, 'Probe', {
  functionName: 'dshsa-spike-s3-probe', runtime: lambda.Runtime.PYTHON_3_12, architecture: lambda.Architecture.ARM_64, handler: 'probe.handler',
  code: lambda.Code.fromAsset(fileURLToPath(new URL('.', import.meta.url)), { exclude: ['results', '*.ts', '*.md'] }),
  timeout: Duration.minutes(15), memorySize: 256, role, logGroup,
})
