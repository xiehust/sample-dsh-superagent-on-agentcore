/**
 * The assessor card's routing context (`card-context.ts`): pure functions over a real Store on a temp file, and the whole
 * card through a cell with the StatelessAssessor and a scripted model.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { CellEnvelope } from '@dshsa/contracts'
import type { SourceKind } from '@dshsa/core/host'
import { feishuChannel, feishuTrigger, feishuTriggerId } from '@dshsa/sources'
import { key, type Candidate, type Decision, type Thread, type Ticket, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { githubKind } from '../src/sources/github.ts'
import { LIMITS, cardContext, nearbyTickets, recentDecisions, referencedTickets } from '../src/card-context.ts'
import { StatelessAssessor } from '../src/assessor.ts'
import type { ModelClient, ToolCall } from '@dshsa/assess'
import { CELL_ID, chatEnvelope, chatKind, makeCell, sent, type ChatMessage } from './fixtures/cell.ts'

let cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups) await cleanup(); cleanups = []; sent.length = 0 })

const NOW = '2026-11-03T12:00:00.000Z'
const ago = (minutes: number) => new Date(Date.parse(NOW) - minutes * 60_000).toISOString()
const CHAT = 'oc_team', OTHER_CHAT = 'oc_other'

function tempStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), 'dshsa-card-'))
  const store = new Store(join(dir, 'orchestrator.sqlite'))
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  return store
}
const registry = () => {
  const sources = new SourceRegistry(() => SettingsSchema.parse({}))
  sources.register(feishuKind); sources.register(githubKind)
  return sources
}
let seq = 0
function feishuMessage(overrides: { chat?: string; from?: string; at?: string; text?: string; id?: string } = {}): Trigger {
  const message = overrides.id ?? `om_${++seq}`, chat = overrides.chat ?? CHAT
  return { id: feishuTriggerId(message), source: 'feishu', threads: [{ source: 'feishu', id: `${chat}:${message}` }],
    actor: { source: 'feishu', id: overrides.from ?? 'ou_alice' }, human: true, addressed: 'mention', at: overrides.at ?? NOW,
    text: overrides.text ?? `@agent message ${message}`, channel: feishuChannel(chat, message), meta: { chatId: chat, messageId: message } }
}
function githubMessage(number: number, overrides: { from?: string; at?: string; text?: string } = {}): Trigger {
  const id = key('gh', String(++seq))
  return { id, source: 'github', threads: [{ source: 'github', id: String(number) }], actor: { source: 'github', id: overrides.from ?? 'alice' },
    human: true, addressed: 'mention', at: overrides.at ?? NOW, text: overrides.text ?? `@dshsa-agent comment ${id}`,
    channel: { source: 'github', thread: `github:${number}`, address: { number: String(number) } }, meta: {} }
}
function ticketOf(origin: Trigger, overrides: Partial<Ticket> & { id: string }): Ticket {
  return { title: `Ticket ${overrides.id}`, decisionId: `d-${overrides.id}`, channels: origin.channel ? [origin.channel] : [],
    mandate: { strength: 'explicit', policyVersion: 'p', basis: { via: 'addressed' } as never, actor: origin.actor, scope: 'x' },
    assignments: [], inputs: [], undelivered: [], createdAt: origin.at, updatedAt: origin.at,
    origin: { triggerId: origin.id, triggerIds: [origin.id] }, ...overrides }
}
const threadOf = (key: string, subscriptions: string[] = []): Thread =>
  ({ key, ref: { source: key.split(':')[0]!, id: key.slice(key.indexOf(':') + 1) }, createdAt: NOW, subscriptions, correlated: [], pending: [], meta: {} })
function decisionOf(trigger: Trigger, overrides: Partial<Decision> & { id: string }): Decision {
  return { evalId: `e-${overrides.id}`, threadKey: `${trigger.threads[0]!.source}:${trigger.threads[0]!.id}`, triggerIds: [trigger.id],
    policyVersion: 'p', at: trigger.at, kind: 'ignore', reason: [{ code: 'ordinaryDiscussion' }], strength: 'explicit', ...overrides }
}
const candidateOf = (trigger: Trigger, tickets: Ticket[] = []): Candidate =>
  ({ evalId: 'e-now', thread: threadOf(`${trigger.threads[0]!.source}:${trigger.threads[0]!.id}`), triggers: [trigger], strength: 'explicit', policyVersion: 'p', tickets })
const save = (store: Store, ...items: (Trigger | Ticket)[]) => { for (const item of items) 'source' in item ? store.triggers.save(item) : store.tickets.save(item) }

describe('nearby_tickets', () => {
  it('lists open tickets of the same Feishu chat updated in the last 2 h and tickets ended in the last 24 h, newest first, at most four', () => {
    const store = tempStore()
    const tickets: Ticket[] = []
    for (const [index, minutes] of [10, 20, 30, 40, 50].entries()) {
      const origin = feishuMessage({ at: ago(minutes), from: index % 2 ? 'ou_bob' : 'ou_alice' })
      tickets.push(ticketOf(origin, { id: `open${index}`, updatedAt: ago(minutes) })); save(store, origin)
    }
    const stale = feishuMessage({ at: ago(200) }), ended = feishuMessage({ at: ago(23 * 60) }), old = feishuMessage({ at: ago(26 * 60) })
    const elsewhere = feishuMessage({ chat: OTHER_CHAT, at: ago(5) })
    save(store, stale, ended, old, elsewhere, ...tickets,
      ticketOf(stale, { id: 'stale', updatedAt: ago(121) }),
      ticketOf(ended, { id: 'ended', updatedAt: ago(23 * 60), ended: { at: ago(23 * 60), by: 'executor', outcome: 'completed' } }),
      ticketOf(old, { id: 'old', updatedAt: ago(25 * 60), ended: { at: ago(25 * 60), by: 'executor', outcome: 'completed' } }),
      ticketOf(elsewhere, { id: 'elsewhere', updatedAt: ago(5) }))
    const primary = feishuMessage()
    expect(nearbyTickets(store, primary, new Set()).map(item => item.ticket_id)).toEqual(['open0', 'open1', 'open2', 'open3'])
    // A ticket already on the card is not listed again; the next one fits.
    expect(nearbyTickets(store, primary, new Set(['open0', 'open1', 'open2'])).map(item => item.ticket_id)).toEqual(['open3', 'open4', 'ended'])
    expect(nearbyTickets(store, feishuMessage({ chat: OTHER_CHAT }), new Set()).map(item => item.ticket_id)).toEqual(['elsewhere'])
    expect(nearbyTickets(store, feishuMessage({ chat: 'oc_empty' }), new Set())).toEqual([])
  })
  it('carries the ticket card, a capped report and the origin trigger preview', () => {
    const store = tempStore()
    const origin = feishuMessage({ at: ago(10), text: `@agent  please\n\nrename ${'x'.repeat(400)}` })
    save(store, origin, ticketOf(origin, { id: 't1', updatedAt: ago(5),
      assignments: [{ id: 'a1', state: 'ended', createdAt: ago(10), report: { state: 'ready', summary: 'r'.repeat(500), at: ago(5) } }] }))
    const [item] = nearbyTickets(store, feishuMessage(), new Set())
    expect(item).toMatchObject({ ticket_id: 't1', title: 'Ticket t1', open: true, strength: 'explicit', report: 'r'.repeat(LIMITS.report),
      origin: { trigger_id: origin.id } })
    expect(item!.origin!.preview).toMatch(/^@agent please rename x+$/)
    expect(item!.origin!.preview).toHaveLength(LIMITS.preview)
  })
  it('on GitHub, lists the same author\'s tickets only', () => {
    const store = tempStore()
    const mine = githubMessage(11, { at: ago(30) }), theirs = githubMessage(12, { from: 'bob', at: ago(20) })
    save(store, mine, theirs, ticketOf(mine, { id: 'mine', updatedAt: ago(30) }), ticketOf(theirs, { id: 'theirs', updatedAt: ago(20) }))
    expect(nearbyTickets(store, githubMessage(13, { from: 'Alice' }), new Set()).map(item => item.ticket_id)).toEqual(['mine'])
    expect(nearbyTickets(store, githubMessage(13, { from: 'carol' }), new Set())).toEqual([])
  })
})

describe('recent_decisions', () => {
  it('lists this sender\'s decisions in the same chat on other threads in the last 30 minutes, newest first, at most four', () => {
    const store = tempStore()
    const primary = feishuMessage()
    const sameThread = { ...feishuMessage({ at: ago(1) }), threads: primary.threads }
    const lines = [1, 2, 3, 4, 5].map(minutes => feishuMessage({ at: ago(minutes), text: `ask ${minutes}` }))
    const stale = feishuMessage({ at: ago(31) }), bob = feishuMessage({ at: ago(1), from: 'ou_bob' }), otherChat = feishuMessage({ at: ago(1), chat: OTHER_CHAT })
    save(store, sameThread, stale, bob, otherChat, ...lines)
    for (const trigger of [sameThread, stale, bob, otherChat, ...lines]) store.decisions.save(decisionOf(trigger, { id: `d-${trigger.id}` }))
    store.decisions.save(decisionOf(lines[0]!, { id: 'accepted', at: ago(0.5), kind: 'accept', ticketId: 't1', reason: [{ code: 'explicitRouted' }] }))
    expect(recentDecisions(store, primary, 'feishu:other-thread', new Set()).length).toBe(4)
    const decisions = recentDecisions(store, primary, `feishu:${primary.threads[0]!.id}`, new Set())
    expect(decisions).toEqual([
      { kind: 'accept', ticket_id: 't1', reason: ['explicitRouted'], trigger_id: lines[0]!.id, preview: 'ask 1', at: ago(0.5) },
      { kind: 'ignore', reason: ['ordinaryDiscussion'], trigger_id: lines[0]!.id, preview: 'ask 1', at: ago(1) },
      { kind: 'ignore', reason: ['ordinaryDiscussion'], trigger_id: lines[1]!.id, preview: 'ask 2', at: ago(2) },
      { kind: 'ignore', reason: ['ordinaryDiscussion'], trigger_id: lines[2]!.id, preview: 'ask 3', at: ago(3) },
    ])
    // Decisions on this candidate's own triggers are not "other" context either.
    expect(recentDecisions(store, primary, `feishu:${primary.threads[0]!.id}`, new Set([lines[0]!.id])).map(item => item.trigger_id)).toEqual([lines[1]!.id, lines[2]!.id, lines[3]!.id, lines[4]!.id])
  })
})

describe('referenced_tickets', () => {
  it('lists the tickets subscribed to the Issues and PRs the text names by #N or URL, not already listed, at most four', () => {
    const store = tempStore(), sources = registry()
    for (let index = 1; index <= 6; index++) {
      const origin = githubMessage(100 + index)
      save(store, origin, ticketOf(origin, { id: `r${index}` }))
    }
    store.threads.save(threadOf('github:42', ['r1', 'r2']))
    store.threads.save(threadOf('github:43', ['r3', 'r4', 'r5', 'r6']))
    expect(referencedTickets(store, sources, [feishuMessage({ text: 'see https://github.com/acme/widgets/pull/42 again' })], new Set()).map(item => item.id)).toEqual(['r1', 'r2'])
    expect(referencedTickets(store, sources, [githubMessage(7, { text: 'like #42 (and #43)' })], new Set(['r1'])).map(item => item.id)).toEqual(['r2', 'r3', 'r4', 'r5'])
    expect(referencedTickets(store, sources, [githubMessage(7, { text: 'nothing here, #999' })], new Set())).toEqual([])
  })
})

describe('cardContext', () => {
  it('builds the DSH routing sections, omits empty ones, stays within the budget and is stable for the same state', () => {
    const store = tempStore(), sources = registry()
    const first = feishuMessage({ at: ago(40), text: '@agent rename the Save button' })
    const pr = githubMessage(42, { at: ago(30) })
    const nearbyOrigin = feishuMessage({ at: ago(20), text: '@agent fix the footer' })
    const primary = feishuMessage({ text: '@agent also https://github.com/acme/widgets/pull/42 needs the same label' })
    const related = ticketOf(first, { id: 'related', updatedAt: ago(40) })
    const ended = ticketOf(first, { id: 'related-ended', createdAt: ago(60), ended: { at: ago(50), by: 'executor', outcome: 'completed' } })
    save(store, first, pr, nearbyOrigin, primary, related, ended, ticketOf(pr, { id: 'referenced', updatedAt: ago(30) }), ticketOf(nearbyOrigin, { id: 'nearby', updatedAt: ago(20) }))
    store.threads.save(threadOf('github:42', ['referenced']))
    store.triggers.saveDisposition(primary.id, { fanout: ['related'], handbacks: [{ ticketId: 'related', reason: 'beyond this ticket', at: ago(1) }], at: NOW })
    const other = feishuMessage({ at: ago(3), text: 'unrelated chat' })
    save(store, other); store.decisions.save(decisionOf(other, { id: 'd-other' }))
    const candidate = candidateOf(primary, [ended, related])
    const card = cardContext(store, sources, candidate)
    expect(card).toEqual({
      handed_back: [{ trigger_id: primary.id, ticket_id: 'related', reason: 'beyond this ticket' }],
      related_tickets: [
        { ticket_id: 'related', title: 'Ticket related', open: true, strength: 'explicit' },
        { ticket_id: 'related-ended', title: 'Ticket related-ended', open: false, strength: 'explicit', ended: { at: ago(50), by: 'executor', outcome: 'completed' } },
      ],
      delivered_to: ['related'],
      referenced_tickets: [{ ticket_id: 'referenced', title: 'Ticket referenced', open: true, strength: 'explicit' }],
      nearby_tickets: [{ ticket_id: 'nearby', title: 'Ticket nearby', open: true, strength: 'explicit', origin: { trigger_id: nearbyOrigin.id, preview: '@agent fix the footer' } }],
      recent_decisions: [{ kind: 'ignore', reason: ['ordinaryDiscussion'], trigger_id: other.id, preview: 'unrelated chat', at: ago(3) }],
    })
    expect(JSON.stringify(cardContext(store, sources, candidate))).toBe(JSON.stringify(card))
    // Nothing nearby, referenced or decided: only related_tickets remains, empty.
    expect(cardContext(store, sources, candidateOf(feishuMessage({ chat: 'oc_quiet' })))).toEqual({ related_tickets: [] })
  })
  it('caps nearby_tickets and recent_decisions together at the budget', () => {
    const store = tempStore(), sources = registry()
    for (let index = 0; index < 6; index++) {
      const origin = feishuMessage({ at: ago(index + 1), text: `@agent ${'long request '.repeat(30)}` })
      save(store, origin, ticketOf(origin, { id: `n${index}`, title: 'T'.repeat(200), updatedAt: ago(index + 1),
        assignments: [{ id: 'a', state: 'ended', createdAt: ago(1), report: { state: 'ready', summary: 's'.repeat(400), at: ago(1) } }] }))
      store.decisions.save(decisionOf(origin, { id: `d${index}` }))
    }
    const card = cardContext(store, sources, candidateOf(feishuMessage()))
    expect(JSON.stringify([card.nearby_tickets ?? [], card.recent_decisions ?? []]).length).toBeLessThanOrEqual(LIMITS.budget)
    expect(card.nearby_tickets!.length).toBeGreaterThan(0)
    expect(card.nearby_tickets![0]!.ticket_id).toBe('n0')
  })
})

// The whole card through a cell: a Feishu Source built on the real normalizer, and the fake GitHub kind with the real `find`.
const BOT = 'ou_bot'
const fakeFeishu: SourceKind = { kind: 'feishu', title: { zh: 'fake feishu', en: 'fake feishu' }, description: { zh: '', en: '' },
  schema: z.object({}).passthrough(), fields: [], health: ['feishu'],
  channel: { send: async (_host, message) => { sent.push(message); return 'sent' }, link: () => ({ url: '', label: { zh: 'chat', en: 'chat' } }) },
  policy: chatKind.policy, find: feishuKind.find,
  async ingest(event, ctx) { const trigger = feishuTrigger(event.payload, BOT, 'cli_bot'); if (trigger) await ctx.receive(trigger) } }
const github: SourceKind = { ...chatKind as SourceKind, find: githubKind.find }
const SETTINGS = { policy: { sources: { github: { allowed: [{ id: 'alice' }, { id: 'bob' }] }, feishu: { allowed: [{ id: 'ou_alice' }, { id: 'ou_bob' }] } } } }
let messages = 0
function feishuEnvelope(chat: string, text: string, from = 'ou_alice'): { envelope: CellEnvelope; triggerId: string } {
  const id = `om_live${++messages}`, at = new Date().toISOString()
  const payload = { message_id: id, chat_id: chat, chat_type: 'group', sender_id: from, sender_type: 'user', content: `@_user_1 ${text}`,
    create_time: String(Date.now()), mentions: [{ id: BOT, key: '@_user_1', name: 'agent' }] }
  return { triggerId: feishuTriggerId(id), envelope: { v: 1, id: `feishu:${id}`, cellId: CELL_ID, type: 'source.event', at,
    body: { source: 'feishu', kind: 'im.message.receive_v1', deliveryId: id, payload } } }
}
const githubEnvelope = (id: string, thread: string, text: string, from = 'alice'): ChatMessage =>
  ({ id, thread, from, text: `@dshsa-agent ${text}`, at: new Date().toISOString(), mention: true })

/** A scripted model that attaches to the first nearby or referenced ticket on the card, else accepts. */
function router() {
  const cards: Record<string, any>[] = []
  const model: ModelClient = { call: async request => {
    const card = JSON.parse((request as ToolCall<never>).prompt) as Record<string, any>
    cards.push(card)
    const target = card.referenced_tickets?.[0] ?? card.nearby_tickets?.[0]
    return (target ? { kind: 'attach', trigger_id: card.trigger_id, ticket_id: target.ticket_id }
      : { kind: 'accept', trigger_id: card.trigger_id, title: 'Rename the Save button', worktree_name: 'rename-save-button', acknowledgement: 'On it.' }) as never
  } }
  return { model, cards }
}
async function cellWith() {
  const { model, cards } = router()
  let assessor: StatelessAssessor | undefined
  const made = makeCell({ kinds: [github, fakeFeishu], assessor: parts => (assessor = new StatelessAssessor(parts, { model })) }, SETTINGS)
  cleanups.push(made.cleanup)
  made.cell.start()
  const send = async (envelope: CellEnvelope) => { await made.cell.handle(envelope); await made.cell.passes.idle() }
  return { ...made, cards, send, assessor: assessor! }
}

describe('StatelessAssessor card', () => {
  it('shows a Feishu non-reply follow-up in the same chat the open ticket, and attaching to it gives the ticket the message', async () => {
    const { cell, cards, send } = await cellWith()
    const first = feishuEnvelope(CHAT, 'rename the Save changes button to Save')
    await send(first.envelope)
    const [ticket] = cell.store.tickets.list()
    expect(ticket).toBeDefined()
    expect(cards[0]).not.toHaveProperty('nearby_tickets')
    const followup = feishuEnvelope(CHAT, 'and the Cancel button too')
    await send(followup.envelope)
    expect(cards).toHaveLength(2)
    expect(cards[1]!.related_tickets).toEqual([])
    expect(cards[1]!.nearby_tickets).toEqual([expect.objectContaining({ ticket_id: ticket!.id, open: true,
      origin: { trigger_id: first.triggerId, preview: '@agent rename the Save changes button to Save' } })])
    expect(cards[1]!.recent_decisions).toEqual([expect.objectContaining({ kind: 'accept', ticket_id: ticket!.id, trigger_id: first.triggerId })])
    expect(cell.store.tickets.list()).toHaveLength(1)
    const inputs = cell.store.tickets.get(ticket!.id)!.inputs
    expect(inputs.some(input => input.kind === 'trigger' && input.triggerId === followup.triggerId)).toBe(true)
    expect(cell.store.triggers.disposition(followup.triggerId)?.fanout).toContain(ticket!.id)
    // A message in another chat sees nothing of it and becomes its own ticket.
    await send(feishuEnvelope(OTHER_CHAT, 'rename the Help link').envelope)
    expect(cards[2]).not.toHaveProperty('nearby_tickets')
    expect(cards[2]).not.toHaveProperty('recent_decisions')
    expect(cell.store.tickets.list()).toHaveLength(2)
  })
  it('on GitHub, shows the same author\'s ticket from another Issue, not another author\'s', async () => {
    const { cell, cards, send } = await cellWith()
    await send(chatEnvelope(githubEnvelope('g1', '11', 'rename the Save button')))
    await send(chatEnvelope(githubEnvelope('g2', '12', 'rename the Cancel button', 'bob')))
    expect(cards[1]).not.toHaveProperty('nearby_tickets')
    const tickets = cell.store.tickets.list()
    expect(tickets).toHaveLength(2)
    await send(chatEnvelope(githubEnvelope('g3', '13', 'also the Help link')))
    expect(cards[2]!.nearby_tickets.map((item: { ticket_id: string }) => item.ticket_id)).toEqual([tickets.find(item => item.mandate.actor.id === 'alice')!.id])
  })
  it('lists the ticket of a PR a Feishu message links in a new thread, and the card is the same JSON for the same state', async () => {
    const { cell, cards, send, assessor } = await cellWith()
    await send(chatEnvelope(githubEnvelope('g1', '11', 'rename the Save button')))
    const [ticket] = cell.store.tickets.list()
    cell.engine.bindThread(ticket!.id, { source: 'github', id: '42' }, true)
    const followup = feishuEnvelope(CHAT, 'https://github.com/acme/widgets/pull/42 needs the same change on the Cancel button', 'ou_bob')
    await send(followup.envelope)
    expect(cards[1]!.referenced_tickets).toEqual([expect.objectContaining({ ticket_id: ticket!.id })])
    expect(cards[1]).not.toHaveProperty('nearby_tickets')
    expect(cell.store.tickets.get(ticket!.id)!.inputs.some(input => input.kind === 'trigger' && input.triggerId === followup.triggerId)).toBe(true)
    // `#42` on GitHub resolves through the same Source `find`.
    await send(chatEnvelope(githubEnvelope('g2', '15', 'see #42', 'bob')))
    expect(cards[2]!.referenced_tickets).toEqual([expect.objectContaining({ ticket_id: ticket!.id })])
    const candidate = { ...candidateOf(cell.store.triggers.get(followup.triggerId)!), tickets: [] }
    expect(await assessor.card(candidate, new AbortController().signal)).toBe(await assessor.card(candidate, new AbortController().signal))
  })
})
