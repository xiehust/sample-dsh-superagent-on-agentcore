import { createHash, webcrypto } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { Auth, AuthError, challengeOf, randomString, SCOPES } from '../src/auth.ts'
import { createClient } from '../src/api.ts'
import { parseConfig } from '../src/config.ts'

const CONFIG = { clientId: 'client123', domain: 'https://dshsa-1.auth.us-west-2.amazoncognito.com/' }
const ORIGIN = 'https://panel.example.com'
const b64url = (value: string) => Buffer.from(value).toString('base64url')
const jwt = (claims: Record<string, unknown>) => `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify(claims))}.sig`

function memoryStorage() {
  const items = new Map<string, string>()
  return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value) },
    removeItem: (key: string) => { items.delete(key) }, items }
}
function setup({ now = 1_800_000_000_000 } = {}) {
  const storage = memoryStorage()
  const navigate = vi.fn<(url: string) => void>()
  const clock = { now }
  const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const form = new URLSearchParams(String(init?.body))
    const exp = Math.floor(clock.now / 1000) + 3600
    const body = form.get('grant_type') === 'refresh_token'
      ? { id_token: jwt({ email: 'op@example.com', exp, n: 2 }), access_token: 'access-2', expires_in: 3600 }
      : { id_token: jwt({ email: 'op@example.com', exp }), access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 }
    return new Response(JSON.stringify(body), { status: 200 })
  })
  const auth = new Auth(CONFIG, { storage, navigate, fetch: fetch as typeof globalThis.fetch, origin: ORIGIN,
    crypto: webcrypto as unknown as Crypto, now: () => clock.now })
  return { auth, storage, navigate, fetch, clock }
}
async function signIn(context: ReturnType<typeof setup>) {
  await context.auth.login()
  const authorize = new URL(context.navigate.mock.calls[0]![0])
  await context.auth.completeLogin(new URL(`${ORIGIN}/?code=abc&state=${authorize.searchParams.get('state')}`))
  return authorize
}

describe('PKCE helpers', () => {
  it('code_challenge = base64url(sha256(verifier)) (RFC 7636 appendix B)', async () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    expect(await challengeOf(verifier, webcrypto.subtle as SubtleCrypto)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
    const random = randomString(48, webcrypto as unknown as Crypto)
    expect(random).toMatch(/^[A-Za-z0-9_-]{64}$/)
    expect(await challengeOf(random, webcrypto.subtle as SubtleCrypto)).toBe(createHash('sha256').update(random).digest('base64url'))
  })

  it('login redirects to the hosted UI with an S256 challenge of the stored verifier', async () => {
    const { auth, storage, navigate } = setup()
    await auth.login()
    const url = new URL(navigate.mock.calls[0]![0])
    expect(`${url.origin}${url.pathname}`).toBe('https://dshsa-1.auth.us-west-2.amazoncognito.com/oauth2/authorize')
    const pending = JSON.parse(storage.items.get('dshsa.auth.pending')!) as { state: string; verifier: string }
    expect(Object.fromEntries(url.searchParams)).toEqual({ response_type: 'code', client_id: 'client123', redirect_uri: `${ORIGIN}/`,
      scope: SCOPES, state: pending.state, code_challenge: createHash('sha256').update(pending.verifier).digest('base64url'),
      code_challenge_method: 'S256' })
    expect(SCOPES).toBe('openid email profile')
  })
})

describe('callback', () => {
  it('rejects a state mismatch without exchanging the code', async () => {
    const context = setup()
    await context.auth.login()
    await expect(context.auth.completeLogin(new URL(`${ORIGIN}/?code=abc&state=forged`))).rejects.toMatchObject({ code: 'state_mismatch' })
    expect(context.fetch).not.toHaveBeenCalled()
    // The pending login is consumed: replaying the right state later fails too.
    expect(context.storage.items.has('dshsa.auth.pending')).toBe(false)
  })

  it('rejects a callback when this tab never started a login', async () => {
    const { auth, fetch } = setup()
    await expect(auth.completeLogin(new URL(`${ORIGIN}/?code=abc&state=x`))).rejects.toBeInstanceOf(AuthError)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('ignores a URL without a code', async () => {
    expect(await setup().auth.completeLogin(new URL(`${ORIGIN}/`))).toBe(false)
  })

  it('exchanges the code with the verifier and returns the ID token as the bearer', async () => {
    const context = setup()
    await signIn(context)
    const [url, init] = context.fetch.mock.calls[0]!
    expect(String(url)).toBe('https://dshsa-1.auth.us-west-2.amazoncognito.com/oauth2/token')
    const pending = context.navigate.mock.calls[0]![0]
    const form = Object.fromEntries(new URLSearchParams(String(init!.body)))
    expect(form).toMatchObject({ grant_type: 'authorization_code', client_id: 'client123', code: 'abc', redirect_uri: `${ORIGIN}/` })
    expect(createHash('sha256').update(form.code_verifier!).digest('base64url')).toBe(new URL(pending).searchParams.get('code_challenge'))
    const bearer = await context.auth.idToken()
    expect(bearer).toBe(jwt({ email: 'op@example.com', exp: Math.floor(context.clock.now / 1000) + 3600 }))
    expect(context.auth.email()).toBe('op@example.com')
  })
})

describe('refresh and logout', () => {
  it('refreshes the ID token with the refresh token 60 s before its exp, keeping the refresh token', async () => {
    const context = setup()
    await signIn(context)
    context.clock.now += 3600_000 - 59_000
    const [first, second] = await Promise.all([context.auth.idToken(), context.auth.idToken()])
    expect(first).toBe(second)
    expect(context.fetch).toHaveBeenCalledTimes(2)
    const form = Object.fromEntries(new URLSearchParams(String(context.fetch.mock.calls[1]![1]!.body)))
    expect(form).toEqual({ grant_type: 'refresh_token', client_id: 'client123', refresh_token: 'refresh-1' })
    expect(JSON.parse(context.storage.items.get('dshsa.auth.tokens')!).refreshToken).toBe('refresh-1')
    expect(JSON.parse(Buffer.from(first!.split('.')[1]!, 'base64url').toString()).n).toBe(2)
  })

  it('does not refresh a token that is still valid', async () => {
    const context = setup()
    await signIn(context)
    context.clock.now += 3600_000 - 61_000
    await context.auth.idToken()
    expect(context.fetch).toHaveBeenCalledTimes(1)
  })

  it('logout clears storage and redirects to the hosted UI logout', async () => {
    const context = setup()
    await signIn(context)
    context.auth.logout()
    expect(context.storage.items.size).toBe(0)
    const url = new URL(context.navigate.mock.calls.at(-1)![0])
    expect(`${url.origin}${url.pathname}`).toBe('https://dshsa-1.auth.us-west-2.amazoncognito.com/logout')
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: 'client123', logout_uri: `${ORIGIN}/` })
  })
})

describe('client and config', () => {
  it('maps error statuses to typed ApiErrors', async () => {
    const replies = [[503, { error: 'cell_unavailable', message: 'down' }], [409, { error: 'Settings changed elsewhere' }],
      [403, { error: 'forbidden', message: 'Forbidden' }], [401, { message: 'Unauthorized' }]] as const
    let index = 0
    const onUnauthorized = vi.fn()
    const client = createClient({ apiUrl: 'https://api.test', token: async () => 'id', onUnauthorized,
      fetch: async () => { const [status, body] = replies[index++]!; return new Response(JSON.stringify(body), { status }) } })
    const kinds = []
    for (let i = 0; i < replies.length; i++) kinds.push(await client.me().catch(error => [error.status, error.kind]))
    expect(kinds).toEqual([[503, 'offline'], [409, 'conflict'], [403, 'forbidden'], [401, 'unauthorized']])
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it('validates config.json', () => {
    const config = { region: 'us-west-2', userPoolId: 'p', clientId: 'c', domain: 'https://d.example.com/', apiUrl: 'https://a.example.com' }
    expect(parseConfig(config).domain).toBe('https://d.example.com')
    expect(() => parseConfig({ ...config, apiUrl: 'http://evil.example.com' })).toThrow(/https/)
    expect(() => parseConfig({ region: 'x' })).toThrow(/missing/)
  })
})
