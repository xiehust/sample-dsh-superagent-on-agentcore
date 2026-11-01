import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ConverseCommand } from '@aws-sdk/client-bedrock-runtime'
import { AssessUnavailable, BedrockModelClient, callTool, modelFor, mustCall, type ModelClient, type Usage } from '../src/index.ts'

const Decision = z.object({ kind: z.enum(['accept', 'ignore']), reason: z.string().min(1) }).strict()
const tool = { name: 'orchestrator_route', description: 'Route the candidate.', schema: Decision }
const request = { model: 'global.anthropic.claude-sonnet-5-5', system: { prefix: 'DSH orchestrator prompt', policy: '## Policy\nversion v1' },
  prompt: '{"eval_id":"e1"}', tool }
const answer = (input: unknown) => ({ output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: 'u1', name: tool.name, input } }] } },
  stopReason: 'tool_use', usage: { inputTokens: 1200, outputTokens: 40, cacheReadInputTokens: 1100 }, metrics: { latencyMs: 900 } })
const error = (name: string, status = 400) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } })
/** A Bedrock runtime client that answers from a script, recording each command and its abort signal. */
function bedrock(script: ((command: ConverseCommand, signal?: AbortSignal) => unknown)[]) {
  const sent: { command: ConverseCommand; signal?: AbortSignal }[] = []
  return { sent, client: { send: async (command: ConverseCommand, options?: { abortSignal?: AbortSignal }) => {
    sent.push({ command, ...options?.abortSignal ? { signal: options.abortSignal } : {} })
    const step = script[Math.min(sent.length - 1, script.length - 1)]!
    const value = await step(command, options?.abortSignal)
    if (value instanceof Error) throw value
    return value
  } } }
}
const noSleep = { sleep: async () => {}, random: () => 0 }

describe('BedrockModelClient', () => {
  it('sends the prefix, a cache point and then the Policy, and offers the tool without forcing tool_choice', async () => {
    const usage: Usage[] = []
    const { client, sent } = bedrock([() => answer({ kind: 'ignore', reason: 'not addressed' })])
    const model = new BedrockModelClient(client as never, { onUsage: value => usage.push(value) })
    expect(await model.call(request)).toEqual({ kind: 'ignore', reason: 'not addressed' })
    const input = sent[0]!.command.input
    expect(input.modelId).toBe('global.anthropic.claude-sonnet-5-5')
    expect(input.system).toEqual([{ text: 'DSH orchestrator prompt' }, { cachePoint: { type: 'default' } }, { text: '## Policy\nversion v1' }])
    // The Claude 5.5 models refuse tool_choice `tool` and `any` (ValidationException): the choice stays the default (auto).
    expect(input.toolConfig?.toolChoice).toBeUndefined()
    expect(input.toolConfig?.tools).toHaveLength(1)
    expect(input.toolConfig?.tools?.[0]?.toolSpec?.inputSchema?.json).toMatchObject({ type: 'object', required: ['kind', 'reason'] })
    expect(input.messages).toEqual([{ role: 'user', content: [{ text: `{"eval_id":"e1"}\n\n${mustCall('orchestrator_route')}` }] }])
    expect(usage).toEqual([{ model: request.model, tool: 'orchestrator_route', attempts: 1, inputTokens: 1200, outputTokens: 40, cacheReadTokens: 1100, latencyMs: 900 }])
  })
  it('keeps the cache point last when there is no Policy (the Replier)', async () => {
    const { client, sent } = bedrock([() => answer({ kind: 'ignore', reason: 'x' })])
    await new BedrockModelClient(client as never).call({ ...request, system: { prefix: 'p' } })
    expect(sent[0]!.command.input.system).toEqual([{ text: 'p' }, { cachePoint: { type: 'default' } }])
  })
  it('retries throttling with backoff and answers once Bedrock lets it through', async () => {
    const slept: number[] = []
    const { client, sent } = bedrock([() => error('ThrottlingException', 429), () => error('ServiceUnavailableException', 503), () => answer({ kind: 'accept', reason: 'asked' })])
    const model = new BedrockModelClient(client as never, { random: () => 1, sleep: async ms => { slept.push(ms) } })
    expect(await model.call(request)).toEqual({ kind: 'accept', reason: 'asked' })
    expect(sent).toHaveLength(3)
    expect(slept).toEqual([500, 1000])
  })
  it('gives up with AssessUnavailable when throttling outlasts its attempts', async () => {
    const { client, sent } = bedrock([() => error('ThrottlingException', 429)])
    const failure = await new BedrockModelClient(client as never, { ...noSleep, retry: { attempts: 3, baseMs: 1, maxMs: 1 } }).call(request).catch((value: unknown) => value)
    expect(failure).toBeInstanceOf(AssessUnavailable)
    expect(sent).toHaveLength(3)
  })
  it('turns the Eval deadline into AssessUnavailable, but rethrows the caller\'s own abort', async () => {
    const hang = (_: ConverseCommand, signal?: AbortSignal) => new Promise((_resolve, reject) => { signal?.addEventListener('abort', () => reject(signal.reason)) })
    const { client } = bedrock([hang])
    await expect(new BedrockModelClient(client as never).call({ ...request, deadlineMs: 20 })).rejects.toBeInstanceOf(AssessUnavailable)
    const caller = new AbortController()
    const call = new BedrockModelClient(bedrock([hang]).client as never).call({ ...request, signal: caller.signal, deadlineMs: 10_000 })
    caller.abort(new Error('released'))
    await expect(call).rejects.toThrow('released')
  })
  it('does not retry a request Bedrock refuses outright', async () => {
    const { client, sent } = bedrock([() => error('ValidationException', 400)])
    await expect(new BedrockModelClient(client as never, noSleep).call(request)).rejects.toThrow('ValidationException')
    expect(sent).toHaveLength(1)
  })
  const prose = { output: { message: { role: 'assistant', content: [{ text: 'I would ignore this.' }] } }, stopReason: 'end_turn' }
  it('answers prose with one corrective turn and takes the tool call it then makes', async () => {
    const { client, sent } = bedrock([() => prose, () => answer({ kind: 'ignore', reason: 'not addressed' })])
    expect(await new BedrockModelClient(client as never).call(request)).toEqual({ kind: 'ignore', reason: 'not addressed' })
    expect(sent).toHaveLength(2)
    const retry = sent[1]!.command.input
    expect(retry.messages?.map(message => message.role)).toEqual(['user', 'assistant', 'user'])
    expect(retry.messages?.[1]?.content).toEqual([{ text: 'I would ignore this.' }])
    expect(retry.messages?.[2]?.content?.[0]?.text).toBe('You must call the orchestrator_route tool now: exactly one call, no prose.')
    for (const { command } of sent) expect(command.input.toolConfig?.toolChoice).toBeUndefined()
  })
  it('is unavailable when the model still answers without the tool, and counts the retry inside the deadline', async () => {
    const { client, sent } = bedrock([() => prose])
    const failure = await new BedrockModelClient(client as never).call(request).catch((value: unknown) => value)
    expect(failure).toBeInstanceOf(AssessUnavailable)
    expect((failure as Error).message).toBe('The model did not call orchestrator_route (stop reason end_turn)')
    expect(sent).toHaveLength(2)
    const hang = (_: ConverseCommand, signal?: AbortSignal) => new Promise((_resolve, reject) => { signal?.addEventListener('abort', () => reject(signal.reason)) })
    const slow = bedrock([() => prose, hang])
    await expect(new BedrockModelClient(slow.client as never).call({ ...request, deadlineMs: 30 })).rejects.toBeInstanceOf(AssessUnavailable)
    expect(slow.sent[1]!.signal).toBe(slow.sent[0]!.signal)
  })
  it('ignores a call to another tool than the one offered', async () => {
    const other = { output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: 'x', name: 'other', input: {} } }] } }, stopReason: 'tool_use' }
    const { client } = bedrock([() => other, () => answer({ kind: 'accept', reason: 'asked' })])
    expect(await new BedrockModelClient(client as never).call(request)).toEqual({ kind: 'accept', reason: 'asked' })
  })
})

describe('callTool', () => {
  const scripted = (inputs: unknown[]) => {
    const prompts: string[] = []
    const client: ModelClient = { call: async value => { prompts.push(value.prompt); return inputs[prompts.length - 1] } }
    return { client, prompts }
  }
  it('returns the parsed decision', async () => {
    expect(await callTool(scripted([{ kind: 'accept', reason: 'asked' }]).client, request)).toEqual({ kind: 'accept', reason: 'asked' })
  })
  it('retries once with what was refused, then gives up so the Eval is recorded unavailable', async () => {
    const once = scripted([{ kind: 'maybe' }, { kind: 'ignore', reason: 'fixed' }])
    expect(await callTool(once.client, request)).toEqual({ kind: 'ignore', reason: 'fixed' })
    expect(once.prompts[1]).toMatch(/^\{"eval_id":"e1"\}\n\nYour previous orchestrator_route call was refused: .*kind.*Call it again, corrected\.$/s)
    const twice = scripted([{ kind: 'maybe' }, { reason: '' }])
    await expect(callTool(twice.client, request)).rejects.toBeInstanceOf(z.ZodError)
    expect(twice.prompts).toHaveLength(2)
  })
})

describe('modelFor', () => {
  it('uses the contracts defaults unless the cell names an eval model', () => {
    expect(modelFor('eval')).toBe('global.anthropic.claude-sonnet-5-5')
    expect(modelFor('reply', { eval: { model: null } })).toBe('global.anthropic.claude-sonnet-5-5')
    expect(modelFor('reply', { eval: { model: { model: 'global.anthropic.claude-haiku-5-5' } } })).toBe('global.anthropic.claude-haiku-5-5')
  })
})
