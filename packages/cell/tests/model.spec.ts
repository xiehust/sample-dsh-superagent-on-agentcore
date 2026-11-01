import { afterEach, describe, expect, it } from 'vitest'
import { ticketKey } from '@dshsa/contracts'
import { key, latestAssignment } from '../src/core/index.ts'
import { StatelessAssessor } from '../src/assessor.ts'
import { Replier } from '../src/replier.ts'
import type { ModelClient, ToolCall } from '@dshsa/assess'
import { CELL_ID, chatEnvelope, makeCell, sent, type ChatMessage } from './fixtures/cell.ts'

const message = (id: string, overrides: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, thread: '11', from: 'alice', text: `@dshsa-agent rename the Save changes button to Save`, at: `2026-11-01T00:00:0${id}Z`, mention: true, ...overrides })

/** A scripted model: answers each tool by name, recording every call. */
function scripted(answers: Record<string, (call: ToolCall<never>) => unknown>) {
  const calls: ToolCall<never>[] = []
  const model: ModelClient = { call: async request => { calls.push(request as never); return answers[request.tool.name]!(request as never) } }
  return { model, calls }
}
let cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups) await cleanup(); cleanups = []; sent.length = 0 })

describe('StatelessAssessor', () => {
  it('routes an explicit candidate with orchestrator_route under the DSH orchestrator prompt and accepts it', async () => {
    const { model, calls } = scripted({ orchestrator_route: () => ({ kind: 'accept', trigger_id: key('chat', '1'), title: 'Rename the Save button',
      worktree_name: 'rename-save-button', acknowledgement: 'On it: renaming the button to “Save”.' }) })
    const made = makeCell({ assessor: parts => new StatelessAssessor(parts, { model }) }); cleanups.push(made.cleanup)
    made.cell.start()
    await made.cell.handle(chatEnvelope(message('1')))
    await made.cell.passes.idle()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.system.prefix).toContain('You are the orchestrator')
    expect(calls[0]!.system.prefix).not.toContain('## Policy')
    expect(calls[0]!.system.policy).toMatch(/^## Policy/)
    expect(calls[0]!.deadlineMs).toBeGreaterThan(0)
    expect(calls[0]!.model).toBe('global.anthropic.claude-sonnet-5-5')
    expect(JSON.parse(calls[0]!.prompt)).toMatchObject({ strength: 'explicit', trigger_id: key('chat', '1') })
    const [ticket] = made.cell.store.tickets.list()
    expect(ticket).toMatchObject({ title: 'Rename the Save button', execution: { name: expect.stringMatching(/^rename-save-button-/) } })
    expect(made.recorder.started).toHaveLength(1)
    await made.cell.effects.idle()
    expect(sent.map(item => item.text)).toEqual(['On it: renaming the button to “Save”.'])
  })
  it('retries once with the validation error, then records the eval unavailable', async () => {
    const { model, calls } = scripted({ orchestrator_route: () => ({ kind: 'accept', trigger_id: key('chat', '2') }) })
    const made = makeCell({ assessor: parts => new StatelessAssessor(parts, { model }) }); cleanups.push(made.cleanup)
    made.cell.start()
    await made.cell.handle(chatEnvelope(message('2')))
    await made.cell.passes.idle()
    expect(calls).toHaveLength(2)
    expect(calls[1]!.prompt).toContain('was refused')
    expect(made.cell.store.tickets.list()).toEqual([])
    expect(made.cell.store.decisions.byThread('github:11').at(-1)).toMatchObject({ kind: 'unavailable' })
  })
})

describe('Replier', () => {
  it('composes the ready result for a ready report and the reply gate sends it to the request channel', async () => {
    const { model, calls } = scripted({
      orchestrator_route: () => ({ kind: 'accept', trigger_id: key('chat', '3'), title: 'Rename', worktree_name: 'rename-button', acknowledgement: 'On it.' }),
      orchestrator_reply: () => ({ send: true, purpose: 'result', text: '[PR #5](https://github.com/acme/widgets/pull/5) is ready for review.' }),
    })
    const made = makeCell({ assessor: parts => new StatelessAssessor(parts, { model }), replier: parts => new Replier(parts, { model }) }); cleanups.push(made.cleanup)
    made.cell.start()
    await made.cell.handle(chatEnvelope(message('3')))
    await made.cell.passes.idle()
    const [ticket] = made.cell.store.tickets.list()
    // The fake executor never starts the assignment; mark it started as the AgentCore Executor would.
    made.cell.engine.assignmentStarted(ticket!.id, latestAssignment(ticket!)!.id)
    const assignment = latestAssignment(made.cell.store.tickets.get(ticket!.id)!)!.id
    await made.cell.workerEvents.apply({ event: { id: 'r1', ticketKey: ticketKey(CELL_ID, ticket!.id), assignmentId: assignment, at: '2026-11-01T00:02:00Z', type: 'report',
      body: { state: 'ready', text: 'PR #5 is ready' } }, verified: { tid: 'acme', cid: CELL_ID, tkt: ticket!.id, asg: assignment } })
    await made.cell.passes.idle()
    expect(calls.map(call => call.tool.name)).toEqual(['orchestrator_route', 'orchestrator_reply'])
    expect(calls[1]!.system.policy).toBeUndefined()
    expect(JSON.parse(calls[1]!.prompt)).toMatchObject({ report: { state: 'ready', summary: 'PR #5 is ready' } })
    expect(sent.map(item => item.text)).toContain('[PR #5](https://github.com/acme/widgets/pull/5) is ready for review.')
  })
})
