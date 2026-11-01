/**
 * English labels and formatting helpers.
 * Labels adapted from dsh-superagent `src/client/locales.ts` and `src/core/reasons.ts` (MIT, DeepSeek Harness superagent prototype).
 */
import type { Localized, TicketStage } from './types.ts'

const REASONS: Record<string, string> = {
  timeout: 'Eval timed out',
  policyChanged: 'Policy changed during the Eval',
  noAdmissible: 'No admissible Trigger',
  startedTicket: 'Already started Ticket {ticket}',
  acceptedBefore: 'Trigger {trigger} was accepted before',
  routed: 'Routed to Ticket {ticket}',
  explicitRouted: 'Explicit request from someone on the list',
  humanStop: 'Someone asked to stop',
  forwarded: "Fanned out to the Thread's Ticket",
  senderNotMember: "Sender is not on this Source's list",
  retried: 'Retried by a person',
  hostRestarted: 'Cell restarted',
  stopUnknown: 'The Ticket to stop is unknown or ended',
  stopNotExplicit: 'Stopping needs an explicit request from someone on the list',
  directionUnsettled: 'Intent or target not settled, or a product or design decision is still open',
  noRuleMatched: 'No enabled admission rule matched',
  ignoredFromCard: 'Ignored from its card, without a rule assessment',
  observed: 'Observe mode: would accept ({text})',
  // dshsa: the Policy gate's own codes, as the Overview's recent ignores show them.
  not_a_member: "Sender is not on this Source's allowed list",
  no_mention: 'The agent was not mentioned',
  not_human: 'Sent by a bot or system that is not listed',
  admission_ignored: 'The admission table ignores this kind of message',
  completed: 'Completed',
  dropped: 'No action needed; closed',
  merged: 'PR merged',
  closed: 'PR closed',
  stopped: 'Stopped by a person',
  revoked: 'Mandate no longer valid',
}
const fill = (template: string, values: Record<string, string> = {}) =>
  template.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match)

/** Renders a DSH reason (`string`, `{code, values}`, or a list of them) as plain English text. */
export function reasonText(reason: unknown): string {
  if (!reason) return ''
  if (typeof reason === 'string') return REASONS[reason] ?? reason
  if (Array.isArray(reason)) return reason.map(reasonText).filter(Boolean).join('; ')
  if (typeof reason === 'object') {
    const { code, values } = reason as { code?: unknown; values?: Record<string, string> }
    if (code === 'said') return values?.text ?? ''
    if (typeof code === 'string') return fill(REASONS[code] ?? code, values)
  }
  return ''
}

/**
 * One plain-language line per reason of an ignore Decision; a `said` reason is what the assessor wrote, shown as such
 * (the tenant's own data, on an authenticated page).
 */
export function ignoreReasons(reasons: readonly { code: string; values?: Record<string, string> }[]): string[] {
  return reasons.map(reason => reason.code === 'said' ? `Assessor: ${reason.values?.text ?? ''}`.trim() : reasonText(reason)).filter(Boolean)
}

const ACTIONS: Record<string, string> = {
  delivery: 'Reply delivery failed', answer: 'Waiting for an answer', review: 'Ready for review', blocked: 'Blocked', failed: 'Failed',
}
export function stageText(stage: TicketStage): string {
  if (stage.stage === 'person') return ACTIONS[stage.action] ?? 'Waiting for a person'
  if (stage.stage === 'working') return stage.action === 'queued' ? 'Queued' : 'Working'
  return stage.stage === 'idle' ? 'Idle' : 'Ended'
}
export const FILTER_LABELS: Record<string, string> = { open: 'Open', person: 'Waiting for a person', working: 'Working', idle: 'Idle',
  ended: 'Ended' }

export const localized = (value: Localized | string | undefined, fallback = ''): string =>
  typeof value === 'string' ? value : value?.en || value?.zh || fallback

export function when(at: string | undefined): string {
  if (!at) return ''
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
}

/** Only http(s) links from API content are rendered as anchors; anything else (e.g. `javascript:`) is dropped. */
export function safeHref(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : undefined
  } catch { return undefined }
}

/**
 * Why an installation claim waits for platform approval (contracts v6.2 `pendingReason`). Written for the team admin who
 * linked it ("you"), or about `login` when given (the platform view). An unknown or absent reason gets a generic text.
 */
export function claimReasonText(reason: string | undefined, account: string, login?: string): string {
  switch (reason) {
    case 'not_own_account': return login ? `installed on another person's account, not ${login}'s own` : "installed on another person's account"
    case 'not_org_admin': return `${login ? `${login} is` : 'you are'} not an admin of ${account}`
    case 'membership_unavailable':
      return `GitHub did not confirm ${login ? `${login}'s` : 'your'} org role (the App may lack Organization → Members: read)`
    case 'unknown_account_type': return `GitHub did not say whether ${account} is a user or an organization`
    default: return 'a platform admin has to check it'
  }
}
