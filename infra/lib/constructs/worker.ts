/**
 * Worker module (owner a8): AgentCore runtimes `dshsa_worker` (Claude) and `dshsa_worker_codex` (Codex, optional), the S3 Files file system with its policy and mount targets,
 * the broker / provisioner / worker-api Lambdas, the session mount role and the private worker-api.
 * Design: docs/design.md §4.10. Security model: parent design §5.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  Arn, ArnFormat, AssetHashType, DockerImage, Duration, IgnoreMode, RemovalPolicy, Stack, Tags,
  aws_apigateway as apigw, aws_bedrockagentcore as agentcore, aws_ec2 as ec2, aws_ecr_assets as ecrAssets, aws_iam as iam,
  aws_lambda as lambda, aws_logs as logs, aws_s3files as s3files, aws_ssm as ssm,
} from 'aws-cdk-lib'
import { WorkerVersion } from '@dshsa/contracts'
import { NagSuppressions } from 'cdk-nag'
import { Construct } from 'constructs'
import type { ModuleProps, WorkerOutputs } from '../shared-resources.ts'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..')
const WORKER = join(ROOT, 'worker')
const CONTRACTS_PY = join(ROOT, 'packages/contracts/python/dshsa_contracts.py')
export const RUNTIME_NAME = 'dshsa_worker'
export const CODEX_RUNTIME_NAME = 'dshsa_worker_codex'
/** CDK context flag (default on): `-c dshsa:codexWorker=false` omits the Codex image, runtime and version parameter. */
export const CODEX_FLAG = 'dshsa:codexWorker'
export type WorkerAgent = 'claude' | 'codex'
/** container/ files only the codex image carries: editing them must not mark Claude sessions stale (and vice versa). */
const AGENT_ONLY: Record<WorkerAgent, string[]> = { claude: ['requirements-claude.txt'], codex: ['codex_runner.py', 'codex-config.toml'] }
const IDLE_TIMEOUT_S = 1800
const MAX_LIFETIME_S = 8 * 3600
const STAGE = 'v1'

/** Files under `dir` (recursive), for asset hashing; skips caches. */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (name === '__pycache__' || name.startsWith('.')) return []
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}
const hashOf = (paths: string[], extra = ''): string => {
  const h = createHash('sha256').update(extra)
  for (const path of paths.sort()) h.update(relative(ROOT, path)).update(readFileSync(path))
  return h.digest('hex')
}

/**
 * A worker image's content version (contracts WorkerVersion): a hash of exactly what that image target is built from (container/
 * without the other agent's files, the dshsa_worker package, the contracts mirror) and the agent name. Git-independent and
 * deterministic; it changes iff the image would. `workerImageVersion()` is the Claude image's.
 */
export function workerImageVersion(agent: WorkerAgent = 'claude', container = join(WORKER, 'container')): string {
  const other = AGENT_ONLY[agent === 'claude' ? 'codex' : 'claude']
  const sources = files(container).filter(path => !other.includes(relative(container, path)))
  // The claude image keeps its pre-v7 hash input (no agent prefix): the version changes only when its files do.
  return hashOf([...sources, ...files(join(WORKER, 'src/dshsa_worker')), CONTRACTS_PY], agent === 'claude' ? '' : agent).slice(0, 16)
}

/**
 * Python 3.12 arm64 Lambda code: the `dshsa_worker` package, the contracts mirror and its wheels (boto3 for the s3files
 * client, cryptography for ES256/RS256), bundled locally with uv; no Docker needed.
 */
function pythonCode(): lambda.Code {
  const sources = [...files(join(WORKER, 'src/dshsa_worker')), CONTRACTS_PY]
  const deps = ['boto3>=1.43', 'cryptography>=44']
  return lambda.Code.fromAsset(join(WORKER, 'src'), {
    assetHashType: AssetHashType.CUSTOM,
    assetHash: hashOf(sources, deps.join(',')),
    bundling: {
      image: DockerImage.fromRegistry('public.ecr.aws/sam/build-python3.12:latest'),
      command: ['bash', '-c', 'echo "local bundling with uv is required (install uv)" >&2; exit 1'],
      local: {
        tryBundle(outputDir: string): boolean {
          execFileSync('uv', ['pip', 'install', '--quiet', '--target', outputDir, '--python-platform', 'aarch64-manylinux2014',
            '--python-version', '3.12', '--only-binary', ':all:', ...deps], { stdio: 'inherit' })
          cpSync(join(WORKER, 'src/dshsa_worker'), join(outputDir, 'dshsa_worker'), { recursive: true, filter: src => !src.includes('__pycache__') })
          cpSync(CONTRACTS_PY, join(outputDir, 'dshsa_contracts.py'))
          return true
        },
      },
    },
  })
}

export class WorkerModule extends Construct implements WorkerOutputs {
  readonly runtimeArn: string
  readonly provisionerFunction: lambda.IFunction
  readonly fileSystemId: string
  readonly workerApiSg: ec2.ISecurityGroup
  /** The deployed image's version; every InvocationResponse carries the version of the image that answered (`workerVersion`). */
  readonly workerVersion: string
  /** SSM `/dshsa-worker/version` = `workerVersion`, updated only after the runtime; the cell reads it (grantRead) to spot stale sessions. */
  readonly workerVersionParameter: ssm.IStringParameter
  /** The Codex runtime (`dshsa_worker_codex`), unless `-c dshsa:codexWorker=false`. */
  readonly codexRuntimeArn?: string
  readonly codexWorkerVersion?: string
  /** SSM `/dshsa-worker-codex/version`, published after the Codex runtime. */
  readonly codexWorkerVersionParameter?: ssm.IStringParameter

  constructor(scope: Construct, id: string, props: ModuleProps) {
    super(scope, id)
    const { shared } = props
    const stack = Stack.of(this)
    const { vpc, privateSubnets, executeApiEndpoint, executeApiPrivateDns } = shared.network
    const subnets = vpc.selectSubnets(privateSubnets)

    // ---- network ---------------------------------------------------------------------------------------------------
    const runtimeSg = new ec2.SecurityGroup(this, 'RuntimeSg', {
      vpc, securityGroupName: 'dshsa-worker-runtime', description: 'dshsa worker microVMs (no ingress)', allowAllOutbound: true,
    })
    const fsSg = new ec2.SecurityGroup(this, 'FsSg', {
      vpc, securityGroupName: 'dshsa-worker-fs', description: 'dshsa S3 Files mount targets: NFS from worker microVMs only', allowAllOutbound: false,
    })
    fsSg.addIngressRule(runtimeSg, ec2.Port.tcp(2049), 'NFS from dshsa worker microVMs')
    const apiSg = new ec2.SecurityGroup(this, 'WorkerApiSg', {
      vpc, securityGroupName: 'dshsa-worker-api', description: 'dshsa worker-api Lambda (egress to host :8080, AWS APIs, GitHub)', allowAllOutbound: true,
    })
    this.workerApiSg = apiSg

    // ---- S3 Files ---------------------------------------------------------------------------------------------------
    const fs = new s3files.CfnFileSystem(this, 'FileSystem', {
      bucket: shared.buckets.data.bucketArn, roleArn: shared.dataBucketS3FilesRole.roleArn,
      tags: [{ key: 'Name', value: 'dshsa-worker-fs-1' }, { key: 'dshsa:managed', value: 'true' }],
    })
    fs.applyRemovalPolicy(RemovalPolicy.DESTROY)
    this.fileSystemId = fs.attrFileSystemId
    // Backstop (reference infra.yaml): nobody mounts, writes or acts as root without an access point, whatever IAM allows.
    new s3files.CfnFileSystemPolicy(this, 'FileSystemPolicy', {
      fileSystemId: fs.attrFileSystemId,
      policy: {
        Version: '2012-10-17',
        Statement: [{
          Sid: 'DenyMountWithoutAccessPoint', Effect: 'Deny', Principal: '*',
          Action: ['s3files:ClientMount', 's3files:ClientWrite', 's3files:ClientRootAccess'],
          Resource: '*', Condition: { Null: { 's3files:AccessPointArn': 'true' } },
        }],
      },
    })
    const mountTargets = subnets.subnets.map((subnet, i) => new s3files.CfnMountTarget(this, `MountTarget${i}`, {
      fileSystemId: fs.attrFileSystemId, subnetId: subnet.subnetId, securityGroups: [fsSg.securityGroupId],
    }))
    const fsArn = fs.attrFileSystemArn

    // ---- roles ------------------------------------------------------------------------------------------------------
    const lambdaRole = (name: string, description: string, vpcAccess = false) => {
      const role = new iam.Role(this, `${name}Role`, {
        roleName: `dshsa-worker-${name.toLowerCase()}`, description, assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      })
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [stack.formatArn({ service: 'logs', resource: 'log-group', resourceName: `/aws/lambda/dshsa-*`, arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
      }))
      if (vpcAccess) {
        role.addToPolicy(new iam.PolicyStatement({
          actions: ['ec2:CreateNetworkInterface', 'ec2:DescribeNetworkInterfaces', 'ec2:DeleteNetworkInterface', 'ec2:AssignPrivateIpAddresses',
            'ec2:UnassignPrivateIpAddresses'],
          resources: ['*'],
        }))
      }
      return role
    }
    const brokerRole = lambdaRole('Broker', 'dshsa broker: ticket token -> AP-scoped mount credentials')
    const provisionerRole = lambdaRole('Provisioner', 'dshsa provisioner: one S3 Files access point per ticket')
    const apiRole = lambdaRole('Api', 'dshsa worker-api: worker events, reads, GitHub credentials, token refresh', true)

    // The only identity that can mount the FS. Its full-power credentials never leave the broker; microVMs get a copy narrowed
    // to one access point by the session policy (max 1 h, role chaining).
    const mountRole = new iam.Role(this, 'MountRole', {
      roleName: 'dshsa-worker-mount', description: 'dshsa: mount S3 Files through an access point (narrowed per ticket by the broker)',
      assumedBy: new iam.ArnPrincipal(brokerRole.roleArn), maxSessionDuration: Duration.hours(1),
    })
    mountRole.assumeRolePolicy?.addStatements(new iam.PolicyStatement({
      actions: ['sts:SetSourceIdentity'], principals: [new iam.ArnPrincipal(brokerRole.roleArn)],
    }))
    mountRole.addToPolicy(new iam.PolicyStatement({ actions: ['s3files:ClientMount', 's3files:ClientWrite'], resources: [fsArn] }))
    mountRole.addToPolicy(new iam.PolicyStatement({
      actions: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite', 'elasticfilesystem:DescribeMountTargets'], resources: ['*'],
    }))
    brokerRole.addToPolicy(new iam.PolicyStatement({ actions: ['sts:AssumeRole', 'sts:SetSourceIdentity'], resources: [mountRole.roleArn] }))
    shared.tables.ticketStorage.grant(brokerRole, 'dynamodb:GetItem')
    for (const role of [brokerRole, apiRole]) {
      role.addToPolicy(new iam.PolicyStatement({ actions: ['kms:GetPublicKey', 'kms:DescribeKey'], resources: [shared.ticketTokenKey.keyArn] }))
    }

    provisionerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3files:CreateAccessPoint', 's3files:TagResource'], resources: [fsArn, `${fsArn}/access-point/*`],
    }))
    provisionerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3files:GetAccessPoint', 's3files:DeleteAccessPoint'], resources: [`${fsArn}/access-point/*`],
    }))
    shared.tables.ticketStorage.grant(provisionerRole, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem')

    shared.tables.ticketStorage.grant(apiRole, 'dynamodb:GetItem')
    shared.tables.cells.grant(apiRole, 'dynamodb:GetItem')
    shared.tables.leases.grant(apiRole, 'dynamodb:GetItem')
    apiRole.addToPolicy(new iam.PolicyStatement({ actions: ['sqs:SendMessage'], resources: [shared.cellQueueArnPattern] }))
    apiRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'], resources: [shared.secrets.githubApp.secretArn],
    }))

    // ---- Lambdas ----------------------------------------------------------------------------------------------------
    const code = pythonCode()
    const fn = (name: string, handler: string, role: iam.IRole, environment: Record<string, string>, extra: Partial<lambda.FunctionProps> = {}) => {
      const logGroup = new logs.LogGroup(this, `${name}Logs`, {
        logGroupName: `/aws/lambda/dshsa-${name}`, retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY,
      })
      return new lambda.Function(this, `${name}Fn`, {
        functionName: `dshsa-${name}`, runtime: lambda.Runtime.PYTHON_3_12, architecture: lambda.Architecture.ARM_64, handler, code, role,
        memorySize: 256, timeout: Duration.seconds(30), logGroup, environment: { ...environment }, ...extra,
      })
    }
    const tokenEnv = { TICKET_KEY_ID: shared.ticketTokenKey.keyId, TICKET_STORAGE_TABLE: shared.tables.ticketStorage.tableName }
    const broker = fn('broker', 'dshsa_worker.broker.handler', brokerRole, {
      ...tokenEnv, FILE_SYSTEM_ID: fs.attrFileSystemId, SESSION_MOUNT_ROLE_ARN: mountRole.roleArn, ACCOUNT_ID: stack.account, CRED_TTL_SECONDS: '3600',
    })
    const provisioner = fn('provisioner', 'dshsa_worker.provisioner.handler', provisionerRole, {
      TICKET_STORAGE_TABLE: shared.tables.ticketStorage.tableName, FILE_SYSTEM_ID: fs.attrFileSystemId,
    }, { timeout: Duration.seconds(90) })
    this.provisionerFunction = provisioner
    const workerApi = fn('worker-api', 'dshsa_worker.worker_api.handler', apiRole, {
      ...tokenEnv, CELLS_TABLE: shared.tables.cells.tableName, LEASES_TABLE: shared.tables.leases.tableName,
      GITHUB_APP_SECRET_ARN: shared.secrets.githubApp.secretArn,
    }, { vpc, vpcSubnets: privateSubnets, securityGroups: [apiSg] })

    // ---- runtime execution role: nothing that touches ticket data (no S3, no S3 Files, no DynamoDB) ----------------
    const runtimeRole = new iam.Role(this, 'RuntimeRole', {
      roleName: 'dshsa-worker-runtime', description: 'dshsa worker microVMs: Bedrock, broker invoke, worker-api invoke; no data access',
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': stack.account },
          ArnLike: { 'aws:SourceArn': stack.formatArn({ service: 'bedrock-agentcore', resource: '*', arnFormat: ArnFormat.NO_RESOURCE_NAME }) },
        },
      }),
    })
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
      resources: [stack.formatArn({ service: 'logs', resource: 'log-group', resourceName: '/aws/bedrock-agentcore/runtimes/*', arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
    }))
    runtimeRole.addToPolicy(new iam.PolicyStatement({ actions: ['logs:DescribeLogGroups'], resources: [stack.formatArn({ service: 'logs', resource: 'log-group', resourceName: '*', arnFormat: ArnFormat.COLON_RESOURCE_NAME })] }))
    runtimeRole.addToPolicy(new iam.PolicyStatement({ actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'], resources: ['*'] }))
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'], resources: ['*'], conditions: { StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' } },
    }))
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: ['arn:aws:bedrock:*::foundation-model/*', stack.formatArn({ service: 'bedrock', resource: 'inference-profile', resourceName: '*' }),
        `arn:aws:bedrock:*:${stack.account}:inference-profile/*`],
    }))
    // Responses API models (GPT-6 on bedrock-runtime, the Codex worker) also need the account's default Bedrock project (model cards).
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'], resources: [`arn:aws:bedrock:*:${stack.account}:project/default`],
    }))
    runtimeRole.addToPolicy(new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [broker.functionArn] }))
    runtimeRole.addToPolicy(new iam.PolicyStatement({ actions: ['kms:GetPublicKey', 'kms:DescribeKey'], resources: [shared.ticketTokenKey.keyArn] }))

    // ---- private worker-api: SigV4 (runtime role) + VPC endpoint + ticket token -----------------------------------
    // No stage access or execution logs: both need the account-level API Gateway CloudWatch role, an account-wide setting
    // outside the dshsa scope in a shared account (never set here). The worker-api Lambda logs each request instead.
    const api = new apigw.LambdaRestApi(this, 'WorkerApi', {
      restApiName: 'dshsa-worker-api', description: 'dshsa worker -> control plane (private; SigV4 runtime role + ticket token)',
      handler: workerApi, proxy: true,
      endpointConfiguration: { types: [apigw.EndpointType.PRIVATE], vpcEndpoints: [executeApiEndpoint] },
      defaultMethodOptions: { authorizationType: apigw.AuthorizationType.IAM },
      deployOptions: {
        stageName: STAGE, throttlingRateLimit: 200, throttlingBurstLimit: 400,
        loggingLevel: apigw.MethodLoggingLevel.OFF, dataTraceEnabled: false, metricsEnabled: true,
      },
      cloudWatchRole: false,
      policy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW, principals: [new iam.ArnPrincipal(runtimeRole.roleArn)], actions: ['execute-api:Invoke'], resources: ['execute-api:/*'],
            conditions: { StringEquals: { 'aws:SourceVpce': executeApiEndpoint.vpcEndpointId } },
          }),
          new iam.PolicyStatement({
            effect: iam.Effect.DENY, principals: [new iam.AnyPrincipal()], actions: ['execute-api:Invoke'], resources: ['execute-api:/*'],
            conditions: { StringNotEquals: { 'aws:SourceVpce': executeApiEndpoint.vpcEndpointId } },
          }),
        ],
      }),
    })
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      actions: ['execute-api:Invoke'],
      resources: [Arn.format({ service: 'execute-api', resource: api.restApiId, resourceName: `${STAGE}/POST/*` }, stack)],
    }))
    const apiHost = executeApiPrivateDns
      ? `${api.restApiId}.execute-api.${stack.region}.amazonaws.com`
      : `${api.restApiId}-${executeApiEndpoint.vpcEndpointId}.execute-api.${stack.region}.amazonaws.com`
    const workerApiUrl = `https://${apiHost}/${STAGE}`

    // ---- image + runtime --------------------------------------------------------------------------------------------
    // The version is computed from the build inputs (not the asset hash: build args feed that hash), baked in as a build arg.
    runtimeRole.addToPolicy(new iam.PolicyStatement({ actions: ['ecr:GetAuthorizationToken'], resources: ['*'] }))
    // One runtime per worker agent (contracts WorkerType), from one Dockerfile's targets; same role, network, lifecycle and env.
    // Each version is published after its runtime, so the cell never treats sessions as stale before the new image serves new ones.
    const workerRuntime = (agent: WorkerAgent, id: string, name: string, description: string) => {
      const version = workerImageVersion(agent)
      const image = new ecrAssets.DockerImageAsset(this, id === 'Runtime' ? 'Image' : `${id}Image`, {
        directory: ROOT, file: 'worker/container/Dockerfile', target: agent, platform: ecrAssets.Platform.LINUX_ARM64, ignoreMode: IgnoreMode.DOCKER,
        buildArgs: { [WorkerVersion.env]: version },
        exclude: ['*', '!packages', '!packages/contracts', '!packages/contracts/python', '!packages/contracts/python/dshsa_contracts.py',
          '!worker', '!worker/src', '!worker/src/**', '!worker/container', '!worker/container/**', '**/__pycache__'],
      })
      image.repository.grantPull(runtimeRole)
      const runtime = new agentcore.CfnRuntime(this, id, {
        agentRuntimeName: name, description, platformVersion: 'V2', roleArn: runtimeRole.roleArn, protocolConfiguration: 'HTTP',
        agentRuntimeArtifact: { containerConfiguration: { containerUri: image.imageUri } },
        networkConfiguration: { networkMode: 'VPC', networkModeConfig: { securityGroups: [runtimeSg.securityGroupId], subnets: subnets.subnetIds } },
        lifecycleConfiguration: { idleRuntimeSessionTimeout: IDLE_TIMEOUT_S, maxLifetime: MAX_LIFETIME_S },
        environmentVariables: {
          AWS_REGION: stack.region, AWS_DEFAULT_REGION: stack.region, BROKER_FUNCTION: broker.functionName, TICKET_KEY_ID: shared.ticketTokenKey.keyId,
          WORKER_API_URL: workerApiUrl, WORKER_API_SIGV4: '1', AGENT_UID: '1000',
        },
        tags: { project: 'dshsa' },
      })
      for (const target of mountTargets) runtime.node.addDependency(target)
      runtime.node.addDependency(runtimeRole)
      const parameter = new ssm.StringParameter(this, id === 'Runtime' ? 'WorkerVersion' : `${id}Version`, {
        parameterName: WorkerVersion.parameters[agent], stringValue: version,
        description: `dshsa worker image version served by the ${name} runtime; sessions answering another workerVersion are stale`,
      })
      parameter.node.addDependency(runtime)
      return { arn: runtime.attrAgentRuntimeArn, version, parameter }
    }
    const claude = workerRuntime('claude', 'Runtime', RUNTIME_NAME, 'dshsa worker: one microVM per ticket session (IAM inbound auth only)')
    this.runtimeArn = claude.arn
    this.workerVersion = claude.version
    this.workerVersionParameter = claude.parameter
    if (String(this.node.tryGetContext(CODEX_FLAG) ?? 'true') !== 'false') {
      const codex = workerRuntime('codex', 'CodexRuntime', CODEX_RUNTIME_NAME,
        'dshsa Codex worker (codex app-server, Bedrock GPT-6): one microVM per ticket session (IAM inbound auth only)')
      this.codexRuntimeArn = codex.arn
      this.codexWorkerVersion = codex.version
      this.codexWorkerVersionParameter = codex.parameter
    }
    Tags.of(this).add('dshsa:module', 'worker')

    // ---- cdk-nag: reviewed exceptions -------------------------------------------------------------------------------
    const why = (id: string, reason: string, appliesTo?: string[]) => ({ id, reason, ...(appliesTo ? { appliesTo } : {}) })
    NagSuppressions.addResourceSuppressions([brokerRole, provisionerRole, apiRole, runtimeRole, mountRole], [
      why('AwsSolutions-IAM5', 'Wildcards are scoped: dshsa-* log groups, access points of the dshsa file system, Bedrock models/profiles and the default project in any region (global CRIS), '
        + 'dshsa-cell-*.fifo queues, ENI management for the VPC Lambda, and execute-api POST routes of the private API. The mount role is '
        + 'narrowed to one access point per ticket by the broker session policy; elasticfilesystem:DescribeMountTargets has no resource scope.'),
    ], true)
    NagSuppressions.addResourceSuppressions(api, [
      why('AwsSolutions-APIG2', 'Request validation happens in the Lambda (zod-equivalent checks of the WorkerEvent contract).'),
      why('AwsSolutions-APIG3', 'Private API reachable only through the dshsa execute-api VPC endpoint; WAF is out of scope (parent PRD).'),
      why('AwsSolutions-APIG4', 'AWS_IAM authorization (SigV4 by the runtime role) on every method, plus ticket-token verification in the Lambda.'),
      why('AwsSolutions-COG4', 'Callers are worker microVMs, not Cognito users; SigV4 + ticket token is the authorizer.'),
      why('AwsSolutions-APIG1', 'Stage access logging needs the account-level API Gateway CloudWatch role, an account-wide setting this shared '
        + 'account does not set for dshsa. The worker-api Lambda writes one structured log line per request (requestId, route, caller role, '
        + 'ticketKey, status; never the token).'),
      why('AwsSolutions-APIG6', 'Execution logging needs the same account-level role; it would also capture headers and bodies (ticket tokens). '
        + 'Per-request logs come from the worker-api Lambda.'),
    ], true)
    for (const f of [broker, provisioner, workerApi]) {
      NagSuppressions.addResourceSuppressions(f, [why('AwsSolutions-L1', 'python3.12 is pinned to match the worker container (design §2).')])
    }
    NagSuppressions.addResourceSuppressions(fsSg, [why('AwsSolutions-EC23', 'Ingress is NFS 2049 from the worker runtime SG only.')])
  }
}

export const workerPaths = { ROOT, WORKER, CONTRACTS_PY, exists: (p: string) => existsSync(p) }
