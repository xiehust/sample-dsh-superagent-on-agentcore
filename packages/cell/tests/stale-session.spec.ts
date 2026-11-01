/** Stale worker sessions (contracts `WorkerVersion`): an idle session on an old image is stopped before its next start/deliver. */
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { runtimeSessionId, type InvocationRequest, type InvocationResponse, type Logger } from '@dshsa/contracts'
import { latestAssignment } from '../src/core/index.ts'
import { AgentCoreExecutor, type WorkerRuntime } from '../src/executor/agentcore.ts'
import { TicketTokens } from '../src/token.ts'
import { CELL_ID, chatEnvelope, makeCell, quiet, sent, type ChatMessage } from './fixtures/cell.ts'

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const tokens = new TicketTokens({ keyId: 'k', sign: async message => cryptoSign('sha256', message, { key: privateKey, dsaEncoding: 'der' }) })
const message = (id: string, overrides: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, thread: '9', from: 'alice', text: `@dshsa-agent fix the button ${id}`, at: `2026-11-01T00:00:0${id}Z`, mention: true, ...overrides })

let cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups) await cleanup(); cleanups = []; sent.length = 0 })

/** A runtime whose live session runs `vm` until it is stopped; a fresh microVM runs `image`. */
function harness(options: { vm?: string | null; image?: string; current?: string | undefined; state?: 'idle' | 'running' } = {}) {
  const world = { vm: options.vm === undefined ? 'old' : options.vm, image: options.image ?? 'new', current: 'current' in options ? options.current : 'new',
    state: options.state ?? 'idle', live: false }
  const calls: string[] = []
  const infos: [string, Record<string, unknown> | undefined][] = []
  const respond = (request: InvocationRequest): InvocationResponse => {
    if (!world.live) { world.live = true; world.vm = world.vm ?? null }
    const version = world.vm === null ? {} : { workerVersion: world.vm }
    return { ok: true, accepted: request.inputs.map(input => input.id), state: request.action === 'status' ? world.state : 'running', ...version }
  }
  const runtime: WorkerRuntime = {
    invoke: async (_sessionId, request) => { calls.push(request.action); return respond(request) },
    stopSession: async sessionId => { calls.push(`stopSession:${sessionId}`); world.vm = world.image },
  }
  const log: Logger = { ...quiet, info: (m, d) => { infos.push([m, d]) } }
  const executors: AgentCoreExecutor[] = []
  const deps = { runtime, provisioner: { ensure: async () => {} }, tokens, workerVersion: async () => world.current, staleStopSettleMs: 0 }
  const made = makeCell({ log, executor: parts => { const executor = new AgentCoreExecutor(parts, deps); executors.push(executor); return executor } })
  cleanups.push(made.cleanup)
  made.cell.start()
  const accept = async () => {
    await made.cell.handle(chatEnvelope(message('1')))
    await made.cell.passes.idle()
    const decision = made.cell.engine.decide(made.recorder.candidates[0]!.triggers[0]!.id, { kind: 'accept', title: 'Fix', scope: 'Fix', reason: 'explicit', name: 'fix-button' })
    await made.cell.passes.idle()
    return made.cell.store.tickets.get(decision.ticketId!)!
  }
  const turnEnded = (ticketId: string) => { made.cell.engine.turnEnded(ticketId, latestAssignment(made.cell.store.tickets.get(ticketId)!)!.id) }
  const followUp = async (id: string) => { await made.cell.handle(chatEnvelope(message(id, { mention: false, text: `also ${id}` }))); await made.cell.passes.idle(); await made.cell.effects.idle() }
  return { ...made, world, calls, infos, executors, deps, accept, turnEnded, followUp }
}

it('stops an idle session that answered an old workerVersion before the next deliver, which reaches a fresh microVM', async () => {
  const h = harness()
  const ticket = await h.accept()
  h.turnEnded(ticket.id)
  await h.followUp('2')
  expect(h.calls).toEqual(['start', `stopSession:${runtimeSessionId(CELL_ID, ticket.id)}`, 'deliver'])
  expect(h.infos.find(([m]) => m === 'stopping stale worker session')?.[1]).toMatchObject({ ticketId: ticket.id, workerVersion: 'old', expected: 'new' })
  // The fresh microVM answers the current version: the next idle delivery stops nothing.
  h.turnEnded(ticket.id)
  await h.followUp('3')
  expect(h.calls.filter(call => call.startsWith('stopSession'))).toHaveLength(1)
  expect(h.calls.at(-1)).toBe('deliver')
})

it('counts an answer without workerVersion (an image older than the field) as stale', async () => {
  const h = harness({ vm: null })
  const ticket = await h.accept()
  h.turnEnded(ticket.id)
  await h.followUp('2')
  expect(h.calls).toEqual(['start', `stopSession:${runtimeSessionId(CELL_ID, ticket.id)}`, 'deliver'])
})

it('never stops a session in a turn: a delivery since its last turn end means the worker is busy', async () => {
  const h = harness()
  await h.accept()
  await h.followUp('2')
  expect(h.calls).toEqual(['start', 'deliver'])
})

it('stops nothing while the current version is unknown (parameter missing or unreadable)', async () => {
  const h = harness({ current: undefined })
  const ticket = await h.accept()
  h.turnEnded(ticket.id)
  await h.followUp('2')
  expect(h.calls).toEqual(['start', 'deliver'])
})

it('stops nothing when the session runs the current version', async () => {
  const h = harness({ vm: 'new' })
  const ticket = await h.accept()
  h.turnEnded(ticket.id)
  await h.followUp('2')
  expect(h.calls).toEqual(['start', 'deliver'])
})

it('after a restart, probes an idle session once with status, and stops it only when the probe says it is idle and stale', async () => {
  const h = harness()
  const ticket = await h.accept()
  const assignment = latestAssignment(h.cell.store.tickets.get(ticket.id)!)!
  // A new executor (as after a host restart) knows no session versions.
  const parts = (h.cell as unknown as { parts: ConstructorParameters<typeof AgentCoreExecutor>[0] }).parts
  const running = new AgentCoreExecutor(parts, h.deps)
  h.world.state = 'running'
  await running.refreshStale(ticket, assignment, true, true)
  expect(h.calls).toEqual(['start', 'status'])
  const restarted = new AgentCoreExecutor(parts, h.deps)
  h.world.state = 'idle'
  await restarted.refreshStale(ticket, assignment, true, true)
  expect(h.calls).toEqual(['start', 'status', 'status', `stopSession:${runtimeSessionId(CELL_ID, ticket.id)}`])
})

it('does not stop when the stop itself fails, and still delivers', async () => {
  const h = harness()
  h.deps.runtime.stopSession = async () => { h.calls.push('stopSession:failed'); throw new Error('throttled') }
  const ticket = await h.accept()
  h.turnEnded(ticket.id)
  await h.followUp('2')
  expect(h.calls).toEqual(['start', 'stopSession:failed', 'deliver'])
})
