/** Contracts v7: settings validation against the model catalog, rollback-safe storage, sticky worker types and `GET models`. */
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_MODELS, MODEL_CATALOG, runtimeSessionId, type InvocationRequest, type InvocationResponse, type WorkerType } from '@dshsa/contracts'
import { UserError, latestAssignment } from '../src/core/index.ts'
import { AgentCoreExecutor, type AgentCoreExecutorDeps, type WorkerRuntime } from '../src/executor/agentcore.ts'
import { KV } from '../src/kv.ts'
import { internalServer } from '../src/server.ts'
import { TicketTokens } from '../src/token.ts'
import { CELL_ID, chatEnvelope, makeCell, quiet, sent, type ChatMessage } from './fixtures/cell.ts'
import type { CellOptions } from '../src/cell.ts'

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const tokens = new TicketTokens({ keyId: 'k', sign: async message => cryptoSign('sha256', message, { key: privateKey, dsaEncoding: 'der' }) })
const message = (id: string, overrides: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, thread: '9', from: 'alice', text: `@dshsa-agent fix the button ${id}`, at: `2026-11-01T00:00:0${id}Z`, mention: true, ...overrides })
const POLICY = { sources: { github: { allowed: [{ id: 'alice' }] } } }
const bedrock = (model: string, reasoningEffort?: string) => ({ provider: 'bedrock', model, ...reasoningEffort ? { reasoningEffort } : {} })

let cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups) await cleanup(); cleanups = []; sent.length = 0 })

function cell(overrides: Partial<CellOptions> = {}, settings: Record<string, unknown> = {}) {
  const made = makeCell(overrides, { policy: POLICY, ...settings })
  cleanups.push(made.cleanup)
  return made
}
/** The raw stored snapshot of the current settings revision, as a pre-v7 host would read it. */
const rawSettings = (made: ReturnType<typeof cell>) => {
  const store = made.cell.store
  return store.get(KV.settings.version(store.get(KV.settings.revision)!))!.settings as unknown as { eval: Record<string, unknown>; executor: Record<string, unknown> }
}
async function refused(promise: Promise<unknown>): Promise<UserError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(UserError)
  return error as UserError
}

describe('Settings.save model validation (v7)', () => {
  const saveEval = (made: ReturnType<typeof cell>, patch: Record<string, unknown>) =>
    made.cell.settings.save('eval', { ...made.cell.store.settings().eval, ...patch }, made.cell.store.blockRevision('eval'), 'panel')
  const saveExecutor = (made: ReturnType<typeof cell>, patch: Record<string, unknown>) =>
    made.cell.settings.save('executor', { ...made.cell.store.settings().executor, ...patch }, made.cell.store.blockRevision('executor'), 'panel')

  it('rejects an eval model outside the catalog, an effort the model does not accept, and a worker-only model', async () => {
    const made = cell()
    expect((await refused(saveEval(made, { model: bedrock('anthropic.claude-3-legacy') }))).values)
      .toMatchObject({ block: 'eval', field: 'model', reason: 'unknownModel' })
    expect((await refused(saveEval(made, { model: bedrock('global.anthropic.claude-sonnet-5-5', 'none') }))).values)
      .toMatchObject({ block: 'eval', field: 'model', reason: 'badEffort' })
    expect((await refused(saveEval(made, { model: bedrock('global.anthropic.claude-opus-5-5') }))).values)
      .toMatchObject({ block: 'eval', field: 'model', reason: 'wrongSurface' })
    expect((await refused(saveEval(made, { model: bedrock('global.anthropic.claude-opus-5-5') }))).code).toBe('modelUnavailable')
    await saveEval(made, { model: bedrock('global.anthropic.claude-sonnet-5-5', 'high') })
    expect(made.cell.store.settings().eval.model).toEqual(bedrock('global.anthropic.claude-sonnet-5-5', 'high'))
  })
  it('validates the reply model on the Converse surface', async () => {
    const made = cell()
    expect((await refused(saveEval(made, { replyModel: bedrock('global.openai.gpt-6-astra') }))).values)
      .toMatchObject({ block: 'eval', field: 'replyModel', reason: 'wrongSurface' })
    expect((await refused(saveEval(made, { replyModel: bedrock('global.openai.gpt-6-luna', 'ultra') }))).values)
      .toMatchObject({ block: 'eval', field: 'replyModel', reason: 'badEffort' })
    await saveEval(made, { replyModel: bedrock('global.openai.gpt-6-luna', 'none') })
    expect(made.cell.store.settings().eval.replyModel).toEqual(bedrock('global.openai.gpt-6-luna', 'none'))
  })
  it('checks only a changed model: an untouched stored pre-v7 id does not block saving another field of the block', async () => {
    const made = cell({}, { eval: { model: bedrock('anthropic.claude-3-legacy') }, executor: { model: bedrock('anthropic.claude-3-legacy') } })
    await saveEval(made, { mode: 'auto' })
    expect(made.cell.store.settings().eval).toMatchObject({ mode: 'auto', model: bedrock('anthropic.claude-3-legacy') })
    await saveExecutor(made, { maxWorkers: 5 })
    expect(made.cell.store.settings().executor).toMatchObject({ maxWorkers: 5, model: bedrock('anthropic.claude-3-legacy') })
  })
  it('re-checks the worker model against a new worker type, and refuses a worker type this host cannot run', async () => {
    const both = cell({ workerTypes: ['claude', 'codex'] }, { executor: { model: bedrock('global.anthropic.claude-opus-5-5') } })
    expect((await refused(saveExecutor(both, { workerType: 'codex' }))).values)
      .toMatchObject({ block: 'executor', field: 'model', reason: 'wrongSurface' })
    await saveExecutor(both, { workerType: 'codex', model: bedrock('global.openai.gpt-6.1-sol', 'xhigh') })
    expect(both.cell.store.settings().executor).toMatchObject({ workerType: 'codex', model: bedrock('global.openai.gpt-6.1-sol', 'xhigh') })
    expect((await refused(saveExecutor(both, { model: bedrock('global.openai.gpt-6.1-sol', 'none') }))).values)
      .toMatchObject({ block: 'executor', field: 'model', reason: 'badEffort' })

    const claudeOnly = cell()
    expect((await refused(saveExecutor(claudeOnly, { workerType: 'codex', model: null }))).values)
      .toMatchObject({ block: 'executor', field: 'workerType', reason: 'workerUnavailable' })
    expect(claudeOnly.cell.store.settings().executor.workerType).toBe('claude')
  })
  it('lets a cell already stored as codex save other executor fields while this host has no Codex runtime', async () => {
    const made = cell({}, { executor: { workerType: 'codex' } })
    await saveExecutor(made, { maxWorkers: 7 })
    expect(made.cell.store.settings().executor).toMatchObject({ workerType: 'codex', maxWorkers: 7 })
  })
})

describe('rollback-safe settings storage (v7)', () => {
  it('stores no v7 key that holds its default, and reads both back with defaults', async () => {
    const made = cell()
    expect(rawSettings(made).executor).not.toHaveProperty('workerType')
    expect(rawSettings(made).eval).not.toHaveProperty('replyModel')
    await made.cell.settings.pause(true, 'panel')
    expect(rawSettings(made).executor).not.toHaveProperty('workerType')
    expect(rawSettings(made).eval).not.toHaveProperty('replyModel')
    await made.cell.settings.save('eval', { ...made.cell.store.settings().eval, mode: 'auto' }, made.cell.store.blockRevision('eval'), 'panel')
    expect(rawSettings(made).eval).not.toHaveProperty('replyModel')
    expect(made.cell.store.settings().executor.workerType).toBe('claude')
    expect(made.cell.store.settings().eval.replyModel).toBeNull()
    for (const version of made.cell.store.settingsHistory()) {
      expect(version.settings.executor.workerType).toBe('claude')
      expect(version.settings.eval.replyModel).toBeNull()
    }
  })
  it('stores the v7 keys once they differ from their defaults', async () => {
    const made = cell({ workerTypes: ['claude', 'codex'] })
    await made.cell.settings.save('executor', { ...made.cell.store.settings().executor, workerType: 'codex' }, made.cell.store.blockRevision('executor'), 'panel')
    await made.cell.settings.save('eval', { ...made.cell.store.settings().eval, replyModel: bedrock('global.openai.gpt-6-luna') }, made.cell.store.blockRevision('eval'), 'panel')
    expect(rawSettings(made).executor.workerType).toBe('codex')
    expect(rawSettings(made).eval.replyModel).toEqual(bedrock('global.openai.gpt-6-luna'))
    const [newest, previous] = made.cell.store.settingsHistory()
    expect(newest!.settings.eval.replyModel).toEqual(bedrock('global.openai.gpt-6-luna'))
    expect(previous!.settings).toMatchObject({ executor: { workerType: 'codex' }, eval: { replyModel: null } })
  })
})

/** An executor with one recording runtime per worker type in `types`. */
function executorCell(types: WorkerType[], settings: Record<string, unknown> = {}, extra: Partial<AgentCoreExecutorDeps> = {}) {
  const calls: { type: WorkerType; sessionId: string; request: InvocationRequest }[] = []
  const vm: Partial<Record<WorkerType, string>> = {}
  const runtimeOf = (type: WorkerType): WorkerRuntime => ({
    invoke: async (sessionId, request): Promise<InvocationResponse> => {
      calls.push({ type, sessionId, request })
      return { ok: true, accepted: request.inputs.map(input => input.id), state: 'running', ...vm[type] ? { workerVersion: vm[type] } : {} }
    },
    stopSession: async sessionId => { calls.push({ type, sessionId, request: { action: 'stopSession' } as never }) },
  })
  const runtimes: Partial<Record<WorkerType, WorkerRuntime>> = Object.fromEntries(types.map(type => [type, runtimeOf(type)]))
  const provisioned: string[] = []
  const deps: AgentCoreExecutorDeps = { runtimes, provisioner: { ensure: async request => { provisioned.push(request.ticketId) } }, tokens, staleStopSettleMs: 0, ...extra }
  const made = cell({ workerTypes: types, executor: parts => new AgentCoreExecutor(parts, deps) }, settings)
  made.cell.start()
  const settle = async () => { await made.cell.passes.idle(); await made.cell.effects.idle(); await made.cell.passes.idle() }
  const accept = async (id = '1') => {
    await made.cell.handle(chatEnvelope(message(id)))
    await settle()
    const candidate = made.recorder.candidates.at(-1)!
    const decision = made.cell.engine.decide(candidate.triggers[0]!.id, { kind: 'accept', title: 'Fix', scope: 'Fix', reason: 'explicit', name: 'fix-button' })
    await settle()
    return made.cell.store.tickets.get(decision.ticketId!)!
  }
  const followUp = async (id: string) => { await made.cell.handle(chatEnvelope(message(id, { mention: false, text: `also ${id}` }))); await settle() }
  const setWorkerType = (workerType: WorkerType) => {
    const current = made.cell.store.settings()
    made.cell.store.saveSettings({ ...current, executor: { ...current.executor, workerType } })
  }
  const actions = (type?: WorkerType) => calls.filter(call => !type || call.type === type).map(call => `${call.type}:${call.request.action}`)
  return { ...made, calls, vm, deps, provisioned, accept, followUp, setWorkerType, actions }
}

describe('AgentCoreExecutor worker types (v7)', () => {
  it('fixes the worker type on first launch; a later settings change does not move the ticket', async () => {
    const h = executorCell(['claude', 'codex'])
    const ticket = await h.accept()
    expect(h.cell.store.get(KV.workerType(ticket.id))).toBe('claude')
    h.setWorkerType('codex')
    await h.followUp('2')
    expect(h.actions()).toEqual(['claude:start', 'claude:deliver'])
    expect(h.calls.at(-1)!.request.config).toMatchObject({ agent: 'claude', model: DEFAULT_MODELS.worker.claude })
    expect(h.cell.store.get(KV.workerType(ticket.id))).toBe('claude')
  })
  it('a running Claude ticket uses the Claude default once the cell\'s worker model is a Codex one', async () => {
    const h = executorCell(['claude', 'codex'])
    await h.accept()
    const current = h.cell.store.settings()
    h.cell.store.saveSettings({ ...current, executor: { ...current.executor, workerType: 'codex', model: bedrock('global.openai.gpt-6.1-sol', 'xhigh') } })
    await h.followUp('2')
    expect(h.actions()).toEqual(['claude:start', 'claude:deliver'])
    const config = h.calls.at(-1)!.request.config!
    expect(config).toMatchObject({ agent: 'claude', model: DEFAULT_MODELS.worker.claude })
    expect(config).not.toHaveProperty('effort')
  })
  it('treats a ticket that started before v7 (no stored type) as a Claude ticket, and records it', async () => {
    const h = executorCell(['claude', 'codex'])
    const ticket = await h.accept()
    h.cell.store.delete(KV.workerType(ticket.id))
    h.setWorkerType('codex')
    await h.followUp('2')
    expect(h.actions()).toEqual(['claude:start', 'claude:deliver'])
    expect(h.cell.store.get(KV.workerType(ticket.id))).toBe('claude')
  })
  it('sends the resolved model, effort and agent: Claude default has no effort, Codex default is Terra at high', async () => {
    const claude = executorCell(['claude', 'codex'])
    await claude.accept()
    const claudeConfig = claude.calls[0]!.request.config!
    expect(claudeConfig).toMatchObject({ model: 'global.anthropic.claude-opus-5-5', agent: 'claude' })
    expect(claudeConfig).not.toHaveProperty('effort')

    const codex = executorCell(['claude', 'codex'], { executor: { workerType: 'codex' } })
    const ticket = await codex.accept()
    expect(codex.actions()).toEqual(['codex:start'])
    expect(codex.calls[0]!.sessionId).toBe(runtimeSessionId(CELL_ID, ticket.id))
    expect(codex.calls[0]!.request.config).toMatchObject({ model: 'global.openai.gpt-6.1-terra', effort: 'high', agent: 'codex' })
    expect(codex.cell.store.get(KV.workerType(ticket.id))).toBe('codex')
  })
  it('sends an explicit effort, and applies a model change from the next turn', async () => {
    const h = executorCell(['claude'], { executor: { model: bedrock('global.anthropic.claude-sonnet-5-5', 'xhigh') } })
    await h.accept()
    expect(h.calls[0]!.request.config).toMatchObject({ model: 'global.anthropic.claude-sonnet-5-5', effort: 'xhigh', agent: 'claude' })
    const current = h.cell.store.settings()
    h.cell.store.saveSettings({ ...current, executor: { ...current.executor, model: bedrock('global.anthropic.claude-haiku-5-5', 'low') } })
    await h.followUp('2')
    expect(h.calls.at(-1)!.request).toMatchObject({ action: 'deliver', config: { model: 'global.anthropic.claude-haiku-5-5', effort: 'low' } })
  })
  it('fails a Codex ticket permanently when this host has no Codex runtime, without provisioning or retrying', async () => {
    const h = executorCell(['claude'], { executor: { workerType: 'codex' } })
    const ticket = await h.accept()
    expect(h.calls).toEqual([])
    expect(h.provisioned).toEqual([])
    const report = latestAssignment(h.cell.store.tickets.get(ticket.id)!)!.report
    expect(report).toMatchObject({ state: 'failed', summary: expect.stringContaining('not deployed') })
    expect(h.cell.store.get(KV.workerType(ticket.id))).toBe('codex')
    await h.cell.effects.idle()
    expect(h.calls).toEqual([])
  })
  it('fails a delivery to a Codex ticket whose runtime is gone with a report, without throwing or invoking', async () => {
    const h = executorCell(['claude', 'codex'], { executor: { workerType: 'codex' } })
    const ticket = await h.accept()
    expect(h.actions()).toEqual(['codex:start'])
    delete h.deps.runtimes!.codex  // as after a host restart without RUNTIME_ARN_CODEX
    await h.followUp('2')
    expect(h.actions()).toEqual(['codex:start'])
    const current = h.cell.store.tickets.get(ticket.id)!
    expect(latestAssignment(current)!.report).toMatchObject({ state: 'failed', summary: expect.stringContaining('not deployed') })
    expect(current.delivery?.error).toContain('not deployed')
  })
  it('checks a session for staleness against its own worker type\'s served version', async () => {
    const h = executorCell(['claude', 'codex'], { executor: { workerType: 'codex' } },
      { workerVersion: async () => 'old', workerVersions: { codex: async () => 'new' } })
    h.vm.codex = 'old'
    const ticket = await h.accept()
    h.cell.engine.turnEnded(ticket.id, latestAssignment(h.cell.store.tickets.get(ticket.id)!)!.id)
    h.vm.codex = 'new'
    await h.followUp('2')
    expect(h.actions()).toEqual(['codex:start', 'codex:stopSession', 'codex:deliver'])

    // A Claude ticket compares with the Claude version: its session answers 'old', which is what claude serves, so nothing stops.
    const claude = executorCell(['claude', 'codex'], {}, { workerVersion: async () => 'old', workerVersions: { codex: async () => 'new' } })
    claude.vm.claude = 'old'
    const claudeTicket = await claude.accept()
    claude.cell.engine.turnEnded(claudeTicket.id, latestAssignment(claude.cell.store.tickets.get(claudeTicket.id)!)!.id)
    await claude.followUp('2')
    expect(claude.actions()).toEqual(['claude:start', 'claude:deliver'])
  })
})

describe('GET models (v7)', () => {
  async function serve(workerTypes?: WorkerType[]) {
    const made = cell(workerTypes ? { workerTypes } : {})
    made.cell.start()
    const server = internalServer({ log: quiet, verify: async () => 'arn:api', cells: { get: id => id === CELL_ID ? made.cell : undefined, list: () => [CELL_ID] } })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(async () => { server.close() })
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/${CELL_ID}/api/models`,
      { headers: { 'x-dshsa-caller': 'ok-api', 'x-dshsa-role': 'admin' } })
    expect(response.status).toBe(200)
    return response.json()
  }
  it('returns the catalog, the defaults and which worker types this host runs', async () => {
    expect(await serve()).toEqual({ models: MODEL_CATALOG, defaults: DEFAULT_MODELS,
      workerTypes: [{ id: 'claude', label: expect.any(String), available: true }, { id: 'codex', label: expect.any(String), available: false }] })
    expect((await serve(['claude', 'codex']) as { workerTypes: unknown[] }).workerTypes)
      .toEqual([expect.objectContaining({ id: 'claude', available: true }), expect.objectContaining({ id: 'codex', available: true })])
  })
})
