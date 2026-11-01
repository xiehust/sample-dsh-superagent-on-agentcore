/**
 * CellRuntime: the composition root of one cell (one tenant + repository), i.e. DSH's `Runtime` without the DSH host
 * services. It owns one SQLite Store and wires the verbatim DSH Engine, Effects, Passes, Outbox and Prompts to the
 * Source kinds of `@dshsa/sources`, the AgentCore Executor and the stateless Bedrock Assessor.
 * It runs only while its lease is held (`LeaseToken`), and every side effect checks `holding()`.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { CellEnvelope, type Logger } from '@dshsa/contracts'
import { Engine, type Assessor, type DomainEvent, type Executor, type OutboundMessage, type ReceiveResult, type Ticket, type Trigger } from './core/index.ts'
import { HealthBoard, SourceRegistry, type CellInfo, type SourceApis, type SourceContext, type SourceKind } from '@dshsa/core/host'
import { settingsPolicy } from './policy.ts'
import { chatMembers } from '@dshsa/sources'
import { logFiltered, logIgnores } from './admission-log.ts'
import { ignoreHint } from './ignore-hint.ts'
import { Effects } from './app/effects.ts'
import { Outbox } from './app/outbox.ts'
import { Passes } from './app/passes.ts'
import { Prompts } from './app/prompts.ts'
import { Store } from './app/store.ts'
import { environmentOf } from './app/execution-environment.ts'
import { sourceContextOf, type SourceContextDeps } from './app/source-context.ts'
import { ticketExecution } from './executor/messages.ts'
import { WorkerEvents } from './worker-events.ts'
import { KV } from './kv.ts'
import { Settings } from './app/settings.ts'
import { NoticeLog } from './app/sessions.ts'
import { TextCache } from './app/cache.ts'
import { CodedError, cellRoutes, type HttpHost, type Routes } from './app/http.ts'
import { z } from 'zod'
import { ticketEnvironment } from './app/execution-environment.ts'
import { runningAssignment } from './core/index.ts'
import { Models, ticketKey, runtimeSessionId } from '@dshsa/contracts'
import type { TicketTokenSigner } from '@dshsa/contracts'
import type { LeaseToken } from './lease.ts'

/** What a cell's Executor and Assessor are built from; `engine` is a getter because the Engine needs them first. */
export interface CellParts {
  readonly cell: CellInfo
  readonly apis: SourceApis
  readonly store: Store
  readonly effects: Effects
  readonly sources: SourceRegistry
  readonly prompts: Prompts
  readonly board: HealthBoard
  readonly engine: Engine
  readonly log: Logger
  readonly lifetime: AbortSignal
  /** False once the cell's lease is no longer valid: no external side effect may start then. */
  holding(): boolean
  paused(): boolean
  /** Queue a message for a Channel through the Outbox (DSH `SourceContext.notify`). */
  notify(message: OutboundMessage): void
}
export interface CellOptions {
  cell: CellInfo
  apis: SourceApis
  /** The cell's SQLite file (restored by Litestream before the cell opens). */
  dbPath: string
  kinds: readonly SourceKind[]
  lease: Pick<LeaseToken, 'fence' | 'valid' | 'signal'>
  executor(parts: CellParts): Executor & { install?(): void; resume?(): void; shutdown?(): Promise<void> }
  assessor(parts: CellParts): Assessor & { install?(): void; dispose?(): void }
  /** The reply composer for worker reports (stateless Bedrock), when the cell has one. */
  replier?(parts: CellParts): { install?(): void; reported(ticket: Ticket, report: { state: string; question?: string | null | undefined }): void }
  /** Reads a Source resource for a ticket's worker (worker-api `/v1/read` of `feishu/...`), after the cell checked its scope. */
  readResource?(runtime: CellRuntime, trigger: Trigger, resource: string): Promise<{ content: string; mediaType: string }>
  /** Reads and claims a PR a worker reports (GitHub Source); returns why it is refused. */
  claimPull?(ticketId: string, prNumber: number): Promise<string | undefined>
  /** v6: the Feishu chats routed to this cell now (`dshsa-routes`, the binding authority); the members picker reads only these. */
  boundChats?(): Promise<string[]>
  /** Domain events, after the Engine's transaction commits. */
  onEvent?(event: DomainEvent, parts: CellParts): void
  log: Logger
  promptMaxChars?: number
  /** Issues ticket tokens for token refresh (parent design §4.3); absent in local mode. */
  tokens?: TicketTokenSigner
  /** The cell's working directory, shown as the state directory in the panel. */
  stateDir?: string
}

export class StaleFence extends Error {}

export class CellRuntime {
  readonly store: Store
  readonly effects: Effects
  readonly sources: SourceRegistry
  readonly prompts: Prompts
  readonly outbox: Outbox
  readonly engine: Engine
  readonly passes: Passes
  readonly board = new HealthBoard()
  readonly workerEvents: WorkerEvents
  readonly parts: CellParts
  readonly settings: Settings
  readonly sessions: NoticeLog
  readonly routes: Routes
  private readonly sourceLinks = new TextCache(200_000)
  private readonly stopped = new AbortController()
  private readonly executor: ReturnType<CellOptions['executor']>
  private readonly assessor: ReturnType<CellOptions['assessor']>
  private readonly replier?: ReturnType<NonNullable<CellOptions['replier']>>
  private readonly loops: Promise<void>[] = []
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  private closing = false
  private stopping?: Promise<void>
  constructor(private readonly options: CellOptions) {
    const runtime = this
    mkdirSync(dirname(options.dbPath), { recursive: true, mode: 0o700 })
    const store = this.store = new Store(options.dbPath, error => { options.log.warn('store afterCommit failed', { error: String(error) }) })
    try {
      // Fencing: a database last written under a larger fence belongs to a newer owner; this one must not write to it.
      const fence = store.get(KV.lease.fence)
      if (fence !== undefined && fence > options.lease.fence) throw new StaleFence(`cell ${options.cell.cellId}: database fence ${fence} > lease fence ${options.lease.fence}`)
      store.set(KV.lease.fence, options.lease.fence)
      const board = this.board
      const effects = this.effects = new Effects(store, board)
      const sources = this.sources = new SourceRegistry(() => store.settings(), board)
      const environment = () => environmentOf({ cell: options.cell, sources, settings: store.settings() })
      this.prompts = new Prompts(store, () => options.promptMaxChars ?? 100_000, environment, () => !!options.cell.feishu)
      const holding = () => !this.closing && options.lease.valid()
      const paused = () => store.settings().paused
      this.outbox = new Outbox({ store, effects, sources, apis: options.apis, cell: options.cell, paused, holding })
      this.parts = { cell: options.cell, apis: options.apis, store, effects, sources, prompts: this.prompts, board, log: options.log,
        lifetime: AbortSignal.any([this.stopped.signal, options.lease.signal]), holding, paused, get engine() { return runtime.engine },
        notify: message => { this.outbox.send(message) } }
      this.executor = options.executor(this.parts)
      this.assessor = options.assessor(this.parts)
      this.replier = options.replier?.(this.parts)
      const policy = () => settingsPolicy(store.settings(), sources)
      this.engine = new Engine({ repo: store, scope: sources, policy, assessor: this.assessor, executor: this.executor, outbox: this.outbox,
        prepareTicket: (ticket, outcome) => ({ ...ticket, execution: ticketExecution(ticket, outcome, store.settings()) }),
        emit: event => {
          if (event.type === 'decision.recorded') {
            this.hintIgnored(event.data.decisionId, policy)
            store.afterCommit(() => { logIgnores(options.log, options.cell.cellId, store, event) })
          }
          if (options.onEvent) store.afterCommit(() => { options.onEvent!(event, this.parts) })
        } })
      this.passes = new Passes({ engine: { receive: trigger => this.engine.receive(trigger), evaluateDue: () => { this.engine.evaluateDue() } }, effects,
        health: this.runtimeHealth, lifetime: this.parts.lifetime, configured: holding, closing: () => this.closing })
      this.sessions = new NoticeLog(() => this.prompts.current().revision)
      const lifetime = this.parts.lifetime
      this.settings = new Settings({ store, sources, engine: { policyChanged: (from, to, effects) => { this.engine.policyChanged(from, to, effects) } }, health: board,
        lifetime, sessions: this.sessions, sourceHost: { sources, context: kind => this.context(kind) }, requestPass: () => { this.passes.request() },
        setup: { configured: holding, checkAccounts: async () => {}, blockCommands: async () => {}, restart: () => {} } })
      this.workerEvents = new WorkerEvents({ store, engine: this.engine, cellId: options.cell.cellId, log: options.log,
        reported: (ticket, report) => { this.replier?.reported(ticket, report) },
        ...options.claimPull ? { claimPull: options.claimPull } : {} })
      for (const kind of options.kinds) sources.register(kind)
      this.routes = cellRoutes(this.httpHost())
    } catch (error) {
      store.close()
      throw error
    }
  }
  /**
   * dshsa: queues the reply to an ignored explicit request (`ignore-hint.ts`) in the Decision's own transaction, so it goes
   * out exactly when the Decision commits. A failure here is logged and never undoes the Decision.
   */
  private hintIgnored(decisionId: string, policy: () => ReturnType<typeof settingsPolicy>): void {
    const { store } = this
    try {
      store.atomic(() => {
        const decision = store.decisions.get(decisionId)
        const message = decision && ignoreHint({ store, settings: () => store.settings(), policy }, decision)
        if (message) this.outbox.send(message)
      })
    } catch (error) { this.options.log.warn('ignore hint failed', { cellId: this.cellId, decisionId, error: String(error).slice(0, 300) }) }
  }
  get cellId(): string { return this.options.cell.cellId }
  get health() { return this.board.all }
  /** The Source context of one kind (DSH `Runtime.context`). */
  context(kind: { kind: string; health: readonly string[] }): SourceContext {
    const runtime = this
    const deps: SourceContextDeps = { store: this.store, engine: this.engine, outbox: this.outbox, sources: this.sources, ready: Promise.resolve(),
      get cell() { return runtime.options.cell }, get apis() { return runtime.options.apis }, configured: () => this.parts.holding(),
      receive: (trigger: Trigger): ReceiveResult => {
        const result = this.passes.receive(trigger)
        if (result === 'filtered') logFiltered(this.options.log, this.cellId, this.store, trigger)
        return result
      } }
    return sourceContextOf(deps, kind)
  }
  start(): void {
    this.executor.install?.()
    this.assessor.install?.()
    this.replier?.install?.()
    this.executor.resume?.()
    this.passes.start()
    this.effects.start()
    for (const kind of this.options.kinds) {
      if (!kind.run) continue
      const context = this.context(kind)
      this.loops.push(kind.run(context, this.parts.lifetime).catch((error: unknown) => {
        if (kind.health[0]) context.report(kind.health[0], { state: 'error', detail: String(error) })
        this.options.log.error('source loop failed', { kind: kind.kind, error: String(error) })
      }))
    }
    this.runtimeHealth.set({ state: 'ready', detail: 'Cell is ready', at: new Date().toISOString() })
  }
  /**
   * Handles one queue envelope (parent design §4.6). Returns normally once it is applied (or was a duplicate); throws when it
   * should be retried, leaving the message on the queue.
   */
  async handle(envelope: CellEnvelope): Promise<void> {
    if (!this.parts.holding()) throw new Error('cell lease not held')
    if (envelope.cellId !== this.cellId) { this.options.log.warn('envelope for another cell dropped', { id: envelope.id, cellId: envelope.cellId }); return }
    switch (envelope.type) {
      case 'source.event': {
        const kind = this.sources.kind(envelope.body.source)
        if (!kind?.ingest) { this.options.log.warn('no source kind ingests this event', { id: envelope.id, source: envelope.body.source }); return }
        await kind.ingest(envelope.body, this.context(kind))
        break
      }
      case 'worker.event': await this.workerEvents.apply(envelope.body); break
      case 'admin.command': this.options.log.info('admin command ignored (reserved)', { id: envelope.id, command: envelope.body.command }); break
    }
    this.passes.request()
  }
  /** The DSH management routes' host for this cell (parent design §4.7). */
  httpHost(): HttpHost {
    const runtime = this
    const { store, sources, prompts, sessions, settings, engine, board } = this
    const maxChars = this.options.promptMaxChars ?? 100_000
    return { store, sources, prompts, sessions, settings, engine, sourceLinks: this.sourceLinks, masterId: `cell-${this.cellId}`, ready: Promise.resolve(),
      get health() { return board.all as Record<string, never> },
      executor: { activeCount: () => store.tickets.open().filter(ticket => runningAssignment(ticket)).length },
      machine: { stateDir: this.options.stateDir ?? '', promptMaxChars: { get: () => maxChars }, admissionContextMaxPages: { get: () => 10 }, admissionContextTimeoutMs: { get: () => 15_000 } },
      get deployment() { return runtime.options.cell }, configured: () => this.parts.holding(),
      links: () => channel => sources.link(channel, { repository: this.options.cell.repository, ...this.options.cell.feishu ? { feishu: this.options.cell.feishu } : {} }),
      ticketEnvironment: ticket => ticketEnvironment({ cell: this.options.cell, sources, settings: store.settings(), ticket }),
      checkSetup: () => {}, requestPass: () => { this.passes.request() },
      models: async () => ({ models: [{ id: Models.eval, roles: ['eval'] }, { id: Models.worker, roles: ['executor'] }] }),
      pickers: { feishuMembers: chat => this.feishuMembers(chat), githubCollaborators: () => this.githubCollaborators() } }
  }
  /** The people of a chat bound to this cell (design onboarding §5): a chat the cell is not bound to is refused, whatever the bot sees. */
  async feishuMembers(chat: string): Promise<{ id: string; name: string }[]> {
    if (!/^oc_[A-Za-z0-9]+$/.test(chat)) throw new CodedError(400, 'bad_request', 'chat must be a Feishu chat id (oc_…)')
    const feishu = this.options.apis.feishu
    if (!feishu) throw new CodedError(409, 'feishu_not_configured', 'This team has no Feishu/Lark bot')
    const bound = await (this.options.boundChats?.() ?? Promise.resolve([]))
    if (!bound.includes(chat)) throw new CodedError(403, 'chat_not_bound', 'This chat is not bound to this repository')
    try { return await chatMembers(feishu, chat, this.parts.lifetime) }
    catch (error) { throw new CodedError(502, 'feishu_error', String(error).slice(0, 300)) }
  }
  /** The repository's collaborators as `{id: login}` (the GitHub Policy's `allowed` ids), through the installation token. */
  async githubCollaborators(): Promise<{ id: string }[]> {
    let people: { login: string }[]
    try { people = await this.options.apis.github.pages(z.looseObject({ login: z.string().min(1) }), 'collaborators?per_page=100') }
    catch (error) { throw new CodedError(502, 'github_error', String(error).slice(0, 300)) }
    return [...new Set(people.map(person => person.login))].map(id => ({ id }))
  }
  /** A fresh ticket token for a worker whose assignment is still running (parent design §4.3), else undefined. */
  async refreshToken(ticketId: string, assignmentId: string): Promise<string | undefined> {
    const ticket = this.store.tickets.get(ticketId)
    if (!this.options.tokens || !ticket || runningAssignment(ticket)?.id !== assignmentId || !this.parts.holding()) return undefined
    const { cellId, tenantId } = this.options.cell
    return this.options.tokens.sign({ sub: ticketKey(cellId, ticketId), tid: tenantId, cid: cellId, tkt: ticketId, asg: assignmentId, rsid: runtimeSessionId(cellId, ticketId) })
  }
  /**
   * A worker's read of `feishu/<trigger-id>/...` (parent design §4.7): allowed only for a Trigger that reached the ticket
   * (its origin batch or one of its inputs), as DSH limited an Executor's `orchestrator_read` to its own ticket.
   */
  async readForWorker(ticketId: string, resource: string): Promise<{ content: string; mediaType: string } | { refused: string; status: number; message: string }> {
    const ticket = this.store.tickets.get(ticketId)
    if (!ticket) return { refused: 'not_found', status: 404, message: 'No such ticket in this cell' }
    const match = /^feishu\/([^/]+)\//.exec(resource)
    if (!match) return { refused: 'unsupported', status: 400, message: 'Only feishu/<trigger-id>/... resources are read here' }
    const triggerId = decodeURIComponent(match[1]!)
    const reached = ticket.origin.triggerIds.includes(triggerId) || ticket.inputs.some(input => input.kind === 'trigger' && input.triggerId === triggerId)
    const trigger = reached ? this.store.triggers.get(triggerId) : undefined
    if (!trigger) return { refused: 'forbidden', status: 403, message: 'That message did not reach this ticket' }
    // Its chat must still be one the cell listens to (bound to it through dshsa-routes, which the chats sync follows).
    if (!trigger.channel || !this.sources.channelAllowed(trigger.channel)) return { refused: 'forbidden', status: 403, message: 'That chat is no longer bound to this cell' }
    if (!this.options.readResource) return { refused: 'unsupported', status: 400, message: 'This cell has no Feishu reader' }
    return this.options.readResource(this, trigger, resource)
  }
  /** Stops in the order the lease protocol needs: no new work, running effects finish, the database closes. */
  stop(): Promise<void> { return this.stopping ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    this.closing = true
    this.stopped.abort()
    await this.passes.stop()
    this.assessor.dispose?.()
    await Promise.allSettled([this.effects.drain(), ...this.loops, this.executor.shutdown?.()])
    this.store.close()
  }
}
