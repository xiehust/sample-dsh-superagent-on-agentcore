/**
 * LeaseManager (parent design §4.2): one DynamoDB lease per cell (`cell#<cellId>`) and per tenant connector
 * (`connector#<tenantId>`), with fencing. A holder runs only while its lease is valid, and stops *before* the lease expires.
 */
import { Lease } from '@dshsa/contracts'
import type { Logger } from '@dshsa/contracts'

export interface LeaseGrant { leaseKey: string; owner: string; fence: number; expiresAt: number }
/** Conditional writes on `dshsa-leases`; implemented by `DynamoLeaseStore` and `MemoryLeaseStore`. */
export interface LeaseStore {
  /** Take the lease if it is absent or expired at `now`, incrementing its fence; `undefined` if someone else holds it. */
  acquire(leaseKey: string, owner: string, endpoint: string | undefined, now: number, ttlMs: number): Promise<LeaseGrant | undefined>
  /** Extend a lease still held by `owner` under `fence`; `false` when the condition fails (the lease was lost). */
  renew(leaseKey: string, owner: string, fence: number, now: number, ttlMs: number): Promise<boolean>
  /** Delete the lease if `owner` still holds it under `fence`; a lost lease is left alone. */
  release(leaseKey: string, owner: string, fence: number): Promise<void>
}

/** What a holder is handed: its fence, whether its lease is still valid right now, and a signal that aborts when it is not. */
export interface LeaseToken {
  readonly leaseKey: string
  readonly fence: number
  /** True while the lease is held and not within `stopBeforeExpiryMs` of its expiry; check before every external side effect. */
  valid(): boolean
  readonly signal: AbortSignal
}
export interface Holder { stop(): Promise<void> }
export type HolderFactory = (token: LeaseToken) => Promise<Holder>

export interface LeaseManagerOptions {
  store: LeaseStore
  owner: string
  endpoint?: string
  /** Lease keys this task may hold, such as every active cell; read on each tick. */
  candidates(): Promise<string[]>
  /** Starts the holder for a newly acquired lease. */
  start: HolderFactory
  /** How many leases with each prefix (`cell`, `connector`) this task holds at most. */
  capacity: Record<string, number>
  now?: () => number
  ttlMs?: number
  renewEveryMs?: number
  stopBeforeExpiryMs?: number
  log?: Logger
  random?: () => number
}

interface Held { grant: LeaseGrant; renewedAt: number; holder?: Holder; controller: AbortController; lost: boolean; stopping?: Promise<void> }

export class LeaseManager {
  private readonly held = new Map<string, Held>()
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly renewEveryMs: number
  private readonly stopBeforeMs: number
  private ticking?: Promise<void>
  constructor(private readonly options: LeaseManagerOptions) {
    this.now = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? Lease.ttlMs
    this.renewEveryMs = options.renewEveryMs ?? Lease.renewEveryMs
    this.stopBeforeMs = options.stopBeforeExpiryMs ?? Lease.stopBeforeExpiryMs
  }
  /** Leases this task holds now, with their fences. */
  holding(): { leaseKey: string; fence: number; expiresAt: number }[] {
    return [...this.held.values()].filter(item => !item.lost).map(({ grant }) => ({ leaseKey: grant.leaseKey, fence: grant.fence, expiresAt: grant.expiresAt }))
  }
  token(leaseKey: string): LeaseToken | undefined {
    const item = this.held.get(leaseKey)
    return item && !item.lost ? this.tokenOf(item) : undefined
  }
  /** One round: renew or stop what is held, then acquire free candidates up to capacity. Concurrent calls share a round. */
  tick(): Promise<void> {
    return this.ticking ??= this.round().finally(() => { this.ticking = undefined })
  }
  /** Ticks every `renewEveryMs / 2` until `signal` aborts, then stops every holder and releases its lease. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.tick().catch((error: unknown) => { this.options.log?.error('lease round failed', { error: String(error) }) })
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, this.renewEveryMs / 2)
        signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
      })
    }
    await this.stopAll()
  }
  async stopAll(): Promise<void> { await Promise.all([...this.held.keys()].map(key => this.drop(key, true))) }
  /** Stops a holder and releases its lease, so the next round (this task's, usually) acquires it again and starts a fresh holder. */
  async recycle(leaseKey: string): Promise<void> { await this.drop(leaseKey, true) }

  private async round(): Promise<void> {
    const now = this.now()
    for (const [key, item] of [...this.held]) {
      if (item.lost) continue
      if (now - item.renewedAt >= this.renewEveryMs || now >= this.deadline(item)) {
        let renewed: boolean | undefined
        try { renewed = await this.options.store.renew(key, this.options.owner, item.grant.fence, now, this.ttlMs) }
        catch (error) { this.options.log?.warn('lease renewal failed', { leaseKey: key, error: String(error) }) }
        if (renewed === true) { item.grant = { ...item.grant, expiresAt: now + this.ttlMs }; item.renewedAt = now; continue }
        if (renewed === false) { this.options.log?.warn('lease lost', { leaseKey: key, fence: item.grant.fence }); await this.drop(key, false); continue }
      }
      // A renewal that keeps failing must not outlive the lease: stop before its expiry, whoever acquires it next.
      if (this.now() >= this.deadline(item)) { this.options.log?.warn('lease expiring unrenewed', { leaseKey: key }); await this.drop(key, true) }
    }
    // A failed read throws here, before anything is dropped: a catalog outage must not stop the cells this task holds.
    const candidates = await this.options.candidates()
    const wanted = new Set(candidates)
    // A lease that is no longer a candidate (a deleted or suspended cell, a tenant without its Feishu bot) is stopped and released.
    const gone = [...this.held.keys()].filter(key => !wanted.has(key))
    for (const key of gone) this.options.log?.info('lease no longer a candidate', { leaseKey: key })
    await Promise.all(gone.map(key => this.drop(key, true)))
    const free = candidates.filter(key => !this.held.has(key))
    for (let i = free.length - 1; i > 0; i--) { const j = Math.floor((this.options.random ?? Math.random)() * (i + 1)); [free[i], free[j]] = [free[j]!, free[i]!] }
    for (const key of free) {
      const prefix = key.slice(0, key.indexOf('#'))
      const count = [...this.held.keys()].filter(held => held.startsWith(`${prefix}#`)).length
      if (count >= (this.options.capacity[prefix] ?? 0)) continue
      const grant = await this.options.store.acquire(key, this.options.owner, this.options.endpoint, this.now(), this.ttlMs)
        .catch((error: unknown) => { this.options.log?.warn('lease acquire failed', { leaseKey: key, error: String(error) }); return undefined })
      if (!grant) continue
      const item: Held = { grant, renewedAt: this.now(), controller: new AbortController(), lost: false }
      this.held.set(key, item)
      try {
        item.holder = await this.options.start(this.tokenOf(item))
        this.options.log?.info('lease acquired', { leaseKey: key, fence: grant.fence })
      } catch (error) {
        this.options.log?.error('holder failed to start', { leaseKey: key, error: String(error) })
        await this.drop(key, true)
      }
    }
  }
  /** The time by which a holder must have stopped. */
  private deadline(item: Held): number { return item.grant.expiresAt - this.stopBeforeMs }
  private tokenOf(item: Held): LeaseToken {
    return { leaseKey: item.grant.leaseKey, fence: item.grant.fence, signal: item.controller.signal,
      valid: () => !item.lost && this.held.get(item.grant.leaseKey) === item && this.now() < this.deadline(item) }
  }
  /** Stop the holder (abort first, so its side effects stop), then release the lease if it may still be ours. */
  private drop(key: string, release: boolean): Promise<void> {
    const item = this.held.get(key)
    if (!item) return Promise.resolve()
    return item.stopping ??= (async () => {
      item.lost = true
      item.controller.abort()
      try { await item.holder?.stop() } catch (error) { this.options.log?.error('holder failed to stop', { leaseKey: key, error: String(error) }) }
      if (release) await this.options.store.release(key, this.options.owner, item.grant.fence).catch(() => { /* It expires by itself. */ })
      this.held.delete(key)
    })()
  }
}

/** In-memory `LeaseStore` with DynamoDB's conditional semantics, for tests and local mode. */
export class MemoryLeaseStore implements LeaseStore {
  readonly items = new Map<string, LeaseGrant & { endpoint?: string }>()
  async acquire(leaseKey: string, owner: string, endpoint: string | undefined, now: number, ttlMs: number): Promise<LeaseGrant | undefined> {
    const current = this.items.get(leaseKey)
    if (current && current.expiresAt >= now) return undefined
    const grant = { leaseKey, owner, fence: (current?.fence ?? 0) + 1, expiresAt: now + ttlMs }
    this.items.set(leaseKey, { ...grant, ...endpoint ? { endpoint } : {} })
    return grant
  }
  async renew(leaseKey: string, owner: string, fence: number, now: number, ttlMs: number): Promise<boolean> {
    const current = this.items.get(leaseKey)
    if (!current || current.owner !== owner || current.fence !== fence) return false
    current.expiresAt = now + ttlMs
    return true
  }
  async release(leaseKey: string, owner: string, fence: number): Promise<void> {
    const current = this.items.get(leaseKey)
    // Keep the fence counter: a later acquirer must still get a larger fence.
    if (current && current.owner === owner && current.fence === fence) this.items.set(leaseKey, { ...current, owner: '', expiresAt: 0 })
  }
}
