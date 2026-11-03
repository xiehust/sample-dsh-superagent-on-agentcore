/** WorkerModule (owner a8): isolation-relevant properties of dshsa-worker (parent design §5, worker design §7). */
import { Aspects } from 'aws-cdk-lib'
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions'
import { AwsSolutionsChecks } from 'cdk-nag'
import { cpSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WorkerVersion } from '@dshsa/contracts'
import { beforeAll, describe, expect, it } from 'vitest'
import { ACCOUNT, compose } from '../lib/compose.ts'
import { tempDir, testApp } from './test-app.ts'
import { CODEX_FLAG, workerImageVersion, workerPaths } from '../lib/constructs/worker.ts'

let worker: Template
let annotations: Annotations
let all: Template[]
let assemblyDir: string
type Statement = { Effect: string; Action: string | string[]; Resource?: unknown; Condition?: Record<string, unknown> }
const actions = (s: Statement): string[] => (Array.isArray(s.Action) ? s.Action : [s.Action])
const roleStatements = (logicalPrefix: string): Statement[] => {
  const policies = worker.findResources('AWS::IAM::Policy')
  return Object.values(policies).filter(p => JSON.stringify((p as { Properties: { Roles: unknown } }).Properties.Roles).includes(logicalPrefix))
    .flatMap(p => (p as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties.PolicyDocument.Statement)
}

beforeAll(async () => {
  const app = testApp()
  const stacks = await compose(app, { account: ACCOUNT })
  Aspects.of(app).add(new AwsSolutionsChecks())
  assemblyDir = app.synth().directory
  worker = Template.fromStack(stacks.workerStack)
  all = [stacks.shared, stacks.workerStack, stacks.hostStack, stacks.ingressStack, stacks.panel].map(stack => Template.fromStack(stack))
  annotations = Annotations.fromStack(stacks.workerStack)
}, 600_000)

describe('dshsa-worker', () => {
  it('runs the runtime in the VPC with IAM inbound auth and the 30 min / 8 h lifecycle', () => {
    worker.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      AgentRuntimeName: 'dshsa_worker', ProtocolConfiguration: 'HTTP',
      NetworkConfiguration: { NetworkMode: 'VPC', NetworkModeConfig: Match.objectLike({ Subnets: Match.anyValue() }) },
      LifecycleConfiguration: { IdleRuntimeSessionTimeout: 1800, MaxLifetime: 28800 },
      EnvironmentVariables: Match.objectLike({ WORKER_API_SIGV4: '1', BROKER_FUNCTION: Match.anyValue() }),
    })
    const runtime = Object.values(worker.findResources('AWS::BedrockAgentCore::Runtime'))[0] as { Properties: Record<string, unknown> }
    expect(runtime.Properties.AuthorizerConfiguration).toBeUndefined()
    expect(runtime.Properties.RequestHeaderConfiguration).toBeUndefined()
  })

  it('gives the runtime execution role no S3, S3 Files or DynamoDB access', () => {
    const statements = roleStatements('WorkerRuntimeRole')
    expect(statements.length).toBeGreaterThan(0)
    for (const s of statements) for (const a of actions(s)) expect(a).not.toMatch(/^(s3|s3files|dynamodb|elasticfilesystem|sts):/)
    expect(statements.some(s => actions(s).includes('lambda:InvokeFunction'))).toBe(true)
  })

  it('denies mounting the file system without an access point', () => {
    worker.hasResourceProperties('AWS::S3Files::FileSystemPolicy', {
      Policy: { Version: '2012-10-17', Statement: [Match.objectLike({
        Effect: 'Deny', Principal: '*', Action: ['s3files:ClientMount', 's3files:ClientWrite', 's3files:ClientRootAccess'],
        Condition: { Null: { 's3files:AccessPointArn': 'true' } },
      })] },
    })
  })

  it('lets only the broker assume the mount role, and the broker only read ticket storage', () => {
    const role = Object.values(worker.findResources('AWS::IAM::Role', { Properties: { RoleName: 'dshsa-worker-mount' } }))[0] as
      { Properties: { AssumeRolePolicyDocument: { Statement: { Principal: { AWS: unknown } }[] } } }
    for (const s of role.Properties.AssumeRolePolicyDocument.Statement) expect(JSON.stringify(s.Principal.AWS)).toContain('WorkerBrokerRole')
    const broker = roleStatements('WorkerBrokerRole').flatMap(actions)
    expect(broker.filter(a => a.startsWith('dynamodb:'))).toEqual(['dynamodb:GetItem'])
    expect(broker.some(a => a.startsWith('s3files:'))).toBe(false)
  })

  it('exposes worker-api as a private API with AWS_IAM, restricted to the VPC endpoint', () => {
    worker.hasResourceProperties('AWS::ApiGateway::RestApi', {
      Name: 'dshsa-worker-api', EndpointConfiguration: { Types: ['PRIVATE'], VpcEndpointIds: Match.anyValue() },
      Policy: { Statement: Match.arrayWith([Match.objectLike({ Effect: 'Deny', Condition: { StringNotEquals: { 'aws:SourceVpce': Match.anyValue() } } })]) },
    })
    const methods = Object.values(worker.findResources('AWS::ApiGateway::Method')) as { Properties: { AuthorizationType: string; HttpMethod: string } }[]
    expect(methods.length).toBeGreaterThan(0)
    for (const m of methods) if (m.Properties.HttpMethod !== 'OPTIONS') expect(m.Properties.AuthorizationType).toBe('AWS_IAM')
  })

  it('opens NFS only from the runtime SG', () => {
    const rules = Object.values(worker.findResources('AWS::EC2::SecurityGroupIngress')) as { Properties: Record<string, unknown> }[]
    expect(rules).toHaveLength(1)
    expect(rules[0]!.Properties).toMatchObject({ IpProtocol: 'tcp', FromPort: 2049, ToPort: 2049 })
    expect(rules[0]!.Properties.SourceSecurityGroupId).toBeDefined()
    const groups = Object.values(worker.findResources('AWS::EC2::SecurityGroup')) as { Properties: { SecurityGroupIngress?: { CidrIp?: string }[] } }[]
    for (const g of groups) for (const rule of g.Properties.SecurityGroupIngress ?? []) expect(rule.CidrIp).toBeUndefined()
  })

  it('names the Lambdas and roles with the dshsa prefix', () => {
    for (const name of ['dshsa-broker', 'dshsa-provisioner', 'dshsa-worker-api']) worker.hasResourceProperties('AWS::Lambda::Function', { FunctionName: name })
    for (const name of ['dshsa-worker-broker', 'dshsa-worker-provisioner', 'dshsa-worker-api', 'dshsa-worker-runtime', 'dshsa-worker-mount']) {
      worker.hasResourceProperties('AWS::IAM::Role', { RoleName: name })
    }
  })

  it('needs no account-level API Gateway CloudWatch role (shared account)', () => {
    for (const template of all) template.resourceCountIs('AWS::ApiGateway::Account', 0)
    const stages = Object.values(worker.findResources('AWS::ApiGateway::Stage')) as { Properties: Record<string, unknown> }[]
    expect(stages).toHaveLength(1)
    expect(stages[0]!.Properties.AccessLogSetting).toBeUndefined()
    for (const setting of (stages[0]!.Properties.MethodSettings ?? []) as { LoggingLevel?: string; DataTraceEnabled?: boolean }[]) {
      expect(setting.LoggingLevel ?? 'OFF').toBe('OFF')
      expect(setting.DataTraceEnabled ?? false).toBe(false)
    }
  })

  it('bakes the content version into the image and publishes it in SSM after the runtime', () => {
    const version = workerImageVersion()
    expect(version).toMatch(/^[0-9a-f]{16}$/)
    expect(workerImageVersion()).toBe(version) // deterministic, no git or clock input
    const codexVersion = workerImageVersion('codex')
    expect(codexVersion).toMatch(/^[0-9a-f]{16}$/)
    expect(codexVersion).not.toBe(version)
    const runtimes = worker.findResources('AWS::BedrockAgentCore::Runtime') as Record<string, { Properties: { AgentRuntimeName: string } }>
    const runtimeId = (name: string) => Object.entries(runtimes).find(([, r]) => r.Properties.AgentRuntimeName === name)![0]
    for (const [name, parameter, value] of [['dshsa_worker', WorkerVersion.parameters.claude, version], ['dshsa_worker_codex', WorkerVersion.parameters.codex, codexVersion]]) {
      const params = worker.findResources('AWS::SSM::Parameter', { Properties: { Name: parameter } })
      const [param] = Object.values(params) as { Properties: { Value: string; Type: string }; DependsOn?: string[] }[]
      expect(param?.Properties).toMatchObject({ Value: value, Type: 'String' })
      expect(param?.DependsOn).toContain(runtimeId(name!))
    }
    const manifests = readdirSync(assemblyDir).filter(name => name.endsWith('.assets.json'))
    const images = manifests.flatMap(name => Object.values((JSON.parse(readFileSync(join(assemblyDir, name), 'utf8')) as
      { dockerImages?: Record<string, { source: { dockerFile?: string; dockerBuildTarget?: string; dockerBuildArgs?: Record<string, string> } }> }).dockerImages ?? {}))
      .filter(image => image.source.dockerFile === 'worker/container/Dockerfile')
    expect(images.map(image => [image.source.dockerBuildTarget, image.source.dockerBuildArgs]).sort()).toEqual([
      ['claude', { [WorkerVersion.env]: version }], ['codex', { [WorkerVersion.env]: codexVersion }]])
  })

  it('runs a second runtime for the Codex worker with the same role, network and lifecycle', () => {
    const runtimes = Object.values(worker.findResources('AWS::BedrockAgentCore::Runtime')) as { Properties: Record<string, unknown> }[]
    expect(runtimes.map(r => r.Properties.AgentRuntimeName).sort()).toEqual(['dshsa_worker', 'dshsa_worker_codex'])
    const [a, b] = runtimes.map(r => r.Properties)
    for (const key of ['RoleArn', 'NetworkConfiguration', 'LifecycleConfiguration', 'EnvironmentVariables', 'PlatformVersion', 'ProtocolConfiguration'])
      expect(b![key]).toEqual(a![key])
    expect(JSON.stringify(a!.AgentRuntimeArtifact)).not.toEqual(JSON.stringify(b!.AgentRuntimeArtifact))
    for (const r of runtimes) expect(r.Properties.AuthorizerConfiguration).toBeUndefined()
  })

  it('lets the runtime role call the default Bedrock project (GPT-6 Responses API) and nothing of ticket data', () => {
    const statements = roleStatements('WorkerRuntimeRole')
    const project = statements.find(s => JSON.stringify(s.Resource).includes(':project/default'))
    expect(project && actions(project)).toEqual(['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'])
    for (const s of statements) for (const a of actions(s)) expect(a).not.toMatch(/^(s3|s3files|dynamodb|elasticfilesystem|sts):/)
  })

  it('versions each image only by its own files: a codex-only change keeps the claude version', () => {
    const container = join(tempDir('dshsa-container-'), 'container')
    cpSync(join(workerPaths.WORKER, 'container'), container, { recursive: true, filter: src => !src.includes('__pycache__') })
    const before = { claude: workerImageVersion('claude', container), codex: workerImageVersion('codex', container) }
    writeFileSync(join(container, 'codex_runner.py'), '# changed\n')
    expect(workerImageVersion('claude', container)).toBe(before.claude)
    expect(workerImageVersion('codex', container)).not.toBe(before.codex)
    writeFileSync(join(container, 'gateway_core.py'), '# changed\n')
    expect(workerImageVersion('claude', container)).not.toBe(before.claude)
  })

  it('omits the Codex runtime and its version parameter with -c dshsa:codexWorker=false', async () => {
    const app = testApp({ [CODEX_FLAG]: 'false' })
    const stacks = await compose(app, { account: ACCOUNT })
    const off = Template.fromStack(stacks.workerStack)
    const names = Object.values(off.findResources('AWS::BedrockAgentCore::Runtime')).map(r => (r as { Properties: { AgentRuntimeName: string } }).Properties.AgentRuntimeName)
    expect(names).toEqual(['dshsa_worker'])
    expect(Object.keys(off.findResources('AWS::SSM::Parameter', { Properties: { Name: WorkerVersion.parameters.codex } }))).toEqual([])
    const host = JSON.stringify(Template.fromStack(stacks.hostStack).toJSON())
    expect(host).not.toContain('RUNTIME_ARN_CODEX')
    expect(host).not.toContain('dshsa-worker-codex/version')
  }, 300_000)

  it('has no unsuppressed cdk-nag errors', () => {
    expect(annotations.findError('*', Match.stringLikeRegexp('AwsSolutions-.*'))).toEqual([])
  })
})
