import type { CellRecord, LeaseRecord, TenantRecord } from '@dshsa/contracts'
import { describe, expect, it, vi } from 'vitest'
import { PLATFORM_ADMIN_GROUP, parseGroups, principalFrom } from '../src/authz.ts'
import type { ForwardRequest } from '../src/forward.ts'
import { type Deps, type HttpEvent, MAX_BODY_BYTES, handle } from '../src/handler.ts'
import type { ChatBinding, Repo } from '../src/repo.ts'
import { CELL_ROUTES, matchCellRoute } from '../src/routes.ts'
import { parseJsonl, type Transcript } from '../src/transcript.ts'

const NOW = Date.parse('2026-11-01T00:00:00Z')
const tenant = (tenantId: string, status: 'active' | 'disabled' = 'active'): TenantRecord =>
  ({ tenantId, name: tenantId.toUpperCase(), cognitoGroup: `dshsa-tenant-${tenantId}`, status, createdAt: '2026-11-01T00:00:00Z' })
const cell = (tenantId: string, repoId: number): CellRecord => ({
  cellId: `${tenantId}--gh${repoId}`, tenantId, status: 'active', stateBucketPrefix: `cells/${tenantId}--gh${repoId}/`,
  queueUrl: `https://sqs.us-west-2.amazonaws.com/1/dshsa-cell-${tenantId}--gh${repoId}.fifo`, createdAt: '2026-11-01T00:00:00Z',
  repo: { owner: tenantId, name: `repo${repoId}`, id: repoId, installationId: 9, defaultBranch: 'main' },
})

class FakeRepo implements Repo {
  tenants = new Map([['acme', tenant('acme')], ['beta', tenant('beta')], ['gone', tenant('gone', 'disabled')]])
  cells = new Map([cell('acme', 1), cell('acme', 2), cell('beta', 3), cell('gone', 4)].map(c => [c.cellId, c]))
  leases = new Map<string, LeaseRecord>()
  bindings = new Map<string, ChatBinding>()
  async getTenant(id: string) { return this.tenants.get(id) }
  async listTenants() { return [...this.tenants.values()] }
  async getCell(id: string) { return this.cells.get(id) }
  async listCellsByTenant(t: string) { return [...this.cells.values()].filter(c => c.tenantId === t) }
  async getLease(k: string) { return this.leases.get(k) }
  async listChatBindings(t: string) { return [...this.bindings.values()].filter(b => b.tenantId === t) }
  async putChatBinding(b: ChatBinding) { this.bindings.set(`${b.tenantId}#${b.chatId}`, b) }
  async deleteChatBinding(t: string, chat: string) { return this.bindings.delete(`${t}#${chat}`) }
}

function setup() {
  const repo = new FakeRepo()
  const forward = vi.fn(async (_req: ForwardRequest) => ({ status: 200, body: '{"ok":1}', contentType: 'application/json' }))
  const transcripts = { read: vi.fn(async (): Promise<Transcript | undefined> => ({ entries: [{ type: 'user' }], truncated: false })) }
  const deps: Deps = { repo, forward, callerProof: async (cellId: string) => `https://sts.ap-northeast-1.amazonaws.com/?proof=${cellId}`, transcripts, now: () => NOW }
  return { repo, forward, transcripts, deps }
}
const tadmin = (tenantId: string, sub = 'u-1') => user([`dshsa-tenant-${tenantId}`, `dshsa-tadmin-${tenantId}`], sub)
const user = (groups: string[] | string, sub = 'u-1') => ({ sub, email: `${sub}@example.com`, 'cognito:groups': groups })
const ev = (method: string, path: string, claims: Record<string, unknown> | undefined, extra: Partial<HttpEvent> = {}): HttpEvent =>
  ({ rawPath: path, requestContext: { http: { method }, authorizer: claims ? { jwt: { claims } } : undefined }, ...extra })
const body = (r: { body: string }) => JSON.parse(r.body) as Record<string, unknown>
const live = (repo: FakeRepo, cellId: string, expiresAt = NOW + 20_000) =>
  repo.leases.set(`cell#${cellId}`, { leaseKey: `cell#${cellId}`, owner: 'task-1', endpoint: 'http://10.40.1.5:8080', fence: 3, expiresAt })

describe('authz claims', () => {
  it('parses cognito:groups as array, bracketed string, or comma list', () => {
    expect(parseGroups(['a', 'b'])).toEqual(['a', 'b'])
    expect(parseGroups('[dshsa-tenant-acme dshsa-platform-admin]')).toEqual(['dshsa-tenant-acme', 'dshsa-platform-admin'])
    expect(parseGroups('a,b')).toEqual(['a', 'b'])
    expect(parseGroups(undefined)).toEqual([])
  })
  it('requires a sub', () => {
    expect(principalFrom({ email: 'x' })).toBeUndefined()
    expect(principalFrom(user([PLATFORM_ADMIN_GROUP]))?.platformAdmin).toBe(true)
  })
})

describe('panel-api', () => {
  it('rejects a request without authorizer claims (fail closed)', async () => {
    const { deps } = setup()
    expect((await handle(ev('GET', '/v1/cells', undefined), deps)).statusCode).toBe(401)
  })

  it('lists only the caller tenant cells', async () => {
    const { deps } = setup()
    const res = await handle(ev('GET', '/v1/cells', user('[dshsa-tenant-acme]')), deps)
    expect(res.statusCode).toBe(200)
    expect((body(res).cells as { cellId: string }[]).map(c => c.cellId)).toEqual(['acme--gh1', 'acme--gh2'])
    const me = body(await handle(ev('GET', '/v1/me', user(['dshsa-tenant-acme', 'dshsa-tenant-gone'])), deps))
    expect(me.tenants).toEqual([{ tenantId: 'acme', name: 'ACME', role: 'member' }])
    const meAdmin = body(await handle(ev('GET', '/v1/me', tadmin('acme')), deps))
    expect(meAdmin.tenants).toEqual([{ tenantId: 'acme', name: 'ACME', role: 'tadmin' }])
  })

  it('returns 403 for a cell of another tenant, and for an unknown cell, without forwarding', async () => {
    const { deps, repo, forward } = setup()
    live(repo, 'acme--gh1')
    const b = user(['dshsa-tenant-beta'], 'u-b')
    for (const path of ['/v1/cells/acme--gh1/api/tickets', '/v1/cells/acme--gh999/api/tickets', '/v1/cells/acme--gh1/tickets/t1/transcript']) {
      const res = await handle(ev('GET', path, b), deps)
      expect(res.statusCode, path).toBe(403)
    }
    expect((await handle(ev('POST', '/v1/cells/acme--gh1/api/tickets/t1/stop', b), deps)).statusCode).toBe(403)
    expect(forward).not.toHaveBeenCalled()
  })

  it('returns 403 for a disabled tenant even to its members', async () => {
    const { deps, repo } = setup()
    live(repo, 'gone--gh4')
    expect((await handle(ev('GET', '/v1/cells/gone--gh4/api/state', user(['dshsa-tenant-gone'])), deps)).statusCode).toBe(403)
  })

  it('returns 503 cell_unavailable when the lease is missing or expired', async () => {
    const { deps, repo, forward } = setup()
    const a = user(['dshsa-tenant-acme'])
    let res = await handle(ev('GET', '/v1/cells/acme--gh1/api/state', a), deps)
    expect(res.statusCode).toBe(503)
    expect(body(res).error).toBe('cell_unavailable')
    live(repo, 'acme--gh1', NOW - 1)
    res = await handle(ev('GET', '/v1/cells/acme--gh1/api/state', a), deps)
    expect(res.statusCode).toBe(503)
    // Inside the holder's stop window (it stops the cell before expiry, parent design §4.2).
    live(repo, 'acme--gh1', NOW + 4_000)
    expect((await handle(ev('GET', '/v1/cells/acme--gh1/api/state', a), deps)).statusCode).toBe(503)
    // A malformed or non-plain-http endpoint is unavailable, not a 500.
    for (const endpoint of ['not a url', 'https://10.40.1.5:8080', 'http://u:p@10.40.1.5:8080', 'http://10.40.1.5:8080/x']) {
      repo.leases.set('cell#acme--gh1', { leaseKey: 'cell#acme--gh1', owner: 't', endpoint, fence: 1, expiresAt: NOW + 20_000 })
      expect((await handle(ev('GET', '/v1/cells/acme--gh1/api/state', a), deps)).statusCode, endpoint).toBe(503)
    }
    expect(forward).not.toHaveBeenCalled()
  })

  it('forwards an allowlisted route to the lease owner with the internal secret and actor', async () => {
    const { deps, repo, forward } = setup()
    live(repo, 'acme--gh1')
    const res = await handle(ev('POST', '/v1/cells/acme--gh1/api/tickets/t%201/stop', user(['dshsa-tenant-acme']),
      { body: '{}', rawQueryString: 'x=1' }), deps)
    expect(res.statusCode).toBe(200)
    const req = forward.mock.calls[0]![0]
    expect(req.url).toBe('http://10.40.1.5:8080/acme--gh1/api/tickets/t%201/stop?x=1')
    expect(req.headers['x-dshsa-caller']).toBe('https://sts.ap-northeast-1.amazonaws.com/?proof=acme--gh1')
    expect(req.headers['x-dshsa-target']).toBe('acme--gh1')
    expect(req.headers['x-dshsa-internal']).toBeUndefined()
    expect(req.headers['x-dshsa-role']).toBe('member')
    expect(JSON.parse(Buffer.from(req.headers['x-dshsa-actor']!, 'base64url').toString())).toEqual({ sub: 'u-1', email: 'u-1@example.com' })
    expect(req.body).toBe('{}')
    // Segments are forwarded in canonical form (decoded, then re-encoded).
    await handle(ev('PUT', '/v1/cells/acme--gh1/api/settings/source:github', tadmin('acme'), { body: '{}' }), deps)
    expect(forward.mock.calls[1]![0].url).toBe('http://10.40.1.5:8080/acme--gh1/api/settings/source%3Agithub')
    expect(forward.mock.calls[1]![0].headers['x-dshsa-role']).toBe('tadmin')
  })

  it('decodes a base64 body before forwarding and measures the decoded size', async () => {
    const { deps, repo, forward } = setup()
    live(repo, 'acme--gh1')
    const a = tadmin('acme')
    const payload = JSON.stringify({ paused: true })
    const ok = await handle(ev('POST', '/v1/cells/acme--gh1/api/executor/pause', a,
      { body: Buffer.from(payload).toString('base64'), isBase64Encoded: true }), deps)
    expect(ok.statusCode).toBe(200)
    expect(forward.mock.calls[0]![0].body).toBe(payload)
    const big = Buffer.from('x'.repeat(MAX_BODY_BYTES + 1)).toString('base64')
    expect((await handle(ev('PUT', '/v1/cells/acme--gh1/api/prompts', a, { body: big, isBase64Encoded: true }), deps)).statusCode).toBe(413)
    expect((await handle(ev('GET', '/v1/cells/acme--gh1/api/state', a, { body: '{}' }), deps)).statusCode).toBe(400)
  })

  it('maps an upstream 401 (caller proof refused) to 503 and logs an error', async () => {
    const { deps, repo, forward } = setup()
    live(repo, 'acme--gh1')
    const log = vi.fn()
    Object.assign(deps, { log })
    forward.mockResolvedValueOnce({ status: 401, body: '{"error":"unauthorized"}', contentType: 'application/json' })
    const res = await handle(ev('GET', '/v1/cells/acme--gh1/api/state', user(['dshsa-tenant-acme'])), deps)
    expect(res.statusCode).toBe(503)
    expect(body(res).error).toBe('cell_unavailable')
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ level: 'error', msg: 'internal_auth_rejected', cellId: 'acme--gh1' }))
    // Other upstream statuses still pass through unchanged.
    forward.mockResolvedValueOnce({ status: 404, body: '{"error":"Ticket not found"}', contentType: 'application/json' })
    expect((await handle(ev('GET', '/v1/cells/acme--gh1/api/tickets/x', user(['dshsa-tenant-acme'])), deps)).statusCode).toBe(404)
  })

  it('lets a platform admin reach any active tenant', async () => {
    const { deps, repo } = setup()
    live(repo, 'beta--gh3')
    expect((await handle(ev('GET', '/v1/cells/beta--gh3/api/overview', user([PLATFORM_ADMIN_GROUP])), deps)).statusCode).toBe(200)
  })

  it('maps upstream errors through and network failures to 503', async () => {
    const { deps, repo, forward } = setup()
    live(repo, 'acme--gh1')
    forward.mockResolvedValueOnce({ status: 409, body: '{"error":"stale"}', contentType: 'application/json' })
    expect((await handle(ev('PUT', '/v1/cells/acme--gh1/api/settings/policy', tadmin('acme'), { body: '{}' }), deps)).statusCode).toBe(409)
    forward.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    expect((await handle(ev('GET', '/v1/cells/acme--gh1/api/state', user(['dshsa-tenant-acme'])), deps)).statusCode).toBe(503)
  })

  it('refuses non-allowlisted routes and oversized bodies', async () => {
    const { deps, repo, forward } = setup()
    live(repo, 'acme--gh1')
    const a = tadmin('acme')
    for (const [m, p] of [['POST', 'worker/token-refresh'], ['DELETE', 'tickets/t1'], ['GET', 'tickets/../worker'], ['GET', 'tickets/a%2Fb'],
      // Encoded dot segments: fetch's URL parser would turn `tickets/%2e%2e/stop` into `stop` one level up.
      ['GET', 'tickets/%2e%2e'], ['POST', 'tickets/%2E%2e/stop'], ['GET', 'threads/.%2e'], ['GET', 'tickets/%2e'], ['GET', 'tickets/a%5Cb'],
      ['GET', 'tickets/%E0%A4%A'], ['GET', 'tickets/a%00b']]) {
      expect((await handle(ev(m!, `/v1/cells/acme--gh1/api/${p}`, a), deps)).statusCode, p).toBe(404)
    }
    const big = 'x'.repeat(MAX_BODY_BYTES + 1)
    expect((await handle(ev('PUT', '/v1/cells/acme--gh1/api/prompts', a, { body: big }), deps)).statusCode).toBe(413)
    expect(forward).not.toHaveBeenCalled()
  })

  it('serves the transcript for an own ticket', async () => {
    const { deps, transcripts } = setup()
    const res = await handle(ev('GET', '/v1/cells/acme--gh1/tickets/T-1/transcript', user(['dshsa-tenant-acme'])), deps)
    expect(res.statusCode).toBe(200)
    expect(transcripts.read).toHaveBeenCalledWith('acme', 'acme--gh1', 'T-1')
  })

  it('passes the transcript\'s agent through (v7 Codex rollouts)', async () => {
    const { deps, transcripts } = setup()
    transcripts.read.mockResolvedValueOnce({ entries: [{ type: 'event_msg' }], truncated: false, updatedAt: '2026-11-03T11:14:00.000Z', agent: 'codex' })
    const res = await handle(ev('GET', '/v1/cells/acme--gh1/tickets/T-1/transcript', user(['dshsa-tenant-acme'])), deps)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body as string)).toEqual({ entries: [{ type: 'event_msg' }], truncated: false, updatedAt: '2026-11-03T11:14:00.000Z', agent: 'codex' })
  })

  it('manages chat bindings only within the tenant', async () => {
    const { deps, repo } = setup()
    // Members may read bindings but not change them.
    expect((await handle(ev('PUT', '/v1/tenants/acme/chat-bindings/oc_abc', user(['dshsa-tenant-acme']), { body: JSON.stringify({ cellId: 'acme--gh2' }) }), deps)).statusCode).toBe(403)
    expect((await handle(ev('GET', '/v1/tenants/acme/chat-bindings', user(['dshsa-tenant-acme'])), deps)).statusCode).toBe(200)
    const a = tadmin('acme')
    expect((await handle(ev('PUT', '/v1/tenants/acme/chat-bindings/oc_abc', a, { body: JSON.stringify({ cellId: 'acme--gh2', chatName: 'dev' }) }), deps)).statusCode).toBe(200)
    expect(repo.bindings.get('acme#oc_abc')?.cellId).toBe('acme--gh2')
    // A cell of another tenant cannot be the target.
    expect((await handle(ev('PUT', '/v1/tenants/acme/chat-bindings/oc_abc', a, { body: JSON.stringify({ cellId: 'beta--gh3' }) }), deps)).statusCode).toBe(400)
    expect((await handle(ev('PUT', '/v1/tenants/acme/chat-bindings/bad', a, { body: JSON.stringify({ cellId: 'acme--gh2' }) }), deps)).statusCode).toBe(400)
    const list = body(await handle(ev('GET', '/v1/tenants/acme/chat-bindings', a), deps))
    expect((list.bindings as unknown[]).length).toBe(1)
    // Another tenant can neither read nor delete it.
    const b = tadmin('beta', 'u-b')
    expect((await handle(ev('GET', '/v1/tenants/acme/chat-bindings', b), deps)).statusCode).toBe(403)
    expect((await handle(ev('DELETE', '/v1/tenants/acme/chat-bindings/oc_abc', b), deps)).statusCode).toBe(403)
    expect((await handle(ev('DELETE', '/v1/tenants/acme/chat-bindings/oc_abc', a), deps)).statusCode).toBe(200)
    expect((await handle(ev('DELETE', '/v1/tenants/acme/chat-bindings/oc_abc', a), deps)).statusCode).toBe(404)
  })

  it('audits every chat-binding mutation (R7), and no read or refused call', async () => {
    const { deps } = setup()
    const logs: Record<string, unknown>[] = []
    deps.log = entry => logs.push(entry)
    await handle(ev('GET', '/v1/tenants/acme/chat-bindings', tadmin('acme')), deps)
    await handle(ev('PUT', '/v1/tenants/acme/chat-bindings/oc_abc', user(['dshsa-tenant-acme']), { body: JSON.stringify({ cellId: 'acme--gh2' }) }), deps)
    await handle(ev('PUT', '/v1/tenants/acme/chat-bindings/oc_abc', tadmin('acme'), { body: JSON.stringify({ cellId: 'acme--gh2' }) }), deps)
    await handle(ev('PUT', '/v1/tenants/acme/chat-bindings/oc_abc', tadmin('acme'), { body: JSON.stringify({ cellId: 'beta--gh3' }) }), deps)
    await handle(ev('DELETE', '/v1/tenants/acme/chat-bindings/oc_abc', tadmin('acme')), deps)
    expect(logs.filter(l => l.msg === 'audit').map(l => [l.op, l.target, l.ok, l.role, (l.actor as { sub: string }).sub])).toEqual([
      ['panel.chat.bind', 'oc_abc', true, 'tadmin', 'u-1'], ['panel.chat.bind', 'oc_abc', false, 'tadmin', 'u-1'], ['panel.chat.unbind', 'oc_abc', true, 'tadmin', 'u-1'],
    ])
  })
})

describe('cell route authz matrix (onboarding design §1)', () => {
  // Every allowlisted cell route × role: members read and Stop/Retry; tenant admins and platform admins everything;
  // a tenant admin of another tenant nothing. A route path with `:x` placeholders is filled with `x1`.
  const concrete = (route: string) => route.split(' ')[1]!.replace(/:[a-z]+/g, 'x1')
  it.each(CELL_ROUTES.map(r => [r]))('%s', async route => {
    const { deps, repo } = setup()
    live(repo, 'acme--gh1')
    const method = route.split(' ')[0]!
    const call = (claims: Record<string, unknown>) => handle(ev(method, `/v1/cells/acme--gh1/api/${concrete(route)}`, claims,
      method === 'GET' ? {} : { body: '{}' }), deps).then(r => r.statusCode)
    const memberMay = method === 'GET' || route === 'POST tickets/:id/stop' || route === 'POST tickets/:id/retry'
    expect(await call(user(['dshsa-tenant-acme'])), 'member').toBe(memberMay ? 200 : 403)
    expect(await call(tadmin('acme')), 'tadmin').toBe(200)
    expect(await call(user([PLATFORM_ADMIN_GROUP])), 'admin').toBe(200)
    expect(await call(tadmin('beta')), 'other tenant admin').toBe(403)
    // A tenant-admin group without membership of the tenant group grants nothing.
    expect(await call(user(['dshsa-tadmin-acme'])), 'tadmin group alone').toBe(403)
  })
})

describe('routes and transcript parsing', () => {
  it('matches DSH routes by method and shape', () => {
    expect(matchCellRoute('GET', 'tickets')).toBe('GET tickets')
    expect(matchCellRoute('post', 'tickets/abc/retry')).toBe('POST tickets/:id/retry')
    expect(matchCellRoute('PUT', 'settings/source:github')).toBe('PUT settings/:block')
    expect(matchCellRoute('GET', 'tickets/abc/retry')).toBeUndefined()
    expect(matchCellRoute('GET', 'tickets//x')).toBeUndefined()
    expect(matchCellRoute('GET', 'tickets/%2e%2e')).toBeUndefined()
    expect(matchCellRoute('POST', 'tickets/t%201/stop')).toBe('POST tickets/:id/stop')
  })
  it('drops a cut first line and bad lines', () => {
    expect(parseJsonl('{"a":1}\n{"b":2}\n{bad\n', false).entries).toEqual([{ a: 1 }, { b: 2 }])
    expect(parseJsonl('":1}\n{"b":2}\n', true)).toEqual({ entries: [{ b: 2 }], truncated: true })
  })
})
