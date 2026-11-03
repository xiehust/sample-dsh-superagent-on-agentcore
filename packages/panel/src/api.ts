/**
 * Typed panel-api client and polling hook.
 * The route-key style (`'METHOD path/:param'`) and `usePoll` are adapted from dsh-superagent `src/app/api.ts` and
 * `src/client/api.ts` (MIT, DeepSeek Harness superagent prototype); requests now go to panel-api with a Cognito bearer token
 * instead of the loopback host.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Api, ApiRequest, ApiResponse, CellListView, CellView, ChatBinding, ChatBindingListView, ChatListView, FeishuInput,
  FeishuStatusView, GithubAppInput, GithubAppView, InstallationListView, InviteInput, Issue, LinkResultView, LinkStartView, MeView,
  ClaimListView, ReleaseResultView, RepositoryListView, UnlinkResultView, SetupStatusView, TenantListView, TenantView, TranscriptView, UserListView } from './types.ts'

/**
 * The DSH management routes the panel uses, as `METHOD path` keys of the cell's `Api` (`@dshsa/cell/api-types`).
 * panel-api forwards them to the cell that holds the lease; request and response shapes come from `Api`.
 */
export const CELL_ROUTES = ['GET state', 'GET overview', 'GET tickets', 'GET tickets/:id', 'POST tickets/:id/retry', 'POST tickets/:id/stop',
  'POST executor/pause', 'POST triggers/:id/requeue', 'GET decisions', 'POST decisions/:id/dismiss', 'GET settings', 'PUT settings/:block', 'GET prompts',
  'PUT prompts', 'POST policy-sync/:id', 'GET sources/feishu/members', 'GET sources/github/collaborators', 'GET models'] as const satisfies
  readonly (keyof Api)[]
export type CellRoute = typeof CELL_ROUTES[number]
export type CellApi = Pick<Api, CellRoute>
export type CellRequest<K extends CellRoute> = ApiRequest<K>
export type CellResponse<K extends CellRoute> = ApiResponse<K>

export type ErrorKind = 'unauthorized' | 'forbidden' | 'offline' | 'conflict' | 'missing' | 'invalid' | 'network' | 'server'
/** A failed panel-api request: HTTP `status` (0 when unreachable), the server `code`, and a user-facing `message`. */
export class ApiError extends Error {
  /** `issues` are a cell's per-field validation errors on a 400 (`{path, message}`, path dotted). */
  /** `values` are a cell refusal's details (`UserError` values, e.g. `{block, field, reason}` of `modelUnavailable`). */
  constructor(readonly status: number, readonly code: string, message: string, readonly issues: Issue[] = [],
    readonly values: Record<string, string> = {}) { super(message) }
  get kind(): ErrorKind {
    if (this.status === 401) return 'unauthorized'
    if (this.status === 403) return 'forbidden'
    if (this.status === 503 && this.code === 'cell_unavailable') return 'offline'
    if (this.status === 409) return 'conflict'
    if (this.status === 404) return 'missing'
    if (this.status === 400 || this.status === 413) return 'invalid'
    return this.status === 0 ? 'network' : 'server'
  }
}
const MESSAGES: Partial<Record<ErrorKind, string>> = {
  unauthorized: 'Your session expired. Signing in again…',
  forbidden: 'You do not have access to this.',
  offline: 'This cell is offline right now. It reconnects automatically when its host takes the lease again.',
  conflict: 'This was changed elsewhere. Reload to get the latest version, then reapply your edit.',
  network: 'The panel API could not be reached.',
}
/** Codes that carry no more than their status; any other code (e.g. 409 `github_not_configured`) comes with a specific message. */
const GENERIC_CODES = new Set(['forbidden', 'unauthorized', 'cell_unavailable', 'network'])
export function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const specific = !GENERIC_CODES.has(error.code) && !error.code.startsWith('http_') && error.kind !== 'unauthorized'
    return specific ? error.message : MESSAGES[error.kind] ?? error.message
  }
  return error instanceof Error ? error.message : String(error)
}

export interface ClientOptions {
  apiUrl: string
  /** Current bearer (the Cognito ID token), or undefined when the user must sign in. */
  token: () => Promise<string | undefined>
  /** Called on a 401 or a missing token; the app starts a new login. */
  onUnauthorized: () => void
  fetch?: typeof fetch
}
export interface Client {
  me(): Promise<MeView>
  cells(): Promise<CellView[]>
  call<K extends CellRoute>(cellId: string, route: K,
    ...request: {} extends CellRequest<K> ? [request?: CellRequest<K>] : [request: CellRequest<K>]): Promise<CellResponse<K>>
  transcript(cellId: string, ticketId: string): Promise<TranscriptView>
  bindings: {
    list(tenantId: string): Promise<ChatBinding[]>
  }
  /** panel-tenant: tenant admins of the tenant and platform admins (others get 403). */
  setup: {
    status(tenantId: string): Promise<SetupStatusView>
    linkStart(tenantId: string): Promise<LinkStartView>
    link(tenantId: string, value: { code: string; state: string }): Promise<LinkResultView>
    installations(tenantId: string): Promise<InstallationListView>
    repositories(tenantId: string, installationId: number): Promise<RepositoryListView>
    /** Unlinks the team's own claim; 409 `installation_in_use` (message names the repositories) while cells use it. */
    unlink(tenantId: string, installationId: number): Promise<UnlinkResultView>
    addCell(tenantId: string, value: { installationId: number; repoId: number }): Promise<{ cell: { cellId: string } }>
    cellStatus(tenantId: string, cellId: string, action: 'pause' | 'enable' | 'disable'): Promise<unknown>
    feishu(tenantId: string): Promise<FeishuStatusView>
    feishuSet(tenantId: string, value: FeishuInput): Promise<unknown>
    chats(tenantId: string): Promise<ChatListView>
    bind(tenantId: string, chatId: string, cellId: string): Promise<unknown>
    unbind(tenantId: string, chatId: string): Promise<unknown>
    users(tenantId: string): Promise<UserListView>
    invite(tenantId: string, value: { email: string; role: 'member' | 'tadmin' }): Promise<unknown>
    removeUser(tenantId: string, email: string): Promise<unknown>
  }
  /** panel-platform: platform admins only. */
  admin: {
    tenants(): Promise<TenantListView>
    addTenant(value: { tenantId: string; name: string }): Promise<{ tenant: TenantView }>
    tenantStatus(tenantId: string, action: 'disable' | 'enable'): Promise<unknown>
    /** Users of `tenantId`, or the platform admins when it is undefined. */
    users(tenantId?: string): Promise<UserListView>
    invite(value: InviteInput): Promise<unknown>
    removeUser(email: string, tenantId?: string): Promise<unknown>
    githubApp(): Promise<GithubAppView>
    setGithubApp(value: GithubAppInput): Promise<GithubAppView>
    /** Every installation claim, active and pending (`?status=all`). */
    installations(): Promise<ClaimListView>
    /** pending → active (404 when it is no longer pending). */
    approveInstallation(installationId: number): Promise<{ installationId: number; status: 'active' }>
    /**
     * Rejects or releases a claim, so the installation can be linked again. 409 `installation_in_use` while cells of the
     * team use it; `force` releases anyway and reports those cells (they are never changed).
     */
    releaseInstallation(installationId: number, force?: boolean): Promise<ReleaseResultView>
  }
}

const segment = encodeURIComponent
export function createClient(options: ClientOptions): Client {
  const base = options.apiUrl.replace(/\/+$/, '')
  const send = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await options.token()
    if (!token) { options.onUnauthorized(); throw new ApiError(401, 'unauthorized', MESSAGES.unauthorized!) }
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'x-orchestrator-request': '1' }
    if (body !== undefined) headers['content-type'] = 'application/json'
    let response: Response
    try {
      response = await send(`${base}${path}`, { method, headers, ...body === undefined ? {} : { body: JSON.stringify(body) } })
    } catch {
      throw new ApiError(0, 'network', MESSAGES.network!)
    }
    const text = await response.text()
    let value: unknown
    try { value = text ? JSON.parse(text) : {} } catch { value = undefined }
    if (!response.ok) {
      const failure = (value ?? {}) as { error?: unknown; code?: unknown; message?: unknown; issues?: unknown; values?: unknown }
      // panel-api errors are `{error: code, message}`; forwarded DSH host errors are `{error: message, code?}`.
      const code = typeof failure.code === 'string' ? failure.code : typeof failure.error === 'string' && /^[a-z_]+$/.test(failure.error)
        ? failure.error : `http_${response.status}`
      const message = typeof failure.message === 'string' ? failure.message : typeof failure.error === 'string' ? failure.error
        : `Request failed (${response.status})`
      if (response.status === 401) options.onUnauthorized()
      const issues = Array.isArray(failure.issues) ? failure.issues.flatMap(item => item && typeof item === 'object'
        && typeof (item as Issue).path === 'string' && typeof (item as Issue).message === 'string'
        ? [{ path: (item as Issue).path, message: (item as Issue).message }] : []) : []
      const values = failure.values && typeof failure.values === 'object' && !Array.isArray(failure.values)
        ? Object.fromEntries(Object.entries(failure.values).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {}
      throw new ApiError(response.status, code, message, issues, values)
    }
    return value as T
  }
  return {
    me: () => request<MeView>('GET', '/v1/me'),
    cells: async () => {
      const value = await request<CellListView | CellView[]>('GET', '/v1/cells')
      return Array.isArray(value) ? value : value.cells ?? []
    },
    call: (cellId, route, ...[input]) => {
      const [method, pattern] = route.split(' ') as [string, string]
      const values = (input ?? {}) as Record<string, unknown> & { query?: Record<string, unknown>; body?: unknown }
      const path = pattern.replace(/:(\w+)/g, (_match, name: string) => segment(String(values[name])))
      const query = new URLSearchParams(Object.entries(values.query ?? {}).filter(([, value]) => value !== undefined && value !== '')
        .map(([name, value]) => [name, String(value)])).toString()
      return request(method, `/v1/cells/${segment(cellId)}/api/${path}${query ? `?${query}` : ''}`, values.body)
    },
    transcript: (cellId, ticketId) => request<TranscriptView>('GET',
      `/v1/cells/${segment(cellId)}/tickets/${segment(ticketId)}/transcript`),
    bindings: {
      list: async tenantId => {
        const value = await request<ChatBindingListView | ChatBinding[]>('GET', `/v1/tenants/${segment(tenantId)}/chat-bindings`)
        return Array.isArray(value) ? value : value.bindings ?? []
      },
    },
    setup: {
      status: tenantId => request('GET', setup(tenantId)),
      linkStart: tenantId => request('POST', setup(tenantId, 'github/link-start'), {}),
      link: (tenantId, value) => request('POST', setup(tenantId, 'github/link'), value),
      installations: tenantId => request('GET', setup(tenantId, 'github/installations')),
      repositories: (tenantId, id) => request('GET', setup(tenantId, `github/installations/${segment(String(id))}/repositories`)),
      unlink: (tenantId, id) => request('DELETE', setup(tenantId, `github/installations/${segment(String(id))}`)),
      addCell: (tenantId, value) => request('POST', setup(tenantId, 'cells'), value),
      cellStatus: (tenantId, cellId, action) => request('POST', setup(tenantId, `cells/${segment(cellId)}/${action}`), {}),
      feishu: tenantId => request('GET', setup(tenantId, 'feishu')),
      feishuSet: (tenantId, value) => request('PUT', setup(tenantId, 'feishu'), value),
      chats: tenantId => request('GET', setup(tenantId, 'chats')),
      bind: (tenantId, chatId, cellId) => request('PUT', setup(tenantId, `chats/${segment(chatId)}`), { cellId }),
      unbind: (tenantId, chatId) => request('DELETE', setup(tenantId, `chats/${segment(chatId)}`)),
      users: tenantId => request('GET', setup(tenantId, 'users')),
      invite: (tenantId, value) => request('POST', setup(tenantId, 'users'), value),
      removeUser: (tenantId, email) => request('DELETE', setup(tenantId, `users/${segment(email)}`)),
    },
    admin: {
      tenants: () => request('GET', '/v1/admin/tenants'),
      addTenant: value => request('POST', '/v1/admin/tenants', value),
      tenantStatus: (tenantId, action) => request('POST', `/v1/admin/tenants/${segment(tenantId)}/${action}`, {}),
      users: tenantId => request('GET', `/v1/admin/users${tenantId ? `?tenant=${segment(tenantId)}` : ''}`),
      invite: value => request('POST', '/v1/admin/users', value),
      removeUser: (email, tenantId) => request('DELETE', `/v1/admin/users/${segment(email)}${tenantId ? `?tenant=${segment(tenantId)}` : ''}`),
      githubApp: () => request('GET', '/v1/admin/github-app'),
      setGithubApp: value => request('PUT', '/v1/admin/github-app', value),
      installations: () => request('GET', '/v1/admin/installations?status=all'),
      approveInstallation: id => request('POST', `/v1/admin/installations/${segment(String(id))}/approve`, {}),
      releaseInstallation: (id, force) => request('DELETE', `/v1/admin/installations/${segment(String(id))}${force ? '?force=true' : ''}`),
    },
  }
}
const setup = (tenantId: string, path?: string) => `/v1/tenants/${segment(tenantId)}/setup${path ? `/${path}` : ''}`

export const POLL_MS = 5000
export const HIDDEN_POLL_MS = 30_000
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)
/**
 * Polls `load` while mounted: every 5 s, every 30 s while the document is hidden, and at once when it becomes visible.
 * Keeps the last value across errors, skips updates for unchanged responses, and drops stale responses after `deps` change.
 */
export function usePoll<T>(load: () => Promise<T>, deps: readonly unknown[], intervalMs = POLL_MS) {
  const [state, setState] = useState<{ data?: T; error?: Error; key: string }>({ key: '' })
  const key = JSON.stringify(deps)
  const loader = useRef(load)
  loader.current = load
  const refresh = useRef<() => Promise<void>>(async () => {})
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    // Serialize requests so a reload after a mutation runs after the poll in flight.
    let queue = Promise.resolve()
    const once = async () => {
      clearTimeout(timer)
      try {
        const value = await loader.current()
        if (active) setState(previous => previous.key === key && same(previous.data, value) && !previous.error ? previous
          : { data: value, key })
      } catch (failure) {
        const error = failure instanceof Error ? failure : new Error(String(failure))
        if (active) setState(previous => previous.key === key ? { ...previous, error } : { error, key })
      } finally {
        if (active) timer = setTimeout(run, document.hidden ? Math.max(HIDDEN_POLL_MS, intervalMs) : intervalMs)
      }
    }
    const run = () => (queue = queue.then(once))
    const shown = () => { if (!document.hidden) void run() }
    refresh.current = run
    void run()
    document.addEventListener('visibilitychange', shown)
    return () => { active = false; clearTimeout(timer); document.removeEventListener('visibilitychange', shown) }
  }, [key, intervalMs])
  const reload = useCallback(() => refresh.current(), [])
  // Data loaded for other deps (e.g. the previously selected cell) is never shown.
  const current = state.key === key
  return { data: current ? state.data : undefined, error: current ? state.error : undefined, reload }
}
