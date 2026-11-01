/**
 * panel-tenant (onboarding design §1–§4): `/v1/tenants/{t}/setup/**` for tenant admins of `t` and platform admins.
 * Every route is authorized before any side effect, and every mutation writes one audit line. Secrets are write-only.
 */
import { randomBytes } from 'node:crypto'
import { CellId, FeishuDomain, type PanelRole, TenantId, type TenantRecord, onboardingKey } from '@dshsa/contracts'
import { GITHUB_WEB, GithubOAuthError, type GithubUserToken, type OrgMembership, type UserInstallation } from '@dshsa/sources/apis'
import { z } from 'zod'
import type * as ops from '../admin/ops.ts'
import { AdminError } from '../admin/ops.ts'
import { type Audit, type AuditSink, auditFor } from '../audit.ts'
import { type Principal, principalFrom } from '../authz.ts'
import { type HttpEvent, type HttpResult, error, forbidden, json, notFound, parseBody, segments } from '../http.ts'
import type { Repo } from '../repo.ts'
import { atLeast, roleIn } from '../roles.ts'
import { cellsUsing, inUse } from './claims.ts'
import type { ConnectorStateReader } from './connector-state.ts'
import type { HostClient } from './host.ts'
import type { OnboardingStore } from './onboarding.ts'

/** What panel-tenant may do through ops.ts, bound to its AWS clients (tests pass fakes). */
export interface TenantOps {
  cellAdd(input: ops.CellAddInput): Promise<{ cellId: string }>
  cellSetStatus(cellId: string, status: 'active' | 'paused' | 'disabled'): Promise<void>
  feishuSet(input: ops.FeishuInput): Promise<unknown>
  chatBind(tenantId: string, chatId: string, cellId: string, name?: string): Promise<void>
  chatUnbind(tenantId: string, chatId: string): Promise<boolean>
  tenantUsers(tenantId: string): Promise<ops.DirectoryUser[]>
  userInvite(email: string, tenantId: string, role: 'member' | 'tadmin'): Promise<void>
  userRemove(email: string, tenantId: string): Promise<void>
  githubOauth(): Promise<ops.OauthConfig | undefined>
}
export interface GithubUserApi {
  exchange(input: { clientId: string; clientSecret: string; code: string; redirectUri: string }): Promise<GithubUserToken>
  installations(token: GithubUserToken, appId: string): Promise<UserInstallation[]>
  login(token: GithubUserToken): Promise<{ login: string }>
  /** Undefined when GitHub does not tell (403/404: not a member, or the App lacks Organization → Members: read). */
  membership(token: GithubUserToken, org: string): Promise<OrgMembership | undefined>
  revoke(token: GithubUserToken, client: { clientId: string; clientSecret: string }): Promise<boolean>
}

export interface TenantDeps {
  repo: Repo
  ops: TenantOps
  onboarding: OnboardingStore
  host: HostClient
  connector: ConnectorStateReader
  github: GithubUserApi
  /** `https://<distribution>` (no trailing slash): OAuth redirect `<panelUrl>/setup/github/callback`. */
  panelUrl: string
  now(): number
  nonce?(): string
  audit: AuditSink
  log?(entry: Record<string, unknown>): void
}

export const STATE_TTL_SEC = 600
const ChatId = z.string().regex(/^oc_[A-Za-z0-9]{1,64}$/)
const Email = z.string().regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/).max(254)
const Nonce = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/)
const LinkBody = z.object({ code: z.string().min(1).max(200), state: Nonce }).strict()
const CellAddBody = z.object({ installationId: z.number().int().positive(), repoId: z.number().int().positive() }).strict()
const FeishuBody = z.object({
  domain: FeishuDomain, appId: z.string().regex(/^cli_[A-Za-z0-9]{1,64}$/), appSecret: z.string().min(8).max(200),
  encryptKey: z.string().min(1).max(200).optional(),
}).strict()
const BindBody = z.object({ cellId: CellId }).strict()
const InviteBody = z.object({ email: Email, role: z.enum(['member', 'tadmin']) }).strict()

/** Wraps a mutation: success and failure are both audited; AdminError → 400 with its (safe) message. */
async function mutate(audit: Audit, op: string, tenantId: string, target: string | undefined, run: () => Promise<HttpResult>): Promise<HttpResult> {
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

export async function handleTenantSetup(event: HttpEvent, deps: TenantDeps): Promise<HttpResult> {
  const principal = principalFrom(event.requestContext.authorizer?.jwt?.claims)
  if (!principal) return error(401, 'unauthorized', 'Sign in required')
  const method = event.requestContext.http.method.toUpperCase()
  const [v1, tenants, tenantId = '', setup, ...rest] = segments(event.rawPath)
  if (v1 !== 'v1' || tenants !== 'tenants' || setup !== 'setup') return notFound()
  try {
    const tenant = TenantId.safeParse(tenantId).success ? await deps.repo.getTenant(tenantId) : undefined
    const role = roleIn(principal, tenant)
    // Unknown tenant, other tenant, disabled tenant or member: the same 403 (existence is not revealed).
    if (!tenant || !atLeast(role, 'tadmin')) return forbidden()
    const ctx: Ctx = { event, method, rest, principal, role: role!, tenant, deps, audit: auditFor(principal, role!, deps.audit, deps.now) }
    return await route(ctx)
  } catch (cause) {
    if (cause instanceof AdminError) return error(400, 'bad_request', cause.message)
    deps.log?.({ level: 'error', msg: 'panel-tenant failure', path: event.rawPath, error: String(cause) })
    return error(500, 'internal', 'Internal error')
  }
}

interface Ctx { event: HttpEvent; method: string; rest: string[]; principal: Principal; role: PanelRole; tenant: TenantRecord; deps: TenantDeps; audit: Audit }

async function route(x: Ctx): Promise<HttpResult> {
  const { method, rest } = x
  const [a, b, c, d, ...more] = rest
  if (more.length) return notFound()
  if (a === undefined && method === 'GET') return json(200, await status(x))
  if (a === 'github') {
    if (b === 'link-start' && !c && method === 'POST') return linkStart(x)
    if (b === 'link' && !c && method === 'POST') return link(x)
    if (b === 'installations' && !c && method === 'GET') return json(200, { installations: await x.deps.onboarding.listClaims(x.tenant.tenantId) })
    if (b === 'installations' && c && d === 'repositories' && method === 'GET') return repositories(x, c)
    if (b === 'installations' && c && !d && method === 'DELETE') return unlink(x, c)
  }
  if (a === 'cells') {
    if (!b && method === 'POST') return cellAdd(x)
    if (b && ['pause', 'enable', 'disable'].includes(c ?? '') && !d && method === 'POST') return cellStatus(x, b, c as 'pause' | 'enable' | 'disable')
  }
  if (a === 'feishu' && !b) {
    if (method === 'GET') return json(200, await feishuStatus(x))
    if (method === 'PUT') return feishuSet(x)
  }
  if (a === 'chats') {
    if (!b && method === 'GET') return json(200, await chats(x))
    if (b && !c && method === 'PUT') return chatBind(x, b)
    if (b && !c && method === 'DELETE') return chatUnbind(x, b)
  }
  if (a === 'users') {
    if (!b && method === 'GET') return json(200, { users: await x.deps.ops.tenantUsers(x.tenant.tenantId) })
    if (!b && method === 'POST') return userInvite(x)
    if (b && !c && method === 'DELETE') return userRemove(x, b)
  }
  return notFound()
}

// ---- Status / checklist ------------------------------------------------------------------------------------------------

async function status(x: Ctx) {
  const t = x.tenant.tenantId
  const [claims, cells, bindings, connector, oauth] = await Promise.all([
    x.deps.onboarding.listClaims(t), x.deps.repo.listCellsByTenant(t), x.deps.repo.listChatBindings(t), x.deps.connector.read(t), x.deps.ops.githubOauth(),
  ])
  return {
    tenant: { tenantId: t, name: x.tenant.name }, role: x.role,
    github: { configured: !!(oauth?.slug && oauth.appId && oauth.clientId), installUrl: oauth?.slug ? `${GITHUB_WEB}/apps/${encodeURIComponent(oauth.slug)}/installations/new` : undefined },
    checklist: {
      appLinked: claims.some(c => c.status === 'active'), approvalPending: claims.some(c => c.status === 'pending'), repoAdded: cells.some(c => c.status !== 'disabled'),
      botConnected: !!x.tenant.feishu && connector?.health?.state === 'ready', chatBound: bindings.length > 0,
    },
    cells: cells.map(c => ({ cellId: c.cellId, status: c.status, repo: { owner: c.repo.owner, name: c.repo.name, id: c.repo.id, installationId: c.repo.installationId } })),
  }
}

// ---- GitHub link (design §3) ---------------------------------------------------------------------------------------------

const callbackUrl = (x: Ctx) => `${x.deps.panelUrl}/setup/github/callback`
const nonce = (x: Ctx) => x.deps.nonce?.() ?? randomBytes(32).toString('base64url')

async function linkStart(x: Ctx): Promise<HttpResult> {
  const oauth = await x.deps.ops.githubOauth()
  if (!oauth?.appId) return error(409, 'github_not_configured', 'A platform admin must finish Platform → GitHub App first')
  return mutate(x.audit, 'setup.github.link-start', x.tenant.tenantId, undefined, async () => {
    const value = nonce(x)
    await x.deps.onboarding.createState({ key: onboardingKey.githubState(value), tenantId: x.tenant.tenantId, sub: x.principal.sub,
      ttl: Math.floor(x.deps.now() / 1000) + STATE_TTL_SEC })
    const url = new URL(`${GITHUB_WEB}/login/oauth/authorize`)
    url.searchParams.set('client_id', oauth.clientId)
    url.searchParams.set('redirect_uri', callbackUrl(x))
    url.searchParams.set('state', value)
    return json(200, { url: url.toString(), expiresInSec: STATE_TTL_SEC })
  })
}

async function link(x: Ctx): Promise<HttpResult> {
  const body = parseBody(x.event, LinkBody)
  if (!body.ok) return body.result
  return mutate(x.audit, 'setup.github.link', x.tenant.tenantId, undefined, async () => {
    // Single use, same tenant, same Cognito user, unexpired: a replayed or forged `state` stops here.
    if (!await x.deps.onboarding.consumeState(body.value.state, x.tenant.tenantId, x.principal.sub, Math.floor(x.deps.now() / 1000))) {
      return error(400, 'invalid_state', 'This link expired or was already used; start “Link installations” again')
    }
    const oauth = await x.deps.ops.githubOauth()
    if (!oauth?.appId) return error(409, 'github_not_configured', 'A platform admin must finish Platform → GitHub App first')
    let decided: Decided[]
    let login: string
    try {
      const token = await x.deps.github.exchange({ clientId: oauth.clientId, clientSecret: oauth.clientSecret, code: body.value.code, redirectUri: callbackUrl(x) })
      // The user token lives only for these calls and is revoked right after (never stored or logged).
      try {
        const installs = await x.deps.github.installations(token, oauth.appId)
        login = (await x.deps.github.login(token)).login
        decided = []
        for (const install of installs) decided.push({ install, ...await control(x, token, install, login) })
      } finally { await x.deps.github.revoke(token, oauth) }
    } catch (e) {
      if (e instanceof GithubOAuthError) {
        return e.expiredCode ? error(400, 'invalid_code', 'GitHub refused the code (expired or used); start “Link installations” again')
          : error(502, 'github_error', `GitHub sign-in failed (${e.code})`)
      }
      throw e
    }
    const results = []
    for (const { install, status, pendingReason } of decided) {
      const outcome = await x.deps.onboarding.claim({
        key: onboardingKey.githubInstall(install.id), tenantId: x.tenant.tenantId, installationId: install.id, status, ...(pendingReason ? { pendingReason } : {}),
        account: install.account.login, accountType: install.account.type === 'Organization' ? 'Organization' : 'User', githubLogin: login,
        claimedBy: x.principal.email ?? x.principal.sub, claimedAt: new Date(x.deps.now()).toISOString(),
      })
      results.push({ installationId: install.id, account: install.account.login, status: outcome, ...(outcome === 'pending' ? { pendingReason } : {}) })
    }
    x.audit({ op: 'setup.github.claim', tenantId: x.tenant.tenantId, ok: true,
      target: results.map(r => `${r.installationId}:${r.status}`).join(',') || 'none' })
    return json(200, { installations: results })
  })
}

interface Decided { install: UserInstallation; status: 'active' | 'pending'; pendingReason?: string }
/**
 * Whether the GitHub user controls the installation (design §3 step 4a, v6.2): their own User account, or an Organization
 * they are an active admin of. Anything else, including an unreadable membership or an unknown account type, is pending.
 */
async function control(x: Ctx, token: GithubUserToken, install: UserInstallation, login: string): Promise<Omit<Decided, 'install'>> {
  if (install.account.type === 'User') {
    return install.account.login.toLowerCase() === login.toLowerCase() ? { status: 'active' } : { status: 'pending', pendingReason: 'not_own_account' }
  }
  if (install.account.type !== 'Organization') return { status: 'pending', pendingReason: 'unknown_account_type' }
  let membership: OrgMembership | undefined
  try { membership = await x.deps.github.membership(token, install.account.login) } catch (e) {
    x.deps.log?.({ level: 'warn', msg: 'github membership unreadable', tenantId: x.tenant.tenantId, installationId: install.id, error: e instanceof GithubOAuthError ? e.code : 'error' })
    return { status: 'pending', pendingReason: 'membership_unavailable' }
  }
  if (!membership) return { status: 'pending', pendingReason: 'membership_unavailable' }
  return membership.state === 'active' && membership.role === 'admin' ? { status: 'active' } : { status: 'pending', pendingReason: 'not_org_admin' }
}

/** The tenant's own claim; `active` only (a pending claim lists no repositories and adds no cell). */
async function ownClaim(x: Ctx, installationId: number): Promise<'active' | 'pending' | undefined> {
  const claim = await x.deps.onboarding.getClaim(installationId)
  return claim?.tenantId === x.tenant.tenantId ? claim.status : undefined
}
const claimRefused = (status: 'pending' | undefined): HttpResult => status === 'pending'
  ? error(403, 'claim_pending', 'This installation is waiting for platform approval')
  : error(403, 'not_claimed', 'This installation is not linked to your team')

/** Unlinks the team's own claim (active or pending) so the installation can be linked to another team. */
async function unlink(x: Ctx, rawId: string): Promise<HttpResult> {
  const installationId = Number(rawId)
  if (!Number.isSafeInteger(installationId) || installationId <= 0) return error(400, 'bad_request', 'Invalid installation id')
  return mutate(x.audit, 'setup.github.unlink', x.tenant.tenantId, String(installationId), async () => {
    if (!await ownClaim(x, installationId)) return claimRefused(undefined)
    const using = cellsUsing(await x.deps.repo.listCellsByTenant(x.tenant.tenantId), installationId)
    if (using.length) return inUse(using)
    // Conditional on `tenantId = :t`: a claim released and re-linked by another team in between is never deleted.
    return await x.deps.onboarding.releaseClaim(installationId, x.tenant.tenantId)
      ? json(200, { installationId, released: true }) : claimRefused(undefined)
  })
}

async function repositories(x: Ctx, rawId: string): Promise<HttpResult> {
  const installationId = Number(rawId)
  if (!Number.isSafeInteger(installationId) || installationId <= 0) return error(400, 'bad_request', 'Invalid installation id')
  const claim = await ownClaim(x, installationId)
  if (claim !== 'active') return claimRefused(claim)
  const res = await x.deps.host.repositories(x.tenant.tenantId, installationId, x.principal, x.role)
  if (!res.ok) return hostError(x, res.reason)
  const cells = await x.deps.repo.listCellsByTenant(x.tenant.tenantId)
  const byRepo = new Map(cells.map(c => [c.repo.id, c]))
  return json(200, {
    truncated: res.truncated,
    repositories: res.repositories.map(r => ({ ...r, cell: byRepo.get(r.id) ? { cellId: byRepo.get(r.id)!.cellId, status: byRepo.get(r.id)!.status } : undefined })),
  })
}

function hostError(x: Ctx, reason: string): HttpResult {
  if (reason === 'not_claimed') return error(403, 'not_claimed', 'This installation is not linked to your team')
  if (reason === 'installation_not_found') return error(404, 'installation_not_found', 'GitHub no longer has this installation (the App was uninstalled)')
  if (reason === 'auth_rejected') x.deps.log?.({ level: 'error', msg: 'internal_auth_rejected', tenantId: x.tenant.tenantId, route: 'GET tenant repositories' })
  return error(503, 'host_unavailable', 'The platform could not list repositories right now; try again shortly')
}

// ---- Cells (repos) -----------------------------------------------------------------------------------------------------

async function cellAdd(x: Ctx): Promise<HttpResult> {
  const body = parseBody(x.event, CellAddBody)
  if (!body.ok) return body.result
  const { installationId, repoId } = body.value
  return mutate(x.audit, 'setup.cell.add', x.tenant.tenantId, `${installationId}/${repoId}`, async () => {
    const claim = await ownClaim(x, installationId)
    if (claim !== 'active') return claimRefused(claim)
    // Repo names come from GitHub (through the host), never from the request.
    const res = await x.deps.host.repositories(x.tenant.tenantId, installationId, x.principal, x.role)
    if (!res.ok) return hostError(x, res.reason)
    const repo = res.repositories.find(r => r.id === repoId)
    if (!repo) return error(404, 'repo_not_found', 'That repository is not part of this installation')
    if (repo.archived) return error(400, 'bad_request', 'Archived repositories cannot be added')
    const cell = await x.deps.ops.cellAdd({ tenantId: x.tenant.tenantId, repo: `${repo.owner}/${repo.name}`, repoId, installationId, defaultBranch: repo.defaultBranch })
    return json(200, { cell: { cellId: cell.cellId } })
  })
}

async function cellStatus(x: Ctx, rawCellId: string, action: 'pause' | 'enable' | 'disable'): Promise<HttpResult> {
  const cell = CellId.safeParse(rawCellId).success ? await x.deps.repo.getCell(rawCellId) : undefined
  if (!cell || cell.tenantId !== x.tenant.tenantId) return forbidden()
  const status = action === 'pause' ? 'paused' : action === 'enable' ? 'active' : 'disabled'
  return mutate(x.audit, `setup.cell.${action}`, x.tenant.tenantId, cell.cellId, async () => {
    // A disabled cell whose installation was unlinked and then linked to another team stays disabled.
    if (status !== 'disabled') {
      const claim = await x.deps.onboarding.getClaim(cell.repo.installationId)
      if (claim && claim.tenantId !== x.tenant.tenantId) return error(403, 'not_claimed', 'This repository\'s installation is linked to another team')
    }
    await x.deps.ops.cellSetStatus(cell.cellId, status)
    return json(200, { cellId: cell.cellId, status })
  })
}

// ---- Feishu / Lark (design §4) -------------------------------------------------------------------------------------------

async function feishuStatus(x: Ctx) {
  const f = x.tenant.feishu
  const connector = await x.deps.connector.read(x.tenant.tenantId)
  // Write-only: the secret itself is never read; `set` says one exists.
  return { set: !!f, domain: f?.domain, appId: f?.appId, revision: f?.revision, health: connector?.health }
}

async function feishuSet(x: Ctx): Promise<HttpResult> {
  const body = parseBody(x.event, FeishuBody)
  if (!body.ok) return body.result
  return mutate(x.audit, 'setup.feishu.set', x.tenant.tenantId, `${body.value.domain}:${body.value.appId}`, async () => {
    await x.deps.ops.feishuSet({ tenantId: x.tenant.tenantId, ...body.value })
    return json(200, { set: true, domain: body.value.domain, appId: body.value.appId })
  })
}

// ---- Chats (design §4) ---------------------------------------------------------------------------------------------------

async function chats(x: Ctx) {
  const t = x.tenant.tenantId
  const [bindings, connector, cells] = await Promise.all([x.deps.repo.listChatBindings(t), x.deps.connector.read(t), x.deps.repo.listCellsByTenant(t)])
  const bound = new Map(bindings.map(b => [b.chatId, b]))
  const ids = new Set([...Object.keys(connector?.chats ?? {}), ...bound.keys()])
  return {
    botSeen: Object.keys(connector?.chats ?? {}).length > 0,
    chats: [...ids].map(chatId => {
      const seen = connector?.chats[chatId]
      const binding = bound.get(chatId)
      return { chatId, name: seen?.name ?? binding?.chatName, direct: seen?.direct ?? false, lastAt: seen?.lastAt, unrouted: seen?.unrouted,
        cellId: binding?.cellId, seen: !!seen }
    }).sort((a, b) => String(b.lastAt ?? '').localeCompare(String(a.lastAt ?? ''))),
    cells: cells.filter(c => c.status !== 'disabled').map(c => ({ cellId: c.cellId, repo: `${c.repo.owner}/${c.repo.name}` })),
  }
}

async function chatBind(x: Ctx, chatId: string): Promise<HttpResult> {
  if (!ChatId.safeParse(chatId).success) return error(400, 'bad_request', 'Invalid chat id')
  const body = parseBody(x.event, BindBody)
  if (!body.ok) return body.result
  return mutate(x.audit, 'setup.chat.bind', x.tenant.tenantId, `${chatId}→${body.value.cellId}`, async () => {
    const cell = await x.deps.repo.getCell(body.value.cellId)
    if (!cell || cell.tenantId !== x.tenant.tenantId) return error(400, 'bad_request', 'cellId is not a repository of this team')
    if (cell.status === 'disabled') return error(400, 'bad_request', 'That repository is disabled; enable it before binding a chat')
    const name = (await x.deps.connector.read(x.tenant.tenantId))?.chats[chatId]?.name
    await x.deps.ops.chatBind(x.tenant.tenantId, chatId, cell.cellId, name)
    return json(200, { chatId, cellId: cell.cellId })
  })
}

async function chatUnbind(x: Ctx, chatId: string): Promise<HttpResult> {
  if (!ChatId.safeParse(chatId).success) return error(400, 'bad_request', 'Invalid chat id')
  return mutate(x.audit, 'setup.chat.unbind', x.tenant.tenantId, chatId, async () =>
    await x.deps.ops.chatUnbind(x.tenant.tenantId, chatId) ? json(200, { removed: true }) : error(404, 'not_found', 'No such binding'))
}

// ---- Users (design §1, Q3: limited to the own tenant in code, audited) ----------------------------------------------------

async function userInvite(x: Ctx): Promise<HttpResult> {
  const body = parseBody(x.event, InviteBody)
  if (!body.ok) return body.result
  return mutate(x.audit, 'setup.user.invite', x.tenant.tenantId, `${body.value.email}:${body.value.role}`, async () => {
    try {
      await x.deps.ops.userInvite(body.value.email, x.tenant.tenantId, body.value.role)
    } catch (e) {
      if ((e as { name?: string }).name === 'ResourceNotFoundException') {
        return error(409, 'group_missing', 'This team has no tenant-admin group yet; ask a platform admin to invite the first tenant admin')
      }
      throw e
    }
    return json(200, { email: body.value.email, role: body.value.role })
  })
}

async function userRemove(x: Ctx, email: string): Promise<HttpResult> {
  if (!Email.safeParse(email).success) return error(400, 'bad_request', 'Invalid email')
  if (x.principal.email && email.toLowerCase() === x.principal.email.toLowerCase()) return error(400, 'bad_request', 'You cannot remove yourself')
  return mutate(x.audit, 'setup.user.remove', x.tenant.tenantId, email, async () => {
    await x.deps.ops.userRemove(email, x.tenant.tenantId)
    return json(200, { removed: true })
  })
}
