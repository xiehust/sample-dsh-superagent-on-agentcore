import { afterEach, describe, expect, it, vi } from 'vitest'
import { key, type Decision, type Reason } from '../src/core/index.ts'
import { HINT_INTERVAL_MS, hintText, ignoreHint } from '../src/ignore-hint.ts'
import { settingsPolicy } from '../src/policy.ts'
import { chatEnvelope, makeCell, sent, type ChatMessage } from './fixtures/cell.ts'

let cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups) await cleanup(); cleanups = []; vi.useRealTimers(); sent.length = 0 })

const ALLOWED = { policy: { sources: { github: { allowed: [{ id: 'alice' }] } } } }
function harness(settings: unknown = ALLOWED) {
  const made = makeCell({}, settings)
  cleanups.push(made.cleanup)
  made.cell.start()
  const send = async (message: ChatMessage) => { await made.cell.handle(chatEnvelope(message)); await made.cell.passes.idle() }
  const hint = (id: string) => made.cell.store.receipts.get(key('ignore-hint', key('chat', id)))
  /** Ignores the candidate the fake assessor last got, as the Assessor would. */
  const ignore = (reason: string | Reason) => {
    const candidate = made.recorder.candidates.at(-1)!
    return made.cell.engine.decide(candidate.triggers[0]!.id, { kind: 'ignore', reason, evalId: candidate.evalId })
  }
  return { ...made, send, hint, ignore }
}
const at = '2026-11-01T00:00:00Z'
const mention = (id: string, text: string, fields: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, thread: '5', from: 'alice', text, at, mention: true, ...fields })

describe('reply to an ignored explicit request', () => {
  it('queues one reply in the request\'s conversation when an explicit mention is ignored as `said`, without the model\'s words', async () => {
    const h = harness()
    await h.send(mention('1', '@dshsa-agent hi'))
    const decision = h.ignore('Just a greeting, there is no task.')
    expect(decision.strength).toBe('explicit')
    const receipt = h.hint('1')
    expect(receipt).toMatchObject({ kind: 'reply', text: hintText('noTask', 'hi'), channel: { source: 'github', thread: 'github:5', address: { message: '1' } } })
    expect(receipt!.text).not.toContain('greeting')
    expect(receipt!.text).not.toMatch(/said|noRuleMatched|rule/)
    // It goes out through the Source's channel like any reply.
    await h.cell.outbox.sent()
    expect(sent.map(message => message.text)).toEqual([hintText('noTask', 'hi')])
  })

  it('sends at most one per Thread in 10 minutes, and again after that', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-01T00:00:00Z'))
    const h = harness()
    await h.send(mention('1', '@dshsa-agent hi'))
    h.ignore('Greeting.')
    vi.setSystemTime(new Date(Date.parse('2026-11-01T00:00:00Z') + HINT_INTERVAL_MS - 1000))
    await h.send(mention('2', '@dshsa-agent hello again', { at: '2026-11-01T00:09:00Z' }))
    h.ignore('Greeting.')
    // Another Thread is not held back by the first.
    await h.send(mention('3', '@dshsa-agent hey', { thread: '6', at: '2026-11-01T00:09:00Z' }))
    h.ignore('Greeting.')
    vi.setSystemTime(new Date(Date.parse('2026-11-01T00:00:00Z') + HINT_INTERVAL_MS + 1000))
    await h.send(mention('4', '@dshsa-agent still there?', { at: '2026-11-01T00:11:00Z' }))
    h.ignore('Greeting.')
    expect([h.hint('1'), h.hint('2'), h.hint('3'), h.hint('4')].map(Boolean)).toEqual([true, false, true, true])
  })

  it('sends nothing for a sender the gate rejects, so they still get silence', async () => {
    const h = harness()
    await h.send(mention('1', '@dshsa-agent fix the build', { from: 'mallory' }))
    expect(h.recorder.candidates).toEqual([])
    expect(h.hint('1')).toBeUndefined()
    expect(h.cell.store.read.decisions({ kinds: ['ignore'], since: '' }, 0, 10).items).toHaveLength(1)
  })

  it('sends nothing while `eval.replyOnIgnore` is off', async () => {
    const h = harness({ ...ALLOWED, eval: { replyOnIgnore: false } })
    await h.send(mention('1', '@dshsa-agent hi'))
    h.ignore('Greeting.')
    expect(h.hint('1')).toBeUndefined()
  })

  it('reads stored settings without the field as on', () => {
    const h = harness()
    expect(h.cell.store.settings().eval.replyOnIgnore).toBe(true)
  })

  it('sends nothing for an ignore whose reason is not a missing task or direction (a stop of nothing)', async () => {
    const h = harness()
    await h.send(mention('1', '@dshsa-agent stop'))
    const candidate = h.recorder.candidates.at(-1)!
    h.cell.engine.decide(candidate.triggers[0]!.id, { kind: 'stop', ticketId: 'nope', reason: { code: 'humanStop' }, evalId: candidate.evalId })
    expect(h.hint('1')).toBeUndefined()
  })

  it('answers in Chinese for a Han request without kana, else in English', async () => {
    const h = harness()
    await h.send(mention('1', '@dshsa-agent 你好', { thread: '7' }))
    h.ignore('Greeting.')
    await h.send(mention('2', '@dshsa-agent こんにちは世界', { thread: '8' }))
    h.ignore({ code: 'directionUnsettled' })
    expect(h.hint('1')!.text).toBe('我没有看到需要处理的任务。请说明要改什么（仓库、文件、行为），然后再 @ 我。')
    expect(h.hint('2')!.text).toBe("The direction isn't settled yet; tell me exactly what result you want and @ me again.")
    expect(hintText('noTask', 'fix it')).toBe("I didn't see a task to do here. Describe what to change (repo, file, behaviour) and @ me again.")
    expect(hintText('unsettled', '改一下按钮')).toBe('方向还没有确定；请明确说明你想要的结果，然后再 @ 我。')
  })
})

describe('ignoreHint', () => {
  /** A cell with one stored Trigger on Thread github:5, and the hint an ignore Decision of it gets. */
  async function judged(message: ChatMessage, decision: Partial<Decision>, human = true) {
    const made = makeCell()
    cleanups.push(made.cleanup)
    await made.cell.handle(chatEnvelope(message))
    const { store, sources } = made.cell
    if (!human) store.triggers.save({ ...store.triggers.get(key('chat', message.id))!, human: false })
    // The Thread follows a ticket, so a listed sender's unaddressed message on it is an explicit follow-up for the gate.
    store.threads.save({ ...store.threads.get('github:5')!, subscriptions: ['ticket-1'] })
    const full: Decision = { id: 'd1', evalId: 'e1', threadKey: 'github:5', triggerIds: [key('chat', message.id)], policyVersion: 'v', at,
      kind: 'ignore', reason: [{ code: 'said', values: { text: 'no task' } }], strength: 'explicit', ...decision }
    return ignoreHint({ store, settings: () => store.settings(), policy: () => settingsPolicy(store.settings(), sources) }, full)
  }
  it('gives a hint for an explicit `said`, `noRuleMatched` or `directionUnsettled` ignore of an addressed request', async () => {
    for (const code of ['said', 'noRuleMatched', 'directionUnsettled']) {
      expect(await judged(mention('1', '@dshsa-agent hi'), { reason: [{ code }] }), code).toBeDefined()
    }
  })
  it('gives none for an inferred or observed candidate', async () => {
    expect(await judged(mention('1', '@dshsa-agent hi'), { strength: 'inferred' })).toBeUndefined()
    expect(await judged(mention('1', '@dshsa-agent hi'), { reason: [{ code: 'observed', values: { text: 'would fix' } }] })).toBeUndefined()
  })
  it('gives none for a Trigger nobody addressed to the agent (an explicit follow-up)', async () => {
    expect(await judged(mention('1', 'and the footer too', { mention: false }), {})).toBeUndefined()
  })
  it('gives none for a gate rejection, even one recorded as explicit', async () => {
    expect(await judged(mention('1', '@dshsa-agent hi'), { reason: [{ code: 'not_a_member', triggerId: key('chat', '1') }] })).toBeUndefined()
    expect(await judged(mention('1', '@dshsa-agent hi'), { reason: [{ code: 'noAdmissible' }] })).toBeUndefined()
  })
  it('gives none for a message a bot or system wrote', async () => {
    expect(await judged(mention('1', '@dshsa-agent hi'), {}, false)).toBeUndefined()
  })
  it('gives none for a sender the gate no longer admits as explicit', async () => {
    expect(await judged(mention('1', '@dshsa-agent hi', { from: 'mallory' }), {})).toBeUndefined()
  })
})
