/**
 * panel-platform (onboarding design §1–§2): `/v1/admin/**` for platform admins only. Tenants, users of every role, the
 * GitHub App (slug read from GitHub), installation claim release. Every mutation is audited; secrets are write-only.
 */
import { type CellRecord, type InstallationClaim, TenantId, type TenantRecord } from '@dshsa/contracts'
import { z } from 'zod'
import type * as ops from '../admin/ops.ts'
import { AdminError } from '../admin/ops.ts'
import { type Audit, type AuditSink, auditFor } from '../audit.ts'
import { type Principal, principalFrom } from '../authz.ts'
import { type HttpEvent, type HttpResult, error, forbidden, json, notFound, parseBody, query, segments } from '../http.ts'
import { cellsUsing, inUse } from './claims.ts'

export interface PlatformOps {
  tenantList(): Promise<TenantRecord[]>
  tenantAdd(tenantId: string, name: string): Promise<TenantRecord>
  tenantSetStatus(tenantId: string, status: 'active' | 'disabled'): Promise<void>
  tenantUsers(tenantId: string): Promise<ops.DirectoryUser[]>
  platformAdmins(): Promise<ops.DirectoryUser[]>
  userInvite(email: string, tenantId: string, role: 'member' | 'tadmin'): Promise<void>
  userAddAdmin(email: string): Promise<void>
  userRemove(email: string, tenantId: string): Promise<void>
  adminRemove(email: string): Promise<void>
  githubAppSet(input: ops.GithubAppInput): Promise<{ slug: string }>
  githubOauthSet(input: { clientId?: string; clientSecret?: string }): Promise<void>
  githubAppStatus(): Promise<ops.GithubAppStatus>
  /** Conditional on `tenantId` when given (the claim read just before still belongs to it). */
  releaseClaim(installationId: number, tenantId?: string): Promise<boolean>
  getClaim(installationId: number): Promise<InstallationClaim | undefined>
  listPendingClaims(): Promise<InstallationClaim[]>
  listAllClaims(): Promise<InstallationClaim[]>
  /** Read only: the release in-use check never changes a cell. */
  tenantCells(tenantId: string): Promise<CellRecord[]>
  approveClaim(installationId: number, approvedBy: string, approvedAt: string): Promise<boolean>
}
export interface PlatformDeps { ops: PlatformOps; panelUrl: string; now(): number; audit: AuditSink; log?(entry: Record<string, unknown>): void }

const Email = z.string().regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/).max(254)
const TenantBody = z.object({ tenantId: TenantId, name: z.string().min(1).max(100) }).strict()
const InviteBody = z.discriminatedUnion('role', [
  z.object({ email: Email, role: z.literal('admin') }).strict(),
  z.object({ email: Email, role: z.enum(['member', 'tadmin']), tenantId: TenantId }).strict(),
])
const AppBody = z.object({
  appId: z.string().regex(/^\d+$/).optional(),
  privateKey: z.string().includes('PRIVATE KEY').max(10_000).optional(),
  webhookSecret: z.string().min(20).max(200).optional(),
  // Same formats ops.githubOauthSet enforces, checked up front so a bad OAuth field never follows an already-written App key.
  clientId: z.string().regex(/^(Iv|lv)[0-9A-Za-z.]{6,40}$/, 'the OAuth client id looks like Iv23li…').optional(),
  clientSecret: z.string().regex(/^[0-9a-f]{40}$/, 'the OAuth client secret is 40 hex characters').optional(),
}).strict().refine(b => !b.privateKey || b.appId, { message: 'appId is required with privateKey', path: ['appId'] })

async function mutate(audit: Audit, op: string, tenantId: string | undefined, target: string | undefined, run: () => Promise<HttpResult>): Promise<HttpResult> {
  try {
    const result = await run()
    audit({ op, tenantId, target, ok: result.statusCode < 400, ...(result.statusCode >= 400 ? { error: `HTTP ${result.statusCode}` } : {}) })
    return result
  } catch (e) {
    audit({ op, tenantId, target, ok: false, error: e instanceof AdminError ? e.message : (e as { name?: string }).name ?? 'error' })
    if (e instanceof AdminError) return error(400, 'bad_request', e.message)
    throw e
  }
}

export async function handlePlatform(event: HttpEvent, deps: PlatformDeps): Promise<HttpResult> {
  const principal = principalFrom(event.requestContext.authorizer?.jwt?.claims)
  if (!principal) return error(401, 'unauthorized', 'Sign in required')
  const [v1, admin, ...rest] = segments(event.rawPath)
  if (v1 !== 'v1' || admin !== 'admin') return notFound()
  if (!principal.platformAdmin) return forbidden()
  const method = event.requestContext.http.method.toUpperCase()
  try {
    return await route({ event, method, rest, principal, deps, audit: auditFor(principal, 'admin', deps.audit, deps.now) })
  } catch (cause) {
    // A read that names an unknown tenant (e.g. GET /users?tenant=x) surfaces as an AdminError: a client error, not a 500.
    if (cause instanceof AdminError) return error(400, 'bad_request', cause.message)
    deps.log?.({ level: 'error', msg: 'panel-platform failure', path: event.rawPath, error: String(cause) })
    return error(500, 'internal', 'Internal error')
  }
}

interface Ctx { event: HttpEvent; method: string; rest: string[]; principal: Principal; deps: PlatformDeps; audit: Audit }

async function route(x: Ctx): Promise<HttpResult> {
  const { method, rest: [a, b, c, ...more], deps: { ops } } = x
  if (more.length) return notFound()
  if (a === 'tenants') {
    if (!b && method === 'GET') return json(200, { tenants: await ops.tenantList() })
    if (!b && method === 'POST') {
      const body = parseBody(x.event, TenantBody)
      if (!body.ok) return body.result
      return mutate(x.audit, 'admin.tenant.add', body.value.tenantId, body.value.name, async () =>
        json(200, { tenant: await ops.tenantAdd(body.value.tenantId, body.value.name) }))
    }
    if (b && (c === 'disable' || c === 'enable') && method === 'POST') {
      if (!TenantId.safeParse(b).success) return error(400, 'bad_request', 'Invalid tenant id')
      return mutate(x.audit, `admin.tenant.${c}`, b, b, async () => {
        await ops.tenantSetStatus(b, c === 'disable' ? 'disabled' : 'active')
        return json(200, { tenantId: b, status: c === 'disable' ? 'disabled' : 'active' })
      })
    }
  }
  if (a === 'users') {
    const q = query(x.event)
    const tenantId = q.get('tenant') ?? undefined
    if (tenantId !== undefined && !TenantId.safeParse(tenantId).success) return error(400, 'bad_request', 'Invalid tenant id')
    if (!b && method === 'GET') return json(200, { users: tenantId ? await ops.tenantUsers(tenantId) : await ops.platformAdmins() })
    if (!b && method === 'POST') {
      const body = parseBody(x.event, InviteBody)
      if (!body.ok) return body.result
      const v = body.value
      return mutate(x.audit, 'admin.user.invite', v.role === 'admin' ? undefined : v.tenantId, `${v.email}:${v.role}`, async () => {
        if (v.role === 'admin') await ops.userAddAdmin(v.email); else await ops.userInvite(v.email, v.tenantId, v.role)
        return json(200, { email: v.email, role: v.role })
      })
    }
    if (b && !c && method === 'DELETE') {
      if (!Email.safeParse(b).success) return error(400, 'bad_request', 'Invalid email')
      if (!tenantId) {
        if (x.principal.email && b.toLowerCase() === x.principal.email.toLowerCase()) return error(400, 'bad_request', 'You cannot remove your own platform admin role')
        return mutate(x.audit, 'admin.user.remove-admin', undefined, b, async () => { await ops.adminRemove(b); return json(200, { removed: true }) })
      }
      return mutate(x.audit, 'admin.user.remove', tenantId, b, async () => { await ops.userRemove(b, tenantId); return json(200, { removed: true }) })
    }
  }
  if (a === 'github-app' && !b) {
    if (method === 'GET') return json(200, await appStatus(x))
    if (method === 'PUT') return appSet(x)
  }
  if (a === 'installations') {
    // v6.2: claims a tenant admin could not prove control of wait here; approve → active, reject (DELETE) → released.
    // Every claim (active too) is listed so a platform admin can release one linked to the wrong team.
    if (!b && method === 'GET') {
      const status = query(x.event).get('status') ?? 'all'
      if (status !== 'pending' && status !== 'all') return error(400, 'bad_request', 'status is pending or all')
      const [claims, tenants] = await Promise.all([status === 'pending' ? ops.listPendingClaims() : ops.listAllClaims(), ops.tenantList()])
      const names = new Map(tenants.map(t => [t.tenantId, t.name]))
      return json(200, { installations: claims.map(c => ({ ...c, tenantName: names.get(c.tenantId) })) })
    }
    const id = Number(b)
    if (b && (!Number.isSafeInteger(id) || id <= 0)) return error(400, 'bad_request', 'Invalid installation id')
    if (b && c === 'approve' && method === 'POST') {
      return mutate(x.audit, 'admin.installation.approve', undefined, b, async () =>
        await ops.approveClaim(id, x.principal.email ?? x.principal.sub, new Date(x.deps.now()).toISOString())
          ? json(200, { installationId: id, status: 'active' }) : error(404, 'not_found', 'No pending claim for this installation'))
    }
    if (b && !c && method === 'DELETE') return release(x, id)
  }
  return notFound()
}

/**
 * Releases any claim (reject a pending one, or unlink an active one). Refused with 409 while cells of the claim's team still
 * use the installation, unless `?force=true`: then the claim goes and the response names the affected cells, which are left
 * as they are (never disabled or deleted here).
 */
async function release(x: Ctx, id: number): Promise<HttpResult> {
  const force = query(x.event).get('force')
  if (force !== null && force !== 'true') return error(400, 'bad_request', 'force is true or absent')
  const claim = await x.deps.ops.getClaim(id)
  return mutate(x.audit, 'admin.installation.release', claim?.tenantId, force ? `${id}:force` : String(id), async () => {
    if (!claim) return error(404, 'not_found', 'No such claim')
    const using = cellsUsing(await x.deps.ops.tenantCells(claim.tenantId), id)
    if (using.length && !force) return inUse(using)
    return await x.deps.ops.releaseClaim(id, claim.tenantId)
      ? json(200, { released: true, installationId: id, tenantId: claim.tenantId, affectedCells: using })
      : error(409, 'claim_changed', 'The claim changed meanwhile; reload and try again')
  })
}

/** The GitHub App settings a platform admin must enter once (design §3 "Needs from the platform admin"). */
const checklist = (panelUrl: string) => ({
  setupUrl: `${panelUrl}/setup/github`, callbackUrl: `${panelUrl}/setup/github/callback`, redirectOnUpdate: true,
  // v6.2: the claim check reads the user's org membership (GET /user/memberships/orgs/{org}).
  permissions: ['Organization permissions → Members: Read-only'],
})

async function appStatus(x: Ctx) {
  return { ...await x.deps.ops.githubAppStatus(), checklist: checklist(x.deps.panelUrl) }
}

async function appSet(x: Ctx): Promise<HttpResult> {
  const body = parseBody(x.event, AppBody)
  if (!body.ok) return body.result
  const v = body.value
  const parts = [v.privateKey && 'key', v.webhookSecret && 'webhook', v.clientId && 'client-id', v.clientSecret && 'client-secret'].filter(Boolean).join(',')
  if (!parts) return error(400, 'bad_request', 'Nothing to change')
  return mutate(x.audit, 'admin.github-app.set', undefined, `${v.appId ?? ''}:${parts}`, async () => {
    if (v.privateKey) await x.deps.ops.githubAppSet({ appId: v.appId!, privateKey: v.privateKey, webhookSecret: v.webhookSecret })
    else if (v.webhookSecret) return error(400, 'bad_request', 'Changing the webhook secret needs the App ID and private key too')
    if (v.clientId || v.clientSecret) await x.deps.ops.githubOauthSet({ clientId: v.clientId, clientSecret: v.clientSecret })
    return json(200, await appStatus(x))
  })
}
