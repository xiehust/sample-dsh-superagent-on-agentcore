import { describe, expect, it, vi } from 'vitest'
import { LeaseManager, MemoryLeaseStore, type LeaseToken } from '../src/lease.ts'

function task(store: MemoryLeaseStore, owner: string, clock: { now: number }, candidates = ['cell#a']) {
  const tokens: LeaseToken[] = []
  const stopped: string[] = []
  const manager = new LeaseManager({ store, owner, endpoint: `http://${owner}:8080`, now: () => clock.now, candidates: async () => candidates,
    capacity: { cell: 4, connector: 1 }, random: () => 0,
    start: async token => { tokens.push(token); return { stop: async () => { stopped.push(token.leaseKey) } } } })
  return { manager, tokens, stopped }
}

describe('LeaseManager', () => {
  it('acquires a free lease with fence 1 and publishes its endpoint', async () => {
    const store = new MemoryLeaseStore(), clock = { now: 1_000 }
    const a = task(store, 'a', clock)
    await a.manager.tick()
    expect(a.manager.holding()).toEqual([{ leaseKey: 'cell#a', fence: 1, expiresAt: 31_000 }])
    expect(store.items.get('cell#a')).toMatchObject({ owner: 'a', endpoint: 'http://a:8080' })
    expect(a.tokens[0]!.valid()).toBe(true)
  })
  it('does not take a lease another task holds, and takes it over only after expiry with a larger fence', async () => {
    const store = new MemoryLeaseStore(), clock = { now: 0 }
    const a = task(store, 'a', clock), b = task(store, 'b', clock)
    await a.manager.tick()
    await b.manager.tick()
    expect(b.manager.holding()).toEqual([])
    // a disappears without renewing; b waits for the expiry.
    clock.now = 30_000
    await b.manager.tick()
    expect(b.manager.holding()).toEqual([])
    clock.now = 30_001
    await b.manager.tick()
    expect(b.manager.holding()[0]).toMatchObject({ leaseKey: 'cell#a', fence: 2 })
  })
  it('stops a holder whose renewal is refused (fenced out) and never releases the new owner', async () => {
    const store = new MemoryLeaseStore(), clock = { now: 0 }
    const a = task(store, 'a', clock), b = task(store, 'b', clock)
    await a.manager.tick()
    // a stalls past its expiry (e.g. a long GC pause); b takes over.
    clock.now = 31_000
    await b.manager.tick()
    const release = vi.spyOn(store, 'release')
    await a.manager.tick()
    expect(a.stopped).toEqual(['cell#a'])
    expect(a.tokens[0]!.valid()).toBe(false)
    expect(a.tokens[0]!.signal.aborted).toBe(true)
    expect(release).not.toHaveBeenCalledWith('cell#a', 'a', 1)
    expect(store.items.get('cell#a')).toMatchObject({ owner: 'b', fence: 2 })
    expect(a.manager.holding()).toEqual([])
  })
  it('stops before the expiry when renewals keep failing, and the token turns invalid stopBeforeExpiry early', async () => {
    const store = new MemoryLeaseStore(), clock = { now: 0 }
    const a = task(store, 'a', clock)
    await a.manager.tick()
    vi.spyOn(store, 'renew').mockRejectedValue(new Error('network'))
    clock.now = 10_000
    await a.manager.tick()
    expect(a.stopped).toEqual([])
    clock.now = 24_999
    expect(a.tokens[0]!.valid()).toBe(true)
    clock.now = 25_000
    expect(a.tokens[0]!.valid()).toBe(false)
    await a.manager.tick()
    expect(a.stopped).toEqual(['cell#a'])
  })
  it('renews every renewEveryMs and keeps the fence', async () => {
    const store = new MemoryLeaseStore(), clock = { now: 0 }
    const a = task(store, 'a', clock)
    await a.manager.tick()
    for (clock.now = 10_000; clock.now <= 100_000; clock.now += 10_000) await a.manager.tick()
    expect(a.manager.holding()).toEqual([{ leaseKey: 'cell#a', fence: 1, expiresAt: 130_000 }])
    expect(a.stopped).toEqual([])
  })
  it('releases on stopAll, keeping the fence counter for the next owner', async () => {
    const store = new MemoryLeaseStore(), clock = { now: 0 }
    const a = task(store, 'a', clock), b = task(store, 'b', clock)
    await a.manager.tick()
    await a.manager.stopAll()
    expect(a.stopped).toEqual(['cell#a'])
    clock.now = 1
    await b.manager.tick()
    expect(b.manager.holding()[0]).toMatchObject({ fence: 2 })
  })
  it('respects capacity per prefix', async () => {
    const store = new MemoryLeaseStore(), clock = { now: 0 }
    const a = task(store, 'a', clock, ['cell#1', 'cell#2', 'cell#3', 'cell#4', 'cell#5', 'connector#t1', 'connector#t2'])
    await a.manager.tick()
    const keys = a.manager.holding().map(item => item.leaseKey)
    expect(keys.filter(key => key.startsWith('cell#'))).toHaveLength(4)
    expect(keys.filter(key => key.startsWith('connector#'))).toHaveLength(1)
  })
  it('stops and releases a held lease once its key is no longer a candidate (cell deleted or suspended)', async () => {
    const store = new MemoryLeaseStore(), clock = { now: 0 }
    const candidates = ['cell#a', 'cell#b']
    const a = task(store, 'a', clock, candidates)
    await a.manager.tick()
    expect(a.manager.holding().map(item => item.leaseKey).sort()).toEqual(['cell#a', 'cell#b'])
    candidates.splice(candidates.indexOf('cell#b'), 1)
    clock.now = 1_000
    await a.manager.tick()
    expect(a.stopped).toEqual(['cell#b'])
    expect(a.tokens.find(token => token.leaseKey === 'cell#b')!.signal.aborted).toBe(true)
    expect(a.manager.holding().map(item => item.leaseKey)).toEqual(['cell#a'])
    expect(store.items.get('cell#b')).toMatchObject({ expiresAt: 0, fence: 1 })
    expect(store.items.get('cell#a')).toMatchObject({ owner: 'a' })
  })
  it('keeps every holder when the candidate read fails (a catalog outage never stops cells)', async () => {
    const store = new MemoryLeaseStore(), clock = { now: 0 }
    let fail = false
    const stopped: string[] = []
    const manager = new LeaseManager({ store, owner: 'a', now: () => clock.now, capacity: { cell: 4 },
      candidates: async () => { if (fail) throw new Error('catalog unavailable'); return ['cell#a'] },
      start: async token => ({ stop: async () => { stopped.push(token.leaseKey) } }) })
    await manager.tick()
    fail = true
    clock.now = 10_000
    await expect(manager.tick()).rejects.toThrow('catalog unavailable')
    expect(stopped).toEqual([])
    // The renewal before the failed read still went through.
    expect(manager.holding()).toEqual([{ leaseKey: 'cell#a', fence: 1, expiresAt: 40_000 }])
  })
  it('releases the lease when the holder fails to start', async () => {
    const store = new MemoryLeaseStore(), clock = { now: 0 }
    const manager = new LeaseManager({ store, owner: 'a', now: () => clock.now, candidates: async () => ['cell#a'], capacity: { cell: 1 },
      start: async () => { throw new Error('restore failed') } })
    await manager.tick()
    expect(manager.holding()).toEqual([])
    expect(store.items.get('cell#a')).toMatchObject({ expiresAt: 0, fence: 1 })
  })
})
