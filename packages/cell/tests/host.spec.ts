import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HOST_LEASE_PREFIX, LeaseRecord, leaseKey, type CellRecord, type TenantRecord } from '@dshsa/contracts'
import { watchGithubApp } from '../src/main.ts'
import { HostProcess } from '../src/host.ts'
import { MemoryLeaseStore } from '../src/lease.ts'
import { MemoryCellQueue } from '../src/queue.ts'
import type { Catalog } from '../src/aws/catalog.ts'
import { CELL_ID, cellInfo, chatKind, noApis, quiet } from './fixtures/cell.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

it('stops a running cell and releases its lease when the cell disappears from the catalog', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dshsa-host-'))
  dirs.push(dataDir)
  const record = { cellId: CELL_ID, tenantId: 'acme', status: 'active' } as CellRecord
  const records = new Map([[CELL_ID, record]])
  const catalog = { activeCells: async () => [...records.values()], cell: async (id: string) => records.get(id), tenant: async () => undefined,
    feishuTenants: async () => [], route: async () => undefined, boundChats: async () => [], cellChats: async () => [] } satisfies Catalog
  const leases = new MemoryLeaseStore()
  const clock = { now: 1_000 }
  const unused = () => { throw new Error('not used in this test') }
  const host = new HostProcess({ owner: 'task-1', dataDir, maxCells: 4, maxConnectors: 0, leases, catalog, log: quiet, now: () => clock.now,
    replicator: { restore: async () => {}, replicate: () => ({ stop: async () => {} }) },
    queueFor: () => new MemoryCellQueue(Date.now, 5),
    sourcesFor: async () => ({ cell: cellInfo, apis: noApis, kinds: [chatKind] }),
    runtime: { invoke: unused }, provisioner: { ensure: unused }, tokens: {} as never, model: {} as never })
  await host.leases.tick()
  expect(host.list()).toEqual([CELL_ID])
  records.delete(CELL_ID)
  clock.now = 2_000
  await host.leases.tick()
  expect(host.list()).toEqual([])
  expect(host.leases.holding().filter(lease => lease.leaseKey.startsWith('cell#'))).toEqual([])
  expect(leases.items.get(`cell#${CELL_ID}`)).toMatchObject({ expiresAt: 0, fence: 1 })
})

describe('v6 propagation and presence', () => {
  async function hosted() {
    const dataDir = mkdtempSync(join(tmpdir(), 'dshsa-host-'))
    dirs.push(dataDir)
    const record = { cellId: CELL_ID, tenantId: 'acme', status: 'active' } as CellRecord
    const tenant = { tenantId: 'acme', name: 'Acme', cognitoGroup: 'acme', status: 'active', createdAt: '2026-11-01T00:00:00Z',
      feishu: { domain: 'feishu', appId: 'cli_1', secretArn: 'arn:secret', revision: '2026-11-01T00:00:00Z' } } as TenantRecord
    const state: { tenant: TenantRecord | undefined; tenantFails: boolean } = { tenant, tenantFails: false }
    const catalog = { activeCells: async () => [record], cell: async () => record, feishuTenants: async () => state.tenant ? [state.tenant] : [],
      tenant: async () => { if (state.tenantFails) throw new Error('throttled'); return state.tenant },
      route: async () => undefined, boundChats: async () => [], cellChats: async () => [] } satisfies Catalog
    const leases = new MemoryLeaseStore()
    const clock = { now: 1_000 }
    const events: string[] = []
    const unused = () => { throw new Error('not used in this test') }
    const host = new HostProcess({ owner: 'task-1', endpoint: 'http://10.0.0.1:8080', dataDir, maxCells: 4, maxConnectors: 2, leases, catalog, log: quiet, now: () => clock.now,
      replicator: { restore: async () => {}, replicate: () => ({ stop: async () => {} }) },
      queueFor: () => new MemoryCellQueue(Date.now, 5),
      sourcesFor: async (_record, current) => { events.push(`cell start ${current?.feishu?.revision ?? '-'}`); return { cell: cellInfo, apis: noApis, kinds: [chatKind] } },
      runtime: { invoke: unused }, provisioner: { ensure: unused }, tokens: {} as never, model: {} as never,
      connectors: { factory: current => ({ start: async () => { events.push(`connector start ${current.feishu?.revision}`) }, stop: async () => { events.push('connector stop') } }) as never,
        secrets: async () => ({}) as never, kv: () => ({}) as never, enqueue: async () => {} } })
    return { host, leases, clock, events, state }
  }
  it('holds a host#<owner> presence lease with its endpoint, so panel-tenant can find a host for a tenant without cells', async () => {
    const h = await hosted()
    await h.host.leases.tick()
    const presence = h.leases.items.get(leaseKey.host('task-1'))
    expect(presence).toMatchObject({ owner: 'task-1', endpoint: 'http://10.0.0.1:8080' })
    // panel-tenant parses it with the contracts LeaseRecord and finds it by HOST_LEASE_PREFIX.
    expect(LeaseRecord.parse(presence).leaseKey.startsWith(HOST_LEASE_PREFIX)).toBe(true)
  })
  it('restarts the Connector and the cell when the tenant\'s feishu.revision changes, and nothing when it does not or the read fails', async () => {
    const h = await hosted()
    await h.host.leases.tick()
    expect(h.events.sort()).toEqual(['cell start 2026-11-01T00:00:00Z', 'connector start 2026-11-01T00:00:00Z'])
    h.events.length = 0
    await h.host.checkRevisions()
    expect(h.events).toEqual([])
    h.state.tenantFails = true
    h.state.tenant = { ...h.state.tenant!, feishu: { ...h.state.tenant!.feishu!, revision: '2026-11-02T00:00:00Z' } }
    await h.host.checkRevisions()
    expect(h.events).toEqual([])
    h.state.tenantFails = false
    await h.host.checkRevisions()
    expect(h.events).toContain('connector stop')
    expect(h.host.list()).toEqual([])
    h.clock.now += 1_000
    await h.host.leases.tick()
    expect(h.events).toEqual(expect.arrayContaining(['connector start 2026-11-02T00:00:00Z', 'cell start 2026-11-02T00:00:00Z']))
    expect(h.host.list()).toEqual([CELL_ID])
  })
  it('restarts a cell when its tenant gains a Feishu bot', async () => {
    const h = await hosted()
    const bot = h.state.tenant!.feishu
    const { feishu: _dropped, ...withoutBot } = h.state.tenant!
    h.state.tenant = withoutBot
    await h.host.leases.tick()
    h.events.length = 0
    h.state.tenant = { ...h.state.tenant!, feishu: bot }
    await h.host.checkRevisions()
    h.clock.now += 1_000
    await h.host.leases.tick()
    expect(h.events).toContain('cell start 2026-11-01T00:00:00Z')
  })
})

describe('watchGithubApp', () => {
  it('restarts only the cells whose App slug changed when the secret version changes', async () => {
    const versions = ['v1', 'v1', 'v2']
    let slug = 'old-app'
    const restarted: string[] = []
    const stop = new AbortController()
    const host = { cellSlugs: () => new Map([['a--gh1', 'old-app'], ['b--gh2', 'new-app']]),
      restartCell: async (cellId: string) => { restarted.push(cellId); if (restarted.length) stop.abort() } }
    await watchGithubApp({ version: async () => { const next = versions.shift(); if (next === 'v2') slug = 'new-app'; return next ?? 'v2' }, slug: async () => slug,
      host, log: quiet, everyMs: 1, signal: stop.signal })
    expect(restarted).toEqual(['a--gh1'])
  })
})
