/** `Provisioner` on Lambda `dshsa-provisioner` (owner a8): idempotent per ticketKey; `bad_request` is permanent, `internal` retryable. */
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda'
import type { Provisioner } from '../executor/agentcore.ts'

export class ProvisionerRefused extends Error { constructor(readonly code: string, message: string) { super(`provisioner ${code}: ${message}`) } }

export class LambdaProvisioner implements Provisioner {
  constructor(private readonly functionName: string, private readonly client: LambdaClient = new LambdaClient({})) {}
  async ensure(request: Parameters<Provisioner['ensure']>[0]): Promise<void> { await this.call({ action: 'ensure', ...request }) }
  /** Refuse future mounts of a ticket a person stopped. */
  async disable(request: { tenantId: string; cellId: string; ticketId: string }): Promise<void> { await this.call({ action: 'disable', ...request }) }
  private async call(event: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await this.client.send(new InvokeCommand({ FunctionName: this.functionName, InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify(event)) }))
    if (result.FunctionError) throw new Error(`provisioner ${result.FunctionError}: ${Buffer.from(result.Payload ?? []).toString('utf8').slice(0, 500)}`)
    const body = JSON.parse(Buffer.from(result.Payload ?? []).toString('utf8') || '{}') as { ok?: boolean; error?: string; message?: string }
    if (body.ok !== true) throw new ProvisionerRefused(body.error ?? 'internal', body.message ?? 'no message')
    return body
  }
}
