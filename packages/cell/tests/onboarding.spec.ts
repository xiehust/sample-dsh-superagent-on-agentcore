/** v6 panel onboarding on the host (design onboarding §1, §3, §5, §6): role gate, tenant route, pickers, propagation. */
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { FeishuApi, GithubApi, SourceKind } from '@dshsa/core/host'
import { z } from 'zod'
import { internalServer, memberMay, roleOf, type TenantRoutes } from '../src/server.ts'
import { CallerRefused, type CallerArea } from '../src/caller.ts'
import type { RepositoriesResult } from '../src/installations.ts'
import { CELL_ID, chatKind, makeCell, noApis, quiet } from './fixtures/cell.ts'

let cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups) await cleanup(); cleanups = [] })

const feishuApi = (members: { member_id: string; name: string }[]): FeishuApi => ({
  request: async (schema, _method, path) => schema.parse(path.includes('/members') ? { items: members, has_more: false } : {}) as never })
const githubApi = (logins: string[]): GithubApi => ({ ...noApis.github, pages: async (schema, path) => {
  expect(path).toBe('collaborators?per_page=100')
  return logins.map(login => schema.parse({ login, id: 1 })) } })

async function serve(options: { tenants?: TenantRoutes; bound?: string[]; feishu?: FeishuApi; github?: GithubApi; kinds?: SourceKind[] } = {}) {
  const made = makeCell({ ...options.kinds ? { kinds: options.kinds } : {}, apis: { github: options.github ?? noApis.github, ...options.feishu ? { feishu: options.feishu } : {} },
    boundChats: async () => options.bound ?? [] })
  made.cell.start()
  const verified: { target: string; area: CallerArea }[] = []
  const server = internalServer({ log: quiet, ...options.tenants ? { tenants: options.tenants } : {},
    verify: async (presigned, target, area) => { verified.push({ target, area }); if (presigned !== `ok-${area}`) throw new CallerRefused('refused'); return `arn:${area}` },
    cells: { get: id => id === CELL_ID ? made.cell : undefined, list: () => [CELL_ID] } })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  cleanups.push(async () => { server.close(); await made.cleanup() })
  const call = (path: string, init: RequestInit & { caller?: string; role?: string } = {}) =>
    fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', ...init.caller ? { 'x-dshsa-caller': init.caller } : {}, ...init.role ? { 'x-dshsa-role': init.role } : {} } })
  return { made, call, verified }
}
const api = (path: string) => `/${CELL_ID}/api/${path}`

describe('x-dshsa-role (fail closed)', () => {
  it('derives member for a missing or unknown role', () => {
    const req = (role?: string) => ({ headers: role === undefined ? {} : { 'x-dshsa-role': role } }) as never
    expect([roleOf(req()), roleOf(req('tadmin')), roleOf(req('admin')), roleOf(req('Admin')), roleOf(req('root'))]).toEqual(['member', 'tadmin', 'admin', 'member', 'member'])
  })
  it('lets a member read and Stop/Retry a ticket, and nothing else', () => {
    expect(memberMay('GET', 'settings')).toBe(true)
    expect(memberMay('POST', 'tickets/abc/stop')).toBe(true)
    expect(memberMay('POST', 'tickets/abc/retry')).toBe(true)
    for (const [method, path] of [['PUT', 'settings/policy'], ['PUT', 'settings/source:github'], ['PUT', 'prompts'], ['POST', 'policy-sync/github'],
      ['POST', 'executor/pause'], ['POST', 'triggers/x/requeue'], ['POST', 'threads/k/unsubscribe'], ['POST', 'tickets/a/b/stop'], ['HEAD', 'state']] as const) {
      expect(memberMay(method, path), `${method} ${path}`).toBe(false)
    }
  })
  it('answers 403 to a member (or no role) on PUT settings, PUT prompts and POST policy-sync, and serves tadmin', async () => {
    const { call, made } = await serve()
    const body = JSON.stringify({ value: { mode: 'auto' }, revision: 0 })
    for (const role of [undefined, 'member', 'bogus']) {
      const refused = await call(api('settings/eval'), { method: 'PUT', body, caller: 'ok-api', ...role ? { role } : {} })
      expect(refused.status).toBe(403)
      expect(await refused.json()).toMatchObject({ error: 'forbidden' })
    }
    expect((await call(api('prompts'), { method: 'PUT', body: '{}', caller: 'ok-api', role: 'member' })).status).toBe(403)
    expect((await call(api('policy-sync/github'), { method: 'POST', caller: 'ok-api', role: 'member' })).status).toBe(403)
    expect(made.cell.store.settings().eval.mode).not.toBe('auto')
    expect((await call(api('settings'), { caller: 'ok-api', role: 'member' })).status).toBe(200)
    expect((await call(api('tickets/nope/stop'), { method: 'POST', caller: 'ok-api', role: 'member' })).status).toBe(404)
    expect((await call(api('settings/eval'), { method: 'PUT', body, caller: 'ok-api', role: 'tadmin' })).status).toBe(200)
    expect(made.cell.store.settings().eval.mode).toBe('auto')
  })
  it('checks the caller before the role: no proof is 401 whatever the role says', async () => {
    const { call } = await serve()
    expect((await call(api('settings/eval'), { method: 'PUT', body: '{}', role: 'admin' })).status).toBe(401)
  })
})

describe('GET /tenants/{t}/github/installations/{id}/repositories', () => {
  const repos: RepositoriesResult = { ok: true, truncated: false, repositories: [{ id: 7, name: 'widgets', owner: 'acme', fullName: 'acme/widgets', private: true, archived: false, defaultBranch: 'main' }] }
  it('needs the panel-tenant caller proof signed for tenant:<t>; a cell proof or another area is 401', async () => {
    const asked: [string, number][] = []
    const { call, verified } = await serve({ tenants: { installationRepositories: async (t, id) => { asked.push([t, id]); return repos } } })
    const path = '/tenants/acme/github/installations/42/repositories'
    expect((await call(path)).status).toBe(401)
    expect((await call(path, { caller: 'ok-api' })).status).toBe(401)
    expect((await call(path, { caller: 'ok-worker' })).status).toBe(401)
    expect(asked).toEqual([])
    const ok = await call(path, { caller: 'ok-tenant' })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ repositories: repos.repositories, truncated: false })
    expect(asked).toEqual([['acme', 42]])
    expect(verified.at(-1)).toEqual({ target: 'tenant:acme', area: 'tenant' })
  })
  it('passes the refusal through, and 404s malformed paths without asking anything', async () => {
    const { call, verified } = await serve({ tenants: { installationRepositories: async () => ({ ok: false, status: 403, error: 'not_claimed', message: 'no' }) } })
    const refused = await call('/tenants/acme/github/installations/42/repositories', { caller: 'ok-tenant' })
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ error: 'not_claimed', message: 'no' })
    const before = verified.length
    for (const path of ['/tenants/ACME/github/installations/42/repositories', '/tenants/acme/github/installations/0/repositories',
      '/tenants/acme/github/installations/4x/repositories', '/tenants/acme/github/installations/42/repositories/extra', '/tenants/acme/github/installations/42']) {
      expect((await call(path, { caller: 'ok-tenant' })).status, path).toBe(404)
    }
    expect((await call('/tenants/acme/github/installations/42/repositories', { method: 'POST', caller: 'ok-tenant' })).status).toBe(404)
    expect(verified.length).toBe(before)
  })
  it('is 404 on a host without tenant routes', async () => {
    const { call } = await serve()
    expect((await call('/tenants/acme/github/installations/42/repositories', { caller: 'ok-tenant' })).status).toBe(404)
  })
})

describe('Policy form pickers', () => {
  it('lists the members of a chat bound to this cell only', async () => {
    const { call } = await serve({ bound: ['oc_bound'], feishu: feishuApi([{ member_id: 'ou_1', name: 'Ann' }, { member_id: 'ou_2', name: 'Bo' }, { member_id: 'ou_1', name: 'Ann' }]) })
    const ok = await call(api('sources/feishu/members?chat=oc_bound'), { caller: 'ok-api', role: 'member' })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ members: [{ id: 'ou_1', name: 'Ann' }, { id: 'ou_2', name: 'Bo' }] })
    const other = await call(api('sources/feishu/members?chat=oc_other'), { caller: 'ok-api', role: 'admin' })
    expect(other.status).toBe(403)
    expect(await other.json()).toMatchObject({ error: 'chat_not_bound' })
    expect((await call(api('sources/feishu/members?chat=nope'), { caller: 'ok-api' })).status).toBe(400)
    expect((await call(api('sources/feishu/members'), { caller: 'ok-api' })).status).toBe(400)
  })
  it('answers 409 when the team has no Feishu bot', async () => {
    const { call } = await serve({ bound: ['oc_bound'] })
    const response = await call(api('sources/feishu/members?chat=oc_bound'), { caller: 'ok-api' })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'feishu_not_configured' })
  })
  it('lists the repository collaborators as {id: login}', async () => {
    const { call } = await serve({ github: githubApi(['alice', 'bob', 'alice']) })
    const response = await call(api('sources/github/collaborators'), { caller: 'ok-api', role: 'member' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ collaborators: [{ id: 'alice' }, { id: 'bob' }] })
  })
  it('answers 502 github_error when GitHub fails', async () => {
    const { call } = await serve({ github: { ...noApis.github, pages: async () => { throw new Error('HTTP 500') } } })
    const response = await call(api('sources/github/collaborators'), { caller: 'ok-api' })
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: 'github_error' })
  })
})

describe('Policy refusals carry field paths rooted at the Policy (design onboarding §5)', () => {
  it('prefixes an issue only the Source kind\'s own schema finds with sources.<id>', async () => {
    // A kind whose Policy part is stricter than the shared SourcePolicySchema: allowed ids must be open_ids.
    const strict = { ...chatKind, policy: { ...chatKind.policy, schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^ou_/), name: z.string().optional() })) }) } } as SourceKind
    const { call, made } = await serve({ kinds: [strict] })
    const value = { ...made.cell.store.settings().policy, sources: { github: { allowed: [{ id: 'ou_ok' }, { id: 'alice' }] } } }
    const response = await call(api('settings/policy'), { method: 'PUT', caller: 'ok-api', role: 'admin',
      body: JSON.stringify({ value, revision: made.cell.store.blockRevision('policy') }) })
    expect(response.status).toBe(400)
    const body = await response.json() as { issues: { path: string }[] }
    expect(body.issues.map(issue => issue.path)).toEqual(['sources.github.allowed.1.id'])
  })
})
