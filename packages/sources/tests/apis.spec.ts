import { generateKeyPairSync, createVerify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ApiError, FeishuError } from '@dshsa/core/host'
import { appJwt, FeishuClient, feishuBotInfo, GithubApp, GithubClient } from '../src/apis/index.ts'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' } })
const json = (value: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' }, ...init })

describe('GitHub App', () => {
  it('signs an RS256 app JWT backdated for clock drift', () => {
    const now = Date.parse('2026-11-01T00:00:00Z')
    const [head, body, signature] = appJwt('123', privateKey, now).split('.')
    expect(JSON.parse(Buffer.from(body!, 'base64url').toString())).toEqual({ iat: now / 1000 - 60, exp: now / 1000 + 540, iss: '123' })
    expect(createVerify('RSA-SHA256').update(`${head}.${body}`).verify(publicKey, Buffer.from(signature!, 'base64url'))).toBe(true)
  })
  it('mints a repo-scoped installation token and reuses it until five minutes before expiry', async () => {
    const calls: { url: string; body: unknown }[] = []
    let now = Date.parse('2026-11-01T00:00:00Z')
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) })
      return json({ token: `t${calls.length}`, expires_at: new Date(now + 3600_000).toISOString() })
    }) as typeof fetch
    const app = new GithubApp({ appId: '123', privateKey }, fetcher, () => now)
    expect((await app.token(4242, [812345])).token).toBe('t1')
    expect((await app.token(4242, [812345])).token).toBe('t1')
    now += 56 * 60_000
    expect((await app.token(4242, [812345])).token).toBe('t2')
    expect(calls[0]).toMatchObject({ url: 'https://api.github.com/app/installations/4242/access_tokens', body: { repository_ids: [812345] } })
  })
})

describe('GithubClient', () => {
  it('stays inside its repository, follows pagination there, and throws ApiError with the HTTP status', async () => {
    const urls: string[] = []
    const fetcher = (async (url: string) => {
      urls.push(url)
      if (url.endsWith('/issues/1/comments?per_page=100')) return json([{ id: 1 }], { headers: { link: '<https://api.github.com/repos/acme/widgets/issues/1/comments?page=2>; rel="next"' } })
      if (url.endsWith('page=2')) return json([{ id: 2 }])
      return json({ message: 'Not Found' }, { status: 404 })
    }) as typeof fetch
    const client = new GithubClient('acme/widgets', async () => 'token', fetcher)
    expect(await client.pages(z.object({ id: z.number() }), 'issues/1/comments?per_page=100')).toEqual([{ id: 1 }, { id: 2 }])
    await expect(client.request(z.unknown(), 'issues/9')).rejects.toEqual(new ApiError('Not Found (HTTP 404)', 404))
    await expect(client.request(z.unknown(), '../../orgs/acme')).rejects.toThrow('restricted')
    await expect(client.request(z.unknown(), '/user')).rejects.toThrow('restricted')
    expect(urls.every(url => url.startsWith('https://api.github.com/repos/acme/widgets/'))).toBe(true)
  })
  it('returns a 304 instead of throwing, for ETag polling', async () => {
    const client = new GithubClient('acme/widgets', async () => 'token', (async () => new Response(null, { status: 304, headers: { etag: '"x"' } })) as never)
    expect(await client.raw('issues?state=all', { headers: { 'if-none-match': '"x"' } })).toMatchObject({ status: 304 })
  })
})

describe('FeishuClient', () => {
  it('uses the tenant token, retries once on a stale token, and reads payloads beside `data`', async () => {
    let tokens = 0, stale = true
    const fetcher = (async (url: string, init: RequestInit) => {
      if (url.endsWith('/tenant_access_token/internal')) { tokens++; return json({ code: 0, tenant_access_token: `tok${tokens}`, expire: 7200 }) }
      if (url.includes('/bot/v3/info')) return json({ code: 0, msg: 'ok', bot: { open_id: 'ou_bot', app_name: 'Agent' } })
      if (stale) { stale = false; return json({ code: 99991663, msg: 'token invalid' }) }
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok2')
      return json({ code: 0, data: { items: [] } })
    }) as typeof fetch
    const client = new FeishuClient({ domain: 'lark', appId: 'cli_app', appSecret: 's' }, fetcher)
    expect(client.base).toBe('https://open.larksuite.com')
    expect(await client.request(z.object({ items: z.array(z.unknown()) }), 'GET', '/open-apis/im/v1/messages', { params: { container_id: 'oc_1' } })).toEqual({ items: [] })
    expect(await feishuBotInfo(client)).toEqual({ openId: 'ou_bot', name: 'Agent' })
    expect(tokens).toBe(2)
  })
  it('accepts null where Feishu has no value: msg, data, an app name', async () => {
    const fetcher = (async (url: string) => url.endsWith('/internal') ? json({ code: 0, msg: null, tenant_access_token: 't', expire: null })
      : url.includes('/bot/v3/info') ? json({ code: 0, msg: null, data: null, bot: { open_id: 'ou_bot', app_name: null } })
      : json({ code: 0, msg: null, data: { items: [] } })) as typeof fetch
    const client = new FeishuClient({ domain: 'feishu', appId: 'cli_app', appSecret: 's' }, fetcher)
    expect(await client.request(z.object({ items: z.array(z.unknown()) }), 'GET', '/open-apis/im/v1/chats')).toEqual({ items: [] })
    expect(await feishuBotInfo(client)).toEqual({ openId: 'ou_bot', name: '' })
  })
  it('throws FeishuError with Feishu\'s code and explains a bot missing from the chat', async () => {
    const fetcher = (async (url: string) => url.endsWith('/internal') ? json({ code: 0, tenant_access_token: 't', expire: 7200 })
      : json({ code: 232011, msg: 'bot not in chat' })) as typeof fetch
    const client = new FeishuClient({ domain: 'feishu', appId: 'cli_app', appSecret: 's' }, fetcher)
    const error = await client.request(z.unknown(), 'POST', '/open-apis/im/v1/messages/om_1/reply', { data: {} }).catch((value: unknown) => value) as FeishuError
    expect(error).toBeInstanceOf(FeishuError)
    expect([error.code, error.message]).toEqual([232011, expect.stringContaining('Add the bot')])
    await expect(client.request(z.unknown(), 'GET', '/other')).rejects.toThrow('restricted')
  })
})
