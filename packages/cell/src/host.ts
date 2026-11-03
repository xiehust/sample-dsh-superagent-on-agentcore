/**
 * HostProcess: one Fargate task of `dshsa-host` (parent design §1). It holds up to `maxCells` cell leases and `maxConnectors`
 * connector leases; for each cell it restores the SQLite file, runs a CellRuntime with its queue consumer and Litestream, and
 * for each connector it runs the tenant's Feishu Connector. Every dependency is an interface, so local mode and tests run it
 * against fakes.
 */
import { join } from 'node:path'
import { CellEnvelope, HOST_LEASE_PREFIX, WORKER_TYPES, type WorkerType, StateKeys, leaseKey, type CellRecord, type ConnectorFactory, type ConnectorKv, type FeishuSecrets, type Logger,
  type TenantRecord, type TicketTokenSigner } from '@dshsa/contracts'
import type { CellInfo, SourceApis, SourceKind } from '@dshsa/core/host'
import { CellRuntime, type CellParts } from './cell.ts'
import type { DomainEvent } from './core/index.ts'
import { LeaseManager, type Holder, type LeaseStore, type LeaseToken } from './lease.ts'
import { CellQueueConsumer, type CellQueue } from './queue.ts'
import type { Replicator } from './litestream.ts'
import type { Catalog } from './aws/catalog.ts'
import { AgentCoreExecutor, type Provisioner, type WorkerRuntime } from './executor/agentcore.ts'
import { StatelessAssessor } from './assessor.ts'
import { Replier } from './replier.ts'
import type { ModelClient } from '@dshsa/assess'
import type { TicketTokens } from './token.ts'
import type { ServedCells } from './server.ts'

/** What the host needs to build one cell's Source side: its identity, API clients and kinds (from `@dshsa/sources`). */
export interface CellSources {
  cell: CellInfo
  apis: SourceApis
  kinds: SourceKind[]
  /** Hooks into the GitHub Source for worker reports and ended tickets, when it is installed. */
  claimPull?(runtime: CellRuntime, ticketId: string, prNumber: number): Promise<string | undefined>
  onEvent?(event: DomainEvent, parts: CellParts): void
  /** A worker's Feishu read (worker-api `/v1/read`), already scoped to its ticket by the cell. */
  readResource?(runtime: CellRuntime, trigger: import('./core/index.ts').Trigger, resource: string): Promise<{ content: string; mediaType: string }>
  /** Merge the chats routed to this cell into its Feishu Source config; returns the config to save, or undefined when unchanged. */
  syncChats?(config: Record<string, unknown>, chats: { chatId: string; name?: string }[]): Record<string, unknown> | undefined
}
export interface HostDeps {
  owner: string
  endpoint?: string
  dataDir: string
  stateBucket?: string
  maxCells: number
  maxConnectors: number
  leases: LeaseStore
  catalog: Catalog
  replicator: Replicator
  queueFor(record: CellRecord): CellQueue
  sourcesFor(record: CellRecord, tenant: TenantRecord | undefined): Promise<CellSources>
  runtime: WorkerRuntime
  provisioner: Provisioner
  /** The worker version the runtime serves now (SSM, contracts `WorkerVersion`); absent in local mode, where no session is stopped. */
  workerVersion?: () => Promise<string | undefined>
  /** v7: extra worker runtimes by type (`runtime` stays the Claude one) and their served versions. */
  runtimes?: Partial<Record<WorkerType, WorkerRuntime>>
  workerVersions?: Partial<Record<WorkerType, () => Promise<string | undefined>>>
  tokens: TicketTokens & TicketTokenSigner
  model: ModelClient
  /** The tenant's Feishu Connector and what it needs; absent when connectors are not hosted (local mode). */
  connectors?: { factory: ConnectorFactory; secrets(tenant: TenantRecord): Promise<FeishuSecrets>; kv(tenantId: string): ConnectorKv; enqueue(queueUrl: string, envelope: CellEnvelope): Promise<void> }
  log: Logger
  now?: () => number
  chatSyncMs?: number
  /** How often held cells and connectors are compared with their tenant's `feishu.revision` (default 30 s). */
  revisionWatchMs?: number
}
/** What a holder started with, so a change of the tenant's Feishu bot or of the GitHub App slug restarts it (design onboarding §6). */
interface Started { tenantId: string; feishuRevision?: string | undefined; slug?: string }

export class HostProcess implements ServedCells {
  readonly leases: LeaseManager
  private readonly cells = new Map<string, CellRuntime>()
  private readonly started = new Map<string, Started>()
  constructor(private readonly deps: HostDeps) {
    this.leases = new LeaseManager({ store: deps.leases, owner: deps.owner, ...deps.endpoint ? { endpoint: deps.endpoint } : {}, log: deps.log,
      ...deps.now ? { now: deps.now } : {}, capacity: { cell: deps.maxCells, connector: deps.connectors ? deps.maxConnectors : 0, host: 1 },
      candidates: async () => [
        // v6 presence lease: panel-tenant finds a host for a tenant that has no cell yet (Scan `begins_with HOST_LEASE_PREFIX`).
        leaseKey.host(deps.owner),
        ...(await deps.catalog.activeCells()).map(cell => leaseKey.cell(cell.cellId)),
        ...deps.connectors ? (await deps.catalog.feishuTenants()).map(tenant => leaseKey.connector(tenant.tenantId)) : [],
      ],
      start: token => token.leaseKey.startsWith('cell#') ? this.startCell(token)
        : token.leaseKey.startsWith(HOST_LEASE_PREFIX) ? Promise.resolve({ stop: async () => {} }) : this.startConnector(token) })
  }
  get(cellId: string): CellRuntime | undefined { return this.cells.get(cellId) }
  list(): string[] { return [...this.cells.keys()] }
  async run(signal: AbortSignal): Promise<void> {
    const watching = this.watchRevisions(signal)
    await this.leases.run(signal)
    await watching
  }
  /** The App slug each running cell started with, by cellId. */
  cellSlugs(): Map<string, string | undefined> {
    return new Map([...this.started].filter(([key]) => key.startsWith('cell#')).map(([key, started]) => [key.slice('cell#'.length), started.slug]))
  }
  /** Restarts a running cell (stop, release, reacquire on the next round), such as when the GitHub App's slug changed. */
  async restartCell(cellId: string, reason: string): Promise<void> {
    this.deps.log.info('restarting cell', { cellId, reason })
    await this.leases.recycle(leaseKey.cell(cellId))
  }
  /**
   * Restarts each held Connector and cell whose tenant's Feishu bot changed (`feishu.revision`, set by every `feishu set`,
   * or the bot added or removed), so new credentials reach running hosts without an operator (design onboarding §4, R8).
   */
  async checkRevisions(): Promise<void> {
    const tenants = new Map<string, TenantRecord | undefined | Error>()
    for (const [key, started] of [...this.started]) {
      if (!tenants.has(started.tenantId)) tenants.set(started.tenantId, await this.deps.catalog.tenant(started.tenantId).catch((error: unknown) => error instanceof Error ? error : new Error(String(error))))
      const tenant = tenants.get(started.tenantId)
      // A failed read changes nothing: an outage must not restart anything.
      if (tenant instanceof Error) continue
      const revision = tenant?.feishu ? tenant.feishu.revision ?? '' : undefined
      if (revision === started.feishuRevision || !this.started.has(key)) continue
      this.deps.log.info('restarting for a changed Feishu bot', { leaseKey: key, tenantId: started.tenantId, from: started.feishuRevision ?? null, to: revision ?? null })
      this.started.delete(key)
      await this.leases.recycle(key)
    }
  }
  private async watchRevisions(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, this.deps.revisionWatchMs ?? 30_000)
        signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
      })
      if (signal.aborted) return
      await this.checkRevisions().catch((error: unknown) => { this.deps.log.warn('revision check failed', { error: String(error) }) })
    }
  }

  private async startCell(token: LeaseToken): Promise<Holder> {
    const { deps } = this
    const cellId = token.leaseKey.slice('cell#'.length)
    const record = await deps.catalog.cell(cellId)
    if (!record || record.status !== 'active') throw new Error(`cell ${cellId} is not active`)
    const tenant = await deps.catalog.tenant(record.tenantId)
    const sources = await deps.sourcesFor(record, tenant)
    const dbPath = join(deps.dataDir, 'cells', cellId, 'orchestrator.sqlite')
    const replica = deps.stateBucket ? `s3://${deps.stateBucket}/${record.stateBucketPrefix || StateKeys.litestream(cellId)}` : undefined
    if (replica) await deps.replicator.restore(dbPath, replica, token.signal)
    const runtimes: Partial<Record<WorkerType, WorkerRuntime>> = { claude: deps.runtime, ...deps.runtimes }
    const workerVersions = { ...deps.workerVersion ? { claude: deps.workerVersion } : {}, ...deps.workerVersions }
    const runtime: CellRuntime = new CellRuntime({ cell: sources.cell, apis: sources.apis, dbPath, kinds: sources.kinds, lease: token, log: deps.log,
      tokens: deps.tokens, stateDir: join(deps.dataDir, 'cells', cellId), workerTypes: WORKER_TYPES.filter(type => runtimes[type]),
      executor: parts => new AgentCoreExecutor(parts, { runtimes, workerVersions, provisioner: deps.provisioner, tokens: deps.tokens }),
      assessor: parts => new StatelessAssessor(parts, { model: deps.model }),
      replier: parts => new Replier(parts, { model: deps.model }),
      ...sources.onEvent ? { onEvent: sources.onEvent } : {},
      ...sources.readResource ? { readResource: sources.readResource } : {},
      ...sources.claimPull ? { claimPull: (ticketId: string, prNumber: number) => sources.claimPull!(runtime, ticketId, prNumber) } : {},
      boundChats: async () => (await deps.catalog.cellChats(record.tenantId, cellId)).map(chat => chat.chatId) })
    const replication = replica ? deps.replicator.replicate(dbPath, replica) : undefined
    runtime.start()
    this.cells.set(cellId, runtime)
    this.started.set(token.leaseKey, { tenantId: record.tenantId, feishuRevision: tenant?.feishu ? tenant.feishu.revision ?? '' : undefined, slug: sources.cell.app.slug })
    const consumer = new CellQueueConsumer({ queue: deps.queueFor(record), handler: runtime, log: deps.log, afterBatch: () => { runtime.passes.request() } })
    const consuming = consumer.run(token.signal)
    const syncing = sources.syncChats && tenant?.feishu ? this.syncChatsLoop(runtime, record, sources, token.signal) : Promise.resolve()
    deps.log.info('cell started', { cellId, fence: token.fence })
    return { stop: async () => {
      this.cells.delete(cellId)
      this.started.delete(token.leaseKey)
      await Promise.allSettled([consuming, syncing])
      await runtime.stop()
      await replication?.stop()
      deps.log.info('cell stopped', { cellId })
    } }
  }
  /** Keeps the Feishu Source's `chats` equal to the chats routed to this cell (DSH listened only to configured chats). */
  private async syncChatsLoop(runtime: CellRuntime, record: CellRecord, sources: CellSources, signal: AbortSignal): Promise<void> {
    const { deps } = this
    while (!signal.aborted) {
      try {
        const chats = await deps.catalog.cellChats(record.tenantId, record.cellId)
        const instance = runtime.sources.instance('feishu')
        if (instance) {
          const next = sources.syncChats!(instance.config, chats)
          if (next) await runtime.settings.save('source:feishu', { enabled: instance.enabled, config: next }, runtime.store.blockRevision('source:feishu'), 'sync')
        }
      } catch (error) { if (!signal.aborted) deps.log.warn('chat sync failed', { cellId: record.cellId, error: String(error) }) }
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, deps.chatSyncMs ?? 60_000)
        signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
      })
    }
  }
  private async startConnector(token: LeaseToken): Promise<Holder> {
    const { deps } = this
    const connectors = deps.connectors!
    const tenantId = token.leaseKey.slice('connector#'.length)
    const tenant = await deps.catalog.tenant(tenantId)
    if (!tenant?.feishu || tenant.status !== 'active') throw new Error(`tenant ${tenantId} has no active Feishu bot`)
    const connector = connectors.factory(tenant)
    const queues = new Map<string, string>()
    await connector.start({ tenant, secrets: await connectors.secrets(tenant), kv: connectors.kv(tenantId), log: deps.log, signal: token.signal,
      route: chatId => deps.catalog.route(tenantId, chatId), boundChats: () => deps.catalog.boundChats(tenantId),
      enqueue: async (cellId, envelope) => {
        if (!token.valid()) throw new Error('connector lease not held')
        let url = queues.get(cellId)
        if (!url) {
          const cell = await deps.catalog.cell(cellId)
          if (!cell || cell.tenantId !== tenantId) throw new Error(`cell ${cellId} is not this tenant's`)
          queues.set(cellId, url = cell.queueUrl)
        }
        await connectors.enqueue(url, CellEnvelope.parse(envelope))
      } })
    this.started.set(token.leaseKey, { tenantId, feishuRevision: tenant.feishu.revision ?? '' })
    deps.log.info('connector started', { tenantId, fence: token.fence })
    return { stop: async () => { this.started.delete(token.leaseKey); await connector.stop(); deps.log.info('connector stopped', { tenantId }) } }
  }
}
