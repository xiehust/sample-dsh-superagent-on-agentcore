/**
 * AgentCoreExecutor: the core `Executor` port on AgentCore Runtime (parent design §4.4), in the shape of DSH's `DshExecutor`:
 * the Engine's `start`/`deliver`/`stop` only enqueue durable effects (`launch`, `delivery`, `stop`); their handlers provision
 * the ticket's access point, mint a ticket token and invoke the ticket's runtime session, then report back to the Engine.
 */
import { InvocationRequest, InvocationResponse, WORKER_TYPE_LABELS, accessPointRoot, resolveModel, type WorkerType, runtimeSessionId, ticketKey, type WorkerConfig, type WorkerInput,
  type WorkerTicket } from '@dshsa/contracts'
import { latestAssignment, liveTicket, runningAssignment, type Assignment, type Executor, type Ticket, type TicketInput } from '../core/index.ts'
import { Later } from '../app/effects.ts'
import { KV } from '../kv.ts'
import { ticketEnvironment } from '../app/execution-environment.ts'
import type { CellParts } from '../cell.ts'
import type { TicketTokens } from '../token.ts'
import { RETRIED, batchLine, batchOf, capped, inputMessage, mandateInstructions, sourceTrigger, transient, triggerMessage } from './messages.ts'

declare module '../app/effects.ts' {
  interface EffectPayloads {
    /** dshsa: stop a ticket's runtime session turn; the key is the Assignment ID. */
    stop: { ticketId: string; assignmentId: string; reason: string }
  }
}

/** Invokes one runtime session (`InvokeAgentRuntime`); implemented on the AWS SDK and by test fakes. */
export interface WorkerRuntime {
  invoke(runtimeSessionId: string, request: InvocationRequest, signal: AbortSignal): Promise<InvocationResponse>
  /** Ends the session's microVM (`StopRuntimeSession`), so the next invoke starts a fresh one on the current image. */
  stopSession?(runtimeSessionId: string, signal: AbortSignal): Promise<void>
}
/** Ensures a ticket's S3 Files access point and `dshsa-ticket-storage` item exist (Lambda `dshsa-provisioner`, idempotent). */
export interface Provisioner { ensure(request: { tenantId: string; cellId: string; ticketId: string; ticketKey: string; runtimeSessionId: string; rootPath: string }): Promise<void> }

/** What the Executor needs beyond the cell's parts (which hold a lazy `engine`, so they are never spread). */
export interface AgentCoreExecutorDeps {
  /** The Claude worker runtime (pre-v7 name; same as `runtimes.claude`). */
  runtime?: WorkerRuntime
  /** v7: one runtime per worker type this host can invoke; a ticket whose type has none fails permanently. */
  runtimes?: Partial<Record<WorkerType, WorkerRuntime>>
  provisioner: Provisioner
  tokens: TicketTokens
  /** The worker version the runtime serves now (contracts `WorkerVersion`), or undefined when unknown; enables stale-session stops. */
  workerVersion?: () => Promise<string | undefined>
  /** v7: the served version per worker type (`workerVersion` is the claude one). */
  workerVersions?: Partial<Record<WorkerType, () => Promise<string | undefined>>>
  /** Pause after a stale session's stop before the next invoke, so the old microVM's SIGTERM checkpoint can land (default 2 s). */
  staleStopSettleMs?: number
}
/** What a session last answered: its image version (`null` for an image older than the field). */
interface SessionSeen { version: string | null }
/** Worker errors a retry cannot fix; anything else is retried with backoff. */
const PERMANENT = new Set(['unauthorized', 'bad_request', 'bound_to_other_ticket'])
const TRANSIENT_TRIES = 3
const ASSIGNMENT_CHARS = 1500
/** True when the assignment's last turn ended after its last delivery, so its worker is not in a turn. */
const idleSince = (assignment: Assignment): boolean => !!assignment.idleAt && (!assignment.deliveredAt || assignment.idleAt >= assignment.deliveredAt)
class WorkerRefused extends Error { constructor(readonly code: string, message: string) { super(`${code}: ${message}`) } }
/** v7: the ticket's worker type has no runtime in this installation (never retried). */
class NoRuntime extends Error {
  readonly code = 'bad_request'
  constructor(readonly type: WorkerType) { super(`The ${WORKER_TYPE_LABELS[type]} worker is not deployed in this installation`) }
}

export class AgentCoreExecutor implements Executor {
  private readonly attempts = new Map<string, number>()
  /** By runtime session id, what it last answered (in memory: after a restart, an idle session is probed once with `status`). */
  private readonly seen = new Map<string, SessionSeen>()
  constructor(private readonly host: CellParts, private readonly deps: AgentCoreExecutorDeps) {}
  /**
   * v7: the ticket's worker type. Fixed (written if absent) before the first invoke of its first launch from
   * `settings.executor.workerType`; a ticket that already started before v7 is a Claude ticket. Never rewritten.
   */
  workerType(ticket: Ticket, fix = false): WorkerType {
    const { store } = this.host
    const stored = store.get(KV.workerType(ticket.id))
    if (stored) return stored
    const legacy = ticket.assignments.some(item => item.startedAt)
    const type: WorkerType = legacy ? 'claude' : store.settings().executor.workerType
    if (fix || legacy) store.set(KV.workerType(ticket.id), type)
    return type
  }
  private runtimeOf(type: WorkerType): WorkerRuntime | undefined {
    return this.deps.runtimes?.[type] ?? (type === 'claude' ? this.deps.runtime : undefined)
  }
  private runtime(type: WorkerType): WorkerRuntime {
    const runtime = this.runtimeOf(type)
    if (!runtime) throw new NoRuntime(type)
    return runtime
  }
  private served(type: WorkerType): (() => Promise<string | undefined>) | undefined {
    return this.deps.workerVersions?.[type] ?? (type === 'claude' ? this.deps.workerVersion : undefined)
  }
  install(): void {
    const { effects, settings } = { effects: this.host.effects, settings: () => this.host.store.settings() }
    const running = () => this.host.store.tickets.open().filter(ticket => runningAssignment(ticket)).length
    effects.handle('launch', payload => this.launch(payload), { retry: [5000, 120_000],
      limit: () => this.host.paused() ? 0 : Math.max(0, settings().executor.maxWorkers - running()) })
    effects.handle('delivery', ({ ticketId }) => this.deliverQueued(ticketId), { retry: [2000, 60_000], limit: () => this.host.paused() ? 0 : 4 })
    effects.handle('stop', payload => this.stopQueued(payload), { retry: [2000, 30_000], limit: () => 4, quiet: true })
  }
  start(ticket: Ticket, assignment: Assignment): void { this.host.effects.enqueue('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id }) }
  deliver(ticket: Ticket, _assignment: Assignment): void { this.host.effects.enqueue('delivery', ticket.id, { ticketId: ticket.id }) }
  stop(ticket: Ticket, assignment: Assignment, reason: string): void {
    this.host.effects.enqueue('stop', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id, reason })
  }

  /** The invocation's `ticket` block and the ids the session and storage are derived from. */
  identity(ticket: Ticket, assignment: Assignment): { ticket: WorkerTicket; sessionId: string; key: string; rootPath: string } {
    const { cellId, tenantId } = this.host.cell
    const note = ticket.execution?.assignment ?? ''
    return { sessionId: runtimeSessionId(cellId, ticket.id), key: ticketKey(cellId, ticket.id), rootPath: accessPointRoot(tenantId, cellId, ticket.id),
      ticket: { tenantId, cellId, ticketId: ticket.id, assignmentId: assignment.id, title: ticket.title, scope: ticket.title,
        mandate: ticket.mandate as unknown as Record<string, unknown>, ...note ? { note } : {} } }
  }
  /** The `config` block: model, composed worker system prompt, skills, execution variables and repository (sent on start and deliver). */
  config(ticket: Ticket, type: WorkerType = this.workerType(ticket)): WorkerConfig {
    const { store, prompts, sources, cell } = this.host
    const settings = store.settings()
    const version = prompts.current()
    const trigger = sourceTrigger({ store }, ticket)
    const variables = ticketEnvironment({ cell, sources, settings, ticket, ...trigger ? { trigger } : {} })
    const mandate = mandateInstructions(ticket.mandate)
    const systemPrompt = `[dsh-superagent prompt revision ${version.revision}]\n${prompts.compose(version.config, 'worker', variables)}\n${mandate}`
    const { model, effort, source } = resolveModel('worker', settings, type)
    // The cell's worker model is for another worker type (or a hand-edited id): this ticket runs on its type's default.
    if (source === 'fallback') this.host.log.info('model_fallback', { ticketId: ticket.id, workerType: type, stored: settings.executor.model?.model, model })
    return { model, ...effort ? { effort } : {}, agent: type, systemPrompt,
      skills: prompts.skills(version.config).map(([name, content]) => ({ name: `dsh-superagent-${name}`, content })),
      env: Object.fromEntries(variables.map(variable => [variable.key, variable.value])),
      repo: { fullName: cell.repository, defaultBranch: cell.defaultBranch, cloneUrl: `https://github.com/${cell.repository}.git` } }
  }
  /** One Ticket Input as the worker receives it (DSH `inputMessage`, carried in a §4.4 `WorkerInput`). */
  input(ticket: Ticket, input: TicketInput): WorkerInput | undefined {
    const trigger = input.kind === 'trigger' ? this.host.store.triggers.get(input.triggerId) : undefined
    const text = inputMessage(input, trigger ? triggerMessage(trigger, trigger.url ? { source_url: trigger.url } : {}, input.kind === 'trigger' ? input.note : undefined) : undefined)
    if (text === undefined) return undefined
    const source = trigger?.source === 'github' || trigger?.source === 'feishu' ? trigger.source : undefined
    const kind: WorkerInput['kind'] = input.kind === 'trigger' ? 'trigger' : input.kind === 'policy-changed' ? 'policy' : input.kind === 'resumed' ? 'resume' : 'text'
    return { id: input.id, kind, at: input.at, text, ...source ? { source } : {}, ...trigger?.url ? { url: trigger.url } : {},
      ...trigger ? { meta: { triggerId: trigger.id, from: trigger.actor.id, human: trigger.human } } : {} }
  }
  /** The first input of an assignment: its card with the source trigger and batch (DSH `launch`), as a `text` input. */
  assignmentInput(ticket: Ticket, assignment: Assignment): WorkerInput {
    const source = sourceTrigger(this.host, ticket)
    const retried = ticket.assignments.at(-2)?.endedReason === 'retried' ? { note: RETRIED } : {}
    const { text: brief, chars, read } = capped(ticket.execution?.assignment ?? '', ASSIGNMENT_CHARS, `ticket/${ticket.id}/assignment`)
    const card = source ? triggerMessage(source, source.url ? { source_url: source.url } : {}) : undefined
    const batch = batchOf(this.host, ticket).map(batchLine)
    const text = JSON.stringify({ ticket_id: ticket.id, title: ticket.title, assignment_number: ticket.assignments.length, ...(brief ? { assignment: brief } : {}),
      ...(read ? { assignment_chars: chars, assignment_read: read } : {}), ...(card ? { trigger: card } : {}), ...(batch.length ? { batch } : {}), ...retried })
    return { id: `assignment:${assignment.id}`, kind: 'text', at: assignment.createdAt, text }
  }
  async request(action: InvocationRequest['action'], ticket: Ticket, assignment: Assignment, inputs: WorkerInput[]): Promise<InvocationResponse> {
    const { ticket: block, sessionId, key } = this.identity(ticket, assignment)
    const token = await this.deps.tokens.sign({ sub: key, tid: block.tenantId, cid: block.cellId, tkt: ticket.id, asg: assignment.id, rsid: sessionId })
    const type = this.workerType(ticket)
    const runtime = this.runtime(type)
    const request = InvocationRequest.parse({ v: 1, action, token, ticket: block, inputs,
      ...action === 'start' || action === 'deliver' ? { config: this.config(ticket, type) } : {} })
    if (!this.host.holding()) throw new Later('The cell lease is not held')
    const response = InvocationResponse.parse(await runtime.invoke(sessionId, request, this.host.lifetime))
    this.seen.set(sessionId, { version: response.workerVersion ?? null })
    return response
  }
  /**
   * After a worker deploy a live session keeps its old microVM. Before `start` or `deliver` on a session that is idle (not in a
   * turn), stop it when it last answered another version than the runtime serves, so the next invoke gets a fresh microVM that
   * resumes from the ticket's access point. A session in a turn is left alone; it is checked again before its next delivery.
   * Best effort: an unknown current version, or a stop that fails, never blocks the invocation.
   */
  async refreshStale(ticket: Ticket, assignment: Assignment, idle: boolean, probe: boolean): Promise<void> {
    const type = this.workerType(ticket)
    const runtime = this.runtime(type)
    const stop = runtime.stopSession?.bind(runtime)
    const served = this.served(type)
    if (!idle || !stop || !served) return
    const expected = await served().catch(() => undefined)
    if (!expected) return
    const { sessionId } = this.identity(ticket, assignment)
    if (!this.seen.has(sessionId) && probe) {
      try {
        // Only a fresh status says whether the worker is in a turn; a `deliver` answer always says `running`, so earlier ones do not count.
        const status = await this.request('status', ticket, assignment, [])
        if (status.ok && status.state === 'running') return
      } catch (error) { if (error instanceof Later) throw error; this.host.log.warn('worker status probe failed', { ticketId: ticket.id, error: String(error) }); return }
    }
    const seen = this.seen.get(sessionId)
    if (!seen || seen.version === expected) return
    if (!this.host.holding()) throw new Later('The cell lease is not held')
    this.host.log.info('stopping stale worker session', { ticketId: ticket.id, assignmentId: assignment.id, runtimeSessionId: sessionId,
      workerVersion: seen.version, expected })
    try { await stop(sessionId, this.host.lifetime); this.seen.delete(sessionId) }
    catch (error) { this.host.log.warn('stale worker session stop failed', { ticketId: ticket.id, runtimeSessionId: sessionId, error: String(error) }); return }
    const settle = this.deps.staleStopSettleMs ?? 2000
    if (settle > 0) await new Promise<void>(resolve => { const timer = setTimeout(resolve, settle); this.host.lifetime.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true }) })
  }

  private current(ticketId: string, assignmentId: string): { ticket: Ticket; assignment: Assignment } | undefined {
    const ticket = this.host.store.tickets.get(ticketId)
    const assignment = ticket && latestAssignment(ticket)
    return ticket && assignment && liveTicket(ticket) && assignment.id === assignmentId ? { ticket, assignment } : undefined
  }
  private async launch({ ticketId, assignmentId }: { ticketId: string; assignmentId: string }): Promise<void> {
    const found = this.current(ticketId, assignmentId)
    if (!found || found.assignment.state !== 'pending') return
    if (!this.host.holding()) throw new Later('The cell lease is not held')
    if (this.host.paused()) throw new Later('Processing is paused')
    const { ticket, assignment } = found
    try {
      this.runtime(this.workerType(ticket, true))  // fix the type before the first invoke; no runtime → permanent failure below
      const { sessionId, key, rootPath } = this.identity(ticket, assignment)
      await this.deps.provisioner.ensure({ tenantId: this.host.cell.tenantId, cellId: this.host.cell.cellId, ticketId, ticketKey: key, runtimeSessionId: sessionId, rootPath })
      // A resumed ticket reuses its session: its earlier assignment has ended, so the session is idle (never probed: it may be long gone).
      await this.refreshStale(ticket, assignment, ticket.assignments.length > 1, false)
      const response = await this.request('start', ticket, assignment, [this.assignmentInput(ticket, assignment)])
      if (!response.ok) throw new WorkerRefused(response.error, response.message)
      if (!this.current(ticketId, assignmentId)) return
      this.host.engine.assignmentStarted(ticketId, assignmentId)
      this.attempts.delete(`launch:${assignmentId}`)
    } catch (error) {
      if (error instanceof Later) throw error
      const permanent = error instanceof NoRuntime || (error instanceof WorkerRefused && PERMANENT.has(error.code))
        || (error instanceof Error && 'code' in error && (error as { code?: unknown }).code === 'bad_request')
      if (!permanent && this.retries(`launch:${assignmentId}`, error)) throw error
      if (!this.current(ticketId, assignmentId)) return
      this.host.log.error('launch failed', { ticketId, assignmentId, error: String(error) })
      const summary = error instanceof NoRuntime ? error.message : `The worker could not start: ${String(error).slice(0, 500)}`
      this.host.engine.report(ticketId, { state: 'failed', summary })
    }
  }
  /** Delivers the ticket's undelivered Inputs to its running assignment in one `deliver` invocation. */
  private async deliverQueued(ticketId: string): Promise<void> {
    const ticket = this.host.store.tickets.get(ticketId)
    const assignment = ticket && liveTicket(ticket) ? runningAssignment(ticket) : undefined
    if (!ticket || !assignment || !ticket.undelivered.length) return
    if (!this.host.holding()) throw new Later('The cell lease is not held')
    const ids = [...ticket.undelivered]
    const inputs = ids.flatMap(id => { const input = ticket.inputs.find(item => item.id === id); const mapped = input && this.input(ticket, input); return mapped ? [mapped] : [] })
    try {
      await this.refreshStale(ticket, assignment, idleSince(assignment), true)
      const response = await this.request('deliver', ticket, assignment, inputs)
      if (!response.ok) throw new WorkerRefused(response.error, response.message)
      const current = this.host.store.tickets.get(ticketId)
      if (!current || runningAssignment(current)?.id !== assignment.id) return
      // Inputs that produce no message (legacy kinds) count as delivered too, like DSH.
      const accepted = new Set(response.accepted)
      this.host.engine.inputsDelivered(ticketId, assignment.id, ids.filter(id => accepted.has(id) || !inputs.some(input => input.id === id)))
    } catch (error) {
      if (error instanceof Later) throw error
      const current = this.host.store.tickets.get(ticketId)
      const live = current && liveTicket(current) && runningAssignment(current)?.id === assignment.id
      if (live) this.host.engine.deliveryFailed(ticketId, assignment.id, String(error))
      if (error instanceof NoRuntime) {  // permanent: report once, never retry
        if (live) this.host.engine.report(ticketId, { state: 'failed', summary: error.message })
        return
      }
      throw error
    }
  }
  private async stopQueued({ ticketId, assignmentId }: { ticketId: string; assignmentId: string; reason: string }): Promise<void> {
    const ticket = this.host.store.tickets.get(ticketId)
    const assignment = ticket?.assignments.find(item => item.id === assignmentId)
    if (!ticket || !assignment || !assignment.startedAt) return
    if (!this.runtimeOf(this.workerType(ticket))) return  // no runtime for its type: nothing runs there to stop
    const response = await this.request('stop', ticket, assignment, [])
    if (!response.ok && !PERMANENT.has(response.error)) throw new WorkerRefused(response.error, response.message)
  }
  private retries(key: string, error: unknown): boolean {
    const tries = this.attempts.get(key) ?? 0
    if (!(transient(error) || error instanceof WorkerRefused || (error instanceof Error && error.name === 'Error' && /provisioner internal/.test(error.message))) || tries >= TRANSIENT_TRIES) { this.attempts.delete(key); return false }
    this.attempts.set(key, tries + 1)
    return true
  }
}
