/**
 * The routing context of a StatelessAssessor candidate card, as pure functions over a narrow view of the Store and the Source
 * registry. The fields the verbatim DSH `dispatch.md` names (`related_tickets`, `delivered_to`, `referenced_tickets`,
 * `handed_back`) follow DSH `src/app/links.ts` `candidateCard` / `src/app/cards.ts` `relatedTickets`; `nearby_tickets` and
 * `recent_decisions` are dshsa's stand-in for the cross-candidate memory and `orchestrator_read` of DSH's main Session, which
 * a stateless call does not have. Every window is relative to the primary trigger's `at`, so the card depends only on the
 * store state, never on the clock.
 */
import { liveTicket, threadKey, type Candidate, type Decision, type Ticket, type Trigger } from './core/index.ts'
import type { Store } from './app/store.ts'

/** What the card reads from the Store. */
export interface CardRecords {
  readonly triggers: Pick<Store['triggers'], 'get' | 'disposition'>
  readonly threads: Pick<Store['threads'], 'get'>
  readonly tickets: Pick<Store['tickets'], 'get'>
  readonly read: Pick<Store['read'], 'ticketsUpdatedSince' | 'decisionsSince'>
}
/** What the card asks the Source registry: the Threads a reference such as `#12` or a PR URL names. */
export interface CardSources { find(query: string): { threads: string[] } }

const MINUTE = 60_000, HOUR = 60 * MINUTE
export const LIMITS = {
  related: 8, referenced: 4, nearby: 4, decisions: 4,
  /** An open ticket counts as nearby when it was updated this recently, an ended one when it ended this recently. */
  openWindowMs: 2 * HOUR, endedWindowMs: 24 * HOUR, decisionWindowMs: 30 * MINUTE,
  /** How many candidate rows each window query reads before filtering. */
  scan: 200,
  report: 300, preview: 160, title: 120,
  /** Upper bound, in compact JSON characters, of `nearby_tickets` and `recent_decisions` together. */
  budget: 2048,
} as const

/** Collapses whitespace and truncates, as DSH `cards.ts` `preview` does. */
export const preview = (text: string, limit: number = LIMITS.preview): string => text.replace(/\s+/g, ' ').trim().slice(0, limit)

/** The ticket projection every ticket section of the card uses. */
export function ticketCard(ticket: Ticket) {
  const report = ticket.assignments.at(-1)?.report?.summary
  return { ticket_id: ticket.id, title: ticket.title.slice(0, LIMITS.title), open: liveTicket(ticket), strength: ticket.mandate.strength,
    ...ticket.ended ? { ended: ticket.ended } : {}, ...report ? { report: report.slice(0, LIMITS.report) } : {} }
}
type TicketCard = ReturnType<typeof ticketCard>

/** DSH `relatedTickets`: the thread's tickets, open ones first, newest first within each group, with the total when capped. */
export function relatedTickets(tickets: readonly Ticket[]): { related_tickets: TicketCard[]; tickets_total?: number } {
  const order = [...tickets].sort((a, b) => Number(!!a.ended) - Number(!!b.ended) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
  return { related_tickets: order.slice(0, LIMITS.related).map(ticketCard), ...tickets.length > LIMITS.related ? { tickets_total: tickets.length } : {} }
}

const REFERENCE = /#\d+|https?:\/\/[^\s)>\]]+/g
/**
 * DSH `referencedTickets`: the tickets subscribed to the Threads the triggers' text names (`#12`, an Issue or PR URL), not
 * already in `known`, at most four.
 */
export function referencedTickets(records: Pick<CardRecords, 'threads' | 'tickets'>, sources: CardSources, triggers: readonly Trigger[],
  known: ReadonlySet<string>): Ticket[] {
  const threads = triggers.flatMap(trigger => trigger.text.match(REFERENCE) ?? []).flatMap(reference => sources.find(reference).threads)
  const ids = new Set(threads.flatMap(thread => records.threads.get(thread)?.subscriptions ?? []))
  for (const id of known) ids.delete(id)
  return [...ids].flatMap(id => records.tickets.get(id) ?? []).slice(0, LIMITS.referenced)
}

/** The Feishu chat a trigger was written in, from its reply address or its meta. */
const chatOf = (trigger: Pick<Trigger, 'channel' | 'meta'>): string | undefined => {
  const chat = trigger.channel?.address.chatId ?? trigger.meta.chatId
  return typeof chat === 'string' && chat ? chat : undefined
}
const actorPlace = (source: string, actor: string) => `${source}:actor:${actor.toLowerCase()}`
/**
 * Where a trigger was written, for "nearby": a Feishu chat, or elsewhere (a GitHub cell is one repository) its author.
 * A Feishu trigger without a chat has no place, and nothing is near it.
 */
export function placeOf(trigger: Pick<Trigger, 'source' | 'actor' | 'channel' | 'meta'>): string | undefined {
  if (trigger.source !== 'feishu') return actorPlace(trigger.source, trigger.actor.id)
  const chat = chatOf(trigger)
  return chat ? `feishu:chat:${chat}` : undefined
}
/** The places a ticket belongs to: its origin trigger's, its Feishu reply chats', and outside Feishu its requester's. */
function ticketPlaces(ticket: Ticket, origin: Trigger | undefined): Set<string> {
  const places = new Set<string>()
  const own = origin && placeOf(origin)
  if (own) places.add(own)
  for (const channel of ticket.channels) if (channel.source === 'feishu' && channel.address.chatId) places.add(`feishu:chat:${channel.address.chatId}`)
  if (ticket.mandate.actor.source !== 'feishu') places.add(actorPlace(ticket.mandate.actor.source, ticket.mandate.actor.id))
  return places
}
const iso = (ms: number) => new Date(ms).toISOString()
const newest = (a: { at: string; id: string }, b: { at: string; id: string }) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id)

/**
 * Open tickets updated in the last two hours, and tickets ended in the last day, of this trigger's place (same Source, and
 * the same Feishu chat or the same author elsewhere), not in `known`, newest first, at most four.
 */
export function nearbyTickets(records: Pick<CardRecords, 'triggers' | 'read'>, primary: Trigger, known: ReadonlySet<string>) {
  const place = placeOf(primary)
  const at = Date.parse(primary.at)
  if (!place || !Number.isFinite(at)) return []
  const recent = (time: string | undefined, window: number) => time !== undefined && Date.parse(time) >= at - window
  return records.read.ticketsUpdatedSince(iso(at - LIMITS.endedWindowMs), LIMITS.scan)
    .filter(ticket => !known.has(ticket.id))
    .filter(ticket => ticket.ended ? recent(ticket.ended.at, LIMITS.endedWindowMs) : recent(ticket.updatedAt, LIMITS.openWindowMs))
    .flatMap(ticket => {
      const origin = records.triggers.get(ticket.origin.triggerId)
      if (!ticketPlaces(ticket, origin).has(place)) return []
      return [{ ticket, at: ticket.updatedAt, id: ticket.id, origin }]
    })
    .sort(newest).slice(0, LIMITS.nearby)
    .map(({ ticket, origin }) => ({ ...ticketCard(ticket), ...origin ? { origin: { trigger_id: origin.id, preview: preview(origin.text) } } : {} }))
}

/** This sender's Decisions in the last 30 minutes in the same Source (and Feishu chat), on other threads, newest first, at most four. */
export function recentDecisions(records: Pick<CardRecords, 'triggers' | 'read'>, primary: Trigger, thread: string, exclude: ReadonlySet<string>) {
  const at = Date.parse(primary.at)
  if (!Number.isFinite(at)) return []
  const chat = primary.source === 'feishu' ? chatOf(primary) : undefined
  if (primary.source === 'feishu' && !chat) return []
  const actor = primary.actor.id.toLowerCase()
  const mine = (trigger: Trigger) => trigger.source === primary.source && trigger.actor.id.toLowerCase() === actor
    && (primary.source !== 'feishu' || chatOf(trigger) === chat)
  return records.read.decisionsSince(iso(at - LIMITS.decisionWindowMs), LIMITS.scan)
    .filter(decision => decision.threadKey !== thread && !decision.triggerIds.some(id => exclude.has(id)) && Date.parse(decision.at) >= at - LIMITS.decisionWindowMs)
    .flatMap(decision => {
      const trigger = decision.triggerIds.slice(0, 8).flatMap(id => records.triggers.get(id) ?? []).find(mine)
      return trigger ? [{ decision, trigger, at: decision.at, id: decision.id }] : []
    })
    .sort(newest).slice(0, LIMITS.decisions)
    .map(({ decision, trigger }) => decisionLine(decision, trigger))
}
const decisionLine = (decision: Decision, trigger: Trigger) => ({ kind: decision.kind, ...decision.ticketId ? { ticket_id: decision.ticketId } : {},
  reason: decision.reason.map(reason => reason.code), trigger_id: trigger.id, preview: preview(trigger.text), at: decision.at })

/** Drops the oldest entries of the longer list until both fit `LIMITS.budget` characters of compact JSON. */
function withinBudget<A, B>(nearby: A[], decisions: B[]): [A[], B[]] {
  const a = [...nearby], b = [...decisions]
  while ((a.length || b.length) && JSON.stringify([a, b]).length > LIMITS.budget) {
    if (a.length >= b.length) a.pop(); else b.pop()
  }
  return [a, b]
}

/**
 * The card's routing sections for a candidate, in DSH's names. `related_tickets` is always present (dispatch reads it as
 * possibly empty); every other section is omitted when empty.
 */
export function cardContext(records: CardRecords, sources: CardSources, candidate: Candidate) {
  const primary = candidate.triggers[0]!
  const delivered = records.triggers.disposition(primary.id)?.fanout ?? []
  // Triggers a worker handed back as outside its ticket's scope, with the worker's reason (DSH `candidateCard`).
  const handedBack = candidate.triggers.flatMap(trigger => (records.triggers.disposition(trigger.id)?.handbacks ?? [])
    .map(item => ({ trigger_id: trigger.id, ticket_id: item.ticketId, reason: item.reason })))
  const listed = new Set(candidate.tickets.map(ticket => ticket.id))
  const referenced = referencedTickets(records, sources, candidate.triggers, listed)
  for (const ticket of referenced) listed.add(ticket.id)
  const own = new Set(candidate.triggers.map(trigger => trigger.id))
  const [nearby, decisions] = withinBudget(nearbyTickets(records, primary, listed),
    recentDecisions(records, primary, threadKey(candidate.thread.ref), own))
  return { ...handedBack.length ? { handed_back: handedBack } : {}, ...relatedTickets(candidate.tickets),
    ...delivered.length ? { delivered_to: delivered } : {}, ...referenced.length ? { referenced_tickets: referenced.map(ticketCard) } : {},
    ...nearby.length ? { nearby_tickets: nearby } : {}, ...decisions.length ? { recent_decisions: decisions } : {} }
}
