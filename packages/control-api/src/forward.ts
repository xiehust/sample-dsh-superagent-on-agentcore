/** Forwarding a panel request to the cell's lease owner over host internal HTTP (design §4.7). */
import { InternalApiCallerHeader, InternalApiTargetHeader, Lease, type LeaseRecord, type PanelRole, PanelRoleHeader } from '@dshsa/contracts'

export const ACTOR_HEADER = 'x-dshsa-actor'
export const FORWARD_TIMEOUT_MS = 10_000

export interface ForwardRequest { method: string; url: string; headers: Record<string, string>; body?: string }
export interface ForwardResponse { status: number; body: string; contentType?: string }
export type Forwarder = (req: ForwardRequest) => Promise<ForwardResponse>

/**
 * The owner's endpoint while the lease is live; `undefined` means the cell is unavailable (no owner, expired, no endpoint).
 * A lease inside the holder's stop window (`Lease.stopBeforeExpiryMs`, parent design §4.2) counts as expired: a holder that
 * failed to renew has already stopped the cell by then, while a healthy holder renews long before it.
 */
export function liveEndpoint(lease: LeaseRecord | undefined, now: number): string | undefined {
  if (!lease?.endpoint || lease.expiresAt - Lease.stopBeforeExpiryMs <= now) return undefined
  let url: URL
  try { url = new URL(lease.endpoint) } catch { return undefined }
  // Lease endpoints are private task IPs written by the host; refuse anything that is not plain http, or that carries
  // credentials, a path, a query or a fragment.
  if (url.protocol !== 'http:' || url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    return undefined
  }
  return url.origin
}

export const encodeActor = (actor: { sub: string; email?: string }): string =>
  Buffer.from(JSON.stringify({ sub: actor.sub, email: actor.email }), 'utf8').toString('base64url')

/**
 * `caller` is the presigned STS proof for `target` (contracts v3 §4.7: a cellId, or `tenant:<t>` for host tenant routes); the
 * host replays it with the same target header. `role` (contracts v6) is derived from verified claims; the cell re-checks it.
 */
export function forwardHeaders(caller: string, target: string, actor: { sub: string; email?: string }, hasBody: boolean, role: PanelRole = 'member'): Record<string, string> {
  return {
    [InternalApiCallerHeader]: caller, [InternalApiTargetHeader]: target, [ACTOR_HEADER]: encodeActor(actor), [PanelRoleHeader]: role,
    'x-orchestrator-request': '1', accept: 'application/json',
    ...(hasBody ? { 'content-type': 'application/json' } : {}),
  }
}

export const fetchForwarder: Forwarder = async req => {
  const res = await fetch(req.url, {
    method: req.method, headers: req.headers, body: req.body, redirect: 'error', signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
  })
  return { status: res.status, body: await res.text(), contentType: res.headers.get('content-type') ?? undefined }
}
