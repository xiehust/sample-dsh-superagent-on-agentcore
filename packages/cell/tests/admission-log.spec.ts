import { afterEach, expect, it } from 'vitest'
import type { Logger } from '@dshsa/contracts'
import { key } from '../src/core/index.ts'
import { CELL_ID, chatEnvelope, makeCell, quiet, type ChatMessage } from './fixtures/cell.ts'

let cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups) await cleanup(); cleanups = [] })

function harness(settings?: unknown) {
  const lines: Record<string, unknown>[] = []
  const log: Logger = { ...quiet, info: (message, data) => { if (message === 'trigger not admitted') lines.push(data ?? {}) } }
  const made = settings === undefined ? makeCell({ log }) : makeCell({ log }, settings)
  cleanups.push(made.cleanup)
  made.cell.start()
  const send = async (message: ChatMessage) => { await made.cell.handle(chatEnvelope(message)); await made.cell.passes.idle() }
  return { ...made, lines, send }
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
