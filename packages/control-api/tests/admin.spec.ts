import { createVerify, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import * as ops from '../src/admin/ops.ts'

type Sent = { name: string; input: Record<string, any> }
/** One fake for every AWS client: records commands and answers from a per-command responder. */
function clients(respond: Partial<Record<string, (input: any) => unknown>> = {}) {
  const sent: Sent[] = []
  const client = { send: async (cmd: { constructor: { name: string }; input: Record<string, any> }) => {
    const name = cmd.constructor.name
    sent.push({ name, input: cmd.input })
    const r = respond[name]
    return r ? r(cmd.input) : {}
  } }
  const c = { db: client, sqs: client, secrets: client, cognito: client, userPoolId: 'pool-1',
    now: () => new Date('2026-11-01T00:00:00Z'), log: () => {} } as unknown as ops.AdminClients
  return { c, sent, names: () => sent.map(s => s.name) }
}
const acme = { tenantId: 'acme', name: 'Acme', cognitoGroup: 'dshsa-tenant-acme', status: 'active', createdAt: '2026-11-01T00:00:00Z' }

describe('dshsa-admin ops', () => {
  it('tenant add creates the group and a conditional tenant record', async () => {
    const { c, sent } = clients()
    const t = await ops.tenantAdd(c, 'acme', 'Acme')
    expect(t.cognitoGroup).toBe('dshsa-tenant-acme')
    expect(sent[0]).toMatchObject({ name: 'CreateGroupCommand', input: { GroupName: 'dshsa-tenant-acme', UserPoolId: 'pool-1' } })
    expect(sent[1]).toMatchObject({ name: 'CreateGroupCommand', input: { GroupName: 'dshsa-tadmin-acme' } })
    expect(sent[2]).toMatchObject({ name: 'PutCommand', input: { TableName: 'dshsa-tenants', ConditionExpression: 'attribute_not_exists(tenantId)' } })
    await expect(ops.tenantAdd(c, 'Bad_Id', 'x')).rejects.toThrow()
    for (const reserved of ['admin', 'tadmin', 'platform']) await expect(ops.tenantAdd(c, reserved, 'x')).rejects.toThrow(/reserved/)
  })

  it('cell add creates DLQ + FIFO queue with redrive, then the cell and its GitHub route in one transaction', async () => {
    const { c, sent, names } = clients({
      GetCommand: (i: any) => ({ Item: i.TableName === 'dshsa-tenants' ? acme : undefined }),
      CreateQueueCommand: (i: any) => ({ QueueUrl: `https://sqs.us-west-2.amazonaws.com/123456789012/${i.QueueName}` }),
      GetQueueAttributesCommand: () => ({ Attributes: { QueueArn: 'arn:aws:sqs:us-west-2:123456789012:dshsa-cell-acme--gh42-dlq.fifo' } }),
    })
    const cell = await ops.cellAdd(c, { tenantId: 'acme', repo: 'acme/web', repoId: 42, installationId: 7 })
    expect(cell.cellId).toBe('acme--gh42')
    expect(names()).toEqual(['GetCommand', 'GetCommand', 'CreateQueueCommand', 'GetQueueAttributesCommand', 'CreateQueueCommand', 'TransactWriteCommand'])
    const queue = sent[4]!.input
    expect(queue.QueueName).toBe('dshsa-cell-acme--gh42.fifo')
    expect(queue.Attributes.FifoQueue).toBe('true')
    expect(JSON.parse(queue.Attributes.RedrivePolicy).maxReceiveCount).toBe(5)
    const [cellPut, routePut] = sent[5]!.input.TransactItems
    expect(cellPut.Put).toMatchObject({ TableName: 'dshsa-cells', ConditionExpression: 'attribute_not_exists(cellId)' })
    expect(routePut.Put.Item).toMatchObject({ routeKey: 'gh#7#42', cellId: 'acme--gh42', tenantId: 'acme' })
    expect(routePut.Put.ConditionExpression).toBe('attribute_not_exists(routeKey) OR cellId = :c')
    await expect(ops.cellAdd(c, { tenantId: 'acme', repo: 'nope', repoId: 1, installationId: 1 })).rejects.toThrow(/owner\/name/)
  })

  it('cell add refuses to steal a GitHub route bound to another cell, before creating any queue', async () => {
    const { c, names } = clients({
      GetCommand: (i: any) => ({ Item: i.TableName === 'dshsa-tenants' ? acme : { routeKey: 'gh#7#42', cellId: 'beta--gh42' } }),
    })
    await expect(ops.cellAdd(c, { tenantId: 'acme', repo: 'acme/web', repoId: 42, installationId: 7 })).rejects.toThrow(/already bound to cell beta--gh42/)
    expect(names()).not.toContain('CreateQueueCommand')
  })

  it('cell add maps a cancelled transaction to the failing condition', async () => {
    const cancelled = (codes: string[]) => () => {
      throw Object.assign(new Error('cancelled'), { name: 'TransactionCanceledException', CancellationReasons: codes.map(Code => ({ Code })) })
    }
    const base = {
      GetCommand: (i: any) => ({ Item: i.TableName === 'dshsa-tenants' ? acme : undefined }),
      CreateQueueCommand: (i: any) => ({ QueueUrl: `https://sqs.us-west-2.amazonaws.com/1/${i.QueueName}` }),
      GetQueueAttributesCommand: () => ({ Attributes: { QueueArn: 'arn:aws:sqs:us-west-2:1:dlq' } }),
    }
    const input = { tenantId: 'acme', repo: 'acme/web', repoId: 42, installationId: 7 }
    await expect(ops.cellAdd(clients({ ...base, TransactWriteCommand: cancelled(['ConditionalCheckFailed', 'None']) }).c, input)).rejects.toThrow(/already exists/)
    await expect(ops.cellAdd(clients({ ...base, TransactWriteCommand: cancelled(['None', 'ConditionalCheckFailed']) }).c, input)).rejects.toThrow(/already bound/)
  })

  it('tenant add refuses ids that would make cell ids ambiguous', async () => {
    const { c, names } = clients()
    await expect(ops.tenantAdd(c, 'acme--gh1', 'x')).rejects.toThrow(/must not contain/)
    await expect(ops.tenantAdd(c, 'acme-', 'x')).rejects.toThrow(/must not contain/)
    expect(names()).toEqual([])
  })

  it('cell add refuses an unknown tenant', async () => {
    const { c } = clients({ GetCommand: () => ({}) })
    await expect(ops.cellAdd(c, { tenantId: 'acme', repo: 'a/b', repoId: 1, installationId: 1 })).rejects.toThrow(/no tenant/)
  })

  it('feishu set updates an existing secret and records it on the tenant', async () => {
    const { c, sent } = clients({
      GetCommand: () => ({ Item: acme }),
      CreateSecretCommand: () => { throw Object.assign(new Error('exists'), { name: 'ResourceExistsException' }) },
      PutSecretValueCommand: () => ({ ARN: 'arn:aws:secretsmanager:us-west-2:1:secret:dshsa/feishu/acme-x' }),
    })
    await ops.feishuSet(c, { tenantId: 'acme', domain: 'lark', appId: 'cli_1', appSecret: 's' })
    expect(sent.find(s => s.name === 'CreateSecretCommand')!.input.Name).toBe('dshsa/feishu/acme')
    expect(sent.at(-1)!.input.ExpressionAttributeValues[':f']).toEqual({ domain: 'lark', appId: 'cli_1', secretArn: 'arn:aws:secretsmanager:us-west-2:1:secret:dshsa/feishu/acme-x', revision: '2026-11-01T00:00:00.000Z' })
    await expect(ops.feishuSet(c, { tenantId: 'acme', domain: 'slack', appId: 'a', appSecret: 's' })).rejects.toThrow()
  })

  it('chat bind refuses a cell of another tenant', async () => {
    const { c } = clients({ GetCommand: (i: any) => ({ Item: i.TableName === 'dshsa-tenants' ? acme : { cellId: 'beta--gh1', tenantId: 'beta' } }) })
    await expect(ops.chatBind(c, 'acme', 'oc_1', 'beta--gh1')).rejects.toThrow(/not a cell of acme/)
  })

  it('user add creates a missing user and adds the tenant group', async () => {
    const { c, names, sent } = clients({
      GetCommand: () => ({ Item: acme }),
      AdminGetUserCommand: () => { throw Object.assign(new Error('nf'), { name: 'UserNotFoundException' }) },
    })
    await ops.userAddToTenant(c, 'a@example.com', 'acme')
    expect(names()).toEqual(['GetCommand', 'AdminGetUserCommand', 'AdminCreateUserCommand', 'AdminAddUserToGroupCommand', 'AdminRemoveUserFromGroupCommand'])
    expect(sent[3]!.input.GroupName).toBe('dshsa-tenant-acme')
    // Inviting as member makes the role exactly member: any tenant-admin membership is removed.
    expect(sent[4]!.input.GroupName).toBe('dshsa-tadmin-acme')
  })

  it('user invite as tenant admin adds both groups; remove takes the user out of both', async () => {
    const { c, sent, names } = clients({ GetCommand: () => ({ Item: acme }) })
    await ops.userInvite(c, 'b@example.com', 'acme', 'tadmin', { ensureGroups: true })
    expect(names()).toEqual(['GetCommand', 'CreateGroupCommand', 'AdminGetUserCommand', 'AdminAddUserToGroupCommand', 'AdminAddUserToGroupCommand'])
    expect(sent.filter(s => s.name === 'AdminAddUserToGroupCommand').map(s => s.input.GroupName)).toEqual(['dshsa-tenant-acme', 'dshsa-tadmin-acme'])
    sent.length = 0
    await ops.userRemove(c, 'b@example.com', 'acme')
    expect(sent.filter(s => s.name === 'AdminRemoveUserFromGroupCommand').map(s => s.input.GroupName)).toEqual(['dshsa-tenant-acme', 'dshsa-tadmin-acme'])
    await expect(ops.userInvite(c, 'not-an-email', 'acme', 'member')).rejects.toThrow(/invalid email/)
  })

  it('tenant users lists members once, marking tenant admins', async () => {
    const user = (name: string) => ({ Username: name, UserStatus: 'CONFIRMED', Enabled: true, Attributes: [{ Name: 'email', Value: `${name}@x.io` }] })
    const { c } = clients({
      GetCommand: () => ({ Item: acme }),
      ListUsersInGroupCommand: (i: any) => ({ Users: i.GroupName === 'dshsa-tadmin-acme' ? [user('b')] : [user('a'), user('b')] }),
    })
    expect((await ops.tenantUsers(c, 'acme')).map(u => [u.email, u.role])).toEqual([['a@x.io', 'member'], ['b@x.io', 'tadmin']])
  })

  it('chat unbind only deletes a route of the same tenant', async () => {
    const { c, sent } = clients({ DeleteCommand: () => { throw Object.assign(new Error('c'), { name: 'ConditionalCheckFailedException' }) } })
    expect(await ops.chatUnbind(c, 'acme', 'oc_1')).toBe(false)
    expect(sent[0]!.input).toMatchObject({ Key: { routeKey: 'fs#acme#oc_1' }, ConditionExpression: 'tenantId = :t', ExpressionAttributeValues: { ':t': 'acme' } })
  })

  describe('github app-set', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    /** A fake GitHub `GET /app` that verifies the App JWT signature and issuer like GitHub does. */
    const github = (app: { id: number; slug: string }) => {
      const calls: string[] = []
      const fetch = (async (url: string, init?: RequestInit) => {
        calls.push(url)
        const jwt = String((init?.headers as Record<string, string>).authorization).replace(/^Bearer /, '')
        const [head, body, sig] = jwt.split('.')
        const ok = createVerify('RSA-SHA256').update(`${head}.${body}`).verify(publicKey, Buffer.from(sig!, 'base64url'))
          && JSON.parse(Buffer.from(body!, 'base64url').toString()).iss === String(app.id)
        return new Response(ok ? JSON.stringify({ id: app.id, slug: app.slug, name: 'DSHSA Agent' }) : '{"message":"A JSON web token could not be decoded"}',
          { status: ok ? 200 : 401 })
      }) as typeof globalThis.fetch
      return { fetch, calls }
    }
    const withSecret = (fetch: typeof globalThis.fetch) => {
      const lines: string[] = []
      const k = clients({ GetSecretValueCommand: () => ({ SecretString: JSON.stringify({ webhookSecret: 'w'.repeat(32) }) }) })
      Object.assign(k.c, { fetch, log: (l: string) => lines.push(l) })
      return { ...k, lines }
    }

    it('takes the slug from GitHub when --slug is omitted, and says the host must restart', async () => {
      const gh = github({ id: 123, slug: 'dshsa-agent' })
      const { c, sent, lines } = withSecret(gh.fetch)
      expect(await ops.githubAppSet(c, { appId: '123', privateKey: pem })).toEqual({ slug: 'dshsa-agent' })
      expect(gh.calls).toEqual(['https://api.github.com/app'])
      const put = sent.find(s => s.name === 'PutSecretValueCommand')!.input
      expect(put.SecretId).toBe('dshsa/github-app')
      expect(JSON.parse(put.SecretString)).toMatchObject({ appId: '123', slug: 'dshsa-agent', webhookSecret: 'w'.repeat(32) })
      expect(lines.join('\n')).toMatch(/restart the host/)
      // A matching --slug (with or without @) is accepted.
      await expect(ops.githubAppSet(c, { appId: '123', slug: '@dshsa-agent', privateKey: pem })).resolves.toEqual({ slug: 'dshsa-agent' })
    })

    it('refuses a --slug that differs from the App, naming the Client ID mistake, and writes nothing', async () => {
      const { c, names } = withSecret(github({ id: 123, slug: 'dshsa-agent' }).fetch)
      await expect(ops.githubAppSet(c, { appId: '123', slug: 'Iv23liAbCdEf', privateKey: pem }))
        .rejects.toThrow(/slug is dshsa-agent, not Iv23liAbCdEf \(it looks like the Client ID\)/)
      await expect(ops.githubAppSet(c, { appId: '123', slug: 'other-app', privateKey: pem })).rejects.toThrow(/slug is dshsa-agent, not other-app;/)
      expect(names()).not.toContain('PutSecretValueCommand')
    })

    /** Fake Secrets Manager keyed by SecretId; a missing id throws ResourceNotFoundException like the real one. */
    const secretStore = (fetch: typeof globalThis.fetch, initial: Record<string, unknown>) => {
      const store = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]))
      const notFound = () => { throw Object.assign(new Error('nf'), { name: 'ResourceNotFoundException' }) }
      const lines: string[] = []
      const k = clients({
        GetSecretValueCommand: (i: any) => store.has(i.SecretId) ? { SecretString: store.get(i.SecretId) } : notFound(),
        PutSecretValueCommand: (i: any) => { if (!store.has(i.SecretId)) notFound(); store.set(i.SecretId, i.SecretString); return {} },
      })
      Object.assign(k.c, { fetch, log: (l: string) => lines.push(l) })
      return { ...k, store, lines }
    }

    it('mirrors the App id and slug into dshsa/github-oauth, keeping the OAuth client', async () => {
      const gh = github({ id: 123, slug: 'dshsa-agent' })
      const { c, store } = secretStore(gh.fetch, {
        'dshsa/github-app': { webhookSecret: 'w'.repeat(32) }, 'dshsa/github-oauth': { clientId: 'Iv23liClient', clientSecret: 'c'.repeat(40), placeholder: 'x' },
      })
      await ops.githubAppSet(c, { appId: '123', privateKey: pem })
      expect(JSON.parse(store.get('dshsa/github-oauth')!)).toEqual({ clientId: 'Iv23liClient', clientSecret: 'c'.repeat(40), appId: '123', slug: 'dshsa-agent' })
      expect(await ops.githubOauth(c)).toMatchObject({ clientId: 'Iv23liClient', appId: '123', slug: 'dshsa-agent' })
      // The status names the App and the client id, never a secret value.
      const status = JSON.stringify(await ops.githubAppStatus(c))
      expect(status).toContain('dshsa-agent')
      expect(status).not.toMatch(/PRIVATE KEY|cccccccccc|wwwwwwwwww/)
    })

    it('keeps the CLI working when dshsa/github-oauth does not exist yet (dshsa-shared older than v6)', async () => {
      const { c, store, lines } = secretStore(github({ id: 123, slug: 'dshsa-agent' }).fetch, { 'dshsa/github-app': { webhookSecret: 'w'.repeat(32) } })
      await expect(ops.githubAppSet(c, { appId: '123', privateKey: pem })).resolves.toEqual({ slug: 'dshsa-agent' })
      expect(JSON.parse(store.get('dshsa/github-app')!)).toMatchObject({ appId: '123', slug: 'dshsa-agent' })
      expect(lines.join('\n')).toMatch(/dshsa\/github-oauth does not exist yet/)
      expect(await ops.githubOauth(c)).toBeUndefined()
    })

    it('oauth-set validates the client id and secret before writing, and keeps omitted fields', async () => {
      const { c, store, names } = secretStore(github({ id: 1, slug: 's' }).fetch, { 'dshsa/github-oauth': { clientId: 'Iv23liClient', clientSecret: 'c'.repeat(40) } })
      await expect(ops.githubOauthSet(c, { clientSecret: 'too-short' })).rejects.toThrow(/40 hex/)
      await expect(ops.githubOauthSet(c, { clientId: '12345' })).rejects.toThrow(/Iv23li/)
      expect(names()).not.toContain('PutSecretValueCommand')
      await ops.githubOauthSet(c, { clientSecret: 'd'.repeat(40) })
      expect(JSON.parse(store.get('dshsa/github-oauth')!)).toEqual({ clientId: 'Iv23liClient', clientSecret: 'd'.repeat(40) })
    })

    it('refuses credentials GitHub rejects (wrong App ID for the key, or a key that cannot sign)', async () => {
      const { c, names } = withSecret(github({ id: 999, slug: 'dshsa-agent' }).fetch)
      await expect(ops.githubAppSet(c, { appId: '123', privateKey: pem })).rejects.toThrow(/GitHub rejected the App credentials \(GET \/app → HTTP 401\)/)
      await expect(ops.githubAppSet(c, { appId: '123', privateKey: '-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----' }))
        .rejects.toThrow(/could not sign an App JWT/)
      expect(names()).not.toContain('PutSecretValueCommand')
    })
  })
})
