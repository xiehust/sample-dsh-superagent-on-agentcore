import { Aspects } from 'aws-cdk-lib'
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions'
import { AwsSolutionsChecks } from 'cdk-nag'
import { beforeAll, describe, expect, it } from 'vitest'
import { ACCOUNT, compose } from '../lib/compose.ts'
import { testApp } from './test-app.ts'

let stacks: Awaited<ReturnType<typeof compose>>
let shared: Template, panel: Template
beforeAll(async () => {
  const app = testApp()
  stacks = await compose(app, { account: ACCOUNT, stubsOnly: true })
  Aspects.of(app).add(new AwsSolutionsChecks())
  app.synth()
  shared = Template.fromStack(stacks.shared)
  panel = Template.fromStack(stacks.panel)
}, 120_000)

/** Physical-name properties that must carry the dshsa prefix (parent design §3). */
const NAME_PROPS: Record<string, string[]> = {
  'AWS::DynamoDB::Table': ['TableName'], 'AWS::S3::Bucket': ['BucketName'], 'AWS::IAM::Role': ['RoleName'],
  'AWS::Lambda::Function': ['FunctionName'], 'AWS::Cognito::UserPool': ['UserPoolName'], 'AWS::Cognito::UserPoolClient': ['ClientName'],
  'AWS::Cognito::UserPoolGroup': ['GroupName'], 'AWS::SecretsManager::Secret': ['Name'], 'AWS::ApiGatewayV2::Api': ['Name'],
  'AWS::EC2::SecurityGroup': ['GroupName'], 'AWS::KMS::Alias': ['AliasName'], 'AWS::Logs::LogGroup': ['LogGroupName'],
}
const flat = (v: unknown): string => typeof v === 'string' ? v : JSON.stringify(v)

describe('dshsa stacks', () => {
  it('names every named resource with the dshsa prefix', () => {
    for (const stack of [stacks.shared, stacks.panel, stacks.workerStack]) {
      const resources = Template.fromStack(stack).toJSON().Resources as Record<string, { Type: string; Properties?: Record<string, unknown> }>
      for (const [id, r] of Object.entries(resources)) {
        for (const prop of NAME_PROPS[r.Type] ?? []) {
          const name = r.Properties?.[prop]
          if (name === undefined) continue
          expect(flat(name), `${stack.stackName}/${id}.${prop}`).toMatch(/^(dshsa[-/]|alias\/dshsa-|\/dshsa\/|\{"Fn::Join":\["",\["dshsa-)/)
        }
      }
      expect(stack.stackName).toMatch(/^dshsa-/)
    }
  })

  it('creates the six tables with PITR and the byTenant indexes', () => {
    shared.resourceCountIs('AWS::DynamoDB::Table', 6)
    shared.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'dshsa-onboarding', KeySchema: [{ AttributeName: 'key', KeyType: 'HASH' }], TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
    })
    shared.hasResourceProperties('AWS::SecretsManager::Secret', { Name: 'dshsa/github-oauth' })
    for (const name of ['dshsa-cells', 'dshsa-routes', 'dshsa-onboarding']) {
      shared.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: name, PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        GlobalSecondaryIndexes: [Match.objectLike({ IndexName: 'byTenant' })],
      })
    }
  })

  it('creates the ES256 ticket-token key', () => {
    shared.hasResourceProperties('AWS::KMS::Key', { KeySpec: 'ECC_NIST_P256', KeyUsage: 'SIGN_VERIFY' })
    shared.hasResourceProperties('AWS::KMS::Alias', { AliasName: 'alias/dshsa-ticket-token' })
  })

  it('keeps every bucket private', () => {
    for (const t of [shared, panel]) {
      const buckets = t.findResources('AWS::S3::Bucket')
      for (const [id, b] of Object.entries(buckets)) {
        expect(b.Properties.PublicAccessBlockConfiguration, id).toEqual({
          BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
        })
      }
    }
  })

  it('gates every panel API route with the Cognito JWT authorizer', () => {
    panel.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', { AuthorizerType: 'JWT' })
    const routes = panel.findResources('AWS::ApiGatewayV2::Route')
    expect(Object.keys(routes).length).toBeGreaterThan(0)
    for (const [id, r] of Object.entries(routes)) expect(r.Properties.AuthorizationType, id).toBe('JWT')
  })

  it('names the panel-api role for host caller auth and keeps no internal shared secret (contracts v3 §4.7)', () => {
    panel.hasResourceProperties('AWS::IAM::Role', { RoleName: 'dshsa-panel-api' })
    expect(JSON.stringify(shared.findResources('AWS::SecretsManager::Secret'))).not.toContain('dshsa/internal-api')
    expect(JSON.stringify(panel.findResources('AWS::Lambda::Function'))).not.toContain('INTERNAL_SECRET')
  })

  it('limits panel-api data-bucket reads to the agent transcript tree (contracts v4 AP layout)', () => {
    const policies = JSON.stringify(panel.findResources('AWS::IAM::Policy'))
    expect(policies).toContain('/tenants/*/*/*/.claude/*')
    expect(policies).not.toContain('cells/*/tickets')
    expect(policies).toContain('"s3:prefix":["tenants/*/*/*/.claude/*","tenants/*/*/*/.codex/sessions/*"]')
    // v7 Codex rollouts only: not .codex/config.toml, installation_id or skills/.
    expect(policies).toContain('/tenants/*/*/*/.codex/sessions/*')
    expect(policies).not.toMatch(/\.codex\/\*/)
  })

  it('routes setup and admin paths to their own Lambdas, all behind the JWT authorizer', () => {
    const routes = Object.values(panel.findResources('AWS::ApiGatewayV2::Route')).map(r => r.Properties as Record<string, unknown>)
    const keys = routes.map(r => String(r.RouteKey))
    for (const path of ['/v1/tenants/{tenantId}/setup', '/v1/tenants/{tenantId}/setup/{proxy+}', '/v1/admin/{proxy+}', '/v1/{proxy+}']) {
      for (const method of ['GET', 'POST', 'PUT', 'DELETE']) expect(keys).toContain(`${method} ${path}`)
    }
    for (const r of routes) expect(r.AuthorizationType, String(r.RouteKey)).toBe('JWT')
    for (const [name, role] of [['dshsa-panel-tenant', 'dshsa-panel-tenant'], ['dshsa-panel-platform', 'dshsa-panel-platform']]) {
      panel.hasResourceProperties('AWS::Lambda::Function', { FunctionName: name, LoggingConfig: Match.objectLike({ LogGroup: Match.anyValue() }) })
      panel.hasResourceProperties('AWS::IAM::Role', { RoleName: role })
    }
    panel.hasResourceProperties('AWS::Logs::LogGroup', { LogGroupName: '/dshsa/panel-admin' })
  })

  it('scopes each setup Lambda to its own actions (design §2)', () => {
    const policyOf = (roleName: string): string => {
      const roles = panel.findResources('AWS::IAM::Role', { Properties: { RoleName: roleName } })
      const roleId = Object.keys(roles)[0]!
      const policies = Object.values(panel.findResources('AWS::IAM::Policy')).filter(p => JSON.stringify(p.Properties.Roles).includes(roleId))
      return JSON.stringify(policies.map(p => p.Properties.PolicyDocument))
    }
    const tenantPolicy = policyOf('dshsa-panel-tenant'), platformPolicy = policyOf('dshsa-panel-platform')
    // panel-tenant: Feishu secrets write-only; OAuth client readable; never the App key, KMS, data bucket or CreateGroup.
    expect(tenantPolicy).toContain('secret:dshsa/feishu/*')
    const statements = (JSON.parse(tenantPolicy) as { Statement: { Action: string | string[]; Resource: unknown }[] }[]).flatMap(d => d.Statement)
    for (const st of statements.filter(st => JSON.stringify(st.Resource).includes('dshsa/feishu'))) {
      expect([st.Action].flat()).not.toContain('secretsmanager:GetSecretValue')
    }
    expect(statements.some(st => [st.Action].flat().includes('secretsmanager:GetSecretValue') && JSON.stringify(st.Resource).includes('GithubOauthSecret'))).toBe(true)
    expect(tenantPolicy).toContain('GithubOauthSecret')
    expect(tenantPolicy).not.toContain('GithubAppSecret')
    expect(tenantPolicy).not.toMatch(/kms:|cognito-idp:CreateGroup|dshsa-data|"dynamodb:\*"|"s3:\*"/)
    expect(tenantPolicy).toContain('connectors/*/kv.json')
    // The tenants UpdateItem is limited to the key + `feishu` and must not read other attributes back (ops.feishuSet).
    const tenantsUpdate = statements.filter(st => [st.Action].flat().includes('dynamodb:UpdateItem') && JSON.stringify(st.Resource).includes('Tenants'))
    expect(tenantsUpdate.length).toBe(1)
    expect((tenantsUpdate[0] as unknown as { Condition: unknown }).Condition).toEqual({
      'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['tenantId', 'feishu'] }, StringEquals: { 'dynamodb:ReturnValues': 'NONE' },
    })
    // Onboarding deletes: the OAuth state consume (`ghstate#`) and unlinking a claim (`ghinst#`, tenant-conditioned in code).
    const onboardingDeletes = statements.filter(st => [st.Action].flat().includes('dynamodb:DeleteItem') && JSON.stringify(st.Resource).includes('Onboarding'))
    expect(onboardingDeletes.map(st => [[st.Action].flat(), (st as unknown as { Condition: unknown }).Condition])).toEqual([
      [['dynamodb:DeleteItem'], { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['ghstate#*'] } }],
      [['dynamodb:DeleteItem'], { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['ghinst#*'] } }],
    ])
    // panel-platform: tenants + GitHub secrets + users; cells read-only (the release in-use check); never routes, queues or Feishu secrets.
    expect(platformPolicy).toContain('GithubAppSecret')
    const platformAll = (JSON.parse(platformPolicy) as { Statement: { Action: string | string[]; Resource: unknown }[] }[]).flatMap(d => d.Statement)
    const cellsStatements = platformAll.filter(st => JSON.stringify(st.Resource).includes('Cells'))
    expect(cellsStatements.map(st => [st.Action].flat())).toEqual([['dynamodb:Query']])
    expect(platformAll.some(st => JSON.stringify(st.Resource).includes('Routes'))).toBe(false)
    expect(platformPolicy).toContain('cognito-idp:CreateGroup')
    expect(platformPolicy).not.toMatch(/sqs:|dshsa\/feishu|kms:|s3:GetObject/)
    // v6.2: platform approves (UpdateItem) and rejects (DeleteItem) claims only; it never writes nonces or new claims.
    const platformStatements = (JSON.parse(platformPolicy) as { Statement: { Action: string | string[]; Resource: unknown; Condition?: unknown }[] }[]).flatMap(d => d.Statement)
      .filter(st => JSON.stringify(st.Resource).includes('Onboarding'))
    const writes = platformStatements.filter(st => [st.Action].flat().some(a => /PutItem|UpdateItem|DeleteItem/.test(a)))
    expect(writes.length).toBe(1)
    expect([writes[0]!.Action].flat().sort()).toEqual(['dynamodb:DeleteItem', 'dynamodb:UpdateItem'])
    expect(writes[0]!.Condition).toEqual({ 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['ghinst#*'] } })
  })

  it('uses authorization code + PKCE only, no client secret', () => {
    panel.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false, AllowedOAuthFlows: ['code'], AllowedOAuthFlowsUserPoolClient: true,
    })
    shared.hasResourceProperties('AWS::Cognito::UserPool', { AdminCreateUserConfig: { AllowAdminCreateUserOnly: true } })
  })

  it('has no unsuppressed cdk-nag errors', () => {
    for (const stack of [stacks.shared, stacks.panel]) {
      const errors = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'))
      expect(errors.map(e => `${e.id}: ${flat(e.entry.data).slice(0, 120)}`)).toEqual([])
    }
  })
})
