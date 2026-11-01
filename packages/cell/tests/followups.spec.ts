/**
 * The follow-up scenarios of DSH `tests/followups.spec.ts`, ported over the cell (queue envelope → Source kind → Engine →
 * AgentCore Executor). DSH's assertions about main-Session relays, notices and model-call counts have no counterpart here
 * (there is no main Session, parent PRD R5); the domain outcome of each scenario is asserted instead.
 */
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { ticketKey, type InvocationRequest } from '@dshsa/contracts'
import { key, latestAssignment, liveTicket } from '../src/core/index.ts'
import { AgentCoreExecutor } from '../src/executor/agentcore.ts'
import { TicketTokens } from '../src/token.ts'
import { CELL_ID, chatEnvelope, makeCell, type ChatMessage } from './fixtures/cell.ts'

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const tokens = new TicketTokens({ keyId: 'k', sign: async message => cryptoSign('sha256', message, { key: privateKey, dsaEncoding: 'der' }) })
let n = 0
const message = (overrides: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id: String(++n), thread: '5', from: 'alice', text: `@dshsa-agent request ${n}`, at: `2026-11-01T00:${String(n).padStart(2, '0')}:00Z`, mention: true, ...overrides })

let cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups) await cleanup(); cleanups = []; n = 0 })

async function harness() {
  const calls: InvocationRequest[] = []
  const made = makeCell({ executor: parts => new AgentCoreExecutor(parts, { tokens, provisioner: { ensure: async () => {} },
    runtime: { invoke: async (_session, request) => { calls.push(request); return { ok: true, accepted: request.inputs.map(input => input.id), state: 'running' } } } }) })
  cleanups.push(made.cleanup)
  made.cell.start()
  const send = async (overrides: Partial<ChatMessage> = {}) => {
    const item = message(overrides)
    await made.cell.handle(chatEnvelope(item))
    await made.cell.passes.idle()
    return key('chat', item.id)
  }
  const accept = async (triggerId: string) => {
    const decision = made.cell.engine.decide(triggerId, { kind: 'accept', title: 'Fix it', scope: 'Fix it', reason: 'explicit', name: 'fix-it', acknowledgement: 'On it.' })
    await made.cell.passes.idle()
    return decision.ticketId!
  }
  const report = async (ticketId: string, body: Record<string, unknown>, type = 'report') => {
    const ticket = made.cell.store.tickets.get(ticketId)!
    const asg = latestAssignment(ticket)!.id
    const id = `e${++n}`
    // Through the cell queue envelope, as worker-api enqueues it (parent design §4.6).
    await made.cell.handle({ v: 1, id: `worker:${id}`, cellId: CELL_ID, type: 'worker.event', at: new Date().toISOString(),
      body: { event: { id, ticketKey: ticketKey(CELL_ID, ticketId), assignmentId: asg, at: new Date().toISOString(), type, body } as never,
        verified: { tid: 'acme', cid: CELL_ID, tkt: ticketId, asg } } })
    await made.cell.passes.idle()
  }
  return { ...made, calls, send, accept, report }
}

it('delivers a follow-up on the ticket\'s thread to its worker, without an Eval', async () => {
  const h = await harness()
  const ticketId = await h.accept(await h.send())
  const candidates = h.recorder.candidates.length
  await h.send({ text: 'also make it blue', mention: false })
  expect(h.recorder.candidates).toHaveLength(candidates)
  const deliver = h.calls.find(call => call.action === 'deliver')!
  expect(deliver.inputs[0]).toMatchObject({ kind: 'trigger' })
  expect(deliver.inputs[0]!.text).toContain('also make it blue')
  expect(h.cell.store.tickets.get(ticketId)!.undelivered).toEqual([])
})

it('sends a person\'s message that reaches no ticket, such as only one a person stopped, to Eval as before', async () => {
  const h = await harness()
  const ticketId = await h.accept(await h.send())
  h.cell.engine.stopTicket(ticketId)
  await h.cell.passes.idle()
  const before = h.recorder.candidates.length
  await h.send({ text: '@dshsa-agent another thing' })
  expect(h.recorder.candidates.length).toBe(before + 1)
  expect(h.calls.filter(call => call.action === 'stop')).toHaveLength(1)
})

it('returns a request a worker handed back to Eval, as an explicit candidate', async () => {
  const h = await harness()
  const ticketId = await h.accept(await h.send())
  const followup = await h.send({ text: '@dshsa-agent unrelated: also redo the login page' })
  const before = h.recorder.candidates.length
  await h.report(ticketId, { triggerIds: [followup], reason: 'Another ticket' }, 'handback')
  expect(h.recorder.candidates.length).toBe(before + 1)
  expect(h.recorder.candidates.at(-1)).toMatchObject({ strength: 'explicit' })
  expect(h.recorder.candidates.at(-1)!.triggers.map(trigger => trigger.id)).toContain(followup)
})

it('resumes an ended ticket on a person\'s follow-up with a new assignment on the same runtime session', async () => {
  const h = await harness()
  const ticketId = await h.accept(await h.send())
  await h.report(ticketId, { state: 'ready', text: 'Done' })
  expect(liveTicket(h.cell.store.tickets.get(ticketId)!)).toBe(false)
  await h.send({ text: 'one more tweak please', mention: false })
  const ticket = h.cell.store.tickets.get(ticketId)!
  expect(liveTicket(ticket)).toBe(true)
  expect(ticket.assignments).toHaveLength(2)
  const starts = h.calls.filter(call => call.action === 'start')
  expect(starts).toHaveLength(2)
  expect(new Set(starts.map(call => call.ticket.ticketId))).toEqual(new Set([ticketId]))
})

it('lets a worker follow a related thread for context: its messages reach the worker marked as context and are not assessed', async () => {
  const h = await harness()
  const ticketId = await h.accept(await h.send())
  await h.report(ticketId, { thread: 'github:77', reason: 'The issue it fixes' }, 'thread.follow')
  const before = h.recorder.candidates.length
  await h.send({ thread: '77', text: 'a comment on the issue', mention: false, from: 'bob' })
  expect(h.recorder.candidates.length).toBe(before)
  const ticket = h.cell.store.tickets.get(ticketId)!
  expect(ticket.inputs.at(-1)).toMatchObject({ kind: 'trigger', context: true })
})
