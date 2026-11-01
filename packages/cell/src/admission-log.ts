/**
 * dshsa: a trace in the host log for every Trigger the cell does not admit (there is no DSH main Session to see it). A
 * Trigger a Source does not listen to is `filtered` at intake; one the Policy gate rejects (`not_a_member`, `no_mention`,
 * `not_human`, …) or that already started a ticket is recorded in an `ignore` Decision whose reason names it. Ignores the
 * Assessor or a person decides carry no per-Trigger reason and are not logged here. The Trigger's text is never logged.
 */
import type { Logger } from '@dshsa/contracts'
import type { DomainEvent, Reason, Trigger } from './core/index.ts'
import type { Store } from './app/store.ts'

function line(log: Logger, cellId: string, trigger: Trigger | undefined, triggerId: string, reason: string, at: 'intake' | 'gate'): void {
  log.info('trigger not admitted', { cellId, triggerId, reason, at, source: trigger?.source, actor: trigger?.actor.id, addressed: trigger?.addressed ?? null })
}

/** Logs the Trigger a Source filtered at intake (`Engine.receive` returned `filtered`). */
export function logFiltered(log: Logger, cellId: string, store: Pick<Store, 'triggers'>, trigger: Trigger): void {
  line(log, cellId, trigger, trigger.id, store.triggers.disposition(trigger.id)?.filtered?.code ?? 'filtered', 'intake')
}

/** Logs each Trigger of an `ignore` Decision the gate recorded, once, with its own reason. */
export function logGateIgnores(log: Logger, cellId: string, store: Pick<Store, 'triggers' | 'decisions'>, event: DomainEvent): void {
  if (event.type !== 'decision.recorded' || event.data.kind !== 'ignore') return
  const decision = store.decisions.get(event.data.decisionId)
  if (!decision) return
  const own = new Map(decision.reason.filter((reason): reason is Reason & { triggerId: string } => !!reason.triggerId).map(reason => [reason.triggerId, reason.code]))
  // The gate found none of the batch admissible without a per-Trigger reason.
  const none = decision.reason.length === 1 && decision.reason[0]!.code === 'noAdmissible'
  for (const triggerId of new Set(decision.triggerIds)) {
    const reason = own.get(triggerId) ?? (none ? 'noAdmissible' : undefined)
    if (reason) line(log, cellId, store.triggers.get(triggerId), triggerId, reason, 'gate')
  }
}
