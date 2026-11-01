import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { InvocationRequest, TicketTokenClaims, accessPointRoot, decodeUnverified, runtimeSessionId, ticketKey, type InvocationResponse } from '@dshsa/contracts'
import { key, latestAssignment } from '../src/core/index.ts'
import { AgentCoreExecutor, type Provisioner, type WorkerRuntime } from '../src/executor/agentcore.ts'
import { TicketTokens } from '../src/token.ts'
import { CELL_ID, chatEnvelope, makeCell, sent, type ChatMessage } from './fixtures/cell.ts'

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const tokens = new TicketTokens({ keyId: 'k', sign: async message => cryptoSign('sha256', message, { key: privateKey, dsaEncoding: 'der' }) })
const message = (id: string, overrides: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, thread: '9', from: 'alice', text: `@dshsa-agent fix the button ${id}`, at: `2026-11-01T00:00:0${id}Z`, mention: true, ...overrides })

function harness(respond: (request: InvocationRequest) => InvocationResponse = request => ({ ok: true, accepted: request.inputs.map(input => input.id), state: 'running' })) {
  const calls: { sessionId: string; request: InvocationRequest }[] = []
  const provisioned: Parameters<Provisioner['ensure']>[0][] = []
  const runtime: WorkerRuntime = { invoke: async (sessionId, request) => { calls.push({ sessionId, request }); return respond(request) } }
  const provisioner: Provisioner = { ensure: async request => { provisioned.push(request) } }
  const made = makeCell({ executor: parts => new AgentCoreExecutor(parts, { runtime, provisioner, tokens }) })
  made.cell.start()
  return { ...made, calls, provisioned }
}
async function accepted(h: ReturnType<typeof harness>) {
  await h.cell.handle(chatEnvelope(message('1')))
  await h.cell.passes.idle()
  const candidate = h.recorder.candidates[0]!
  const decision = h.cell.engine.decide(candidate.triggers[0]!.id, { kind: 'accept', title: 'Fix the button', scope: 'Fix the button', reason: 'explicit',
    name: 'fix-button', acknowledgement: 'On it: fixing the button.' })
  await h.cell.passes.idle()
  return h.cell.store.tickets.get(decision.ticketId!)!
}

let cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups) await cleanup(); cleanups = []; sent.length = 0 })

describe('AgentCoreExecutor', () => {
  it('provisions, then starts the ticket session with a contracts-valid payload and a valid ticket token', async () => {
    const h = harness(); cleanups.push(h.cleanup)
    const ticket = await accepted(h)
    expect(h.provisioned).toEqual([expect.objectContaining({ tenantId: 'acme', cellId: CELL_ID, ticketId: ticket.id, ticketKey: ticketKey(CELL_ID, ticket.id),
      rootPath: accessPointRoot('acme', CELL_ID, ticket.id) })])
    const start = h.calls.find(call => call.request.action === 'start')!
    expect(start.sessionId).toBe(runtimeSessionId(CELL_ID, ticket.id))
    expect(() => InvocationRequest.parse(start.request)).not.toThrow()
    expect(start.request.ticket).toMatchObject({ tenantId: 'acme', cellId: CELL_ID, ticketId: ticket.id, title: 'Fix the button' })
    expect(start.request.inputs[0]).toMatchObject({ kind: 'text' })
    expect(JSON.parse(start.request.inputs[0]!.text)).toMatchObject({ ticket_id: ticket.id, trigger: { trigger_id: key('chat', '1') } })
    expect(start.request.config).toMatchObject({ model: 'global.anthropic.claude-opus-5-5', repo: { fullName: 'acme/widgets', defaultBranch: 'main' } })
    expect(start.request.config!.systemPrompt).toContain('You are a worker.')
    expect(start.request.config!.env).toMatchObject({ DSH_SUPERAGENT_DIR: '/mnt/work/repo', DSH_SUPERAGENT_TICKET: ticket.id })
    const claims = TicketTokenClaims.parse(decodeUnverified(start.request.token).claims)
    expect(claims).toMatchObject({ sub: ticketKey(CELL_ID, ticket.id), cid: CELL_ID, tkt: ticket.id, asg: latestAssignment(ticket)!.id })
    expect(latestAssignment(h.cell.store.tickets.get(ticket.id)!)?.state).toBe('running')
    // The accept's acknowledgement goes out through the Outbox.
    await h.cell.effects.idle()
    expect(sent.map(item => item.text)).toContain('On it: fixing the button.')
  })
  it('delivers a follow-up on the ticket thread with deliver, and records it delivered', async () => {
    const h = harness(); cleanups.push(h.cleanup)
    const ticket = await accepted(h)
    await h.cell.handle(chatEnvelope(message('2', { text: 'also the colour', mention: false })))
    await h.cell.passes.idle()
    const deliver = h.calls.find(call => call.request.action === 'deliver')!
    expect(deliver.request.inputs.map(input => input.kind)).toEqual(['trigger'])
    expect(deliver.request.inputs[0]!.text).toContain('also the colour')
    expect(h.cell.store.tickets.get(ticket.id)!.undelivered).toEqual([])
  })
  it('a permanent refusal fails the ticket with a report instead of retrying', async () => {
    const h = harness(() => ({ ok: false, error: 'bound_to_other_ticket', message: 'vm bound' })); cleanups.push(h.cleanup)
    const ticket = await accepted(h)
    expect(latestAssignment(h.cell.store.tickets.get(ticket.id)!)?.report).toMatchObject({ state: 'failed' })
  })
  it('maps worker events to Engine commands once per event id', async () => {
    const h = harness(); cleanups.push(h.cleanup)
    const ticket = await accepted(h)
    const assignment = latestAssignment(ticket)!.id
    const verified = { tid: 'acme', cid: CELL_ID, tkt: ticket.id, asg: assignment }
    const base = { ticketKey: ticketKey(CELL_ID, ticket.id), assignmentId: assignment, at: '2026-11-01T00:01:00Z' }
    const report = { event: { ...base, id: 'e1', type: 'report' as const, body: { state: 'ready' as const, text: 'PR #5 is ready' } }, verified }
    expect(await h.cell.workerEvents.apply(report)).toBeUndefined()
    expect(await h.cell.workerEvents.apply(report)).toBe('duplicate')
    expect(latestAssignment(h.cell.store.tickets.get(ticket.id)!)?.report).toMatchObject({ state: 'ready', summary: 'PR #5 is ready' })
    expect(await h.cell.workerEvents.apply({ ...report, event: { ...report.event, id: 'e2' }, verified: { ...verified, cid: 'other--gh1' } })).toBe('wrong_cell')
    expect(await h.cell.workerEvents.apply({ event: { ...base, id: 'e3', type: 'inputs.read', body: { inputIds: ['nope'] } }, verified: { ...verified, asg: 'old' } })).toBe('stale_assignment')
  })
})
