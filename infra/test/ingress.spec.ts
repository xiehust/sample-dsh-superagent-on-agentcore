import { Aspects } from 'aws-cdk-lib'
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions'
import { AwsSolutionsChecks } from 'cdk-nag'
import { beforeAll, describe, expect, it } from 'vitest'
import { ACCOUNT, compose } from '../lib/compose.ts'
import { testApp } from './test-app.ts'

let ingress: Template
let annotations: Annotations
beforeAll(async () => {
  const app = testApp()
  const stacks = await compose(app, { account: ACCOUNT })
  Aspects.of(app).add(new AwsSolutionsChecks())
  app.synth()
  ingress = Template.fromStack(stacks.ingressStack)
  annotations = Annotations.fromStack(stacks.ingressStack)
}, 300_000)

describe('dshsa-ingress', () => {
  it('exposes only POST /github/webhook, throttled, on an API named dshsa-ingress', () => {
    ingress.hasResourceProperties('AWS::ApiGatewayV2::Api', { Name: 'dshsa-ingress', ProtocolType: 'HTTP' })
    const routes = ingress.findResources('AWS::ApiGatewayV2::Route')
    expect(Object.values(routes).map(route => (route as { Properties: { RouteKey: string } }).Properties.RouteKey)).toEqual(['POST /github/webhook'])
    ingress.hasResourceProperties('AWS::ApiGatewayV2::Stage', { DefaultRouteSettings: { ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 },
      AccessLogSettings: Match.objectLike({ DestinationArn: Match.anyValue() }) })
  })
  it('runs the webhook Lambda with a dshsa-named role scoped to GetItem, the cell queues and the App secret', () => {
    ingress.hasResourceProperties('AWS::Lambda::Function', { FunctionName: 'dshsa-ingress-github-webhook', Architectures: ['arm64'],
      Environment: { Variables: Match.objectLike({ ROUTES_TABLE: 'dshsa-routes', CELLS_TABLE: 'dshsa-cells' }) } })
    ingress.hasResourceProperties('AWS::IAM::Role', { RoleName: 'dshsa-ingress-github-webhook', ManagedPolicyArns: Match.absent() })
    const policies = JSON.stringify(ingress.findResources('AWS::IAM::Policy'))
    expect(policies).toContain('sqs:SendMessage')
    expect(policies).toContain('dshsa-cell-*.fifo')
    expect(policies).toContain('dynamodb:GetItem')
    expect(policies).not.toMatch(/"dynamodb:(PutItem|UpdateItem|DeleteItem|Scan|Query)"/)
    expect(policies).not.toMatch(/"Action":"\*"|"Resource":"\*"/)
  })
  it('uses only the HTTP API (v2): no REST API, no account-level API Gateway CloudWatch role, HTTP API context variables only', () => {
    const types = Object.values(ingress.toJSON().Resources as Record<string, { Type: string }>).map(resource => resource.Type)
    expect(types.filter(type => type.startsWith('AWS::ApiGateway::'))).toEqual([])
    expect(JSON.stringify(ingress.toJSON())).not.toMatch(/cloudWatchRole|CloudWatchRoleArn|requestOverride/)
  })
  it('names every named resource with the dshsa prefix and passes cdk-nag', () => {
    const resources = ingress.toJSON().Resources as Record<string, { Type: string; Properties?: Record<string, unknown> }>
    const names: Record<string, string> = { 'AWS::Lambda::Function': 'FunctionName', 'AWS::IAM::Role': 'RoleName', 'AWS::Logs::LogGroup': 'LogGroupName',
      'AWS::ApiGatewayV2::Api': 'Name' }
    for (const [id, resource] of Object.entries(resources)) {
      const prop = names[resource.Type]
      if (prop && resource.Properties?.[prop] !== undefined) expect(String(resource.Properties[prop]), id).toMatch(/^(dshsa-|\/dshsa\/)/)
    }
    const errors = annotations.findError('*', Match.stringLikeRegexp('AwsSolutions-.*'))
    expect(errors.map(error => `${error.id}: ${String(error.entry.data).slice(0, 120)}`)).toEqual([])
  })
})
