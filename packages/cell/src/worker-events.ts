/**
 * Worker events → Engine (parent design §4.5): the AWS equivalent of DSH's worker tools (`orchestrator_ack`, `orchestrator_report`,
 * `orchestrator_trigger_handback`, `orchestrator_thread_follow`, `orchestrator_thread_unrelated`) and the Executor's
 * `inputsRead` / `turnEnded` callbacks. Each event applies at most once, by `event.id`, in the same transaction as its command.
 */
import type { Logger, WorkerEventBody } from '@dshsa/contracts'
import { UserError, liveTicket, type Engine, type Ticket, type TicketInput } from './core/index.ts'
import type { Store } from './app/store.ts'
import { KV } from './kv.ts'

export interface WorkerEventsHost {
  store: Store
  engine: Engine
  cellId: string
  log: Logger
  /** Called after a report commits, such as for the Replier. */
  reported?(ticket: Ticket, report: { state: string; summary: string; question?: string | null | undefined }): void
  /**
   * Reads and claims a reported PR for the ticket (DSH `readPull` + `claimPull` through the GitHub Source); returns why it is
   * refused, or undefined once the ticket follows the PR. Runs before the report's transaction, as DSH's tool did.
   */
  claimPull?(ticketId: string, prNumber: number): Promise<string | undefined>
}
/** Why an event was not applied; the queue deletes it either way (retrying cannot change the outcome). */
export type Refusal = 'duplicate' | 'wrong_cell' | 'unknown_ticket' | 'stale_assignment' | 'ticket_ended' | 'refused'

/** The person's message an acknowledgement answers: the latest human, non-context trigger delivered to the assignment, else the origin. */
export function acknowledgedTrigger(ticket: Ticket, assignmentId: string): string {
  const triggers = ticket.inputs.filter((input): input is Extract<TicketInput, { kind: 'trigger' }> =>
    input.kind === 'trigger' && !!input.human && !input.context && input.deliveredTo === assignmentId)
  return triggers.at(-1)?.triggerId ?? ticket.origin.triggerId
}

export class WorkerEvents {
  constructor(private readonly host: WorkerEventsHost) {}
  /** Applies one verified worker event; returns `undefined` when applied, or why it was not. */
  async apply(body: WorkerEventBody): Promise<Refusal | undefined> {
    const { event, verified } = body
    const { store, engine } = this.host
    if (verified.cid !== this.host.cellId) return this.refuse(body, 'wrong_cell')
    if (event.assignmentId !== verified.asg) return this.refuse(body, 'stale_assignment')
    let outcome: Refusal | undefined
    let after: (() => void) | undefined
    // A report naming its PR claims it first (a network read); a refused claim refuses the report, as DSH's orchestrator_report did.
    if (event.type === 'report' && event.body.prNumber && this.host.claimPull && store.get(KV.workerEvents(event.id)) === undefined) {
      const refused = await this.host.claimPull(verified.tkt, event.body.prNumber)
      if (refused) {
        store.set(KV.workerEvents(event.id), 'refused')
        this.host.log.warn('worker report refused: PR claim', { id: event.id, refused })
        return 'refused'
      }
    }
    try {
      store.atomic(() => {
        if (store.get(KV.workerEvents(event.id)) !== undefined) { outcome = 'duplicate'; return }
        const ticket = store.tickets.get(verified.tkt)
        if (!ticket) { outcome = 'unknown_ticket'; return }
        const latest = ticket.assignments.at(-1)
        if (latest?.id !== verified.asg) { outcome = 'stale_assignment'; store.set(KV.workerEvents(event.id), 'stale'); return }
        const id = ticket.id
        switch (event.type) {
          case 'ack': {
            if (!liveTicket(ticket)) { outcome = 'ticket_ended'; break }
            engine.reply({ purpose: 'acknowledgement', ticketId: id, triggerId: event.body.triggerId, text: event.body.text })
            break
          }
          case 'report': {
            const { state, text, question, askedBy, answers } = event.body
            const report = { state, summary: text, ...question !== undefined ? { question } : {}, ...askedBy ? { askedBy } : {}, ...answers ? { answers } : {} }
            const updated = engine.report(id, report)
            after = () => { this.host.reported?.(updated, report) }
            break
          }
          case 'handback': for (const triggerId of event.body.triggerIds) engine.handback(id, triggerId, event.body.reason); break
          case 'thread.follow': {
            const at = event.body.thread.indexOf(':')
            engine.followForContext(id, { source: event.body.thread.slice(0, at), id: event.body.thread.slice(at + 1) })
            this.host.log.info('worker follows a thread', { ticketId: id, thread: event.body.thread, reason: event.body.reason })
            break
          }
          case 'thread.unrelated': engine.markUnrelated(id, event.body.thread, event.body.reason); break
          case 'inputs.read': engine.inputsRead(id, event.body.inputIds); break
          case 'turn.ended': engine.turnEnded(id, verified.asg); break
          // Served synchronously by internal HTTP (parent design §4.3); one on the queue is only recorded.
          case 'token.refresh': break
        }
        store.set(KV.workerEvents(event.id), outcome ?? 'applied')
      })
    } catch (error) {
      // A command the domain refuses (such as a report on an ended ticket) will be refused again: record it and move on.
      if (error instanceof UserError) {
        store.set(KV.workerEvents(event.id), 'refused')
        this.host.log.warn('worker event refused', { id: event.id, type: event.type, error: error.message })
        return 'refused'
      }
      throw error
    }
    after?.()
    return outcome && outcome !== 'ticket_ended' ? this.refuse(body, outcome, false) : outcome
  }
  private refuse(body: WorkerEventBody, why: Refusal, log = true): Refusal {
    if (log && why !== 'duplicate') this.host.log.warn('worker event not applied', { id: body.event.id, type: body.event.type, why })
    return why
  }
}
