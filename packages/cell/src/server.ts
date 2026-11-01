/**
 * Internal HTTP of the host task (parent design §4.7, contracts v3), VPC only: `/{cellId}/api/*` serves the DSH management
 * routes of a cell this task holds (panel-api), `/{cellId}/worker/token-refresh` and `/{cellId}/worker/read` serve worker-api,
 * and (v6) `/tenants/{t}/github/installations/{id}/repositories` serves panel-tenant on any task, whatever it holds.
 * Every request but `/healthz` must prove its caller's IAM role with a presigned `sts:GetCallerIdentity` URL in
 * `x-dshsa-caller` that signs `x-dshsa-target` (the cellId, or `tenant:<t>`) (CallerVerifier); the security group admits only
 * the panel-api SG (which panel-api and panel-tenant share) and the worker-api SG.
 *
 * Authorization inside `/{cellId}/api/*` (v6, design onboarding §1): panel-api forwards the role it derived from the user's
 * verified claims in `x-dshsa-role`. A missing or unknown value is `member`, who may read and Stop/Retry a ticket only.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { InternalApiCallerHeader, PanelRoleHeader, ReadRequest, TenantId, type Logger, type PanelRole } from '@dshsa/contracts'
import { z } from 'zod'
import { dispatch, json } from './app/http.ts'
import type { CellRuntime } from './cell.ts'
import { CallerRefused, type CallerArea } from './caller.ts'
import type { RepositoriesResult } from './installations.ts'

export interface ServedCells { get(cellId: string): CellRuntime | undefined; list(): string[] }
export interface InternalServerOptions {
  /** Verifies the caller for `area` of `cellId` (CallerVerifier); throws when it is not allowed. */
  verify(presigned: string | undefined, cellId: string, area: CallerArea): Promise<string>
  cells: ServedCells
  log: Logger
  /** v6 tenant routes; absent (404) where the host has no GitHub App access, such as local mode. */
  tenants?: TenantRoutes
}
export interface TenantRoutes {
  installationRepositories(tenantId: string, installationId: number): Promise<RepositoriesResult>
}
/** The role panel-api verified, failing closed: anything but `tadmin` or `admin` is `member`. */
export function roleOf(req: IncomingMessage): PanelRole {
  const raw = req.headers[PanelRoleHeader]
  return raw === 'tadmin' || raw === 'admin' ? raw : 'member'
}
/** Mutations a `member` may make (D1: read + ticket Stop/Retry); every other non-GET management route needs `tadmin` or `admin`. */
const MEMBER_MUTATIONS = [/^POST tickets\/[^/]+\/stop$/, /^POST tickets\/[^/]+\/retry$/]
export function memberMay(method: string, path: string): boolean {
  return method === 'GET' || MEMBER_MUTATIONS.some(rule => rule.test(`${method} ${path}`))
}
const INSTALLATION = /^[1-9]\d{0,18}$/
export const ActorHeader = 'x-dshsa-actor'
const CELL = /^[a-z][a-z0-9-]{2,30}--gh\d+$/
/** Ticket token claims as worker-api verified them (KMS signature, ticket storage active); the host re-checks their scope. */
const Claims = z.object({ sub: z.string(), tid: z.string(), cid: z.string(), tkt: z.string().min(1), asg: z.string().min(1), rsid: z.string() }).passthrough()

/** The panel user panel-api authenticated, as base64url JSON `{sub, email}`; recorded for audit, never trusted for authorization. */
export function actorOf(req: IncomingMessage): { sub: string; email?: string } | undefined {
  const raw = req.headers[ActorHeader]
  if (typeof raw !== 'string') return undefined
  try { return z.object({ sub: z.string().min(1), email: z.string().optional() }).parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))) }
  catch { return undefined }
}
async function body(req: IncomingMessage, max = 16 * 1024): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = []
  for await (const chunk of req) { size += chunk.length; if (size > max) throw new Error('body too large'); chunks.push(Buffer.from(chunk)) }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

export function handler(options: InternalServerOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://internal')
    if (url.pathname === '/healthz') { json(res, 200, { ok: true, cells: options.cells.list().length }); return }
    if (url.pathname.startsWith('/tenants/')) { await tenantRoute(options, req, res, url); return }
    const [, cellId = '', area, ...rest] = url.pathname.split('/')
    if (!CELL.test(cellId) || (area !== 'api' && area !== 'worker')) { json(res, 404, { error: 'not_found' }); return }
    let caller: string
    try {
      const header = req.headers[InternalApiCallerHeader]
      caller = await options.verify(typeof header === 'string' ? header : undefined, cellId, area)
    } catch (error) {
      if (!(error instanceof CallerRefused)) options.log.error('caller verification failed', { error: String(error) })
      json(res, 401, { error: 'unauthorized' })
      return
    }
    const cell = options.cells.get(cellId)
    if (!cell || !cell.parts.holding()) { json(res, 503, { error: 'cell_unavailable' }); return }
    if (area === 'api') {
      const actor = actorOf(req), role = roleOf(req), method = req.method ?? 'GET', path = rest.join('/')
      if (role === 'member' && !memberMay(method, path)) {
        options.log.info('panel request refused', { cellId, method, path, actor, role, caller })
        json(res, 403, { error: 'forbidden', message: 'A team admin can change this' })
        return
      }
      if (method !== 'GET') options.log.info('panel request', { cellId, method, path, actor, role, caller })
      await dispatch(cell.routes, cell.httpHost(), req, res, path, url.searchParams)
      return
    }
    if (area === 'worker' && rest.join('/') === 'token-refresh' && req.method === 'POST') {
      try {
        const { claims } = z.object({ claims: Claims }).parse(await body(req))
        if (claims.cid !== cellId) { json(res, 403, { error: 'forbidden', message: 'claims are for another cell' }); return }
        const token = await cell.refreshToken(claims.tkt, claims.asg)
        if (!token) { json(res, 409, { error: 'assignment_not_running' }); return }
        json(res, 200, { token })
      } catch (error) { json(res, 400, { error: 'bad_request', message: String(error).slice(0, 200) }) }
      return
    }
    if (area === 'worker' && rest.join('/') === 'read' && req.method === 'POST') {
      let request: { claims: z.infer<typeof Claims>; resource: string }
      try { request = z.object({ claims: Claims, resource: ReadRequest.shape.resource }).parse(await body(req)) }
      catch (error) { json(res, 400, { ok: false, error: 'bad_request', message: String(error).slice(0, 200) }); return }
      if (request.claims.cid !== cellId) { json(res, 403, { ok: false, error: 'forbidden', message: 'claims are for another cell' }); return }
      try {
        const read = await cell.readForWorker(request.claims.tkt, request.resource)
        if ('refused' in read) { json(res, read.status, { ok: false, error: read.refused, message: read.message }); return }
        json(res, 200, { ok: true, ...read })
      } catch (error) { json(res, 200, { ok: false, error: 'unavailable', message: String(error).slice(0, 500) }) }
      return
    }
    json(res, 404, { error: 'not_found' })
  }
}
/** `GET /tenants/{t}/github/installations/{id}/repositories` (v6): panel-tenant only, proof signed for `tenant:<t>`. */
async function tenantRoute(options: InternalServerOptions, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const [, , tenantId = '', github, installations, id = '', repositories, ...extra] = url.pathname.split('/')
  const shaped = TenantId.safeParse(tenantId).success && github === 'github' && installations === 'installations' && INSTALLATION.test(id)
    && repositories === 'repositories' && !extra.length && req.method === 'GET'
  if (!shaped || !options.tenants) { json(res, 404, { error: 'not_found' }); return }
  let caller: string
  try {
    const header = req.headers[InternalApiCallerHeader]
    caller = await options.verify(typeof header === 'string' ? header : undefined, `tenant:${tenantId}`, 'tenant')
  } catch (error) {
    if (!(error instanceof CallerRefused)) options.log.error('caller verification failed', { error: String(error) })
    json(res, 401, { error: 'unauthorized' })
    return
  }
  const installationId = Number(id)
  const result = await options.tenants.installationRepositories(tenantId, installationId)
  options.log.info('tenant request', { tenantId, installationId, op: 'installation.repositories', actor: actorOf(req), role: roleOf(req), caller,
    ...result.ok ? { repositories: result.repositories.length } : { refused: result.error } })
  if (!result.ok) { json(res, result.status, { error: result.error, message: result.message }); return }
  json(res, 200, { repositories: result.repositories, truncated: result.truncated })
}
export function internalServer(options: InternalServerOptions): Server {
  const handle = handler(options)
  return createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      options.log.error('internal request failed', { error: String(error) })
      if (!res.headersSent) json(res, 500, { error: 'internal' })
    })
  })
}
