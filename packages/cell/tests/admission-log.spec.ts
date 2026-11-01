import { afterEach, expect, it } from 'vitest'
import type { Logger } from '@dshsa/contracts'
import { key } from '../src/core/index.ts'
import { CELL_ID, chatEnvelope, makeCell, quiet, type ChatMessage } from './fixtures/cell.ts'

let cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups) await cleanup(); cleanups = [] })

function harness(settings?: unknown) {
  const lines: Record<string, unknown>[] = []
  const ignored: Record<string, unknown>[] = []
  const log: Logger = { ...quiet, info: (message, data) => {
    if (message === 'trigger not admitted') lines.push(data ?? {})
    if (message === 'decision ignored') ignored.push(data ?? {})
  } }
  const made = settings === undefined ? makeCell({ log }) : makeCell({ log }, settings)
  cleanups.push(made.cleanup)
  made.cell.start()
  const send = async (message: ChatMessage) => { await made.cell.handle(chatEnvelope(message)); await made.cell.passes.idle() }
  return { ...made, lines, ignored, send }
}
const at = '2026-11-01T00:00:00Z'

it('logs a Trigger the Policy gate rejects once, with its reason and actor, and never its text', async () => {
  const h = harness()
  await h.send({ id: '1', thread: '5', from: 'mallory', text: '@dshsa-agent secret plans', at, mention: true })
  await h.cell.passes.idle()
  expect(h.lines).toHaveLength(1)
  expect(h.lines[0]).toMatchObject({ cellId: CELL_ID, triggerId: key('chat', '1'), source: 'github', actor: 'mallory', addressed: 'mention', at: 'gate' })
  expect(h.lines[0]!.reason).toBe('not_a_member')
  expect(JSON.stringify(h.lines)).not.toContain('secret plans')
  // The gate's ignore is logged as not admitted only, not again as an ignored Decision.
  expect(h.ignored).toEqual([])
  // A redelivery is a duplicate and is not logged again.
  await h.send({ id: '1', thread: '5', from: 'mallory', text: '@dshsa-agent secret plans', at, mention: true })
  expect(h.lines).toHaveLength(1)
})

it('does not log an admitted Trigger', async () => {
  const h = harness()
  await h.send({ id: '2', thread: '6', from: 'alice', text: '@dshsa-agent fix it', at, mention: true })
  expect(h.lines).toEqual([])
  expect(h.recorder.candidates).toHaveLength(1)
})

it('logs a Trigger its Source filters at intake (such as a disabled Source), with the filter reason', async () => {
  const h = harness({ sources: { github: { enabled: false, config: {} } }, policy: { sources: { github: { allowed: [{ id: 'alice' }] } } } })
  await h.send({ id: '3', thread: '7', from: 'alice', text: '@dshsa-agent hello', at, mention: true })
  expect(h.lines).toEqual([{ cellId: CELL_ID, triggerId: key('chat', '3'), reason: 'source_disabled', at: 'intake', source: 'github', actor: 'alice', addressed: 'mention' }])
})

it('logs an ignore the Assessor decides once as `decision ignored`, with codes but never the text or the model\'s words', async () => {
  const h = harness()
  await h.send({ id: '4', thread: '8', from: 'alice', text: '@dshsa-agent hi there', at, mention: true })
  const candidate = h.recorder.candidates.at(-1)!
  const decision = h.cell.engine.decide(candidate.triggers[0]!.id, { kind: 'ignore', reason: 'A private greeting, no task.', evalId: candidate.evalId })
  expect(h.ignored).toEqual([{ cellId: CELL_ID, decisionId: decision.id, triggerIds: [key('chat', '4')], strength: 'explicit', codes: ['said'],
    source: 'github', actor: 'alice' }])
  expect(h.lines).toEqual([])
  expect(JSON.stringify(h.ignored)).not.toMatch(/hi there|private greeting/)
})

it('lists recent ignores with their source and sender (GET decisions?kind=ignore&window=24h)', async () => {
  const h = harness()
  await h.send({ id: '5', thread: '9', from: 'alice', text: '@dshsa-agent hi', at: new Date().toISOString(), mention: true })
  const candidate = h.recorder.candidates.at(-1)!
  h.cell.engine.decide(candidate.triggers[0]!.id, { kind: 'ignore', reason: 'No task.', evalId: candidate.evalId })
  const list = await h.cell.routes['GET decisions']({ params: {}, query: { kind: 'ignore', window: '24h' }, body: async () => undefined })
  expect(list.items).toHaveLength(1)
  expect(list.items[0]).toMatchObject({ kind: 'ignore', source: 'github', sender: { source: 'github', id: 'alice' }, preview: '@dshsa-agent hi',
    reason: [{ code: 'said', values: { text: 'No task.' } }] })
})
