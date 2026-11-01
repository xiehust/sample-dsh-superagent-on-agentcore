/**
 * panel-api (design §4.1): Cognito-authenticated (API Gateway JWT authorizer) panel backend. It authorizes every request
 * against the cell's tenant, then forwards allowlisted DSH routes to the cell's lease owner or serves platform data.
 */
import { CellId, type PanelRole, TenantId, leaseKey } from '@dshsa/contracts'
import { z } from 'zod'
import { type Principal, canAccessTenant, candidateTenantIds, principalFrom } from './authz.ts'
import { type Forwarder, forwardHeaders, liveEndpoint } from './forward.ts'
import { HEADERS, type HttpEvent, type HttpResult, decode, error, forbidden, json, requestBody } from './http.ts'
import type { Repo } from './repo.ts'
import { auditFor } from './audit.ts'
import { atLeast, roleIn } from './roles.ts'
import { canonicalCellPath, cellRouteRole, matchCellRoute } from './routes.ts'
import type { TranscriptStore } from './transcript.ts'

export { MAX_BODY_BYTES, type HttpEvent, type HttpResult } from './http.ts'

export interface Deps {
  repo: Repo
  forward: Forwarder
  /** Presigned sts:GetCallerIdentity proof of the panel-api role for `cellId` (contracts v3 §4.7). */
  callerProof(cellId: string): Promise<string>
  transcripts: TranscriptStore
  now(): number
  log?(entry: Record<string, unknown>): void
}

const ChatId = z.string().regex(/^oc_[A-Za-z0-9]{1,64}$/)
const BindingBody = z.object({ cellId: CellId, chatName: z.string().max(200).optional() }).strict()

export async function handle(event: HttpEvent, deps: Deps): Promise<HttpResult> {
  const principal = principalFrom(event.requestContext.authorizer?.jwt?.claims)
  // The authorizer already rejects anonymous calls; this guards a misconfigured route (fail closed).
  if (!principal) return error(401, 'unauthorized', 'Sign in required')
  const method = event.requestContext.http.method.toUpperCase()
  const segments = event.rawPath.replace(/^\/+/, '').split('/')
  try {
    if (segments[0] !== 'v1') return error(404, 'not_found', 'Not found')
    const [, a, b, c, ...rest] = segments.map(s => s ?? '')

    if (a === 'me' && segments.length === 2 && method === 'GET') return json(200, await me(principal, deps))
    if (a === 'cells' && segments.length === 2 && method === 'GET') return json(200, { cells: await cells(principal, deps) })

    if (a === 'cells' && b) {
      const cellId = decode(b)
      const cell = CellId.safeParse(cellId).success ? await deps.repo.getCell(cellId) : undefined
      // An unknown cell and a cell of another tenant look the same to non-admins: 403, existence is not revealed.
      const tenant = cell ? await deps.repo.getTenant(cell.tenantId) : undefined
      if (!cell || !canAccessTenant(principal, tenant) || cell.tenantId !== tenant.tenantId) {
        return cell || !principal.platformAdmin ? forbidden() : error(404, 'not_found', 'No such cell')
      }
      const role = roleIn(principal, tenant)!
      if (c === 'api' && rest.length) return await forwardToCell(event, method, cellId, rest.join('/'), principal, role, deps)
      if (c === 'tickets' && rest.length === 2 && rest[1] === 'transcript' && method === 'GET') {
        const ticketId = decode(rest[0]!)
        if (!ticketId || ticketId.length > 200) return error(400, 'bad_request', 'Invalid ticket id')
        const transcript = await deps.transcripts.read(cell.tenantId, cellId, ticketId)
        return transcript ? json(200, transcript) : error(404, 'not_found', 'No transcript yet')
      }
      return error(404, 'not_found', 'Not found')
    }

    if (a === 'tenants' && b && c === 'chat-bindings') {
      const tenantId = decode(b)
      const tenant = TenantId.safeParse(tenantId).success ? await deps.repo.getTenant(tenantId) : undefined
      if (!canAccessTenant(principal, tenant)) return forbidden()
      // Reading bindings is member-level; binding/unbinding a chat is a tenant-admin action (onboarding design §1).
      const role = roleIn(principal, tenant)!
      if (method !== 'GET' && !atLeast(role, 'tadmin')) return forbidden()
      const res = await chatBindings(event, method, tenant.tenantId, rest, principal, deps)
      // R7: every mutation leaves one audit line (AuditEntry shape) in this Lambda's log.
      if (method !== 'GET') {
        auditFor(principal, role, line => deps.log?.(JSON.parse(line) as Record<string, unknown>), deps.now)({
          op: method === 'DELETE' ? 'panel.chat.unbind' : 'panel.chat.bind', tenantId: tenant.tenantId, target: decode(rest[0] ?? ''),
          ok: res.statusCode < 400, ...(res.statusCode >= 400 ? { error: `HTTP ${res.statusCode}` } : {}),
        })
      }
      return res
    }
    return error(404, 'not_found', 'Not found')
  } catch (cause) {
    deps.log?.({ level: 'error', msg: 'panel-api failure', path: event.rawPath, error: String(cause) })
    return error(500, 'internal', 'Internal error')
  }
}

async function me(principal: Principal, deps: Deps) {
  const tenants = await accessibleTenants(principal, deps)
  return {
    sub: principal.sub, email: principal.email, platformAdmin: principal.platformAdmin,
    tenants: tenants.map(t => ({ tenantId: t.tenantId, name: t.name, role: roleIn(principal, t)! })),
  }
}

async function accessibleTenants(principal: Principal, deps: Deps) {
  const tenants = principal.platformAdmin
    ? await deps.repo.listTenants()
    : await Promise.all(candidateTenantIds(principal).filter(id => TenantId.safeParse(id).success).map(id => deps.repo.getTenant(id)))
  return tenants.filter(t => canAccessTenant(principal, t))
}

async function cells(principal: Principal, deps: Deps) {
  const tenants = await accessibleTenants(principal, deps)
  const lists = await Promise.all(tenants.map(t => deps.repo.listCellsByTenant(t.tenantId)))
  return lists.flat().map(c => ({
    cellId: c.cellId, tenantId: c.tenantId, status: c.status,
    repo: { owner: c.repo.owner, name: c.repo.name, defaultBranch: c.repo.defaultBranch },
  }))
}

async function forwardToCell(event: HttpEvent, method: string, cellId: string, rawRoute: string, principal: Principal, role: PanelRole, deps: Deps) {
  const route = canonicalCellPath(rawRoute)
  const matched = route === undefined ? undefined : matchCellRoute(method, route)
  if (route === undefined || !matched) return error(404, 'unknown_route', 'Unknown route')
  // Members read and Stop/Retry only (onboarding design §1); the cell enforces the same from `x-dshsa-role`.
  if (!atLeast(role, cellRouteRole(matched))) return forbidden()
  const body = requestBody(event)
  if (body === null) return error(413, 'too_large', 'Request body too large')
  if (body !== undefined && method === 'GET') return error(400, 'bad_request', 'GET requests take no body')
  const endpoint = liveEndpoint(await deps.repo.getLease(leaseKey.cell(cellId)), deps.now())
  if (!endpoint) return error(503, 'cell_unavailable', 'The cell is not running right now; try again shortly')
  const query = event.rawQueryString ? `?${event.rawQueryString}` : ''
  try {
    const res = await deps.forward({
      method, url: `${endpoint}/${encodeURIComponent(cellId)}/api/${route}${query}`,
      headers: forwardHeaders(await deps.callerProof(cellId), cellId, principal, body !== undefined, role), body,
    })
    if (res.status === 401) {
      // The host refused the caller proof (STS replay failed or the role is not allowed). Passing 401 through would make the
      // panel restart its login in a loop, so the user sees the cell as unavailable and operators get an error log.
      deps.log?.({ level: 'error', msg: 'internal_auth_rejected', cellId, route: `${method} ${route}`, sub: principal.sub })
      return error(503, 'cell_unavailable', 'The cell did not accept the request; try again shortly')
    }
    deps.log?.({ level: 'info', msg: 'forward', cellId, route: `${method} ${route}`, status: res.status, sub: principal.sub })
    return { statusCode: res.status, headers: { ...HEADERS, 'content-type': res.contentType ?? HEADERS['content-type'] }, body: res.body }
  } catch (cause) {
    deps.log?.({ level: 'warn', msg: 'forward failed', cellId, error: String(cause) })
    return error(503, 'cell_unavailable', 'The cell did not answer; try again shortly')
  }
}

async function chatBindings(event: HttpEvent, method: string, tenantId: string, rest: string[], principal: Principal, deps: Deps) {
  if (rest.length === 0 && method === 'GET') return json(200, { bindings: await deps.repo.listChatBindings(tenantId) })
  if (rest.length !== 1) return error(404, 'not_found', 'Not found')
  const chatId = decode(rest[0]!)
  if (!ChatId.safeParse(chatId).success) return error(400, 'bad_request', 'Invalid Feishu chat id (oc_…)')
  if (method === 'DELETE') {
    return await deps.repo.deleteChatBinding(tenantId, chatId) ? json(200, { removed: true }) : error(404, 'not_found', 'No such binding')
  }
  if (method !== 'PUT') return error(404, 'not_found', 'Not found')
  const raw = requestBody(event)
  if (raw === null) return error(413, 'too_large', 'Request body too large')
  let parsed: z.infer<typeof BindingBody>
  try { parsed = BindingBody.parse(JSON.parse(raw ?? '')) } catch { return error(400, 'bad_request', 'Body must be {cellId, chatName?}') }
  const cell = await deps.repo.getCell(parsed.cellId)
  if (!cell || cell.tenantId !== tenantId) return error(400, 'bad_request', 'cellId is not a cell of this tenant')
  const binding = { tenantId, chatId, cellId: cell.cellId, chatName: parsed.chatName, updatedAt: new Date(deps.now()).toISOString(), updatedBy: principal.email ?? principal.sub }
  await deps.repo.putChatBinding(binding)
  return json(200, { binding })
}
