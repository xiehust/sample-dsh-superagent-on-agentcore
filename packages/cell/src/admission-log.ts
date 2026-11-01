/**
 * dshsa: a trace in the host log for every Trigger the cell does not admit (there is no DSH main Session to see it). A
 * Trigger a Source does not listen to is `filtered` at intake; one the Policy gate rejects (`not_a_member`, `no_mention`,
 * `not_human`, …) or that already started a ticket is recorded in an `ignore` Decision whose reason names it, and is
 * logged as `trigger not admitted`. Every other `ignore` Decision (the Assessor's: `said`, `noRuleMatched`,
 * `directionUnsettled`, `observed`, …) is logged once as `decision ignored` with its reason codes. Neither line carries the
 * Trigger's text or the words of a `said` reason.
 */
import type { Logger } from '@dshsa/contracts'
import type { Decision, DomainEvent, Reason, Trigger } from './core/index.ts'
import type { Store } from './app/store.ts'

function line(log: Logger, cellId: string, trigger: Trigger | undefined, triggerId: string, reason: string, at: 'intake' | 'gate'): void {
  log.info('trigger not admitted', { cellId, triggerId, reason, at, source: trigger?.source, actor: trigger?.actor.id, addressed: trigger?.addressed ?? null })
}

/** Logs the Trigger a Source filtered at intake (`Engine.receive` returned `filtered`). */
export function logFiltered(log: Logger, cellId: string, store: Pick<Store, 'triggers'>, trigger: Trigger): void {
  line(log, cellId, trigger, trigger.id, store.triggers.disposition(trigger.id)?.filtered?.code ?? 'filtered', 'intake')
}

/**
 * The per-Trigger reasons of an `ignore` Decision the gate recorded (Evals' `ignore`): each Trigger's own reason, or
 * `noAdmissible` for every Trigger when the gate found none of the batch admissible. Empty for any other Decision.
 */
export function gateReasons(decision: Decision): Map<string, string> {
  const own = new Map(decision.reason.filter((reason): reason is Reason & { triggerId: string } => !!reason.triggerId).map(reason => [reason.triggerId, reason.code]))
  const none = decision.reason.length === 1 && decision.reason[0]!.code === 'noAdmissible'
  const reasons = new Map<string, string>()
  for (const triggerId of new Set(decision.triggerIds)) {
    const reason = own.get(triggerId) ?? (none ? 'noAdmissible' : undefined)
    if (reason) reasons.set(triggerId, reason)
  }
  return reasons
}

/**
 * The Trigger a Decision is about, for showing who asked: the latest one a person addressed to the agent, else the latest
 * one a person wrote, else the latest one.
 */
export function leadTrigger(store: Pick<Store, 'triggers'>, triggerIds: readonly string[]): Trigger | undefined {
  const triggers = triggerIds.flatMap(id => { const trigger = store.triggers.get(id); return trigger ? [trigger] : [] })
  const latest = (items: Trigger[]) => items.reduce<Trigger | undefined>((best, item) => !best || item.at >= best.at ? item : best, undefined)
  return latest(triggers.filter(item => item.human && item.addressed)) ?? latest(triggers.filter(item => item.human)) ?? latest(triggers)
}

/**
 * Logs an `ignore` Decision once: each Trigger the gate rejected as `trigger not admitted` with its own reason, any other
 * as one `decision ignored` line with its reason codes (never the reason's words).
 */
export function logIgnores(log: Logger, cellId: string, store: Pick<Store, 'triggers' | 'decisions'>, event: DomainEvent): void {
  if (event.type !== 'decision.recorded' || event.data.kind !== 'ignore') return
  const decision = store.decisions.get(event.data.decisionId)
  if (!decision) return
  const gate = gateReasons(decision)
  for (const [triggerId, reason] of gate) line(log, cellId, store.triggers.get(triggerId), triggerId, reason, 'gate')
  if (gate.size) return
  const lead = leadTrigger(store, decision.triggerIds)
  log.info('decision ignored', { cellId, decisionId: decision.id, triggerIds: decision.triggerIds, strength: decision.strength,
    codes: decision.reason.map(reason => reason.code), source: lead?.source, actor: lead?.actor.id })
}
