/**
 * Replier: the DSH main Session's reply duty as one stateless Bedrock call per worker report (parent PRD R5). A report that
 * may need a person (ready, blocked, failed, dropped, or one that asks a question) becomes a durable `compose` effect; the
 * model, under the DSH replies/communication prompts, decides whether to send and writes the text; the Engine's reply gate
 * (`Replies`) still decides what may go out, exactly as for DSH's `orchestrator_reply`.
 */
import { z } from 'zod'
import { UserError, liveTicket, type Ticket } from './core/index.ts'
import { IM_WORDS } from './infra/text.ts'
import type { CellParts } from './cell.ts'
import { callTool, modelChoice, type ModelClient } from '@dshsa/assess'
import { orchestratorSystem } from './assessor.ts'

declare module './app/effects.ts' {
  interface EffectPayloads {
    /** dshsa: compose the reply to a worker report; the key is `<ticketId>:<assignmentId>:<report time>`. */
    compose: { ticketId: string; assignmentId: string }
  }
}

const STATELESS = 'You are called once, after a worker report, with no conversation history and no other tools. Decide whether the replies '
  + 'and communication sections ask for a message to a person now; if they do, write it; if not, call the tool with send=false.'
export const ReplySchema = z.object({
  send: z.boolean().describe('false when nothing needs a person now, such as ordinary progress.'),
  purpose: z.enum(['result', 'attention', 'answer']).optional(),
  text: z.string().max(20000).optional().describe(`The message, at most ${IM_WORDS} words for IM.`),
  human_action: z.string().optional().describe('For attention: copy the ticket\'s current attention question exactly.'),
  trigger_id: z.string().optional().describe('For answer: the person\'s question it answers.'),
}).strict()
/** Report states that may warrant a message to a person; progress does only when it carries a question. */
const NOTEWORTHY = new Set(['ready', 'blocked', 'failed', 'dropped'])

export interface ReplierDeps { model: ModelClient }
export class Replier {
  constructor(private readonly host: CellParts, private readonly deps: ReplierDeps) {}
  install(): void {
    this.host.effects.handle('compose', payload => this.compose(payload), { limit: () => this.host.paused() ? 0 : 2, retry: [5000, 120_000] })
  }
  /** Called after a report committed (WorkerEvents `reported`). */
  reported(ticket: Ticket, report: { state: string; question?: string | null | undefined }): void {
    const assignment = ticket.assignments.at(-1)
    if (!assignment || !(NOTEWORTHY.has(report.state) || report.question)) return
    this.host.effects.enqueue('compose', `${ticket.id}:${assignment.id}:${assignment.report?.at ?? ''}`, { ticketId: ticket.id, assignmentId: assignment.id })
  }
  card(ticket: Ticket): string {
    const { store } = this.host
    const origin = store.triggers.get(ticket.origin.triggerId)
    const assignment = ticket.assignments.at(-1)
    return JSON.stringify({ ticket_id: ticket.id, title: ticket.title, open: liveTicket(ticket), channels: ticket.channels,
      request: origin ? { trigger_id: origin.id, from: origin.actor.id, text: origin.text.slice(0, 1500), url: origin.url } : undefined,
      report: assignment?.report, attention: ticket.attention, answers: ticket.answers ?? [] }, null, 1)
  }
  private async compose({ ticketId, assignmentId }: { ticketId: string; assignmentId: string }): Promise<void> {
    const { store, engine, log } = this.host
    const ticket = store.tickets.get(ticketId)
    if (!ticket || ticket.assignments.at(-1)?.id !== assignmentId) return
    // The Replier needs no Policy section (it judges no candidate), so its system prompt is the cached prefix alone.
    const system = orchestratorSystem(this.host, STATELESS, false)
    const { model, effort } = modelChoice('reply', store.settings())
    const decision = await callTool(this.deps.model, { model, ...effort ? { effort } : {}, system, prompt: this.card(ticket), signal: this.host.lifetime,
      tool: { name: 'orchestrator_reply', description: 'Send an answer, a ready result or an attention request to a person, or send=false.', schema: ReplySchema } })
    if (!decision.send || !decision.purpose || !decision.text) return
    if (!this.host.holding()) throw new Error('The cell lease is not held')
    try {
      engine.reply({ purpose: decision.purpose, text: decision.text, ticketId, ...decision.trigger_id ? { triggerId: decision.trigger_id } : {},
        ...decision.human_action ? { question: decision.human_action } : {} })
    } catch (error) {
      // The reply gate refused it (wrong purpose, nothing to deliver): that is the gate's decision, not a failure to retry.
      if (error instanceof UserError) { log.info('reply refused by the gate', { ticketId, error: error.message }); return }
      throw error
    }
  }
}
