/**
 * The GitHub webhook endpoint's logic, independent of AWS clients (see `handler.ts` for the Lambda wiring).
 * GitHub is the only caller and authenticates with its HMAC signature; everything is refused until that verifies, and an
 * unreadable secret refuses every request (fail closed).
 */
import { createHash } from 'node:crypto'
import { CellEnvelope, envelopeId, routeKey } from '@dshsa/contracts'
import { GITHUB_EVENTS, payloadNumber } from '../github/webhook.ts'
import { verifySignature } from './verify.ts'

export interface HttpEvent {
  headers?: Record<string, string | undefined>
  body?: string | null
  isBase64Encoded?: boolean
  requestContext?: { http?: { method?: string }; requestId?: string }
}
export interface HttpResult { statusCode: number; headers: Record<string, string>; body: string }
export interface Route { cellId: string; queueUrl: string; status: string }
export interface WebhookDeps {
  /** The current webhook secret; `fresh` bypasses any cache (after a mismatch, to follow a rotation). Throws when unreadable. */
  secret(fresh?: boolean): Promise<string>
  /** The cell bound to `gh#<installation>#<repo>`, or undefined. */
  route(key: string): Promise<Route | undefined>
  send(queueUrl: string, envelope: CellEnvelope): Promise<void>
  log(message: string, data: Record<string, unknown>): void
  now?: () => Date
}
/** Bodies above this are refused; GitHub caps payloads at 25 MB, API Gateway HTTP APIs at 10 MB. */
export const MAX_BODY = 5 * 1024 * 1024
/** Envelopes above this carry a slim payload; the cell re-reads the Issue/PR (SQS allows 256 KiB per message). */
export const MAX_ENVELOPE = 240 * 1024
/** Error codes of the gate's own refusals; a deploy-time check requires one of them, so a denial is identifiably the gate's. */
export const GATE_ERRORS = ['signature_required', 'bad_signature', 'unavailable'] as const
const reply = (statusCode: number, body: Record<string, unknown>): HttpResult =>
  ({ statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) })
const header = (event: HttpEvent, name: string): string | undefined => {
  const headers = event.headers ?? {}
  return headers[name] ?? Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1]
}
const Events = new Set<string>(GITHUB_EVENTS)
interface Ids { installation?: number; repository?: number; repositoryName?: string; action?: string }
function ids(payload: unknown): Ids {
  const value = (payload ?? {}) as { installation?: { id?: unknown }; repository?: { id?: unknown; full_name?: unknown }; action?: unknown }
  return { ...typeof value.installation?.id === 'number' ? { installation: value.installation.id } : {},
    ...typeof value.repository?.id === 'number' ? { repository: value.repository.id } : {},
    ...typeof value.repository?.full_name === 'string' ? { repositoryName: value.repository.full_name } : {},
    ...typeof value.action === 'string' ? { action: value.action } : {} }
}
/** A payload the queue can carry: the original, or only what the cell needs to re-read it. */
export function slim(payload: unknown, size: number): unknown {
  if (size <= MAX_ENVELOPE) return payload
  const { installation, repository, action } = ids(payload)
  const number = payloadNumber(payload)
  return { dshsa: { truncated: true, ...number ? { number } : {} }, ...action ? { action } : {},
    installation: { id: installation }, repository: { id: repository } }
}

export async function handleWebhook(event: HttpEvent, deps: WebhookDeps): Promise<HttpResult> {
  if ((event.requestContext?.http?.method ?? 'POST') !== 'POST') return reply(405, { error: 'method_not_allowed' })
  const body = Buffer.from(event.body ?? '', event.isBase64Encoded ? 'base64' : 'utf8')
  if (body.length > MAX_BODY) return reply(413, { error: 'too_large' })
  const name = header(event, 'x-github-event'), delivery = header(event, 'x-github-delivery'), signature = header(event, 'x-hub-signature-256')
  // An unsigned request is anonymous: refused as an authentication failure before anything else is looked at.
  if (!signature) return reply(401, { error: 'signature_required' })
  let secret: string
  try { secret = await deps.secret() } catch (error) {
    deps.log('webhook.secret_unavailable', { delivery, error: String(error) })
    return reply(503, { error: 'unavailable' })
  }
  let verified = verifySignature(body, signature, secret)
  if (!verified) {
    // The secret may have rotated since it was cached.
    try { secret = await deps.secret(true) } catch { return reply(503, { error: 'unavailable' }) }
    verified = verifySignature(body, signature, secret)
  }
  if (!verified) { deps.log('webhook.bad_signature', { delivery, event: name }); return reply(401, { error: 'bad_signature' }) }
  if (!name || !delivery || !/^[A-Za-z0-9-]{1,100}$/.test(delivery)) return reply(400, { error: 'missing_headers' })
  if (name === 'ping') return reply(200, { ok: true })
  if (!Events.has(name)) return reply(202, { ignored: 'event' })
  let payload: unknown
  try { payload = JSON.parse(body.toString('utf8')) } catch { return reply(400, { error: 'not_json' }) }
  const { installation, repository, repositoryName, action } = ids(payload)
  const context = { delivery, event: name, action, installation, repository, repositoryName }
  if (installation === undefined || repository === undefined) { deps.log('webhook.no_repository', context); return reply(202, { ignored: 'no_repository' }) }
  const route = await deps.route(routeKey.github(installation, repository))
  if (!route) { deps.log('webhook.unrouted', context); return reply(202, { ignored: 'unrouted' }) }
  if (route.status !== 'active') { deps.log('webhook.cell_inactive', { ...context, cellId: route.cellId, status: route.status }); return reply(202, { ignored: 'cell_inactive' }) }
  const head = { v: 1 as const, id: envelopeId.source('github', delivery), cellId: route.cellId, type: 'source.event' as const,
    at: (deps.now?.() ?? new Date()).toISOString() }
  const full = { ...head, body: { source: 'github' as const, kind: name, deliveryId: delivery, payload } }
  const size = Buffer.byteLength(JSON.stringify(full))
  const envelope = CellEnvelope.parse(size > MAX_ENVELOPE ? { ...full, body: { ...full.body, payload: slim(payload, size) } } : full)
  try { await deps.send(route.queueUrl, envelope) } catch (error) {
    deps.log('webhook.enqueue_failed', { ...context, cellId: route.cellId, error: String(error) })
    // GitHub shows the failure and the delivery can be redelivered.
    return reply(500, { error: 'enqueue_failed' })
  }
  deps.log('webhook.enqueued', { ...context, cellId: route.cellId, slim: size > MAX_ENVELOPE })
  return reply(202, { queued: true })
}
/** FIFO dedup id: the envelope id fits SQS's 128-char limit already; hashed only if a future id did not. */
export const dedupId = (envelope: CellEnvelope): string =>
  envelope.id.length <= 128 ? envelope.id : createHash('sha256').update(envelope.id).digest('hex')
