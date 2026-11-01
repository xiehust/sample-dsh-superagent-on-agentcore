/**
 * One stateless model call with a forced tool (Bedrock Converse), used by the cell's Assessor and Replier (parent PRD R5,
 * decision D3). Moved from `packages/cell/src/model/bedrock.ts` (5c) with the same names. On top of that version:
 * - the system prompt is two blocks, `prefix` then a cache point then `policy`: a Policy save leaves the cached prompt valid;
 * - no forced tool_choice (the Claude 5.5 models refuse `tool`/`any`): the user turn asks for exactly one call, and a prose
 *   answer gets one corrective turn before `AssessUnavailable`;
 * - Bedrock throttling and transient errors are retried with full-jitter backoff, but never past the call's deadline;
 * - a deadline (the Eval's `settings.eval.timeoutSeconds`) or exhausted retries raise `AssessUnavailable`, which the
 *   Assessor records as an `unavailable` Eval; a caller's own abort (lease lost, eval released) stays an AbortError.
 */
import { BedrockRuntimeClient, ConverseCommand, type ConverseCommandOutput, type Message, type SystemContentBlock } from '@aws-sdk/client-bedrock-runtime'
import { z } from 'zod'

export interface SystemPrompt {
  /** Everything before the Policy section: the DSH orchestrator prompt and the stateless preamble. Cached. */
  prefix: string
  /** The Policy section, which changes with every Policy save; after the cache point. */
  policy?: string
}
export interface ToolCall<S extends z.ZodType> {
  model: string
  system: SystemPrompt
  /** The user turn: the candidate or report card, as text. */
  prompt: string
  tool: { name: string; description: string; schema: S }
  maxTokens?: number
  /** The caller's own cancellation (lease lost, eval released); aborting it rejects with its reason, not `AssessUnavailable`. */
  signal?: AbortSignal
  /** Milliseconds from now after which the call gives up with `AssessUnavailable` (the Eval's timeout). */
  deadlineMs?: number
}
export interface ModelClient {
  /** Returns the tool input the model produced, unparsed (the caller validates it with the tool schema). */
  call<S extends z.ZodType>(request: ToolCall<S>): Promise<unknown>
}

/** The model could not answer in time, or Bedrock kept refusing: the Eval is `unavailable`, which the Engine shows and retries. */
export class AssessUnavailable extends Error {
  constructor(message: string, readonly cause?: unknown) { super(message) }
}
/** Bedrock errors worth another try: throttling, capacity and transient service failures. */
const TRANSIENT = new Set(['ThrottlingException', 'ServiceUnavailableException', 'ModelNotReadyException', 'InternalServerException',
  'ServiceQuotaExceededException', 'ModelErrorException', 'TooManyRequestsException'])
export function transient(error: unknown): boolean {
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number }; $retryable?: unknown } | null
  const status = value?.$metadata?.httpStatusCode
  return !!value && (TRANSIENT.has(value.name ?? '') || status === 429 || status === 503 || !!value.$retryable)
}
export interface RetryPolicy { attempts: number; baseMs: number; maxMs: number }
export const DEFAULT_RETRY: RetryPolicy = { attempts: 5, baseMs: 500, maxMs: 8000 }
/** Token usage and latency of one Converse call, for metrics. */
export interface Usage { model: string; tool: string; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number;
  cacheWriteTokens?: number; latencyMs?: number; attempts: number }
export interface BedrockModelOptions {
  retry?: RetryPolicy
  onUsage?(usage: Usage): void
  /** Injected for tests; full jitter by default. */
  random?(): number
  sleep?(ms: number, signal: AbortSignal): Promise<void>
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    const done = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', done); resolve() }, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}
/** Converse system blocks: the prefix, a cache point, then the Policy (absent when there is none). */
export function systemBlocks(system: SystemPrompt): SystemContentBlock[] {
  return [{ text: system.prefix }, { cachePoint: { type: 'default' } }, ...system.policy ? [{ text: system.policy }] : []]
}

export class BedrockModelClient implements ModelClient {
  private readonly retry: RetryPolicy
  /**
   * @param client - a Bedrock runtime client; by default one with the SDK's own retries off (`maxAttempts: 1`), as this class
   *   retries itself within the deadline.
   */
  constructor(private readonly client: Pick<BedrockRuntimeClient, 'send'> = new BedrockRuntimeClient({ maxAttempts: 1 }),
    private readonly options: BedrockModelOptions = {}) {
    this.retry = options.retry ?? DEFAULT_RETRY
  }
  async call<S extends z.ZodType>({ model, system, prompt, tool, maxTokens = 4096, signal, deadlineMs }: ToolCall<S>): Promise<unknown> {
    const json = z.toJSONSchema(tool.schema, { target: 'draft-7', unrepresentable: 'any' }) as Record<string, unknown>
    // The Claude 5.5 models refuse a forced tool_choice (`tool` / `any`): the tool is offered with the default (auto) choice,
    // and the user turn says the answer must be that one call. The instruction sits in the user turn so the cached system prefix
    // stays the same for every tool.
    const toolConfig = { tools: [{ toolSpec: { name: tool.name, description: tool.description, inputSchema: { json: json as never } } }] }
    const deadline = deadlineMs === undefined ? undefined : AbortSignal.timeout(deadlineMs)
    const abort = AbortSignal.any([...signal ? [signal] : [], ...deadline ? [deadline] : []])
    const expired = () => !!deadline?.aborted && !signal?.aborted
    const late = (error?: unknown) => new AssessUnavailable(`The model did not answer within ${deadlineMs} ms`, error)
    const sleep = this.options.sleep ?? wait
    const random = this.options.random ?? Math.random
    let attempts = 0
    const converse = async (messages: Message[]): Promise<ConverseCommandOutput> => {
      const command = new ConverseCommand({ modelId: model, system: systemBlocks(system), messages, inferenceConfig: { maxTokens }, toolConfig })
      for (let attempt = 1; ; attempt++) {
        attempts += 1
        try { return await this.client.send(command, { abortSignal: abort }) as ConverseCommandOutput }
        catch (error) {
          if (expired()) throw late(error)
          if (signal?.aborted) throw signal.reason
          if (!transient(error)) throw error
          if (attempt >= this.retry.attempts) {
            throw new AssessUnavailable(`Bedrock kept refusing after ${attempt} attempts: ${(error as Error).name ?? 'error'}`, error)
          }
          const backoff = Math.min(this.retry.maxMs, this.retry.baseMs * 2 ** (attempt - 1)) * random()
          try { await sleep(backoff, abort) } catch (reason) { if (expired()) throw late(error); throw reason }
        }
      }
    }
    const report = (result: ConverseCommandOutput) => {
      const usage = result.usage as (typeof result.usage & { cacheReadInputTokens?: number; cacheWriteInputTokens?: number }) | undefined
      this.options.onUsage?.({ model, tool: tool.name, attempts, ...usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {},
        ...usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {},
        ...usage?.cacheReadInputTokens !== undefined ? { cacheReadTokens: usage.cacheReadInputTokens } : {},
        ...usage?.cacheWriteInputTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteInputTokens } : {},
        ...result.metrics?.latencyMs !== undefined ? { latencyMs: result.metrics.latencyMs } : {} })
    }
    const toolUse = (result: ConverseCommandOutput) => result.output?.message?.content?.find(block => block.toolUse?.name === tool.name)?.toolUse
    const asked: Message = { role: 'user', content: [{ text: `${prompt}\n\n${mustCall(tool.name)}` }] }
    const first = await converse([asked])
    report(first)
    const use = toolUse(first)
    if (use) return use.input
    // Answered in prose: one corrective turn, within the same deadline, as for a refused schema.
    const said = (first.output?.message?.content ?? []).filter(block => typeof block.text === 'string' && block.text.trim())
    const correction = `You must call the ${tool.name} tool now: exactly one call, no prose.`
    const messages: Message[] = said.length
      ? [asked, { role: 'assistant', content: said.map(block => ({ text: block.text! })) }, { role: 'user', content: [{ text: correction }] }]
      : [{ role: 'user', content: [{ text: `${asked.content![0]!.text!}\n\n${correction}` }] }]
    const second = await converse(messages)
    report(second)
    const retried = toolUse(second)
    if (retried) return retried.input
    throw new AssessUnavailable(`The model did not call ${tool.name} (stop reason ${second.stopReason ?? first.stopReason ?? 'unknown'})`)
  }
}

/** The instruction appended to every user turn: the answer is one call to `tool`, nothing else. */
export const mustCall = (tool: string): string =>
  `Answer with exactly one call to the ${tool} tool and nothing else: no prose before or after it, and no other tool.`

/** Calls the tool and validates its input; one retry tells the model what was wrong, as a tool error would in a Session. */
export async function callTool<S extends z.ZodType>(client: ModelClient, request: ToolCall<S>): Promise<z.infer<S>> {
  const first = request.tool.schema.safeParse(await client.call(request))
  if (first.success) return first.data
  const retry = await client.call({ ...request, prompt: `${request.prompt}\n\nYour previous ${request.tool.name} call was refused: ${z.prettifyError(first.error)}. Call it again, corrected.` })
  return request.tool.schema.parse(retry)
}
