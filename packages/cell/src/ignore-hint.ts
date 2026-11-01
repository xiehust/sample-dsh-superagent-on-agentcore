/**
 * dshsa: one short reply to an explicit request the Assessor ignored, so a listed sender who mentioned or messaged the agent
 * learns why nothing happened (DSH stays silent). Only a request the gate admits as explicit, that a person addressed to the
 * agent, gets it: anything the gate rejected, an inferred or observed candidate, and a bot's message stay silent. The reply
 * names no reason code, rule, or the model's words; it goes out through the Outbox once per Trigger, at most once per Thread
 * in `HINT_INTERVAL_MS`, and not at all while `eval.replyOnIgnore` is off.
 */
import { prefersChinese } from '@dshsa/sources'
import { key, type Decision, type OutboundMessage, type Policy } from './core/index.ts'
import type { Settings } from './policy.ts'
import type { Store } from './app/store.ts'
import { KV } from './kv.ts'
import { leadTrigger } from './admission-log.ts'

export const HINT_INTERVAL_MS = 10 * 60_000
type Hint = 'noTask' | 'unsettled'
/** The ignore reasons that get a hint, by the hint they get. */
const HINTS: Readonly<Record<string, Hint>> = { said: 'noTask', noRuleMatched: 'noTask', directionUnsettled: 'unsettled' }
const TEXT: Readonly<Record<Hint, { zh: string; en: string }>> = {
  noTask: { zh: '我没有看到需要处理的任务。请说明要改什么（仓库、文件、行为），然后再 @ 我。',
    en: "I didn't see a task to do here. Describe what to change (repo, file, behaviour) and @ me again." },
  unsettled: { zh: '方向还没有确定；请明确说明你想要的结果，然后再 @ 我。',
    en: "The direction isn't settled yet; tell me exactly what result you want and @ me again." },
}

/** The hint text for `hint`, in the language of `request` (the `pullEndNotices` rule). */
export function hintText(hint: Hint, request: string): string {
  return prefersChinese(request) ? TEXT[hint].zh : TEXT[hint].en
}

export interface HintHost {
  store: Pick<Store, 'triggers' | 'threads' | 'get' | 'set'>
  settings(): Pick<Settings, 'eval'>
  policy(): Pick<Policy, 'gate'>
}

/**
 * The hint for an `ignore` Decision, or undefined when it gets none (see the module doc). Records the hint's time on its
 * Thread when it returns one; the caller queues it through the Outbox in the same transaction.
 */
export function ignoreHint(host: HintHost, decision: Decision): OutboundMessage | undefined {
  if (decision.kind !== 'ignore' || decision.strength !== 'explicit' || !host.settings().eval.replyOnIgnore) return undefined
  // The gate's own rejections (`not_a_member`, `noAdmissible`, …) carry codes no hint answers, and are never explicit.
  const hint = decision.reason.map(reason => HINTS[reason.code]).find(Boolean)
  if (!hint) return undefined
  const trigger = leadTrigger(host.store, decision.triggerIds)
  if (!trigger?.human || !trigger.addressed || !trigger.channel) return undefined
  // The sender must still be one the gate admits as explicit (a listed sender, or a table cell that makes them explicit);
  // a bot's or system's message never is.
  const thread = host.store.threads.get(decision.threadKey)
  const gate = thread ? host.policy().gate(trigger, thread, []) : undefined
  if (!gate?.admissible || gate.strength !== 'explicit') return undefined
  const last = host.store.get(KV.ignoreHint(decision.threadKey))
  if (last && Date.parse(decision.at) - Date.parse(last) < HINT_INTERVAL_MS) return undefined
  host.store.set(KV.ignoreHint(decision.threadKey), decision.at)
  return { id: key('ignore-hint', trigger.id), channel: trigger.channel, text: hintText(hint, trigger.text), kind: 'reply' }
}
