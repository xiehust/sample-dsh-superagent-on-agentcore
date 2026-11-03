/**
 * `dshsa-host`: the control-plane host on ECS Fargate (parent design §1, §4.2, §4.7; child design 11-01-sa-cell §10). Owner: 5c.
 *
 * Exposure: the task listens on TCP 8080 inside the VPC only (private subnets, no public IP, no load balancer). Its security
 * group admits 8080 from exactly two security groups — panel-api (shared by the panel-api and panel-tenant Lambdas) and
 * worker-api — and every request but `/healthz` must prove its caller's IAM role with a presigned `sts:GetCallerIdentity` URL
 * that signs `x-dshsa-target` (contracts v3, parent design §4.7): the host replays it against regional STS and allows only the
 * panel-api role on `/api/*`, the worker-api role on `/worker/*` and (v6) the panel-tenant role on `/tenants/*` (401 otherwise). No shared secret exists. Everything else the task does is outbound:
 * SQS, DynamoDB, KMS, Bedrock, AgentCore, S3, SSM (the worker version), Secrets Manager, GitHub and Feishu APIs.
 * All permissions are identity policies on the task role; no shared resource policy is edited.
 */
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { Duration, RemovalPolicy, Stack, aws_ec2 as ec2, aws_ecr_assets as ecrAssets, aws_ecs as ecs, aws_iam as iam, aws_logs as logs } from 'aws-cdk-lib'
import { NagSuppressions } from 'cdk-nag'
import { Construct } from 'constructs'
import { InternalApiPort, Tables, WorkerVersion } from '@dshsa/contracts'
import type { HostModuleProps } from '../shared-resources.ts'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..')
const why = (id: string, reason: string) => ({ id, reason })

export interface HostModuleOptions extends HostModuleProps {
  /** Tasks in the service (each holds up to `maxCells` cell leases); default 1. */
  desiredCount?: number
  maxCells?: number
  maxConnectors?: number
  /** IAM role names allowed to call the internal HTTP (parent design §4.7): panel-api on `/api/*`, worker-api on `/worker/*`, panel-tenant on `/tenants/*`. */
  panelApiRoleName?: string
  workerApiRoleName?: string
  panelTenantRoleName?: string
}

export class HostModule extends Construct {
  readonly service: ecs.FargateService
  readonly securityGroup: ec2.SecurityGroup
  readonly taskRole: iam.Role
  constructor(scope: Construct, id: string, props: HostModuleOptions) {
    super(scope, id)
    const { shared, worker } = props
    const { account, region } = Stack.of(this)

    const cluster = new ecs.Cluster(this, 'Cluster', { clusterName: 'dshsa-host', vpc: shared.network.vpc, containerInsightsV2: ecs.ContainerInsights.ENABLED })
    const securityGroup = this.securityGroup = new ec2.SecurityGroup(this, 'TaskSg', { vpc: shared.network.vpc, securityGroupName: 'dshsa-host-sg',
      description: 'dshsa host tasks: internal HTTP 8080 from panel-api and worker-api only', allowAllOutbound: true })
    securityGroup.addIngressRule(shared.network.panelApiSg, ec2.Port.tcp(InternalApiPort), 'panel-api to cell management routes')
    securityGroup.addIngressRule(worker.workerApiSg, ec2.Port.tcp(InternalApiPort), 'worker-api to token refresh')

    const logGroup = new logs.LogGroup(this, 'Logs', { logGroupName: '/dshsa/host', retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY })
    const executionRole = new iam.Role(this, 'ExecutionRole', { roleName: 'dshsa-host-exec', assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'dshsa host: pull the image and write logs' })
    const taskRole = this.taskRole = new iam.Role(this, 'TaskRole', { roleName: 'dshsa-host-task', assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'dshsa host: cells (DynamoDB leases, SQS, Litestream, AgentCore, KMS tokens, Bedrock)' })
    const allow = (actions: string[], resources: string[], sid: string) => taskRole.addToPolicy(new iam.PolicyStatement({ sid, actions, resources }))

    // Leases (read/write) and the read-only platform tables.
    const { tables } = shared
    allow(['dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem'], [tables.leases.tableArn], 'Leases')
    allow(['dynamodb:GetItem', 'dynamodb:Scan', 'dynamodb:Query'], [tables.cells.tableArn, `${tables.cells.tableArn}/index/*`, tables.tenants.tableArn,
      tables.routes.tableArn, `${tables.routes.tableArn}/index/*`], 'PlatformTablesRead')
    // v6 onboarding: the tenant route checks an installation's claim (`ghinst#<id>`); one item read, nothing else of that table.
    allow(['dynamodb:GetItem'], [`arn:aws:dynamodb:${region}:${account}:table/${Tables.onboarding}`], 'OnboardingClaimRead')
    // The per-cell FIFO queues (created at runtime by the admin CLI): consume and, for connectors, send.
    allow(['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:ChangeMessageVisibility', 'sqs:GetQueueAttributes', 'sqs:SendMessage'], [shared.cellQueueArnPattern], 'CellQueues')
    // Ticket tokens (parent design §4.3): only the host signs.
    allow(['kms:Sign', 'kms:GetPublicKey', 'kms:DescribeKey'], [shared.ticketTokenKey.keyArn], 'TicketTokenSign')
    // Workers: one AgentCore runtime session per ticket, and their access points.
    // v7: one runtime per worker type (the Codex one is optional); a ticket's sticky type picks the runtime it is invoked on.
    const runtimes = [worker.runtimeArn, ...worker.codexRuntimeArn ? [worker.codexRuntimeArn] : []].flatMap(arn => [arn, `${arn}/*`])
    allow(['bedrock-agentcore:InvokeAgentRuntime'], runtimes, 'InvokeWorkerRuntime')
    // Stale sessions (contracts WorkerVersion): read the version each runtime serves, and stop an idle session still on an old image.
    allow(['bedrock-agentcore:StopRuntimeSession'], runtimes, 'StopStaleWorkerSessions')
    const parameters = [WorkerVersion.parameters.claude, ...worker.codexRuntimeArn ? [WorkerVersion.parameters.codex] : []]
    allow(['ssm:GetParameter'], parameters.map(name => `arn:aws:ssm:${region}:${account}:parameter${name}`), 'WorkerVersionRead')
    allow(['lambda:InvokeFunction'], [worker.provisionerFunction.functionArn], 'InvokeProvisioner')
    // Stateless assessment and replies (Converse on global cross-region inference profiles of Anthropic and, v7, OpenAI models;
    // GPT-6 models also need the account's default Bedrock project). Independent of the Codex runtime flag.
    allow(['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'], [
      `arn:aws:bedrock:*:${account}:inference-profile/global.anthropic.*`, `arn:aws:bedrock:*:${account}:inference-profile/*.anthropic.*`,
      'arn:aws:bedrock:*::foundation-model/anthropic.*', 'arn:aws:bedrock:::foundation-model/anthropic.*',
      `arn:aws:bedrock:*:${account}:inference-profile/global.openai.*`, 'arn:aws:bedrock:*::foundation-model/openai.*',
      'arn:aws:bedrock:::foundation-model/openai.*', `arn:aws:bedrock:${region}:${account}:project/default`], 'BedrockModels')
    // Litestream replicas and connector KV in the state bucket (host only).
    const state = shared.buckets.state
    allow(['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], [state.arnForObjects('cells/*'), state.arnForObjects('connectors/*')], 'StateObjects')
    allow(['s3:ListBucket', 's3:GetBucketLocation'], [state.bucketArn], 'StateBucket')
    allow(['secretsmanager:GetSecretValue'], [shared.secrets.githubApp.secretArn, shared.secrets.feishuSecretArnPattern], 'Secrets')

    const image = new ecrAssets.DockerImageAsset(this, 'Image', { directory: ROOT, file: 'packages/cell/Dockerfile', platform: ecrAssets.Platform.LINUX_ARM64,
      exclude: ['**/node_modules', '**/.git', 'dsh-superagent-prototype', 'agentcore-s3files-per-user-isolation', 'research', 'spikes', 'worker', 'infra',
        'packages/panel', 'packages/control-api', '**/dist', '**/cdk.out', '.trellis', '.claude', '.codex', '.kiro', '.agents', '.codegraph'] })
    const task = new ecs.FargateTaskDefinition(this, 'Task', { family: 'dshsa-host', cpu: 1024, memoryLimitMiB: 2048, executionRole, taskRole,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX }, ephemeralStorageGiB: 30 })
    task.addContainer('host', {
      containerName: 'host', image: ecs.ContainerImage.fromDockerImageAsset(image), essential: true,
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'host' }),
      portMappings: [{ containerPort: InternalApiPort, protocol: ecs.Protocol.TCP }],
      // Time to stop consuming, drain effects, close SQLite, flush Litestream and release leases (well inside the 30 s lease TTL).
      stopTimeout: Duration.seconds(60),
      environment: {
        AWS_REGION: region, DATA_DIR: '/data', STATE_BUCKET: state.bucketName, RUNTIME_ARN: worker.runtimeArn,
        ...worker.codexRuntimeArn ? { RUNTIME_ARN_CODEX: worker.codexRuntimeArn } : {},
        PROVISIONER_FUNCTION: worker.provisionerFunction.functionName, TOKEN_KEY_ID: shared.ticketTokenKey.keyArn,
        GITHUB_APP_SECRET: shared.secrets.githubApp.secretArn, ACCOUNT_ID: account,
        PANEL_API_ROLE_NAME: props.panelApiRoleName ?? 'dshsa-panel-api', WORKER_API_ROLE_NAME: props.workerApiRoleName ?? 'dshsa-worker-api',
        PANEL_TENANT_ROLE_NAME: props.panelTenantRoleName ?? 'dshsa-panel-tenant',
        MAX_CELLS: String(props.maxCells ?? 20), MAX_CONNECTORS: String(props.maxConnectors ?? 5),
      },
      healthCheck: { command: ['CMD-SHELL', 'node -e "fetch(\'http://127.0.0.1:8080/healthz\').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"'],
        interval: Duration.seconds(30), timeout: Duration.seconds(5), retries: 3, startPeriod: Duration.seconds(30) },
    })
    image.repository.grantPull(executionRole)

    this.service = new ecs.FargateService(this, 'Service', { serviceName: 'dshsa-host', cluster, taskDefinition: task, desiredCount: props.desiredCount ?? 1,
      vpcSubnets: shared.network.privateSubnets, securityGroups: [securityGroup], assignPublicIp: false,
      // Leases, not ECS, keep one writer per cell, so a new task may start before the old one stops.
      minHealthyPercent: 100, maxHealthyPercent: 200, circuitBreaker: { enable: true, rollback: true }, enableExecuteCommand: false })

    NagSuppressions.addResourceSuppressions(taskRole, [
      why('AwsSolutions-IAM5', 'Wildcards are scoped: dshsa-cell-*.fifo queues (created at runtime per cell), dshsa/feishu/* secrets (per tenant), '
        + 'index/* of the dshsa tables, cells/* and connectors/* objects of the state bucket, the dshsa worker runtimes and their endpoints, and '
        + 'Anthropic and OpenAI inference profiles/models in any region (global cross-region inference routes across regions).'),
    ], true)
    NagSuppressions.addResourceSuppressions(executionRole, [
      why('AwsSolutions-IAM5', 'ecr:GetAuthorizationToken has no resource scope; log stream writes are limited to the /dshsa/host log group.'),
    ], true)
    NagSuppressions.addResourceSuppressions(task, [
      why('AwsSolutions-ECS2', 'Environment variables hold resource names and ARNs only; secrets are read at runtime from Secrets Manager.'),
    ])
  }
}
