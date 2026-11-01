/**
 * Internal HTTP caller authentication (parent design §4.7, contracts v3): the caller sends a presigned
 * `sts:GetCallerIdentity` URL that signs `x-dshsa-target: <cellId>`; the host replays it against the regional STS endpoint
 * with that header and accepts the request only when STS answers with an allowed role (the Vault / aws-iam-authenticator
 * scheme). Nothing about the caller is taken from the request except what STS confirms.
 */
import { createHash } from 'node:crypto'
import { InternalApiCallerTtlSec, InternalApiTargetHeader } from '@dshsa/contracts'

/** `api`: panel-api on `/{cellId}/api/*`; `worker`: worker-api on `/{cellId}/worker/*`; `tenant`: panel-tenant on `/tenants/*` (v6). */
export type CallerArea = 'api' | 'worker' | 'tenant'
export interface CallerPolicy {
  region: string
  /** The account the callers' roles belong to; an ARN from another account is refused. */
  account?: string
  /** IAM role name allowed per area, e.g. panel-api for `api`, worker-api for `worker`, panel-tenant for `tenant`. */
  roles: Record<CallerArea, string>
}
export class CallerRefused extends Error {}
type Fetch = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

/** Checks a presigned URL's shape before anything is sent: regional STS host, exactly GetCallerIdentity, short-lived, target signed. */
export function checkPresigned(raw: string, region: string, now = Date.now()): { url: URL; expiresAt: number } {
  let url: URL
  try { url = new URL(raw) } catch { throw new CallerRefused('caller is not a URL') }
  if (url.protocol !== 'https:' || url.host !== `sts.${region}.amazonaws.com` || url.pathname !== '/' || url.username || url.password || url.hash) {
    throw new CallerRefused('caller is not the regional STS endpoint')
  }
  const query = url.searchParams
  const single = (name: string) => { const values = query.getAll(name); if (values.length !== 1) throw new CallerRefused(`${name} must appear once`); return values[0]! }
  if (single('Action') !== 'GetCallerIdentity' || single('Version') !== '2011-06-15') throw new CallerRefused('caller is not GetCallerIdentity')
  if (single('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256') throw new CallerRefused('caller is not SigV4')
  const expires = Number(single('X-Amz-Expires'))
  if (!Number.isInteger(expires) || expires <= 0 || expires > InternalApiCallerTtlSec) throw new CallerRefused('caller expiry out of range')
  const signed = single('X-Amz-SignedHeaders').split(';')
  if (!signed.includes(InternalApiTargetHeader) || !signed.includes('host')) throw new CallerRefused(`caller does not sign ${InternalApiTargetHeader}`)
  const date = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(single('X-Amz-Date'))
  if (!date) throw new CallerRefused('caller date malformed')
  const signedAt = Date.UTC(+date[1]!, +date[2]! - 1, +date[3]!, +date[4]!, +date[5]!, +date[6]!)
  const expiresAt = signedAt + expires * 1000
  // STS checks the signature and the expiry; this check only avoids sending a stale URL at all.
  if (now > expiresAt || signedAt - now > 60_000) throw new CallerRefused('caller expired')
  return { url, expiresAt }
}
/** `arn:aws:sts::<account>:assumed-role/<role>/<session>` → its parts, else undefined. */
export function assumedRole(arn: string): { account: string; role: string } | undefined {
  const match = /^arn:aws:sts::(\d{12}):assumed-role\/([\w+=,.@-]+)\/[\w+=,.@-]+$/.exec(arn)
  return match ? { account: match[1]!, role: match[2]! } : undefined
}

export class CallerVerifier {
  private readonly cache = new Map<string, { arn: string; expiresAt: number }>()
  constructor(private readonly policy: CallerPolicy, private readonly fetcher: Fetch = fetch as unknown as Fetch, private readonly now: () => number = Date.now) {}
  /**
   * The caller's ARN when `presigned` proves an allowed role for `area` of `target` (a cellId, or `tenant:<tenantId>` on
   * tenant routes, so a proof for one kind of resource never replays on the other); throws CallerRefused otherwise.
   */
  async verify(presigned: string | undefined, target: string, area: CallerArea): Promise<string> {
    const cellId = target
    if (!presigned) throw new CallerRefused('no caller')
    const { url, expiresAt } = checkPresigned(presigned, this.policy.region, this.now())
    // The target is part of the key: the same URL replayed against another cell must be verified (and refused) by STS again.
    const cacheKey = createHash('sha256').update(`${cellId}\n${presigned}`).digest('hex')
    let hit = this.cache.get(cacheKey)
    if (!hit || hit.expiresAt <= this.now()) {
      const response = await this.fetcher(url.href, { headers: { [InternalApiTargetHeader]: cellId, accept: 'application/xml' }, signal: AbortSignal.timeout(5000) })
      const text = await response.text()
      if (!response.ok) throw new CallerRefused(`STS refused the caller (${response.status})`)
      const arn = /<Arn>([^<]+)<\/Arn>/.exec(text)?.[1]
      if (!arn) throw new CallerRefused('STS returned no Arn')
      hit = { arn, expiresAt }
      this.prune()
      this.cache.set(cacheKey, hit)
    }
    const role = assumedRole(hit.arn)
    if (!role || role.role !== this.policy.roles[area] || (this.policy.account && role.account !== this.policy.account)) {
      throw new CallerRefused(`${hit.arn} may not call ${area}`)
    }
    return hit.arn
  }
  private prune(): void {
    const now = this.now()
    for (const [key, value] of this.cache) if (value.expiresAt <= now) this.cache.delete(key)
  }
}
