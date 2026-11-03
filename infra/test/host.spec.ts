import { Aspects } from 'aws-cdk-lib'
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions'
import { AwsSolutionsChecks } from 'cdk-nag'
import { beforeAll, describe, expect, it } from 'vitest'
import { ACCOUNT, compose } from '../lib/compose.ts'
import { testApp } from './test-app.ts'

let host: Template
let annotations: Annotations
beforeAll(async () => {
  const app = testApp()
  const stacks = await compose(app, { account: ACCOUNT })
  Aspects.of(app).add(new AwsSolutionsChecks())
  app.synth()
  host = Template.fromStack(stacks.hostStack)
  annotations = Annotations.fromStack(stacks.hostStack)
}, 300_000)

describe('dshsa-host', () => {
  it('runs one arm64 Fargate service in private subnets without a public IP or load balancer', () => {
    host.hasResourceProperties('AWS::ECS::Service', { ServiceName: 'dshsa-host', LaunchType: 'FARGATE',
      NetworkConfiguration: { AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: 'DISABLED' }) } })
    host.hasResourceProperties('AWS::ECS::TaskDefinition', { RuntimePlatform: { CpuArchitecture: 'ARM64', OperatingSystemFamily: 'LINUX' } })
    expect(Object.keys(host.findResources('AWS::ElasticLoadBalancingV2::LoadBalancer'))).toEqual([])
  })
  it('admits 8080 only from the panel-api and worker-api security groups', () => {
    const ingress = Object.values(host.findResources('AWS::EC2::SecurityGroupIngress')) as { Properties: Record<string, unknown> }[]
    expect(ingress).toHaveLength(2)
    for (const rule of ingress) {
      expect(rule.Properties).toMatchObject({ FromPort: 8080, ToPort: 8080, IpProtocol: 'tcp' })
      expect(rule.Properties.SourceSecurityGroupId).toBeDefined()
      expect(rule.Properties.CidrIp).toBeUndefined()
    }
  })
  it('configures IAM caller auth (no shared secret) and dshsa-named roles', () => {
    const task = JSON.stringify(host.findResources('AWS::ECS::TaskDefinition'))
    expect(task).toContain('PANEL_API_ROLE_NAME')
    expect(task).toContain('WORKER_API_ROLE_NAME')
    expect(task).toContain('dshsa-panel-tenant')
    expect(task).not.toContain('INTERNAL_API_SECRET')
    host.hasResourceProperties('AWS::IAM::Role', { RoleName: 'dshsa-host-task' })
    host.hasResourceProperties('AWS::IAM::Role', { RoleName: 'dshsa-host-exec' })
  })
  it('grants the task role only what a cell needs', () => {
    const policies = JSON.stringify(host.findResources('AWS::IAM::Policy'))
    for (const action of ['bedrock-agentcore:InvokeAgentRuntime', 'kms:Sign', 'lambda:InvokeFunction', 'sqs:ReceiveMessage', 'dynamodb:UpdateItem', 'bedrock:InvokeModel'])
      expect(policies).toContain(action)
    expect(policies).not.toContain('bedrock-agentcore:InvokeAgentRuntimeCommand')
    // Stale worker sessions: stop on the dshsa runtime only, and read only the worker version parameter.
    const statements = Object.values(host.findResources('AWS::IAM::Policy')).flatMap(policy =>
      (policy as { Properties: { PolicyDocument: { Statement: { Sid?: string; Action: unknown; Resource: unknown }[] } } }).Properties.PolicyDocument.Statement)
    const stop = statements.find(statement => statement.Sid === 'StopStaleWorkerSessions')!
    expect(stop.Action).toBe('bedrock-agentcore:StopRuntimeSession')
    expect(JSON.stringify(stop.Resource)).not.toMatch(/"\*"|runtime\/\*/)
    const version = statements.find(statement => statement.Sid === 'WorkerVersionRead')!
    expect(version.Action).toBe('ssm:GetParameter')
    expect(JSON.stringify(version.Resource)).toContain(':parameter/dshsa-worker/version')
    // v7: both worker runtimes (invoke and stop), both version parameters, and the Codex runtime ARN for the cell.
    const invoke = statements.find(statement => statement.Sid === 'InvokeWorkerRuntime')!
    for (const s of [invoke, stop]) {
      const resources = JSON.stringify(s.Resource)
      expect(resources).toContain('WorkerRuntime')
      expect(resources).toContain('WorkerCodexRuntime')
      expect((s.Resource as unknown[]).length).toBe(4)  // each runtime and its endpoints
    }
    expect(JSON.stringify(version.Resource)).toContain(':parameter/dshsa-worker-codex/version')
    const env = JSON.stringify(host.findResources('AWS::ECS::TaskDefinition'))
    expect(env).toContain('"RUNTIME_ARN_CODEX"')
    // Assessor/replier models: Anthropic and OpenAI profiles/models plus the default project (GPT-6 on Converse).
    const models = JSON.stringify(statements.find(statement => statement.Sid === 'BedrockModels')!.Resource)
    for (const arn of [':inference-profile/global.openai.*', 'arn:aws:bedrock:*::foundation-model/openai.*', 'arn:aws:bedrock:::foundation-model/openai.*',
      ':project/default', ':inference-profile/global.anthropic.*', 'foundation-model/anthropic.*'])
      expect(models).toContain(arn)
    // v6 onboarding: one item read on dshsa-onboarding, nothing more.
    const claims = statements.find(statement => statement.Sid === 'OnboardingClaimRead')!
    expect(claims.Action).toBe('dynamodb:GetItem')
    expect(JSON.stringify(claims.Resource)).toMatch(/:table\/dshsa-onboarding"$|:table\/dshsa-onboarding"\]?$/)
    expect(policies).not.toMatch(/"Action":"\*"|"s3:\*"|"dynamodb:\*"/)
  })
  it('has no unsuppressed cdk-nag errors', () => {
    expect(annotations.findError('*', Match.stringLikeRegexp('AwsSolutions-.*'))).toEqual([])
  })
})
