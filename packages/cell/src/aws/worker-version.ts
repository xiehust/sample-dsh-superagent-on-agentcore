/**
 * The worker image version a runtime's DEFAULT endpoint serves (contracts `WorkerVersion.parameters[type]`, e.g. SSM `/dshsa-worker/version`),
 * published by the worker stack after the runtime update. Cached for `ttlMs`; `undefined` while it cannot be read, so the
 * cell never stops a session on a guess.
 */
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm'
import { WorkerVersion, type Logger, type WorkerType } from '@dshsa/contracts'

export class SsmWorkerVersion {
  private cached?: { value: string | undefined; until: number }
  private reading?: Promise<string | undefined>
  private warned = false
  constructor(private readonly log: Logger, private readonly client: SSMClient = new SSMClient({}), private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now, private readonly type: WorkerType = 'claude') {}
  /** v7: the SSM parameter of this worker type's runtime. */
  private get parameter(): string { return WorkerVersion.parameters[this.type] }
  current(): Promise<string | undefined> {
    if (this.cached && this.now() < this.cached.until) return Promise.resolve(this.cached.value)
    return this.reading ??= this.read().finally(() => { this.reading = undefined })
  }
  private async read(): Promise<string | undefined> {
    let value: string | undefined
    try {
      value = (await this.client.send(new GetParameterCommand({ Name: this.parameter }))).Parameter?.Value || undefined
      this.warned = false
    } catch (error) {
      if (!this.warned) this.log.warn('worker version unavailable; stale sessions are not stopped', { parameter: this.parameter, error: String(error) })
      this.warned = true
    }
    this.cached = { value, until: this.now() + this.ttlMs }
    return value
  }
}
