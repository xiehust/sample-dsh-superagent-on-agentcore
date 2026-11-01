/**
 * Opt-in live test against real Bedrock: `DSHSA_LIVE=1 pnpm --filter @dshsa/assess test`. It uses the operator's AWS
 * credentials in ap-northeast-1 (contracts REGION, or AWS_REGION) and the default eval model, makes two small Converse calls
 * (a few hundred tokens), and creates no resources.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime'
import { REGION } from '@dshsa/contracts'
import { BedrockModelClient, callTool, modelFor, type Usage } from '../src/index.ts'

const live = process.env.DSHSA_LIVE === '1'
/** `DSHSA_LIVE_MODEL` runs it against another model, such as Models.worker. */
const modelId = process.env.DSHSA_LIVE_MODEL || modelFor('eval')
describe.skipIf(!live)('Bedrock (live)', () => {
  it('answers with the offered tool (auto tool_choice) under the cache point within the Eval deadline', async () => {
    const usage: Usage[] = []
    const model = new BedrockModelClient(new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? REGION, maxAttempts: 1 }),
      { onUsage: value => usage.push(value) })
    const Decision = z.object({ kind: z.enum(['accept', 'ignore']), reason: z.string().min(1).max(300) }).strict()
    const system = {
      prefix: 'You route requests for a coding agent. Accept a request only when an allowed person explicitly asks the agent for work in the repository; otherwise ignore it.',
      policy: '## Policy\nAllowed GitHub accounts: alice. Accept mode: observe.',
    }
    const card = (from: string, text: string) => JSON.stringify({ eval_id: 'live-1', strength: 'explicit', triggers: [{ from, text }] })
    const accepted = await callTool(model, { model: modelId, system, prompt: card('alice', '@agent please fix the typo in README.md'),
      tool: { name: 'route', description: 'Record the routing decision.', schema: Decision }, maxTokens: 512, deadlineMs: 60_000 })
    const ignored = await callTool(model, { model: modelId, system, prompt: card('mallory', 'nice weather today'),
      tool: { name: 'route', description: 'Record the routing decision.', schema: Decision }, maxTokens: 512, deadlineMs: 60_000 })
    expect(accepted.kind).toBe('accept')
    expect(ignored.kind).toBe('ignore')
    expect(usage.every(item => (item.inputTokens ?? 0) > 0)).toBe(true)
    console.log('live usage', JSON.stringify(usage))
  }, 150_000)
})
