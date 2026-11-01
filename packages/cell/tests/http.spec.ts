import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { internalServer } from '../src/server.ts'
import { CallerRefused } from '../src/caller.ts'
import { CELL_ID, chatEnvelope, makeCell, quiet } from './fixtures/cell.ts'

let cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups) await cleanup(); cleanups = [] })

async function serve() {
  const made = makeCell()
  made.cell.start()
  const server = internalServer({ log: quiet, verify: async (presigned, _cell, area) => {
    if (presigned !== `ok-${area}`) throw new CallerRefused('refused'); return `arn:${area}` }, cells: { get: id => id === CELL_ID ? made.cell : undefined, list: () => [CELL_ID] } })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  cleanups.push(async () => { server.close(); await made.cleanup() })
  // `role` is what panel-api forwards in x-dshsa-role (v6); these route tests act as a platform admin unless they say otherwise.
  const call = (path: string, init: RequestInit & { secret?: string; role?: string | null } = {}) => {
    const area = path.split('/')[2] ?? 'api'
    const caller = init.secret === undefined ? `ok-${area}` : init.secret
    const role = init.role === undefined ? 'admin' : init.role
    return fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', ...caller ? { 'x-dshsa-caller': caller } : {}, ...role ? { 'x-dshsa-role': role } : {} } })
  }
  return { made, call }
}

describe('internal HTTP', () => {
  it('refuses a request without a verified caller, or with the caller of the other area', async () => {
    const { call } = await serve()
    expect((await call(`/${CELL_ID}/api/state`, { secret: '' })).status).toBe(401)
    expect((await call(`/${CELL_ID}/api/state`, { secret: 'nope' })).status).toBe(401)
    expect((await call(`/${CELL_ID}/api/state`, { secret: 'ok-worker' })).status).toBe(401)
    expect((await call(`/${CELL_ID}/worker/token-refresh`, { method: 'POST', body: '{}', secret: 'ok-api' })).status).toBe(401)
    expect((await call('/healthz', { secret: '' })).status).toBe(200)
  })
  it('answers 503 cell_unavailable for a cell this task does not hold', async () => {
    const { call } = await serve()
    const response = await call('/other--gh1/api/state')
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'cell_unavailable' })
  })
  it('serves the DSH management routes: state, tickets, settings save with revision conflict, pause', async () => {
    const { made, call } = await serve()
    await made.cell.handle(chatEnvelope({ id: '1', thread: '3', from: 'alice', text: 'hello', at: '2026-11-01T00:00:01Z', mention: true }))
    const state = await (await call(`/${CELL_ID}/api/state`)).json() as { paused: boolean; setup: { accounts: { repository: string; agent: string } } }
    expect(state).toMatchObject({ paused: false, setup: { accounts: { repository: 'acme/widgets', agent: 'dshsa-agent[bot]' } } })
    expect((await call(`/${CELL_ID}/api/tickets`)).status).toBe(200)
    const settings = await (await call(`/${CELL_ID}/api/settings`)).json() as Record<string, unknown>
    expect(settings).toBeTypeOf('object')
    const stale = await call(`/${CELL_ID}/api/settings/eval`, { method: 'PUT', body: JSON.stringify({ value: { mode: 'auto' }, revision: 99 }) })
    expect(stale.status).toBe(409)
    const saved = await call(`/${CELL_ID}/api/settings/eval`, { method: 'PUT', body: JSON.stringify({ value: { mode: 'auto' }, revision: 0 }) })
    expect(saved.status).toBe(200)
    expect(made.cell.store.settings().eval.mode).toBe('auto')
    expect(await (await call(`/${CELL_ID}/api/executor/pause`, { method: 'POST', body: JSON.stringify({ paused: true }) })).json()).toEqual({ paused: true })
    expect((await call(`/${CELL_ID}/api/tickets/nope`)).status).toBe(404)
  })
  it('worker read is limited to Feishu resources of triggers that reached the ticket', async () => {
    const { call } = await serve()
    const unknown = await call(`/${CELL_ID}/worker/read`, { method: 'POST', body: JSON.stringify({ claims: { sub: 's', tid: 'acme', cid: CELL_ID, tkt: 'nope', asg: 'a', rsid: 'r' }, resource: 'feishu/x/message' }) })
    expect(unknown.status).toBe(404)
    const github = await call(`/${CELL_ID}/worker/read`, { method: 'POST', body: JSON.stringify({ claims: { sub: 's', tid: 'acme', cid: CELL_ID, tkt: 't', asg: 'a', rsid: 'r' }, resource: 'bogus/1' }) })
    expect(github.status).toBe(400)
  })
  it('token refresh is refused unless the assignment is running', async () => {
    const { call } = await serve()
    const response = await call(`/${CELL_ID}/worker/token-refresh`, { method: 'POST', body: JSON.stringify({ claims: { sub: 's', tid: 'acme', cid: CELL_ID, tkt: 't', asg: 'a', rsid: 'r' } }) })
    expect(response.status).toBe(409)
    const other = await call(`/${CELL_ID}/worker/token-refresh`, { method: 'POST', body: JSON.stringify({ claims: { sub: 's', tid: 'x', cid: 'other--gh1', tkt: 't', asg: 'a', rsid: 'r' } }) })
    expect(other.status).toBe(403)
  })
})
