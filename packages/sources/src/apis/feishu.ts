/**
 * Feishu/Lark OpenAPI client with the tenant bot's `tenant_access_token`, replacing DSH's `lark-cli --as bot` calls.
 * Only the bot identity exists here: there is no user token, as DSH's strict-mode check required.
 */
import { z } from 'zod'
import { feishuOpenApiBase, type FeishuDomain } from '@dshsa/contracts'
import { FeishuError, type FeishuApi } from '@dshsa/core/host'
import type { Fetch } from './github.ts'
import { absent } from '../feishu/wire.ts'

const TokenSchema = z.object({ code: z.number(), msg: absent(z.string()), tenant_access_token: absent(z.string()), expire: absent(z.number()) })
/** `msg` may be null on success; a null `data` falls back to the payload beside `code`, as for an absent one. */
const Envelope = z.looseObject({ code: z.number(), msg: absent(z.string()), data: z.unknown().optional() })
/** Codes that mean the access token is stale; the call is retried once with a fresh token. */
const STALE_TOKEN = new Set([99991661, 99991663, 99991668])
/** Feishu's "bot is not in the chat" code, rewritten with the remediation as DSH's `Commands.lark` did. */
const NOT_IN_CHAT = 232011

export interface FeishuCredentials { domain: FeishuDomain; appId: string; appSecret: string }
/** A downloaded message resource (image or file). */
export interface FeishuDownload { data: Buffer; contentType: string }

export class FeishuClient implements FeishuApi {
  private token: { value: string; expiresAt: number } | undefined
  private pending: Promise<string> | undefined
  readonly base: string
  constructor(private readonly credentials: FeishuCredentials, private readonly fetcher: Fetch = fetch, private readonly now: () => number = Date.now) {
    this.base = feishuOpenApiBase(credentials.domain)
  }
  /** The tenant access token, refreshed 5 minutes before it expires (Feishu tokens last 2 hours). */
  async accessToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt - this.now() > 5 * 60_000) return this.token.value
    this.pending ??= this.mint().finally(() => { this.pending = undefined })
    return this.pending
  }
  private async mint(): Promise<string> {
    const response = await this.fetcher(`${this.base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: this.credentials.appId, app_secret: this.credentials.appSecret }),
    })
    const result = TokenSchema.parse(await response.json())
    if (result.code !== 0 || !result.tenant_access_token) throw new FeishuError(`Feishu token: ${result.msg ?? 'failed'} (${result.code})`, result.code)
    this.token = { value: result.tenant_access_token, expiresAt: this.now() + (result.expire ?? 7200) * 1000 }
    return this.token.value
  }
  private url(path: string, params?: Record<string, string>): string {
    if (!path.startsWith('/open-apis/') || path.includes('..')) throw new Error('Feishu calls are restricted to /open-apis/')
    const query = params && Object.keys(params).length ? `?${new URLSearchParams(params)}` : ''
    return `${this.base}${path}${query}`
  }
  async request<T>(schema: z.ZodType<T>, method: string, path: string, init: { params?: Record<string, string>; data?: unknown } = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetcher(this.url(path, init.params), {
        method, headers: { authorization: `Bearer ${await this.accessToken(attempt > 0)}`, 'content-type': 'application/json; charset=utf-8' },
        ...init.data !== undefined ? { body: JSON.stringify(init.data) } : {},
      })
      const text = await response.text()
      let parsed: z.infer<typeof Envelope>
      try { parsed = Envelope.parse(JSON.parse(text)) }
      catch { throw new FeishuError(`Feishu ${method} ${path}: HTTP ${response.status}`, response.status) }
      // Most endpoints answer under `data`; a few (such as `bot/v3/info`) put their payload beside `code`.
      if (parsed.code === 0) { const { code: _code, msg: _msg, data, ...rest } = parsed; return schema.parse(data ?? rest) }
      if (STALE_TOKEN.has(parsed.code) && attempt === 0) continue
      if (parsed.code === NOT_IN_CHAT) throw new FeishuError('The Feishu bot is not a member of the chat. Add the bot in the chat settings, then retry.', parsed.code)
      throw new FeishuError(`${parsed.msg ?? 'Feishu request failed'} (${parsed.code})`, parsed.code)
    }
  }
  /** Downloads a resource of a message, such as `im/v1/messages/<id>/resources/<key>?type=image`. */
  async download(path: string, params?: Record<string, string>, maxBytes = 10 * 1024 * 1024): Promise<FeishuDownload> {
    const response = await this.fetcher(this.url(path, params), { headers: { authorization: `Bearer ${await this.accessToken()}` } })
    const contentType = response.headers.get('content-type') ?? ''
    if (!response.ok || contentType.includes('application/json')) {
      const body = await response.text()
      const parsed = Envelope.safeParse((() => { try { return JSON.parse(body) } catch { return {} } })())
      const code = parsed.success ? parsed.data.code : response.status
      throw new FeishuError(`Feishu download: ${parsed.success ? parsed.data.msg ?? '' : ''} (${code})`, code)
    }
    const data = Buffer.from(await response.arrayBuffer())
    if (data.length > maxBytes) throw new Error('The Feishu resource exceeds the size limit')
    return { data, contentType }
  }
}
/** The bot's own identity (`open_id`, name), which mention detection and the agent's own-message check need. */
export async function feishuBotInfo(api: FeishuApi): Promise<{ openId: string; name: string }> {
  const result = await api.request(z.looseObject({ bot: absent(z.looseObject({ open_id: z.string(), app_name: absent(z.string()) })) }),
    'GET', '/open-apis/bot/v3/info')
  if (!result.bot) throw new Error('Feishu returned no bot information; enable the bot capability of the app')
  return { openId: result.bot.open_id, name: result.bot.app_name ?? '' }
}
