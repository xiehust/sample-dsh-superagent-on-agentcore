import type { CellRecord, InstallationClaim, SetupState, TenantRecord } from '@dshsa/contracts'
import { GithubOAuthError, GithubUserToken } from '@dshsa/sources/apis'
import { describe, expect, it, vi } from 'vitest'
import { PLATFORM_ADMIN_GROUP } from '../src/authz.ts'
import type { HttpEvent } from '../src/http.ts'
import type { ChatBinding, Repo } from '../src/repo.ts'
import { parseConnectorKv } from '../src/setup/connector-state.ts'
import { hostClient, pickHost } from '../src/setup/host.ts'
import type { ClaimResult, OnboardingStore } from '../src/setup/onboarding.ts'
import { type PlatformDeps, handlePlatform } from '../src/setup/platform.ts'
import { type TenantDeps, handleTenantSetup } from '../src/setup/tenant.ts'

const NOW = Date.parse('2026-11-01T00:00:00Z')
const tenant = (tenantId: string, status: 'active' | 'disabled' = 'active'): TenantRecord =>
  ({ tenantId, name: tenantId.toUpperCase(), cognitoGroup: `dshsa-tenant-${tenantId}`, status, createdAt: '2026-11-01T00:00:00Z' })
const cell = (tenantId: string, repoId: number, installationId = 7): CellRecord => ({
  cellId: `${tenantId}--gh${repoId}`, tenantId, status: 'active', stateBucketPrefix: `cells/${tenantId}--gh${repoId}/`,
  queueUrl: `https://sqs.ap-northeast-1.amazonaws.com/1/dshsa-cell-${tenantId}--gh${repoId}.fifo`, createdAt: '2026-11-01T00:00:00Z',
  repo: { owner: tenantId, name: `repo${repoId}`, id: repoId, installationId, defaultBranch: 'main' },
})

class FakeRepo implements Repo {
  tenants = new Map([['acme', tenant('acme')], ['beta', tenant('beta')], ['gone', tenant('gone', 'disabled')]])
  cells = new Map([cell('acme', 1), cell('beta', 3, 8)].map(c => [c.cellId, c]))
  bindings = new Map<string, ChatBinding>()
  async getTenant(id: string) { return this.tenants.get(id) }
  async listTenants() { return [...this.tenants.values()] }
  async getCell(id: string) { return this.cells.get(id) }
  async listCellsByTenant(t: string) { return [...this.cells.values()].filter(c => c.tenantId === t) }
  async getLease() { return undefined }
  async listChatBindings(t: string) { return [...this.bindings.values()].filter(b => b.tenantId === t) }
  async putChatBinding(b: ChatBinding) { this.bindings.set(`${b.tenantId}#${b.chatId}`, b) }
  async deleteChatBinding(t: string, chat: string) { return this.bindings.delete(`${t}#${chat}`) }
}

class FakeOnboarding implements OnboardingStore {
  states = new Map<string, SetupState>()
  claims = new Map<number, InstallationClaim>()
  async createState(s: SetupState) { this.states.set(s.key, s) }
  async consumeState(nonce: string, tenantId: string, sub: string, nowSec: number) {
    const s = this.states.get(`ghstate#${nonce}`)
    if (!s || s.tenantId !== tenantId || s.sub !== sub || s.ttl <= nowSec) return false
    this.states.delete(s.key)
    return true
  }
  // Same rules as DynamoOnboarding.claim: another tenant's claim wins; a pending write never downgrades an active claim.
  async claim(c: InstallationClaim): Promise<ClaimResult> {
    const held = this.claims.get(c.installationId)
    if (held && held.tenantId !== c.tenantId) return 'other_tenant'
    if (held?.status === 'active' && c.status === 'pending') return 'active'
    this.claims.set(c.installationId, c)
    return c.status
  }
  async getClaim(id: number) { return this.claims.get(id) }
  async listClaims(t: string) { return [...this.claims.values()].filter(c => c.tenantId === t) }
  async releaseClaim(id: number, tenantId?: string) {
    if (tenantId && this.claims.get(id)?.tenantId !== tenantId) return false
    return this.claims.delete(id)
  }
  async listPending() { return [...this.claims.values()].filter(c => c.status === 'pending') }
  async listAllClaims() { return [...this.claims.values()] }
  async approveClaim(id: number, approvedBy: string, approvedAt: string) {
    const c = this.claims.get(id)
    if (c?.status !== 'pending') return false
    this.claims.set(id, { ...c, status: 'active', approvedBy, approvedAt, pendingReason: undefined })
    return true
  }
}

const OAUTH = { clientId: 'Iv23liClient', clientSecret: 'c'.repeat(40), appId: '123', slug: 'dshsa-agent' }
const NONCE = 'n'.repeat(43)
const repos = [
  { id: 1, name: 'repo1', owner: 'acme', fullName: 'acme/repo1', private: true, archived: false, defaultBranch: 'main' },
  { id: 2, name: 'repo2', owner: 'acme', fullName: 'acme/repo2', private: false, archived: false, defaultBranch: 'trunk' },
  { id: 9, name: 'old', owner: 'acme', fullName: 'acme/old', private: false, archived: true, defaultBranch: 'main' },
]

const claimOf = (id: number, tenantId: string, status: 'active' | 'pending' = 'active'): InstallationClaim => ({
  key: `ghinst#${id}`, tenantId, installationId: id, status, account: tenantId, accountType: 'Organization', githubLogin: 'someone',
  claimedBy: 'x', claimedAt: '2026-11-01T00:00:00Z', ...(status === 'pending' ? { pendingReason: 'not_org_admin' } : {}) })

function setup() {
  const repo = new FakeRepo()
  const onboarding = new FakeOnboarding()
  onboarding.claims.set(7, claimOf(7, 'acme'))
  onboarding.claims.set(8, claimOf(8, 'beta'))
  const audit: Record<string, unknown>[] = []
  const ops = {
    cellAdd: vi.fn(async (i: { tenantId: string; repoId: number }) => ({ cellId: `${i.tenantId}--gh${i.repoId}` })),
    cellSetStatus: vi.fn(async () => {}), feishuSet: vi.fn(async () => 'arn'), chatBind: vi.fn(async () => {}),
    chatUnbind: vi.fn(async () => true), tenantUsers: vi.fn(async () => [{ email: 'a@x.io', role: 'member' as const }]),
    userInvite: vi.fn(async () => {}), userRemove: vi.fn(async () => {}), githubOauth: vi.fn(async () => OAUTH),
  }
  const host = { repositories: vi.fn(async () => ({ ok: true as const, repositories: repos, truncated: false })) }
  const github = {
    exchange: vi.fn(async () => new GithubUserToken('gho_secret')),
    installations: vi.fn(async () => [{ id: 7, account: { login: 'acme', type: 'Organization' } }, { id: 8, account: { login: 'beta', type: 'Organization' } },
      { id: 11, account: { login: 'Octo-Dev', type: 'User' } }]),
    login: vi.fn(async () => ({ login: 'octo-dev' })),
    membership: vi.fn(async (): Promise<{ state: 'active' | 'pending'; role: 'admin' | 'member' } | undefined> => ({ state: 'active', role: 'admin' })),
    revoke: vi.fn(async () => true),
  }
  const connector = { read: vi.fn(async () => parseConnectorKv(JSON.stringify({ state: JSON.stringify({
    chats: { oc_seen1: { direct: false, name: 'dev chat', lastAt: '2026-11-01T00:00:00Z', routed: false, unrouted: 2 } },
    health: { state: 'ready', detail: 'Listening', at: '2026-11-01T00:00:00Z' }, history: { oc_seen1: 'cursor' } }) }))) }
  const deps: TenantDeps = { repo, ops, onboarding, host, connector, github, panelUrl: 'https://panel.example', now: () => NOW,
    nonce: () => NONCE, audit: line => audit.push(JSON.parse(line)) }
  return { repo, onboarding, ops, host, github, deps, audit }
}

const claimsOf = (groups: string[], sub = 'u-1') => ({ sub, email: `${sub}@example.com`, 'cognito:groups': groups })
const member = (t: string, sub?: string) => claimsOf([`dshsa-tenant-${t}`], sub)
const tadmin = (t: string, sub?: string) => claimsOf([`dshsa-tenant-${t}`, `dshsa-tadmin-${t}`], sub)
const admin = () => claimsOf([PLATFORM_ADMIN_GROUP], 'root')
const ev = (method: string, path: string, claims: Record<string, unknown> | undefined, body?: unknown, query?: string): HttpEvent =>
  ({ rawPath: path, rawQueryString: query, body: body === undefined ? undefined : JSON.stringify(body),
    requestContext: { http: { method }, authorizer: claims ? { jwt: { claims } } : undefined } })
const parse = (r: { body: string }) => JSON.parse(r.body) as Record<string, any>

// Every tenant setup route with a valid body. Expected for a tenant admin of acme: not 403.
const TENANT_ROUTES: [string, string, unknown?][] = [
  ['GET', ''], ['POST', '/github/link-start'], ['POST', '/github/link', { code: 'c1', state: NONCE }], ['GET', '/github/installations'],
  ['GET', '/github/installations/7/repositories'], ['DELETE', '/github/installations/12'], ['POST', '/cells', { installationId: 7, repoId: 2 }], ['POST', '/cells/acme--gh1/pause'],
  ['POST', '/cells/acme--gh1/enable'], ['POST', '/cells/acme--gh1/disable'], ['GET', '/feishu'],
  ['PUT', '/feishu', { domain: 'lark', appId: 'cli_abc', appSecret: 'secret-123' }], ['GET', '/chats'], ['PUT', '/chats/oc_seen1', { cellId: 'acme--gh1' }],
  ['DELETE', '/chats/oc_seen1'], ['GET', '/users'], ['POST', '/users', { email: 'new@x.io', role: 'tadmin' }], ['DELETE', '/users/old@x.io'],
]

describe('panel-tenant authz matrix (design §1)', () => {
  it.each(TENANT_ROUTES)('%s setup%s', async (method, path, body) => {
    const call = async (claims: Record<string, unknown> | undefined, tenantId = 'acme') => {
      const { deps, onboarding } = setup()
      onboarding.claims.set(12, claimOf(12, 'acme'))
      if (path === '/github/link') onboarding.states.set(`ghstate#${NONCE}`, { key: `ghstate#${NONCE}`, tenantId, sub: (claims?.sub as string) ?? 'u-1', ttl: NOW / 1000 + 60 })
      return (await handleTenantSetup(ev(method, `/v1/tenants/${tenantId}/setup${path}`, claims, body), deps)).statusCode
    }
    expect(await call(undefined), 'anonymous').toBe(401)
    expect(await call(member('acme')), 'member').toBe(403)
    expect(await call(tadmin('beta')), 'tenant admin of another tenant').toBe(403)
    expect(await call(claimsOf(['dshsa-tadmin-acme'])), 'tadmin group without tenant membership').toBe(403)
    expect(await call(tadmin('nope'), 'nope'), 'unknown tenant').toBe(403)
    expect(await call(tadmin('gone'), 'gone'), 'disabled tenant').toBe(403)
    expect(await call(tadmin('acme')), 'tenant admin').toBeLessThan(400)
    expect(await call(admin()), 'platform admin').toBeLessThan(400)
  })

  it('never runs a side effect (or touches GitHub, the host or audit) before authorization', async () => {
    const refused: [Record<string, unknown> | undefined, string][] = [
      [undefined, 'acme'], [member('acme'), 'acme'], [tadmin('beta'), 'acme'], [claimsOf(['dshsa-tadmin-acme']), 'acme'],
      [tadmin('nope'), 'nope'], [tadmin('gone'), 'gone'], [admin(), 'gone'],
    ]
    for (const [claims, t] of refused) {
      const { deps, ops, onboarding, host, github, audit } = setup()
      onboarding.states.set(`ghstate#${NONCE}`, { key: `ghstate#${NONCE}`, tenantId: t, sub: (claims?.sub as string) ?? 'u-1', ttl: NOW / 1000 + 60 })
      const before = JSON.stringify([...onboarding.claims])
      for (const [method, path, body] of TENANT_ROUTES) {
        expect((await handleTenantSetup(ev(method, `/v1/tenants/${t}/setup${path}`, claims, body), deps)).statusCode).toBeGreaterThanOrEqual(401)
      }
      for (const fn of [...Object.values(ops), host.repositories, ...Object.values(github)]) expect(fn).not.toHaveBeenCalled()
      expect(onboarding.states.size, 'state not consumed').toBe(1)
      expect(JSON.stringify([...onboarding.claims])).toBe(before)
      expect(audit).toEqual([])
    }
  })

  it('answers 403 identically for an unknown, foreign and disabled tenant (existence is not revealed)', async () => {
    const { deps } = setup()
    const bodies = await Promise.all([['nope', tadmin('acme')], ['beta', tadmin('acme')], ['gone', tadmin('acme')], ['acme', member('acme')]].map(async ([t, claims]) =>
      (await handleTenantSetup(ev('GET', `/v1/tenants/${t as string}/setup/users`, claims as Record<string, unknown>), deps)).body))
    expect(new Set(bodies).size).toBe(1)
  })
})

describe('GitHub link (design §3)', () => {
  it('creates a single-use state bound to tenant + sub and returns the authorize URL', async () => {
    const { deps, onboarding, audit } = setup()
    const res = parse(await handleTenantSetup(ev('POST', '/v1/tenants/acme/setup/github/link-start', tadmin('acme')), deps))
    const url = new URL(res.url)
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize')
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: OAUTH.clientId, redirect_uri: 'https://panel.example/setup/github/callback', state: NONCE })
    expect(onboarding.states.get(`ghstate#${NONCE}`)).toEqual({ key: `ghstate#${NONCE}`, tenantId: 'acme', sub: 'u-1', ttl: NOW / 1000 + 600 })
    expect(audit[0]).toMatchObject({ msg: 'audit', op: 'setup.github.link-start', tenantId: 'acme', ok: true, role: 'tadmin', actor: { sub: 'u-1' } })
  })

  it('claims only installations the GitHub user can access, never one held by another tenant, and revokes the token', async () => {
    const { deps, onboarding, github, audit } = setup()
    onboarding.states.set(`ghstate#${NONCE}`, { key: `ghstate#${NONCE}`, tenantId: 'acme', sub: 'u-1', ttl: NOW / 1000 + 60 })
    const res = await handleTenantSetup(ev('POST', '/v1/tenants/acme/setup/github/link', tadmin('acme'), { code: 'c1', state: NONCE }), deps)
    expect(res.statusCode).toBe(200)
    expect(parse(res).installations).toEqual([
      { installationId: 7, account: 'acme', status: 'active' }, { installationId: 8, account: 'beta', status: 'other_tenant' },
      { installationId: 11, account: 'Octo-Dev', status: 'active' }])
    expect(onboarding.claims.get(8)!.tenantId).toBe('beta')
    // Host-facing fields (contracts v6.2): status, account, accountType, githubLogin.
    expect(onboarding.claims.get(11)).toMatchObject({ tenantId: 'acme', status: 'active', account: 'Octo-Dev', accountType: 'User', githubLogin: 'octo-dev', claimedBy: 'u-1@example.com' })
    expect(onboarding.claims.get(7)).toMatchObject({ status: 'active', accountType: 'Organization', githubLogin: 'octo-dev' })
    expect(github.membership).toHaveBeenCalledWith(expect.anything(), 'acme')
    expect(github.exchange).toHaveBeenCalledWith({ clientId: OAUTH.clientId, clientSecret: OAUTH.clientSecret, code: 'c1', redirectUri: 'https://panel.example/setup/github/callback' })
    expect((github.installations.mock.calls[0] as unknown[])[1]).toBe('123')
    expect(github.revoke).toHaveBeenCalledOnce()
    // The state is gone: a replay fails.
    const replay = await handleTenantSetup(ev('POST', '/v1/tenants/acme/setup/github/link', tadmin('acme'), { code: 'c1', state: NONCE }), deps)
    expect(replay.statusCode).toBe(400)
    expect(parse(replay).error).toBe('invalid_state')
    expect(JSON.stringify(audit)).not.toContain('gho_secret')
    expect(JSON.stringify(audit)).not.toContain(OAUTH.clientSecret)
  })

  it('refuses a state issued to another user, another tenant, expired, or forged, before talking to GitHub', async () => {
    const cases: [Partial<SetupState>, Record<string, unknown>, string][] = [
      [{ sub: 'someone-else' }, tadmin('acme'), 'acme'],
      [{ tenantId: 'beta' }, admin(), 'acme'],
      [{ ttl: NOW / 1000 - 1 }, tadmin('acme'), 'acme'],
    ]
    for (const [patch, claims, t] of cases) {
      const { deps, onboarding, github } = setup()
      onboarding.states.set(`ghstate#${NONCE}`, { key: `ghstate#${NONCE}`, tenantId: 'acme', sub: (claims.sub as string), ttl: NOW / 1000 + 60, ...patch })
      const res = await handleTenantSetup(ev('POST', `/v1/tenants/${t}/setup/github/link`, claims, { code: 'c1', state: NONCE }), deps)
      expect(res.statusCode, JSON.stringify(patch)).toBe(400)
      expect(github.exchange).not.toHaveBeenCalled()
    }
    const { deps } = setup()
    expect((await handleTenantSetup(ev('POST', '/v1/tenants/acme/setup/github/link', tadmin('acme'), { code: 'c1', state: 'short' }), deps)).statusCode).toBe(400)
  })

  it('maps an expired code to "link again", and still revokes after a listing failure', async () => {
    const { deps, onboarding, github } = setup()
    onboarding.states.set(`ghstate#${NONCE}`, { key: `ghstate#${NONCE}`, tenantId: 'acme', sub: 'u-1', ttl: NOW / 1000 + 60 })
    github.exchange.mockRejectedValueOnce(new GithubOAuthError('expired', 'bad_verification_code'))
    const res = await handleTenantSetup(ev('POST', '/v1/tenants/acme/setup/github/link', tadmin('acme'), { code: 'c1', state: NONCE }), deps)
    expect(parse(res).error).toBe('invalid_code')
    onboarding.states.set(`ghstate#${NONCE}`, { key: `ghstate#${NONCE}`, tenantId: 'acme', sub: 'u-1', ttl: NOW / 1000 + 60 })
    github.installations.mockRejectedValueOnce(new GithubOAuthError('nope', 'http_500', 500))
    expect((await handleTenantSetup(ev('POST', '/v1/tenants/acme/setup/github/link', tadmin('acme'), { code: 'c2', state: NONCE }), deps)).statusCode).toBe(502)
    expect(github.revoke).toHaveBeenCalledOnce()
  })

  it('answers 409 until the platform admin set the OAuth client', async () => {
    const { deps, ops } = setup()
    ops.githubOauth.mockResolvedValue(undefined as never)
    expect(parse(await handleTenantSetup(ev('POST', '/v1/tenants/acme/setup/github/link-start', tadmin('acme')), deps)).error).toBe('github_not_configured')
  })
})

describe('who may claim (design §3 step 4a, v6.2)', () => {
  async function link(installs: { id: number; account: { login: string; type: string } }[], patch: (g: ReturnType<typeof setup>['github']) => void = () => {}) {
    const k = setup()
    k.onboarding.claims.clear()
    k.onboarding.states.set(`ghstate#${NONCE}`, { key: `ghstate#${NONCE}`, tenantId: 'acme', sub: 'u-1', ttl: NOW / 1000 + 60 })
    k.github.installations.mockResolvedValue(installs)
    patch(k.github)
    const res = await handleTenantSetup(ev('POST', '/v1/tenants/acme/setup/github/link', tadmin('acme'), { code: 'c1', state: NONCE }), k.deps)
    return { ...k, res, body: parse(res) }
  }
  const user = (login: string) => ({ id: 21, account: { login, type: 'User' } })
  const org = (login = 'acme-org') => ({ id: 31, account: { login, type: 'Organization' } })

  it('a User installation on the own account (case-insensitive) is active', async () => {
    const { body, onboarding } = await link([user('OCTO-dev')])
    expect(body.installations).toEqual([{ installationId: 21, account: 'OCTO-dev', status: 'active' }])
    expect(onboarding.claims.get(21)?.status).toBe('active')
  })
  it('a User installation on someone else\'s account is pending (not_own_account)', async () => {
    const { body, onboarding } = await link([user('other-person')])
    expect(body.installations).toEqual([{ installationId: 21, account: 'other-person', status: 'pending', pendingReason: 'not_own_account' }])
    expect(onboarding.claims.get(21)).toMatchObject({ status: 'pending', pendingReason: 'not_own_account' })
  })
  it('an Organization installation is active only for an active org admin', async () => {
    expect((await link([org()])).body.installations[0].status).toBe('active')
    for (const m of [{ state: 'active', role: 'member' }, { state: 'pending', role: 'admin' }] as const) {
      const { body } = await link([org()], g => g.membership.mockResolvedValue(m))
      expect(body.installations[0], JSON.stringify(m)).toMatchObject({ status: 'pending', pendingReason: 'not_org_admin' })
    }
  })
  it('an unreadable membership is pending, never active (404/403 or an error)', async () => {
    const unknown = await link([org()], g => g.membership.mockResolvedValue(undefined))
    expect(unknown.body.installations[0]).toMatchObject({ status: 'pending', pendingReason: 'membership_unavailable' })
    const failing = await link([org()], g => g.membership.mockRejectedValue(new GithubOAuthError('x', 'http_500', 500)))
    expect(failing.res.statusCode).toBe(200)
    expect(failing.body.installations[0]).toMatchObject({ status: 'pending', pendingReason: 'membership_unavailable' })
    expect(failing.github.revoke).toHaveBeenCalledOnce()
  })
  it('an unknown account type is pending', async () => {
    expect((await link([{ id: 41, account: { login: 'ent', type: 'Enterprise' } }])).body.installations[0]).toMatchObject({ status: 'pending' })
  })
  it('a failing /user stops the link (502) and still revokes the token; nothing is claimed', async () => {
    const { res, github, onboarding } = await link([org()], g => g.login.mockRejectedValue(new GithubOAuthError('x', 'bad_credentials', 401)))
    expect(res.statusCode).toBe(502)
    expect(github.revoke).toHaveBeenCalledOnce()
    expect(onboarding.claims.size).toBe(0)
  })
  it('re-linking without proof never downgrades an active claim', async () => {
    const k = setup()
    k.onboarding.states.set(`ghstate#${NONCE}`, { key: `ghstate#${NONCE}`, tenantId: 'acme', sub: 'u-1', ttl: NOW / 1000 + 60 })
    k.github.installations.mockResolvedValue([{ id: 7, account: { login: 'acme', type: 'Organization' } }])
    k.github.membership.mockResolvedValue({ state: 'active', role: 'member' })
    const body = parse(await handleTenantSetup(ev('POST', '/v1/tenants/acme/setup/github/link', tadmin('acme'), { code: 'c1', state: NONCE }), k.deps))
    expect(body.installations[0].status).toBe('active')
    expect(k.onboarding.claims.get(7)?.status).toBe('active')
  })
  it('a pending claim lists no repositories and adds no cell; the status shows approval pending', async () => {
    const k = setup()
    k.onboarding.claims.set(7, claimOf(7, 'acme', 'pending'))
    const repos = await handleTenantSetup(ev('GET', '/v1/tenants/acme/setup/github/installations/7/repositories', tadmin('acme')), k.deps)
    expect(repos.statusCode).toBe(403)
    expect(parse(repos)).toMatchObject({ error: 'claim_pending', message: 'This installation is waiting for platform approval' })
    expect((await handleTenantSetup(ev('POST', '/v1/tenants/acme/setup/cells', tadmin('acme'), { installationId: 7, repoId: 2 }), k.deps)).statusCode).toBe(403)
    expect(k.host.repositories).not.toHaveBeenCalled()
    expect(k.ops.cellAdd).not.toHaveBeenCalled()
    const status = parse(await handleTenantSetup(ev('GET', '/v1/tenants/acme/setup', tadmin('acme')), k.deps))
    expect(status.checklist).toMatchObject({ appLinked: false, approvalPending: true })
    const list = parse(await handleTenantSetup(ev('GET', '/v1/tenants/acme/setup/github/installations', tadmin('acme')), k.deps))
    expect(list.installations[0]).toMatchObject({ installationId: 7, status: 'pending', pendingReason: 'not_org_admin' })
  })
})

describe('repositories and cells (design §3 step 5)', () => {
  it('lists repos of an own installation only, marking those already added', async () => {
    const { deps, host } = setup()
    const res = parse(await handleTenantSetup(ev('GET', '/v1/tenants/acme/setup/github/installations/7/repositories', tadmin('acme')), deps))
    expect(res.repositories.map((r: any) => [r.id, r.cell?.cellId])).toEqual([[1, 'acme--gh1'], [2, undefined], [9, undefined]])
    // Installation 8 belongs to beta: refused before the host is asked.
    expect((await handleTenantSetup(ev('GET', '/v1/tenants/acme/setup/github/installations/8/repositories', tadmin('acme')), deps)).statusCode).toBe(403)
    expect(host.repositories).toHaveBeenCalledTimes(1)
  })

  it('adds a cell with ids and names from GitHub, never from the request', async () => {
    const { deps, ops, audit } = setup()
    const res = await handleTenantSetup(ev('POST', '/v1/tenants/acme/setup/cells', tadmin('acme'), { installationId: 7, repoId: 2 }), deps)
    expect(res.statusCode).toBe(200)
    expect(ops.cellAdd).toHaveBeenCalledWith({ tenantId: 'acme', repo: 'acme/repo2', repoId: 2, installationId: 7, defaultBranch: 'trunk' })
    expect(audit.at(-1)).toMatchObject({ op: 'setup.cell.add', target: '7/2', ok: true })
    // Extra fields (e.g. a repo name) are refused; unknown repo, archived repo and foreign installation too.
    expect((await handleTenantSetup(ev('POST', '/v1/tenants/acme/setup/cells', tadmin('acme'), { installationId: 7, repoId: 2, repo: 'evil/x' }), deps)).statusCode).toBe(400)
    expect((await handleTenantSetup(ev('POST', '/v1/tenants/acme/setup/cells', tadmin('acme'), { installationId: 7, repoId: 99 }), deps)).statusCode).toBe(404)
    expect((await handleTenantSetup(ev('POST', '/v1/tenants/acme/setup/cells', tadmin('acme'), { installationId: 7, repoId: 9 }), deps)).statusCode).toBe(400)
    expect((await handleTenantSetup(ev('POST', '/v1/tenants/acme/setup/cells', tadmin('acme'), { installationId: 8, repoId: 3 }), deps)).statusCode).toBe(403)
    expect(ops.cellAdd).toHaveBeenCalledOnce()
    expect(audit.filter(a => a.op === 'setup.cell.add' && a.ok === false).length).toBe(3)
  })

  it('pauses only cells of the own tenant', async () => {
    const { deps, ops } = setup()
    expect((await handleTenantSetup(ev('POST', '/v1/tenants/acme/setup/cells/beta--gh3/pause', tadmin('acme')), deps)).statusCode).toBe(403)
    expect((await handleTenantSetup(ev('POST', '/v1/tenants/acme/setup/cells/acme--gh1/pause', tadmin('acme')), deps)).statusCode).toBe(200)
    expect(ops.cellSetStatus).toHaveBeenCalledWith('acme--gh1', 'paused')
  })

  it('maps host failures without leaking details', async () => {
    const { deps, host } = setup()
    for (const [reason, status] of [['not_claimed', 403], ['installation_not_found', 404], ['host_unavailable', 503], ['github_error', 503], ['auth_rejected', 503]] as const) {
      host.repositories.mockResolvedValueOnce({ ok: false, reason } as never)
      expect((await handleTenantSetup(ev('GET', '/v1/tenants/acme/setup/github/installations/7/repositories', tadmin('acme')), deps)).statusCode, reason).toBe(status)
    }
  })
})

describe('unlink an installation (A1 follow-up)', () => {
  const unlink = (deps: TenantDeps, id: number | string, claims = tadmin('acme'), t = 'acme') =>
    handleTenantSetup(ev('DELETE', `/v1/tenants/${t}/setup/github/installations/${id}`, claims), deps)

  it('refuses with 409 installation_in_use while a non-disabled cell uses it, and lists those cells', async () => {
    const { deps, onboarding, repo, audit } = setup()
    repo.cells.set('acme--gh2', { ...cell('acme', 2), status: 'paused' })
    repo.cells.set('acme--gh4', { ...cell('acme', 4), status: 'disabled' })
    const res = await unlink(deps, 7)
    expect(res.statusCode).toBe(409)
    expect(parse(res)).toMatchObject({ error: 'installation_in_use', message: expect.stringMatching(/acme\/repo1, acme\/repo2.*disable them first/) })
    expect(parse(res).cells).toEqual([{ cellId: 'acme--gh1', status: 'active', repo: 'acme/repo1' }, { cellId: 'acme--gh2', status: 'paused', repo: 'acme/repo2' }])
    expect(onboarding.claims.has(7)).toBe(true)
    expect(audit.at(-1)).toMatchObject({ op: 'setup.github.unlink', tenantId: 'acme', target: '7', ok: false, error: 'HTTP 409', role: 'tadmin' })
    // Once every cell on it is disabled, the claim goes (conditional on this tenant) and the unlink is audited.
    repo.cells.set('acme--gh1', { ...cell('acme', 1), status: 'disabled' })
    repo.cells.set('acme--gh2', { ...cell('acme', 2), status: 'disabled' })
    const release = vi.spyOn(onboarding, 'releaseClaim')
    const ok = await unlink(deps, 7)
    expect([ok.statusCode, parse(ok)]).toEqual([200, { installationId: 7, released: true }])
    expect(release).toHaveBeenCalledWith(7, 'acme')
    expect(onboarding.claims.has(7)).toBe(false)
    expect(audit.at(-1)).toMatchObject({ op: 'setup.github.unlink', tenantId: 'acme', target: '7', ok: true, actor: expect.objectContaining({ sub: 'u-1' }) })
  })

  it('never unlinks another tenant\'s claim (403 not_claimed, audited), also for a cross-tenant admin', async () => {
    const { deps, onboarding, audit } = setup()
    const res = await unlink(deps, 8)
    expect([res.statusCode, parse(res).error]).toEqual([403, 'not_claimed'])
    expect(onboarding.claims.get(8)?.tenantId).toBe('beta')
    expect(audit.at(-1)).toMatchObject({ op: 'setup.github.unlink', tenantId: 'acme', target: '8', ok: false })
    expect((await unlink(deps, 8, tadmin('acme'), 'beta')).statusCode).toBe(403)
    expect((await unlink(deps, 404)).statusCode).toBe(403)
    expect((await unlink(deps, 'x1')).statusCode).toBe(400)
    // A claim that changed hands between the read and the delete is kept (conditional delete refused).
    onboarding.claims.set(12, claimOf(12, 'acme'))
    vi.spyOn(onboarding, 'releaseClaim').mockResolvedValueOnce(false)
    expect((await unlink(deps, 12)).statusCode).toBe(403)
    expect(onboarding.claims.has(8)).toBe(true)
  })

  it('withdraws an own pending claim; members cannot unlink', async () => {
    const { deps, onboarding } = setup()
    onboarding.claims.set(12, claimOf(12, 'acme', 'pending'))
    expect((await unlink(deps, 12, member('acme'))).statusCode).toBe(403)
    expect(onboarding.claims.has(12)).toBe(true)
    expect((await unlink(deps, 12)).statusCode).toBe(200)
  })

  it('keeps a cell disabled once its installation is linked to another team', async () => {
    const { deps, onboarding, repo, ops } = setup()
    repo.cells.set('acme--gh1', { ...cell('acme', 1), status: 'disabled' })
    onboarding.claims.set(7, claimOf(7, 'beta'))
    for (const action of ['enable', 'pause']) {
      const res = await handleTenantSetup(ev('POST', `/v1/tenants/acme/setup/cells/acme--gh1/${action}`, tadmin('acme')), deps)
      expect([res.statusCode, parse(res).error], action).toEqual([403, 'not_claimed'])
    }
    expect((await handleTenantSetup(ev('POST', '/v1/tenants/acme/setup/cells/acme--gh1/disable', tadmin('acme')), deps)).statusCode).toBe(200)
    expect(ops.cellSetStatus).toHaveBeenCalledTimes(1)
    // An unclaimed installation (a cell onboarded with the CLI) still enables.
    onboarding.claims.delete(7)
    expect((await handleTenantSetup(ev('POST', '/v1/tenants/acme/setup/cells/acme--gh1/enable', tadmin('acme')), deps)).statusCode).toBe(200)
  })
})

describe('Feishu, chats, users (design §4, Q3)', () => {
  it('feishu status never returns the secret; set is audited without it', async () => {
    const { deps, repo, ops, audit } = setup()
    repo.tenants.set('acme', { ...tenant('acme'), feishu: { domain: 'lark', appId: 'cli_1', secretArn: 'arn:secret', revision: '2026-11-01T00:00:00Z' } })
    const status = parse(await handleTenantSetup(ev('GET', '/v1/tenants/acme/setup/feishu', tadmin('acme')), deps))
    expect(status).toEqual({ set: true, domain: 'lark', appId: 'cli_1', revision: '2026-11-01T00:00:00Z', health: { state: 'ready', detail: 'Listening', at: '2026-11-01T00:00:00Z' } })
    await handleTenantSetup(ev('PUT', '/v1/tenants/acme/setup/feishu', tadmin('acme'), { domain: 'lark', appId: 'cli_abc', appSecret: 'super-secret-1', encryptKey: 'ek-1' }), deps)
    expect(ops.feishuSet).toHaveBeenCalledWith({ tenantId: 'acme', domain: 'lark', appId: 'cli_abc', appSecret: 'super-secret-1', encryptKey: 'ek-1' })
    expect(JSON.stringify(audit)).not.toMatch(/super-secret-1|ek-1/)
  })

  it('refuses to bind a chat to a disabled repository', async () => {
    const { deps, ops, repo } = setup()
    repo.cells.set('acme--gh1', { ...repo.cells.get('acme--gh1')!, status: 'disabled' })
    expect((await handleTenantSetup(ev('PUT', '/v1/tenants/acme/setup/chats/oc_seen1', tadmin('acme'), { cellId: 'acme--gh1' }), deps)).statusCode).toBe(400)
    expect(ops.chatBind).not.toHaveBeenCalled()
  })

  it('maps an ops AdminError on a read to 400, not 500', async () => {
    const { deps, ops } = setup()
    ops.tenantUsers.mockRejectedValueOnce(new (await import('../src/admin/ops.ts')).AdminError('no tenant acme'))
    expect((await handleTenantSetup(ev('GET', '/v1/tenants/acme/setup/users', tadmin('acme')), deps)).statusCode).toBe(400)
  })

  it('lists seen and bound chats and binds a seen chat to an own cell only', async () => {
    const { deps, ops, repo } = setup()
    repo.bindings.set('acme#oc_bound', { tenantId: 'acme', chatId: 'oc_bound', cellId: 'acme--gh1', updatedAt: 'x' })
    const res = parse(await handleTenantSetup(ev('GET', '/v1/tenants/acme/setup/chats', tadmin('acme')), deps))
    expect(res.chats.map((c: any) => [c.chatId, c.name, c.cellId ?? null, c.seen])).toEqual([['oc_seen1', 'dev chat', null, true], ['oc_bound', undefined, 'acme--gh1', false]])
    expect(res.cells).toEqual([{ cellId: 'acme--gh1', repo: 'acme/repo1' }])
    expect(JSON.stringify(res)).not.toContain('cursor')
    expect((await handleTenantSetup(ev('PUT', '/v1/tenants/acme/setup/chats/oc_seen1', tadmin('acme'), { cellId: 'beta--gh3' }), deps)).statusCode).toBe(400)
    expect((await handleTenantSetup(ev('PUT', '/v1/tenants/acme/setup/chats/oc_seen1', tadmin('acme'), { cellId: 'acme--gh1' }), deps)).statusCode).toBe(200)
    expect(ops.chatBind).toHaveBeenCalledWith('acme', 'oc_seen1', 'acme--gh1', 'dev chat')
  })

  it('invites and removes users of the own tenant only; no platform-admin role; no self-removal', async () => {
    const { deps, ops } = setup()
    expect((await handleTenantSetup(ev('POST', '/v1/tenants/acme/setup/users', tadmin('acme'), { email: 'p@x.io', role: 'admin' }), deps)).statusCode).toBe(400)
    expect((await handleTenantSetup(ev('POST', '/v1/tenants/acme/setup/users', tadmin('acme'), { email: 'p@x.io', role: 'member' }), deps)).statusCode).toBe(200)
    expect(ops.userInvite).toHaveBeenCalledWith('p@x.io', 'acme', 'member')
    expect((await handleTenantSetup(ev('DELETE', '/v1/tenants/acme/setup/users/u-1%40example.com', tadmin('acme')), deps)).statusCode).toBe(400)
    ops.userInvite.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'ResourceNotFoundException' }))
    expect(parse(await handleTenantSetup(ev('POST', '/v1/tenants/acme/setup/users', tadmin('acme'), { email: 'q@x.io', role: 'tadmin' }), deps)).error).toBe('group_missing')
  })
})

describe('panel-platform (design §1)', () => {
  function platform() {
    const audit: Record<string, unknown>[] = []
    const status = { app: { set: true, appId: '123', slug: 'dshsa-agent', keyValid: true, installations: 2 }, oauth: { set: true, clientId: 'Iv23li' } }
    const ops = {
      tenantList: vi.fn(async () => [tenant('acme')]), tenantAdd: vi.fn(async (t: string, name: string) => ({ ...tenant(t), name })),
      tenantSetStatus: vi.fn(async () => {}), tenantUsers: vi.fn(async () => []), platformAdmins: vi.fn(async () => []),
      userInvite: vi.fn(async () => {}), userAddAdmin: vi.fn(async () => {}), userRemove: vi.fn(async () => {}), adminRemove: vi.fn(async () => {}),
      githubAppSet: vi.fn(async () => ({ slug: 'dshsa-agent' })), githubOauthSet: vi.fn(async () => {}), githubAppStatus: vi.fn(async () => status),
      releaseClaim: vi.fn(async (_id: number, _t?: string) => true), listPendingClaims: vi.fn(async () => [] as InstallationClaim[]),
      approveClaim: vi.fn(async () => true),
      getClaim: vi.fn(async (id: number): Promise<InstallationClaim | undefined> => claimOf(id, 'beta', 'pending')),
      listAllClaims: vi.fn(async () => [] as InstallationClaim[]), tenantCells: vi.fn(async (_t: string) => [] as CellRecord[]),
    }
    const deps: PlatformDeps = { ops, panelUrl: 'https://panel.example', now: () => NOW, audit: line => audit.push(JSON.parse(line)) }
    return { ops, deps, audit }
  }
  const ROUTES: [string, string, unknown?, string?][] = [
    ['GET', '/tenants'], ['POST', '/tenants', { tenantId: 'newt', name: 'New' }], ['POST', '/tenants/acme/disable'], ['POST', '/tenants/acme/enable'],
    ['GET', '/users', undefined, 'tenant=acme'], ['GET', '/users'], ['POST', '/users', { email: 'a@x.io', role: 'tadmin', tenantId: 'acme' }],
    ['POST', '/users', { email: 'b@x.io', role: 'admin' }], ['DELETE', '/users/a%40x.io', undefined, 'tenant=acme'], ['DELETE', '/users/b%40x.io'],
    ['GET', '/github-app'], ['PUT', '/github-app', { clientId: 'Iv23liClient', clientSecret: 'c'.repeat(40) }], ['DELETE', '/installations/8'],
    ['GET', '/installations', undefined, 'status=pending'], ['GET', '/installations'], ['POST', '/installations/8/approve'],
    ['DELETE', '/installations/8', undefined, 'force=true'],
  ]
  it.each(ROUTES)('%s admin%s', async (method, path, body, q) => {
    const { deps } = platform()
    const call = async (claims?: Record<string, unknown>) => (await handlePlatform(ev(method, `/v1/admin${path}`, claims, body, q), deps)).statusCode
    expect(await call(), 'anonymous').toBe(401)
    expect(await call(member('acme')), 'member').toBe(403)
    expect(await call(tadmin('acme')), 'tenant admin').toBe(403)
    expect(await call(admin()), 'platform admin').toBeLessThan(400)
  })

  it('runs no operation for a non-admin caller', async () => {
    for (const claims of [undefined, member('acme'), tadmin('acme'), claimsOf(['dshsa-platform-admins', 'dshsa-tenant-platform-admin'])]) {
      const { deps, ops, audit } = platform()
      for (const [method, path, body, q] of ROUTES) {
        expect((await handlePlatform(ev(method, `/v1/admin${path}`, claims, body, q), deps)).statusCode).toBeGreaterThanOrEqual(401)
      }
      for (const fn of Object.values(ops)) expect(fn).not.toHaveBeenCalled()
      expect(audit).toEqual([])
    }
  })

  it('validates the OAuth client before writing anything (no partial App update)', async () => {
    const { deps, ops } = platform()
    const key = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'
    for (const bad of [{ clientSecret: 'x'.repeat(40) }, { clientId: 'not-a-client' }]) {
      expect((await handlePlatform(ev('PUT', '/v1/admin/github-app', admin(), { appId: '123', privateKey: key, ...bad }), deps)).statusCode).toBe(400)
    }
    expect(ops.githubAppSet).not.toHaveBeenCalled()
    expect(ops.githubOauthSet).not.toHaveBeenCalled()
  })

  it('maps an unknown tenant on a read to 400, not 500', async () => {
    const { deps, ops } = platform()
    ops.tenantUsers.mockRejectedValueOnce(new (await import('../src/admin/ops.ts')).AdminError('no tenant zzz'))
    expect((await handlePlatform(ev('GET', '/v1/admin/users', admin(), undefined, 'tenant=zzz'), deps)).statusCode).toBe(400)
  })

  it('sets the GitHub App with the slug from GitHub and returns status + the URL checklist, never secrets', async () => {
    const { deps, ops, audit } = platform()
    const key = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'
    const res = parse(await handlePlatform(ev('PUT', '/v1/admin/github-app', admin(), { appId: '123', privateKey: key, clientSecret: 'c'.repeat(40) }), deps))
    expect(ops.githubAppSet).toHaveBeenCalledWith({ appId: '123', privateKey: key, webhookSecret: undefined })
    expect(ops.githubOauthSet).toHaveBeenCalledWith({ clientId: undefined, clientSecret: 'c'.repeat(40) })
    expect(res.checklist).toEqual({ setupUrl: 'https://panel.example/setup/github', callbackUrl: 'https://panel.example/setup/github/callback', redirectOnUpdate: true,
      permissions: ['Organization permissions → Members: Read-only'] })
    expect(JSON.stringify(res) + JSON.stringify(audit)).not.toMatch(/PRIVATE KEY|cccccccccc/)
    expect(audit[0]).toMatchObject({ op: 'admin.github-app.set', target: '123:key,client-secret', ok: true, role: 'admin' })
    expect((await handlePlatform(ev('PUT', '/v1/admin/github-app', admin(), { privateKey: key }), deps)).statusCode).toBe(400)
  })

  it('lists pending claims and approves one (audited with the approver); reject releases it', async () => {
    const { deps, ops, audit } = platform()
    ops.listPendingClaims.mockResolvedValueOnce([claimOf(8, 'beta', 'pending')])
    expect(parse(await handlePlatform(ev('GET', '/v1/admin/installations', admin(), undefined, 'status=pending'), deps)).installations[0])
      .toMatchObject({ installationId: 8, status: 'pending' })
    expect((await handlePlatform(ev('GET', '/v1/admin/installations', admin(), undefined, 'status=bogus'), deps)).statusCode).toBe(400)
    const ok = await handlePlatform(ev('POST', '/v1/admin/installations/8/approve', admin()), deps)
    expect(parse(ok)).toEqual({ installationId: 8, status: 'active' })
    expect(ops.approveClaim).toHaveBeenCalledWith(8, 'root@example.com', '2026-11-01T00:00:00.000Z')
    expect(audit.at(-1)).toMatchObject({ op: 'admin.installation.approve', target: '8', ok: true, role: 'admin' })
    ops.approveClaim.mockResolvedValueOnce(false)
    expect((await handlePlatform(ev('POST', '/v1/admin/installations/9/approve', admin()), deps)).statusCode).toBe(404)
    expect((await handlePlatform(ev('DELETE', '/v1/admin/installations/8', admin()), deps)).statusCode).toBe(200)
    expect(ops.releaseClaim).toHaveBeenCalledWith(8, 'beta')
    // Approve and reject are platform-admin only (the matrix above covers every role).
    expect((await handlePlatform(ev('POST', '/v1/admin/installations/8/approve', tadmin('beta')), deps)).statusCode).toBe(403)
  })

  it('lists every claim, active and pending, with the team name', async () => {
    const { deps, ops } = platform()
    ops.listAllClaims.mockResolvedValueOnce([claimOf(7, 'acme'), claimOf(8, 'beta', 'pending')])
    const list = parse(await handlePlatform(ev('GET', '/v1/admin/installations', admin()), deps)).installations
    expect(list.map((c: InstallationClaim & { tenantName?: string }) => [c.installationId, c.status, c.tenantId, c.tenantName, c.account]))
      .toEqual([[7, 'active', 'acme', 'ACME', 'acme'], [8, 'pending', 'beta', undefined, 'beta']])
    expect(ops.listPendingClaims).not.toHaveBeenCalled()
  })

  it('releases any claim, refusing while the team\'s cells use it unless forced; force only reports the cells', async () => {
    const { deps, ops, audit } = platform()
    ops.getClaim.mockResolvedValue(claimOf(7, 'acme'))
    ops.tenantCells.mockResolvedValue([cell('acme', 1), { ...cell('acme', 2), status: 'disabled' }, cell('acme', 3, 99)])
    const refused = await handlePlatform(ev('DELETE', '/v1/admin/installations/7', admin()), deps)
    expect([refused.statusCode, parse(refused).error, parse(refused).cells]).toEqual([409, 'installation_in_use', [{ cellId: 'acme--gh1', status: 'active', repo: 'acme/repo1' }]])
    expect(ops.tenantCells).toHaveBeenCalledWith('acme')
    expect(ops.releaseClaim).not.toHaveBeenCalled()
    expect(audit.at(-1)).toMatchObject({ op: 'admin.installation.release', tenantId: 'acme', target: '7', ok: false, error: 'HTTP 409' })
    const forced = await handlePlatform(ev('DELETE', '/v1/admin/installations/7', admin(), undefined, 'force=true'), deps)
    expect([forced.statusCode, parse(forced)]).toEqual([200, { released: true, installationId: 7, tenantId: 'acme',
      affectedCells: [{ cellId: 'acme--gh1', status: 'active', repo: 'acme/repo1' }] }])
    expect(ops.releaseClaim).toHaveBeenCalledWith(7, 'acme')
    expect(audit.at(-1)).toMatchObject({ op: 'admin.installation.release', tenantId: 'acme', target: '7:force', ok: true })
    expect((await handlePlatform(ev('DELETE', '/v1/admin/installations/7', admin(), undefined, 'force=1'), deps)).statusCode).toBe(400)
    ops.getClaim.mockResolvedValueOnce(undefined)
    expect((await handlePlatform(ev('DELETE', '/v1/admin/installations/7', admin()), deps)).statusCode).toBe(404)
    ops.releaseClaim.mockResolvedValueOnce(false)
    expect(parse(await handlePlatform(ev('DELETE', '/v1/admin/installations/7', admin(), undefined, 'force=true'), deps)).error).toBe('claim_changed')
  })

  it('creates tenants (reserved ids are refused by ops) and invites the first tenant admin', async () => {
    const { deps, ops } = platform()
    ops.tenantAdd.mockRejectedValueOnce(new (await import('../src/admin/ops.ts')).AdminError('tenant id admin is reserved'))
    const res = await handlePlatform(ev('POST', '/v1/admin/tenants', admin(), { tenantId: 'admin', name: 'x' }), deps)
    expect(res.statusCode).toBe(400)
    expect(parse(res).message).toMatch(/reserved/)
    await handlePlatform(ev('POST', '/v1/admin/users', admin(), { email: 'a@x.io', role: 'tadmin', tenantId: 'acme' }), deps)
    expect(ops.userInvite).toHaveBeenCalledWith('a@x.io', 'acme', 'tadmin')
    expect((await handlePlatform(ev('DELETE', '/v1/admin/users/root%40example.com', admin()), deps)).statusCode).toBe(400)
  })
})

describe('host discovery and client', () => {
  const lease = (leaseKey: string, expiresAt = NOW + 20_000, endpoint = `http://10.0.0.${leaseKey.length}:8080`) => ({ leaseKey, endpoint, expiresAt })
  it('prefers a host presence lease, then the tenant Connector, then any cell; never an expiring one', () => {
    expect(pickHost([lease('cell#a--gh1'), lease('connector#acme'), lease('host#t1')], 'acme', NOW)).toBe('http://10.0.0.7:8080')
    expect(pickHost([lease('cell#a--gh1'), lease('connector#acme')], 'acme', NOW)).toBe('http://10.0.0.14:8080')
    expect(pickHost([lease('cell#a--gh1'), lease('connector#beta')], 'acme', NOW)).toBe('http://10.0.0.11:8080')
    expect(pickHost([lease('host#t1', NOW + 1000)], 'acme', NOW)).toBeUndefined()
  })
  it('signs the tenant target and maps host answers', async () => {
    const forward = vi.fn(async () => ({ status: 200, body: JSON.stringify({ repositories: repos, truncated: false }) }))
    const proof = vi.fn(async (target: string) => `https://sts/?t=${target}`)
    const client = hostClient({ directory: { endpoint: async () => 'http://10.0.0.1:8080' }, callerProof: proof, forward, now: () => NOW })
    const res = await client.repositories('acme', 7, { sub: 'u', groups: [], platformAdmin: false }, 'tadmin')
    expect(res).toMatchObject({ ok: true, truncated: false })
    const req = (forward.mock.calls[0] as unknown as [{ url: string; headers: Record<string, string> }])[0]
    expect(req.url).toBe('http://10.0.0.1:8080/tenants/acme/github/installations/7/repositories')
    expect(req.headers['x-dshsa-target']).toBe('tenant:acme')
    expect(req.headers['x-dshsa-role']).toBe('tadmin')
    expect(proof).toHaveBeenCalledWith('tenant:acme')
    for (const [status, reason] of [[401, 'auth_rejected'], [403, 'not_claimed'], [404, 'installation_not_found'], [502, 'github_error'], [503, 'host_unavailable']] as const) {
      forward.mockResolvedValueOnce({ status, body: '{}' })
      expect(await client.repositories('acme', 7, { sub: 'u', groups: [], platformAdmin: false }, 'tadmin')).toEqual({ ok: false, reason })
    }
  })
})

describe('DynamoOnboarding claim conditions (v6.2)', () => {
  const conditional = () => { throw Object.assign(new Error('c'), { name: 'ConditionalCheckFailedException' }) }
  const fakeDb = (onPut: () => unknown, held?: InstallationClaim) => {
    const sent: { name: string; input: Record<string, any> }[] = []
    const db = { send: async (cmd: { constructor: { name: string }; input: Record<string, any> }) => {
      sent.push({ name: cmd.constructor.name, input: cmd.input })
      if (cmd.constructor.name === 'PutCommand') return onPut()
      if (cmd.constructor.name === 'GetCommand') return { Item: held }
      if (cmd.constructor.name === 'UpdateCommand') return {}
      return {}
    } }
    return { db: db as never, sent }
  }
  const claim = (status: 'active' | 'pending', tenantId = 'acme') => ({ ...claimOf(5, tenantId, status), githubLogin: 'me' })

  it('an active write may replace the tenant\'s own claim; a pending write only a pending one', async () => {
    const { DynamoOnboarding } = await import('../src/setup/onboarding.ts')
    const active = fakeDb(() => ({}))
    expect(await new DynamoOnboarding(active.db, 't').claim(claim('active'))).toBe('active')
    expect(active.sent[0]!.input.ConditionExpression).toBe('attribute_not_exists(#k) OR tenantId = :t')
    const pending = fakeDb(() => ({}))
    expect(await new DynamoOnboarding(pending.db, 't').claim(claim('pending'))).toBe('pending')
    expect(pending.sent[0]!.input).toMatchObject({ ConditionExpression: 'attribute_not_exists(#k) OR (tenantId = :t AND #st = :pending)',
      ExpressionAttributeValues: { ':t': 'acme', ':pending': 'pending' } })
  })
  it('classifies a refused write: own active claim kept, otherwise another tenant', async () => {
    const { DynamoOnboarding } = await import('../src/setup/onboarding.ts')
    expect(await new DynamoOnboarding(fakeDb(conditional, claim('active')).db, 't').claim(claim('pending'))).toBe('active')
    expect(await new DynamoOnboarding(fakeDb(conditional, claim('pending', 'beta')).db, 't').claim(claim('active'))).toBe('other_tenant')
  })
  it('a tenant release is conditional on the tenant; listing all claims never returns nonces', async () => {
    const { DynamoOnboarding } = await import('../src/setup/onboarding.ts')
    const k = fakeDb(() => ({}))
    const store = new DynamoOnboarding(k.db, 't')
    expect(await store.releaseClaim(5, 'acme')).toBe(true)
    expect(k.sent[0]!.input).toMatchObject({ Key: { key: 'ghinst#5' }, ConditionExpression: 'attribute_exists(#k) AND tenantId = :t',
      ExpressionAttributeValues: { ':t': 'acme' } })
    await store.releaseClaim(5)
    expect(k.sent[1]!.input.ConditionExpression).toBe('attribute_exists(#k)')
    expect(k.sent[1]!.input.ExpressionAttributeValues).toBeUndefined()
    await store.listAllClaims()
    expect(k.sent[2]).toMatchObject({ name: 'ScanCommand', input: { FilterExpression: 'begins_with(#k, :p)', ExpressionAttributeValues: { ':p': 'ghinst#' } } })
    await store.listPending()
    expect(k.sent[3]!.input).toMatchObject({ FilterExpression: 'begins_with(#k, :p) AND #st = :st', ExpressionAttributeValues: { ':p': 'ghinst#', ':st': 'pending' } })
    expect(await new DynamoOnboarding({ send: async () => conditional() } as never, 't').releaseClaim(5, 'beta')).toBe(false)
  })
  it('approve only flips a pending claim and records the approver', async () => {
    const { DynamoOnboarding } = await import('../src/setup/onboarding.ts')
    const k = fakeDb(() => ({}))
    expect(await new DynamoOnboarding(k.db, 't').approveClaim(5, 'root@x.io', '2026-11-01T00:00:00Z')).toBe(true)
    expect(k.sent[0]!.input).toMatchObject({ Key: { key: 'ghinst#5' }, ConditionExpression: 'attribute_exists(#k) AND #st = :pending',
      UpdateExpression: 'SET #st = :active, approvedBy = :by, approvedAt = :at REMOVE pendingReason' })
  })
})
