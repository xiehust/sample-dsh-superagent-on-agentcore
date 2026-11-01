/** `WorkerRuntime` on AgentCore Runtime `InvokeAgentRuntime` (SigV4, parent design §4.4); the worker always answers HTTP 200 with JSON. */
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand, StopRuntimeSessionCommand } from '@aws-sdk/client-bedrock-agentcore'
import type { InvocationRequest, InvocationResponse } from '@dshsa/contracts'
import type { WorkerRuntime } from '../executor/agentcore.ts'

export class AgentCoreRuntime implements WorkerRuntime {
  constructor(private readonly runtimeArn: string, private readonly client: BedrockAgentCoreClient = new BedrockAgentCoreClient({}),
    private readonly qualifier = 'DEFAULT') {}
  async invoke(runtimeSessionId: string, request: InvocationRequest, signal: AbortSignal): Promise<InvocationResponse> {
    const result = await this.client.send(new InvokeAgentRuntimeCommand({ agentRuntimeArn: this.runtimeArn, qualifier: this.qualifier, runtimeSessionId,
      contentType: 'application/json', accept: 'application/json', payload: Buffer.from(JSON.stringify(request)) }), { abortSignal: signal })
    const text = result.response ? await result.response.transformToString() : ''
    try { return JSON.parse(text) as InvocationResponse }
    catch { throw new Error(`The worker answered ${result.statusCode ?? '?'} with no JSON: ${text.slice(0, 300)}`) }
  }
  /** Ends the session's microVM (`StopRuntimeSession`); the next invoke with the same id starts a fresh one. A session already gone is fine. */
  async stopSession(runtimeSessionId: string, signal: AbortSignal): Promise<void> {
    try {
      await this.client.send(new StopRuntimeSessionCommand({ agentRuntimeArn: this.runtimeArn, qualifier: this.qualifier, runtimeSessionId }), { abortSignal: signal })
    } catch (error) {
      if ((error as { name?: string }).name !== 'ResourceNotFoundException') throw error
    }
  }
}
