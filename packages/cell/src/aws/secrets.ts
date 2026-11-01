/** Secrets Manager reads with a short cache (the GitHub App, the internal API secret, per-tenant Feishu bots). */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'

export class SecretCache {
  private readonly cache = new Map<string, { value: string; at: number }>()
  constructor(private readonly client: SecretsManagerClient = new SecretsManagerClient({}), private readonly ttlMs = 5 * 60_000, private readonly now = Date.now) {}
  async get(id: string): Promise<string> {
    const hit = this.cache.get(id)
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value
    const result = await this.client.send(new GetSecretValueCommand({ SecretId: id }))
    if (!result.SecretString) throw new Error(`secret ${id} has no string value`)
    this.cache.set(id, { value: result.SecretString, at: this.now() })
    return result.SecretString
  }
  async json<T>(id: string): Promise<T> { return JSON.parse(await this.get(id)) as T }
  /** Drops a cached value, so the next read fetches it again (such as after its owner announced a new version). */
  forget(id: string): void { this.cache.delete(id) }
  /** The secret's current version id, read past the cache (the GitHub App watch, design onboarding §6). */
  async version(id: string): Promise<string | undefined> {
    const result = await this.client.send(new GetSecretValueCommand({ SecretId: id }))
    if (result.SecretString) this.cache.set(id, { value: result.SecretString, at: this.now() })
    return result.VersionId
  }
  /** The last value read, without waiting (undefined before the first read). */
  peek(id: string): string | undefined { return this.cache.get(id)?.value }
}
