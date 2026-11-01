/** API Gateway HTTP API (payload v2) plumbing shared by the three panel Lambdas (panel-api, panel-tenant, panel-platform). */

/** The subset of an API Gateway HTTP API (payload v2) event the panel Lambdas read. */
export interface HttpEvent {
  rawPath: string
  rawQueryString?: string
  body?: string
  isBase64Encoded?: boolean
  headers?: Record<string, string | undefined>
  requestContext: { http: { method: string }; authorizer?: { jwt?: { claims?: Record<string, unknown> } } }
}
export interface HttpResult { statusCode: number; headers: Record<string, string>; body: string }

export const MAX_BODY_BYTES = 128 * 1024
export const HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
export const json = (statusCode: number, value: unknown): HttpResult => ({ statusCode, headers: HEADERS, body: JSON.stringify(value) })
export const error = (statusCode: number, code: string, message: string): HttpResult => json(statusCode, { error: code, message })
export const forbidden = (): HttpResult => error(403, 'forbidden', 'You do not have access to this resource')
export const notFound = (): HttpResult => error(404, 'not_found', 'Not found')

/** The request body as text: `undefined` when absent, `null` when over the limit. */
export function requestBody(event: HttpEvent): string | undefined | null {
  if (event.body === undefined || event.body === '') return undefined
  const text = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body
  return Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES ? null : text
}

/** The JSON body parsed with `schema`; a result (400/413) instead when absent, too large, not JSON or invalid. */
export function parseBody<T>(event: HttpEvent, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }):
  { ok: true; value: T } | { ok: false; result: HttpResult } {
  const raw = requestBody(event)
  if (raw === null) return { ok: false, result: error(413, 'too_large', 'Request body too large') }
  let value: unknown
  try { value = JSON.parse(raw ?? '') } catch { return { ok: false, result: error(400, 'bad_request', 'Body must be JSON') } }
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { ok: false, result: error(400, 'bad_request', issue ? `${issue.path.map(String).join('.') || 'body'}: ${issue.message}` : 'Invalid body') }
  }
  return { ok: true, value: parsed.data }
}

export function decode(segment: string): string {
  try { return decodeURIComponent(segment) } catch { return '' }
}
/** Path segments after the leading slash, percent-decoded (an undecodable segment becomes ''). */
export const segments = (rawPath: string): string[] => rawPath.replace(/^\/+/, '').split('/').map(decode)
export const query = (event: HttpEvent): URLSearchParams => new URLSearchParams(event.rawQueryString ?? '')
