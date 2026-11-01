import { generateKeyPairSync } from 'node:crypto'
import { expect, it } from 'vitest'
import { MAX_REPOSITORIES, installationRepositories, type InstallationDeps } from '../src/installations.ts'

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
const claim = (tenantId: string, installationId = 42, status: string = 'active') => ({ key: `ghinst#${installationId}`, tenantId, installationId, status,
  account: 'acme', accountType: 'Organization', githubLogin: 'alice', claimedBy: 'sub-1', claimedAt: '2026-11-01T00:00:00Z' })
const repo = (id: number) => ({ id, name: `r${id}`, full_name: `acme/r${id}`, owner: { login: 'acme' }, private: id % 2 === 0, archived: false, default_branch: 'main' })
interface Sent { url: string; method: string; body?: string; auth?: string }

function deps(options: { claim?: unknown; app?: boolean; pages?: unknown[][]; tokenStatus?: number; pageStatus?: number; nextOverride?: string } = {}) {
  const sent: Sent[] = []
  const pages = options.pages ?? [[repo(1), repo(2)]]
  const value: InstallationDeps = {
    claim: async () => 'claim' in options ? options.claim : claim('acme'),
    app: async () => options.app === false ? undefined : { appId: '123', privateKey },
    fetch: async (url, init) => {
      sent.push({ url, method: init.method ?? 'GET', ...init.body ? { body: init.body } : {}, ...init.headers.authorization ? { auth: init.headers.authorization } : {} })
      if (url.endsWith('/access_tokens')) {
        const status = options.tokenStatus ?? 201
        return { ok: status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify({ token: 'ghs_x', expires_at: '2026-11-01T01:00:00Z' }) }
      }
      const page = Number(new URL(url).searchParams.get('page') ?? '1')
      const status = options.pageStatus ?? 200
      const next = page < pages.length ? (options.nextOverride ?? `https://api.github.com/installation/repositories?per_page=100&page=${page + 1}`) : undefined
      return { ok: status < 300, status, headers: { get: (name: string) => name === 'link' && next ? `<${next}>; rel="next"` : null },
        text: async () => JSON.stringify({ total_count: 0, repositories: pages[page - 1] ?? [] }) }
    },
  }
  return { value, sent }
}

it('lists every page of a claimed installation with a metadata-only token', async () => {
  const d = deps({ pages: [[repo(1), repo(2)], [repo(3)]] })
  const result = await installationRepositories(d.value, 'acme', 42)
  expect(result).toEqual({ ok: true, truncated: false, repositories: [
    { id: 1, name: 'r1', owner: 'acme', fullName: 'acme/r1', private: false, archived: false, defaultBranch: 'main' },
    { id: 2, name: 'r2', owner: 'acme', fullName: 'acme/r2', private: true, archived: false, defaultBranch: 'main' },
    { id: 3, name: 'r3', owner: 'acme', fullName: 'acme/r3', private: false, archived: false, defaultBranch: 'main' }] })
  expect(d.sent[0]).toMatchObject({ url: 'https://api.github.com/app/installations/42/access_tokens', method: 'POST' })
  expect(JSON.parse(d.sent[0]!.body!)).toEqual({ permissions: { metadata: 'read' } })
  expect(d.sent.slice(1).map(item => [item.url, item.auth])).toEqual([
    ['https://api.github.com/installation/repositories?per_page=100', 'Bearer ghs_x'],
    ['https://api.github.com/installation/repositories?per_page=100&page=2', 'Bearer ghs_x']])
})
it('refuses an installation not claimed by this tenant before touching GitHub (missing, other tenant, malformed, other id, pending, unknown status)', async () => {
  const { status: _status, ...noStatus } = claim('acme')
  for (const value of [undefined, claim('beta'), { key: 'ghinst#42', tenantId: 'acme' }, claim('acme', 43), claim('acme', 42, 'pending'),
    { ...claim('acme', 42, 'pending'), pendingReason: 'not_org_admin' }, noStatus, claim('acme', 42, 'approved')]) {
    const d = deps({ claim: value })
    expect(await installationRepositories(d.value, 'acme', 42)).toMatchObject({ ok: false, status: 403, error: 'not_claimed' })
    expect(d.sent).toEqual([])
  }
})
it('maps GitHub failures: 404 installation_not_found, others 502 github_error; no App is 502', async () => {
  expect(await installationRepositories(deps({ tokenStatus: 404 }).value, 'acme', 42)).toMatchObject({ status: 404, error: 'installation_not_found' })
  expect(await installationRepositories(deps({ tokenStatus: 500 }).value, 'acme', 42)).toMatchObject({ status: 502, error: 'github_error' })
  expect(await installationRepositories(deps({ pageStatus: 403 }).value, 'acme', 42)).toMatchObject({ status: 502, error: 'github_error' })
  expect(await installationRepositories(deps({ app: false }).value, 'acme', 42)).toMatchObject({ status: 502, error: 'github_error' })
})
it('never follows pagination outside the installation listing with the token', async () => {
  const d = deps({ pages: [[repo(1)], [repo(2)]], nextOverride: 'https://evil.example/steal' })
  expect(await installationRepositories(d.value, 'acme', 42)).toMatchObject({ ok: false, status: 502 })
  expect(d.sent.some(item => item.url.startsWith('https://evil'))).toBe(false)
})
it(`stops at ${MAX_REPOSITORIES} repositories and says so`, async () => {
  const pages = Array.from({ length: 11 }, (_, page) => Array.from({ length: 100 }, (_, index) => repo(page * 100 + index + 1)))
  const result = await installationRepositories(deps({ pages }).value, 'acme', 42)
  expect(result).toMatchObject({ ok: true, truncated: true })
  expect(result.ok && result.repositories.length).toBe(MAX_REPOSITORIES)
})
