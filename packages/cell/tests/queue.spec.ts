import { afterEach, describe, expect, it } from 'vitest'
import { CellQueueConsumer, MemoryCellQueue } from '../src/queue.ts'
import { key } from '../src/core/index.ts'
import { CELL_ID, chatEnvelope, makeCell, quiet, type ChatMessage } from './fixtures/cell.ts'

const message = (id: string, overrides: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, thread: '7', from: 'alice', text: `@dshsa-agent please do ${id}`, at: `2026-11-01T00:00:0${id}Z`, mention: true, ...overrides })

let cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups) await cleanup(); cleanups = [] })

describe('cell queue consumer', () => {
  it('applies a source.event through the kind, and a redelivered envelope is a duplicate receive (no second candidate)', async () => {
    const { cell, recorder, cleanup } = makeCell(); cleanups.push(cleanup)
    cell.start()
    const queue = new MemoryCellQueue()
    const consumer = new CellQueueConsumer({ queue, handler: cell, log: quiet })
    queue.send(JSON.stringify(chatEnvelope(message('1'))), 'a')
    // The same delivery arrives again with another dedup id (webhook + reconcile): the Trigger id is the same.
    queue.send(JSON.stringify(chatEnvelope(message('1'))), 'b')
    const signal = new AbortController().signal
    expect(await consumer.process(await queue.receive(signal))).toBe(2)
    await cell.passes.idle()
    expect(cell.store.triggers.get(key('chat', '1'))).toMatchObject({ text: '@dshsa-agent please do 1' })
    expect(recorder.candidates).toHaveLength(1)
    expect(cell.engine.receive({ ...cell.store.triggers.get(key('chat', '1'))! })).toBe('duplicate')
    expect(queue.size).toBe(0)
  })
  it('an unauthorized sender is recorded with a disposition only (no candidate)', async () => {
    const { cell, recorder, cleanup } = makeCell(); cleanups.push(cleanup)
    cell.start()
    await cell.handle(chatEnvelope(message('2', { from: 'mallory' })))
    await cell.passes.idle()
    expect(cell.store.triggers.get(key('chat', '2'))).toBeDefined()
    expect(recorder.candidates).toHaveLength(0)
  })
  it('a failing envelope is not deleted and blocks the rest of its batch; a poison envelope is dropped', async () => {
    let fail = true
    const handled: string[] = []
    const queue = new MemoryCellQueue(() => now)
    let now = 0
    const consumer = new CellQueueConsumer({ queue, log: quiet, retryAfterSeconds: 10, handler: { handle: async envelope => {
      if (envelope.id === 'chat:3' && fail) throw new Error('transient')
      handled.push(envelope.id)
    } } })
    queue.send('{not json', 'poison')
    queue.send(JSON.stringify(chatEnvelope(message('3'))), 'c')
    queue.send(JSON.stringify(chatEnvelope(message('4'))), 'd')
    const signal = new AbortController().signal
    expect(await consumer.process(await queue.receive(signal))).toBe(0)
    expect(handled).toEqual([])
    expect(queue.size).toBe(2)
    fail = false
    now = 10_000
    expect(await consumer.process(await queue.receive(signal))).toBe(2)
    expect(handled).toEqual(['chat:3', 'chat:4'])
    expect(queue.size).toBe(0)
  })
  it('refuses envelopes once the lease is no longer valid (they stay on the queue)', async () => {
    let valid = true
    const { cell, cleanup } = makeCell({ lease: { fence: 1, valid: () => valid, signal: new AbortController().signal } }); cleanups.push(cleanup)
    cell.start()
    valid = false
    await expect(cell.handle(chatEnvelope(message('5')))).rejects.toThrow('lease')
  })
  it('drops an envelope addressed to another cell', async () => {
    const { cell, cleanup } = makeCell(); cleanups.push(cleanup)
    await cell.handle({ ...chatEnvelope(message('6')), cellId: 'other--gh1' })
    expect(cell.store.triggers.get(key('chat', '6'))).toBeUndefined()
    expect(CELL_ID).not.toBe('other--gh1')
  })
})
