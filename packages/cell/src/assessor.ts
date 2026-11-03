/**
 * StatelessAssessor: the core `Assessor` port as one Bedrock call per candidate (parent PRD R5), in place of DSH's
 * `MasterAssessor` + main Session. It keeps the DSH main-Session prompt (`Prompts.compose('orchestrator')`) and decision
 * shapes: an explicit candidate is routed with `orchestrator_route` items, an inferred one is assessed with
 * `orchestrator_eval_decide` and mapped through `assessmentOutcome`, exactly as DSH's tools did.
 */
import { z } from 'zod'
import { UserError, liveTicket, threadKey, type Assessor, type Candidate, type Ticket, type Trigger } from './core/index.ts'
import { assessmentOutcome } from './policy.ts'
import { checkedImText } from './infra/text.ts'
import type { CellParts } from './cell.ts'
import { AssessmentSchema, RouteItemSchema, invalid } from './decisions.ts'
import { callTool, modelChoice, type ModelClient, type SystemPrompt } from '@dshsa/assess'
import { environmentSection, policySection, promptParts } from './app/prompts.ts'
import { environmentOf } from './app/execution-environment.ts'
import { triggerMessage } from './executor/messages.ts'

/** What the model is told on top of the DSH main-Session prompt: it is called once, statelessly, and must answer with the tool. */
const STATELESS = 'You are called once for one candidate, with no conversation history and no other tools: read the card and answer by calling the one tool offered. ' +
  'Anything the card does not show is unknown; do not invent ticket ids or quotes.'
const CONTEXT_MESSAGES = 20

export interface AssessorDeps { model: ModelClient }

/**
 * The DSH main-Session system prompt, split for prompt caching: everything before the Policy section (plus the stateless
 * preamble) is the cached prefix, the Policy section (which every Policy save changes) follows the cache point.
 */
export function orchestratorSystem(parts: Pick<CellParts, 'prompts' | 'store' | 'cell' | 'sources'>, preamble: string, withPolicy = true): SystemPrompt {
  const settings = parts.store.settings()
  const { config } = parts.prompts.current()
  const environment = environmentSection(config, environmentOf({ cell: parts.cell, sources: parts.sources, settings }))
  const policy = policySection(settings, config)
  const prefix = promptParts(config, 'orchestrator', environment, policy).filter(part => part.name !== 'runtime/policy').map(part => part.text).join('\n\n')
  return { prefix: `${prefix}\n\n${preamble}`, ...withPolicy ? { policy: policy.text } : {} }
}

export class StatelessAssessor implements Assessor {
  private readonly running = new Map<string, AbortController>()
  constructor(private readonly host: CellParts, private readonly deps: AssessorDeps) {}
  install(): void {
    this.host.effects.handle('assessment', ({ triggerId }, evalId) => this.assess(triggerId, evalId),
      { limit: () => this.host.paused() ? 0 : 4, retry: [5000, 60_000] })
  }
  request(candidate: Candidate): void { this.host.effects.enqueue('assessment', candidate.evalId, { triggerId: candidate.triggers[0]!.id }) }
  release(evalId: string): void { this.running.get(evalId)?.abort(); this.running.delete(evalId) }
  dispose(): void { for (const controller of this.running.values()) controller.abort() }

  /** The card the model reads: the candidate's triggers, thread, tickets and (for an inferred one) the thread's recent messages. */
  async card(candidate: Candidate, signal: AbortSignal): Promise<string> {
    const { store, sources, apis } = this.host
    const ticket = (item: Ticket) => ({ ticket_id: item.id, title: item.title, open: liveTicket(item), strength: item.mandate.strength,
      ...item.ended ? { ended: item.ended } : {}, report: item.assignments.at(-1)?.report?.summary.slice(0, 300) })
    const triggers = candidate.triggers.map(trigger => triggerMessage(trigger, trigger.url ? { source_url: trigger.url } : {}))
    let context: unknown
    if (candidate.strength === 'inferred') {
      const first = candidate.triggers[0]!
      try { context = (await sources.threadContext(first)?.read(apis, 'thread'))?.messages.slice(-CONTEXT_MESSAGES) }
      catch (error) { context = { unavailable: String(error).slice(0, 200) } }
    }
    signal.throwIfAborted()
    const delivered = (trigger: Trigger) => store.triggers.disposition(trigger.id)
    return JSON.stringify({ eval_id: candidate.evalId, strength: candidate.strength, policy_version: candidate.policyVersion,
      thread: threadKey(candidate.thread.ref), trigger_id: candidate.triggers[0]!.id, triggers,
      dispositions: Object.fromEntries(candidate.triggers.map(trigger => [trigger.id, delivered(trigger)])),
      tickets: candidate.tickets.map(ticket), ...context ? { thread_context: context } : {} }, null, 1)
  }
  private async assess(triggerId: string, evalId: string): Promise<void> {
    const { engine, store, log } = this.host
    const candidate = engine.candidate(triggerId)
    if (!candidate || candidate.evalId !== evalId) return
    engine.candidateDelivered(evalId)
    const controller = new AbortController()
    this.running.set(evalId, controller)
    const signal = AbortSignal.any([controller.signal, this.host.lifetime])
    try {
      const settings = store.settings()
      // The Bedrock deadline is the Eval's own timeout, so an unanswered call ends as the Eval would.
      const deadlineMs = settings.eval.timeoutSeconds * 1000
      const system = orchestratorSystem(this.host, STATELESS)
      const { model, effort } = modelChoice('eval', settings)
      const card = await this.card(candidate, signal)
      const live = () => engine.candidate(triggerId)?.evalId === evalId && this.host.holding()
      if (candidate.strength === 'explicit') {
        const item = await callTool(this.deps.model, { model, ...effort ? { effort } : {}, system, signal, deadlineMs, prompt: card,
          tool: { name: 'orchestrator_route', description: 'Route this explicit candidate: accept it as a new ticket, attach it to an existing ticket, stop a ticket on a person\'s stop message, or ignore it, as dispatch says.',
            schema: RouteItemSchema.superRefine((value, ctx) => { const problem = invalid(value); if (problem) ctx.addIssue({ code: 'custom', message: problem }) }) } })
        if (!live()) return
        this.route(candidate, item)
      } else {
        const assessment = await callTool(this.deps.model, { model, ...effort ? { effort } : {}, system, signal, deadlineMs, prompt: card,
          tool: { name: 'orchestrator_eval_decide', description: 'Record the decision of this assessment, as admission describes it.', schema: AssessmentSchema } })
        if (!live()) return
        let outcome = assessmentOutcome(assessment, settings, candidate.strength)
        if (outcome.kind === 'accept' && outcome.acknowledgement) outcome = { ...outcome, acknowledgement: checkedImText(outcome.acknowledgement) }
        engine.decide(triggerId, { ...outcome, evalId })
      }
    } catch (error) {
      if (this.host.lifetime.aborted) throw error
      if (controller.signal.aborted) return
      if (engine.candidate(triggerId)?.evalId !== evalId) return
      // A refused decision or a model that cannot decide makes the Eval unavailable, which the Engine retries and shows.
      log.warn('assessment failed', { evalId, triggerId, error: String(error).slice(0, 500) })
      try { engine.decide(triggerId, { kind: 'unavailable', reason: `The assessment failed: ${String(error).slice(0, 300)}`, evalId }) }
      catch (refused) { if (!(refused instanceof UserError)) throw refused }
    } finally { this.running.delete(evalId) }
  }
  /** DSH `orchestrator_route`'s `route()`, for one item. */
  private route(candidate: Candidate, item: z.infer<typeof RouteItemSchema>): void {
    const { engine } = this.host
    const triggerId = candidate.triggers[0]!.id
    const note = item.note ? { note: item.note } : {}
    switch (item.kind) {
      case 'accept':
        engine.decide(triggerId, { kind: 'accept', title: item.title!, scope: item.title!, reason: { code: 'explicitRouted' },
          acknowledgement: item.acknowledgement!, name: item.worktree_name!, evalId: candidate.evalId, ...note })
        break
      case 'attach': engine.attach(item.ticket_id!, triggerId, item.note ?? undefined); break
      case 'stop': engine.decide(triggerId, { kind: 'stop', ticketId: item.ticket_id!, reason: item.reason || { code: 'humanStop' }, evalId: candidate.evalId }); break
      case 'ignore': engine.decide(triggerId, { kind: 'ignore', reason: item.reason!, evalId: candidate.evalId }); break
    }
  }
}
