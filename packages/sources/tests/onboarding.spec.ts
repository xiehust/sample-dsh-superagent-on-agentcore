import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { FeishuApi } from '@dshsa/core/host'
import { GithubOAuthError, GithubUserToken, githubUserLogin, oauthExchange, orgMembership, revokeUserToken, userInstallations } from '../src/apis/index.ts'
import { chatMembers } from '../src/index.ts'

const json = (value: unknown, init: ResponseInit & { link?: string } = {}) => new Response(JSON.stringify(value), {
  status: init.status ?? 200, headers: { 'content-type': 'application/json', ...init.link ? { link: init.link } : {} } })
interface Sent { url: string; init: RequestInit }
const fake = (answer: (url: string, init: RequestInit) => Response | Promise<Response>) => {
  const sent: Sent[] = []
  const fetcher = (async (url: string, init: RequestInit) => { sent.push({ url, init }); return answer(url, init) }) as typeof fetch
  return { sent, fetcher }
}
const client = { clientId: 'Iv1.client', clientSecret: 'client-secret-value', code: 'code-123', redirectUri: 'https://panel.example/setup/github/callback' }
const SECRET_TOKEN = 'ghu_SECRETtoken0123456789'

describe('oauthExchange', () => {
  it('posts the code with Accept: application/json and returns a token that never prints', async () => {
    const { sent, fetcher } = fake(() => json({ access_token: SECRET_TOKEN, token_type: 'bearer', expires_in: 28800, refresh_token: 'ghr_x' }))
    const token = await oauthExchange(client, fetcher, () => Date.parse('2026-11-01T00:00:00Z'))
    expect(sent).toHaveLength(1)
    expect(sent[0]!.url).toBe('https://github.com/login/oauth/access_token')
    expect(sent[0]!.init.method).toBe('POST')
    expect((sent[0]!.init.headers as Record<string, string>).accept).toBe('application/json')
    expect(JSON.parse(String(sent[0]!.init.body))).toEqual({ client_id: 'Iv1.client', client_secret: 'client-secret-value', code: 'code-123',
      redirect_uri: 'https://panel.example/setup/github/callback' })
    expect(token.reveal()).toBe(SECRET_TOKEN)
    expect(token.expiresAt).toBe('2026-11-01T08:00:00.000Z')
    for (const shown of [String(token), `${token}`, JSON.stringify({ token }), inspect(token), inspect({ token })]) expect(shown).not.toContain(SECRET_TOKEN)
  })
  it('reports an expired, used or wrong code (GitHub answers 200 with an error) as expiredCode', async () => {
    const { fetcher } = fake(() => json({ error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' }))
    const failure = await oauthExchange(client, fetcher).catch((error: unknown) => error) as GithubOAuthError
    expect(failure).toBeInstanceOf(GithubOAuthError)
    expect([failure.code, failure.expiredCode]).toEqual(['bad_verification_code', true])
    expect(failure.message).toContain('incorrect or expired')
  })
  it('surfaces other OAuth errors, HTTP failures, non-JSON answers and timeouts without leaking the client secret', async () => {
    const cases: [() => Response | Promise<Response>, string][] = [
      [() => json({ error: 'redirect_uri_mismatch' }), 'redirect_uri_mismatch'],
      [() => json({ error: 'incorrect_client_credentials' }), 'incorrect_client_credentials'],
      [() => json({ message: 'Server Error' }, { status: 502 }), 'http_502'],
      [() => new Response('<html>oops</html>', { status: 200 }), 'bad_response'],
      [() => json({ token_type: 'bearer' }), 'bad_response'],
      [() => Promise.reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })), 'timeout'],
    ]
    for (const [answer, code] of cases) {
      const failure = await oauthExchange(client, fake(answer).fetcher).catch((error: unknown) => error) as GithubOAuthError
      expect(failure, code).toBeInstanceOf(GithubOAuthError)
      expect(failure.code).toBe(code)
      expect(failure.expiredCode).toBe(false)
      expect(failure.message).not.toContain('client-secret-value')
    }
    await expect(oauthExchange({ ...client, code: '' }, fake(() => json({})).fetcher)).rejects.toMatchObject({ code: 'bad_request' })
  })
})

describe('userInstallations', () => {
  const token = new GithubUserToken(SECRET_TOKEN)
  const installation = (id: number, appId: number, login: string, type = 'Organization') => ({ id, app_id: appId, account: { login, type } })
  it('reads every page with the user token and keeps only our App\'s installations', async () => {
    const { sent, fetcher } = fake(url => url.includes('page=2')
      ? json({ total_count: 3, installations: [installation(30, 42, 'acme-labs'), installation(10, 42, 'acme')] })
      : json({ total_count: 3, installations: [installation(10, 42, 'acme'), installation(20, 7, 'other-app-org'), installation(11, 42, 'alice', 'User')] },
        { link: '<https://api.github.com/user/installations?per_page=100&page=2>; rel="next", <https://api.github.com/user/installations?per_page=100&page=2>; rel="last"' }))
    expect(await userInstallations(token, '42', fetcher)).toEqual([
      { id: 10, account: { login: 'acme', type: 'Organization' } }, { id: 11, account: { login: 'alice', type: 'User' } },
      { id: 30, account: { login: 'acme-labs', type: 'Organization' } }])
    expect(sent.map(item => item.url)).toEqual(['https://api.github.com/user/installations?per_page=100', 'https://api.github.com/user/installations?per_page=100&page=2'])
    for (const { init } of sent) expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${SECRET_TOKEN}`)
  })
  it('accepts null fields and an empty account list', async () => {
    const { fetcher } = fake(() => json({ total_count: 0, installations: null }))
    expect(await userInstallations(token, 42, fetcher)).toEqual([])
    const nulls = fake(() => json({ installations: [{ id: 5, app_id: 42, account: { login: 'bob', type: null } }, { id: 6, app_id: 42, account: null }] }))
    expect(await userInstallations(token, 42, nulls.fetcher)).toEqual([{ id: 5, account: { login: 'bob', type: 'User' } }])
  })
  it('fails on an expired or revoked token, a bad App id, and pagination that leaves /user/installations', async () => {
    await expect(userInstallations(token, 42, fake(() => json({ message: 'Bad credentials' }, { status: 401 })).fetcher))
      .rejects.toMatchObject({ code: 'bad_credentials', status: 401 })
    await expect(userInstallations(token, 'not-a-number', fake(() => json({})).fetcher)).rejects.toMatchObject({ code: 'bad_request' })
    const away = fake(() => json({ installations: [] }, { link: '<https://evil.example/user/installations?page=2>; rel="next"' }))
    await expect(userInstallations(token, 42, away.fetcher)).rejects.toMatchObject({ code: 'bad_response' })
    expect(away.sent).toHaveLength(1)
    const failure = await userInstallations(token, 42, fake(() => json({ message: 'Bad credentials' }, { status: 401 })).fetcher).catch((error: unknown) => error) as Error
    expect(failure.message).not.toContain(SECRET_TOKEN)
  })
  it('revokes the token with the client credentials, and never throws', async () => {
    const { sent, fetcher } = fake(() => new Response(null, { status: 204 }))
    expect(await revokeUserToken(token, client, fetcher)).toBe(true)
    expect(sent[0]!.url).toBe('https://api.github.com/applications/Iv1.client/token')
    expect(sent[0]!.init.method).toBe('DELETE')
    expect(JSON.parse(String(sent[0]!.init.body))).toEqual({ access_token: SECRET_TOKEN })
    expect(await revokeUserToken(token, client, fake(() => Promise.reject(new Error('down'))).fetcher)).toBe(false)
  })
})

describe('githubUserLogin and orgMembership (who may claim, design §3 step 4a)', () => {
  const token = new GithubUserToken(SECRET_TOKEN)
  const header = (sent: Sent[]) => (sent[0]!.init.headers as Record<string, string>).authorization
  it('reads the user behind the token', async () => {
    const { sent, fetcher } = fake(() => json({ login: 'Alice', id: 101, type: 'User', email: null }))
    expect(await githubUserLogin(token, fetcher)).toEqual({ login: 'Alice', id: 101 })
    expect(sent[0]!.url).toBe('https://api.github.com/user')
    expect(header(sent)).toBe(`Bearer ${SECRET_TOKEN}`)
    await expect(githubUserLogin(token, fake(() => json({ message: 'Bad credentials' }, { status: 401 })).fetcher)).rejects.toMatchObject({ code: 'bad_credentials' })
    await expect(githubUserLogin(token, fake(() => json({ id: 1 })).fetcher)).rejects.toMatchObject({ code: 'bad_response' })
  })
  it('returns the org membership, reading only active admin as admin', async () => {
    const { sent, fetcher } = fake(() => json({ state: 'active', role: 'admin', organization: { login: 'acme' }, user: { login: 'alice' } }))
    expect(await orgMembership(token, 'Acme', fetcher)).toEqual({ state: 'active', role: 'admin' })
    expect(sent[0]!.url).toBe('https://api.github.com/user/memberships/orgs/Acme')
    expect(header(sent)).toBe(`Bearer ${SECRET_TOKEN}`)
    const answers: [unknown, unknown][] = [
      [{ state: 'pending', role: 'admin', organization: { login: 'acme' } }, { state: 'pending', role: 'admin' }],
      [{ state: 'active', role: 'member', organization: { login: 'acme' } }, { state: 'active', role: 'member' }],
      [{ state: 'active', role: 'billing_manager', organization: { login: 'acme' } }, { state: 'active', role: 'member' }],
      [{ state: null, role: null, organization: null }, { state: 'pending', role: 'member' }],
    ]
    for (const [body, want] of answers) expect(await orgMembership(token, 'acme', fake(() => json(body)).fetcher)).toEqual(want)
  })
  it('is undefined for 404 (not a member) and 403 (no Members: read), and throws on anything else', async () => {
    expect(await orgMembership(token, 'acme', fake(() => json({ message: 'Not Found' }, { status: 404 })).fetcher)).toBeUndefined()
    expect(await orgMembership(token, 'acme', fake(() => json({ message: 'Resource not accessible by integration' }, { status: 403 })).fetcher)).toBeUndefined()
    await expect(orgMembership(token, 'acme', fake(() => json({}, { status: 401 })).fetcher)).rejects.toMatchObject({ code: 'bad_credentials' })
    await expect(orgMembership(token, 'acme', fake(() => json({}, { status: 500 })).fetcher)).rejects.toMatchObject({ code: 'http_500' })
    await expect(orgMembership(token, 'acme', fake(() => new Response('nope')).fetcher)).rejects.toMatchObject({ code: 'bad_response' })
    await expect(orgMembership(token, 'acme', fake(() => json({ state: 'active', role: 'admin', organization: { login: 'evil' } })).fetcher))
      .rejects.toMatchObject({ code: 'bad_response' })
    const timeout = fake(() => Promise.reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })))
    await expect(orgMembership(token, 'acme', timeout.fetcher)).rejects.toMatchObject({ code: 'timeout' })
  })
  it('refuses an org that is not a GitHub login before calling GitHub, and keeps the token out of every message', async () => {
    for (const org of ['', '../user', 'acme/x', '-acme', 'a--b', 'x'.repeat(40)]) {
      const { sent, fetcher } = fake(() => json({}))
      await expect(orgMembership(token, org, fetcher), org).rejects.toMatchObject({ code: 'bad_request' })
      expect(sent).toHaveLength(0)
    }
    for (const status of [401, 500]) {
      const failure = await orgMembership(token, 'acme', fake(() => json({ message: SECRET_TOKEN }, { status })).fetcher).catch((error: unknown) => error) as Error
      expect(failure.message).not.toContain(SECRET_TOKEN)
      const user = await githubUserLogin(token, fake(() => json({ message: SECRET_TOKEN }, { status })).fetcher).catch((error: unknown) => error) as Error
      expect(user.message).not.toContain(SECRET_TOKEN)
    }
  })
})

describe('chatMembers', () => {
  const api = (pages: Record<string, unknown>[]) => {
    const calls: { path: string; params: Record<string, string> }[] = []
    const feishu: FeishuApi = { request: async <T,>(schema: z.ZodType<T>, _method: string, path: string, init?: { params?: Record<string, string> }) => {
      calls.push({ path, params: init?.params ?? {} })
      return schema.parse(pages[calls.length - 1])
    } } as FeishuApi
    return { feishu, calls }
  }
  it('lists every page as open_id entries, tolerating nulls and dropping duplicates', async () => {
    const { feishu, calls } = api([
      { items: [{ member_id: 'ou_alice', member_id_type: 'open_id', name: 'Alice', tenant_key: null }, { member_id: 'ou_bob', name: null }], has_more: true, page_token: 'p2' },
      { items: [{ member_id: 'ou_carol', name: 'Carol' }, { member_id: 'ou_alice', name: 'Alice' }], has_more: null, page_token: null },
    ])
    expect(await chatMembers(feishu, 'oc_team')).toEqual([{ id: 'ou_alice', name: 'Alice' }, { id: 'ou_bob', name: '' }, { id: 'ou_carol', name: 'Carol' }])
    expect(calls).toEqual([
      { path: '/open-apis/im/v1/chats/oc_team/members', params: { page_size: '100', member_id_type: 'open_id' } },
      { path: '/open-apis/im/v1/chats/oc_team/members', params: { page_size: '100', member_id_type: 'open_id', page_token: 'p2' } },
    ])
  })
  it('refuses anything but an oc_ chat id, and pagination that does not advance', async () => {
    await expect(chatMembers(api([]).feishu, '../chats')).rejects.toThrow()
    const stuck = api([{ items: [], has_more: true, page_token: 'same' }, { items: [], has_more: true, page_token: 'same' }])
    await expect(chatMembers(stuck.feishu, 'oc_team')).rejects.toThrow('did not advance')
    expect(await chatMembers(api([{ items: null, has_more: false }]).feishu, 'oc_empty')).toEqual([])
  })
})
