/**
 * In-memory fake of panel-api (design §4.1) behind a `fetch` stub, after dsh-superagent `tests/fixtures/panel-server.ts`
 * (MIT, DeepSeek Harness superagent prototype). Every request is checked: a route outside the allowlist, a missing or wrong
 * ID-token bearer, or a missing `x-orchestrator-request` header is recorded in `misuse`, which fails the test in `afterEach`.
 * The allowlist is written out here on purpose rather than imported from `src/`, so the panel cannot drift from it unnoticed.
 */
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import type { Api, ApiResponse, CellView, ChatBinding, DirectoryUser, FeishuStatusView, GithubAppView, InstallationClaim, Issue, Localized,
  OverviewView, PanelRole, Problem, PromptConfig, PromptVersion, SeenChatView, SettingsView, SetupCell, SetupRepository, SourceSettings, TenantView,
  TicketPageView, TicketRow, TicketStage, TranscriptEntry } from '../src/types.ts'

export const API = 'https://api.test'
/** The bearer the panel must send: the Cognito ID token (not the access token). */
export const ID_TOKEN = 'header.eyJzdWIiOiJ1MSIsImVtYWlsIjoib3BAZXhhbXBsZS5jb20ifQ.sig'

/** DSH management routes panel-api forwards (`ANY /v1/cells/{cellId}/api/{route+}`), as `METHOD pattern` keys of the cell's `Api`. */
const FORWARDED = ['GET state', 'GET overview', 'GET tickets', 'GET tickets/:id', 'POST tickets/:id/retry', 'POST tickets/:id/stop',
  'POST executor/pause', 'POST triggers/:id/requeue', 'POST decisions/:id/dismiss', 'GET settings', 'PUT settings/:block', 'GET prompts',
  'PUT prompts', 'POST policy-sync/:id', 'GET sources/feishu/members', 'GET sources/github/collaborators'] as const satisfies readonly (keyof Api)[]
/** The only forwarded mutations a member may make (control-api `cellRouteRole`); every other non-GET is 403 for members. */
const MEMBER_WRITES = new Set(['POST tickets/:id/retry', 'POST tickets/:id/stop'])
const RANK: Record<PanelRole, number> = { member: 1, tadmin: 2, admin: 3 }

export interface Request { method: string; path: string; query: Record<string, string>; body: unknown }
type Reply = { status: number; body: unknown }
const ok = (body: unknown): Reply => ({ status: 200, body })
/** A forwarded route's reply, checked against the cell's response type for that route. */
const answer = <K extends keyof Api>(body: ApiResponse<K>): Reply => ok(body)
const fail = (status: number, error: string, message = error): Reply => ({ status, body: { error, message } })

export const CELLS: CellView[] = [
  { cellId: 'acme--gh1', tenantId: 'acme', repo: { owner: 'acme', name: 'widgets' }, status: 'active' },
  { cellId: 'acme--gh2', tenantId: 'acme', repo: { owner: 'acme', name: 'gadgets' }, status: 'active' },
  { cellId: 'beta--gh3', tenantId: 'beta', repo: { owner: 'beta', name: 'site' }, status: 'active' },
]

const AT = '2026-10-30T10:00:00Z'
export const text = (en: string): Localized => ({ en, zh: en })
type ThreadSummary = Extract<Problem, { kind: 'eval-overdue' }>['thread']
export function thread(key: string, title: string): ThreadSummary {
  return { key, source: key.split(':')[0]!, title, stage: 'subscribed', latest: undefined, lastAt: AT, createdAt: AT, subscriptions: 1,
    tickets: [], evaluating: undefined, pending: 0, pollError: undefined, url: undefined, facts: {} }
}
/** Ticket page fields that do not depend on the stage. */
type TicketBody = Omit<TicketPageView, 'stage' | 'action'>
const body = ({ stage: _stage, action: _action, ...rest }: TicketPageView & { action?: unknown }): TicketBody => rest
export function ticket(id: string, stage: TicketStage = { stage: 'working' }, fields: Partial<TicketBody> = {}): TicketPageView {
  const base: TicketBody = {
    id, title: `Ticket ${id}`, state: 'open', actions: { retry: false, stop: true }, strength: 'explicit', ended: undefined,
    attention: undefined, undelivered: 1, deliveryError: undefined, sessionId: `dshsa-${id}`, directory: undefined, summary: '',
    createdAt: '2026-10-30T09:00:00Z', updatedAt: AT, threads: [thread('github:42', '#42 Fix login')], environment: [],
    mandate: { actor: { source: 'github', id: 'alice', name: text('alice') }, strength: 'explicit', policyVersion: 'abcdef0123',
      basis: { source: 'github', via: 'addressed', addressed: 'mention' }, scope: 'Fix the login regression' },
    basis: { facts: [{ name: 'addressed', value: 'mention' }], legacy: false }, paused: false,
    channels: [{ source: 'github', url: 'https://github.com/acme/widgets/pull/42', label: text('PR #42') }],
    decision: undefined,
    assignments: [{ id: 'a1', state: 'running', createdAt: '2026-10-30T09:00:00Z', startedAt: '2026-10-30T09:01:00Z' }],
    inputs: [{ id: 'i1', kind: 'text', at: '2026-10-30T09:30:00Z', text: 'Also update the docs', delivered: false }],
  }
  return { ...base, ...fields, ...stage }
}
const row = ({ environment: _e, mandate: _m, basis: _b, paused: _p, channels: _c, decision: _d, assignments, inputs, threads,
  ...rest }: TicketPageView): TicketRow => ({ ...rest, assignments: assignments.length, inputs: inputs.length,
  threads: threads.map(({ key, source, title, url, facts }) => ({ key, source, title, url, facts })) })
const promptConfig = (communication: string): PromptConfig => ({ communication, scope: '', delivery: '', skills: {} })

/** The GitHub and Feishu Sources of `GET settings`, with the Policy metadata of packages/sources (abridged hints). */
export function settingsSources(): SourceSettings[] {
  const base = { installed: true, restarts: [], fields: [], facts: {}, revision: 1 }
  return [
    { ...base, id: 'github', kind: 'github', title: text('GitHub'), description: text('Watches the repository'), labels: {},
      value: { enabled: true, config: {} },
      policy: {
        fields: [
          { key: 'allowed', type: 'rows', label: text('GitHub accounts that may originate work'),
            columns: [{ key: 'id', type: 'text', label: text('Account'), pattern: '[A-Za-z0-9\\-]+' }] },
          { key: 'bots', type: 'rows', label: text('Bots whose comments may become candidates'),
            columns: [{ key: 'id', type: 'text', label: text('Account'), pattern: '[A-Za-z0-9\\-]+(\\[bot\\])?' }] },
        ],
        explicit: text("An account on the list mentions the agent's App in an Issue or a comment."),
        rows: [
          { id: 'issues', label: text('New Issues'), note: text('@ only'), cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } },
          { id: 'ci', label: text('Default branch CI'), note: text('Received'), cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: true } },
        ],
      } },
    { ...base, id: 'feishu', kind: 'feishu', title: text('Feishu'), description: text('Receives bot messages'), labels: { oc_team: 'Team chat' },
      value: { enabled: true, config: { chats: [{ chatId: 'oc_team', listen: 'mentions' }] } },
      policy: {
        fields: [
          { key: 'allowed', type: 'rows', label: text('Feishu users who may originate work'),
            columns: [{ key: 'id', type: 'text', label: text('open_id'), pattern: 'ou_[a-zA-Z0-9]+' },
              { key: 'name', type: 'text', label: text('Name'), optional: true }] },
          { key: 'syncChat', type: 'text', pattern: '(oc_[a-zA-Z0-9]+)?', label: text('Sync chat'), choose: text('Do not sync') },
        ],
        explicit: text('Someone on the list who mentions the bot always makes an explicit request.'),
        rows: [{ id: 'oc_team', label: 'Team chat', note: text('@ only'), cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } }],
        sync: { label: text('Sync now'), ready: false, health: undefined },
      } },
  ]
}
/** A v6.2 installation claim (active, by an org admin, unless `fields` say otherwise). */
export function claim(installationId: number, tenantId: string, account: string, fields: Partial<InstallationClaim> = {}): InstallationClaim {
  return { key: `ghinst#${installationId}`, installationId, tenantId, status: 'active', account, accountType: 'Organization', githubLogin: 'op-gh',
    claimedBy: 'op@example.com', claimedAt: AT, ...fields }
}
const NONCE = (n: number) => `state${String(n).padStart(4, '0')}${'x'.repeat(32)}`
/** Bodies must have exactly these keys (`required` present, nothing unknown), as panel-api's strict zod schemas demand. */
const shape = (body: unknown, required: string[], optional: string[] = []) => !!body && typeof body === 'object' && !Array.isArray(body)
  && required.every(key => key in body) && Object.keys(body).every(key => required.includes(key) || optional.includes(key))

export function createFakeApi() {
  const misuse: string[] = []
  const requests: Request[] = []
  const overview: OverviewView = {
    problems: [{ kind: 'eval-unavailable', decisionId: 'd9', triggerId: 'tr9', thread: thread('github:7', '#7 Flaky test'),
      reason: [{ code: 'timeout' }] }],
    person: [], executor: { running: 1, queued: 0, maxWorkers: 3, idle: 0 },
    flow: { received: 12, filtered: 2, triggers: 10, judged: 9, accepted: 3, evaluating: 0, dropped: 0 }, policyVersion: 'abcdef0123',
  }
  const settings: SettingsView['blocks'] = {
    policy: { value: { rules: [{ id: 'r1', name: 'Bugs', enabled: true, instruction: 'Fix reported bugs.' }], sources: {} }, revision: 3 },
    eval: { value: { mode: 'observe', timeoutSeconds: 120, model: null }, revision: 1 },
    executor: { value: { model: { provider: 'bedrock', model: 'global.anthropic.claude-opus-5-5' }, maxWorkers: 3, directory: '',
      prepare: '', blockedCommands: [] }, revision: 2 },
  }
  const prompts: PromptVersion = { revision: 4, previousRevision: 3, savedAt: AT, source: 'panel', config: promptConfig('Be concise.') }
  const transcript: TranscriptEntry[] = [
    { type: 'user', uuid: 'e1', timestamp: '2026-10-30T09:01:00Z', message: { role: 'user', content: 'Fix the login regression' } },
    { type: 'assistant', uuid: 'e2', message: { role: 'assistant', content: [{ type: 'text', text: 'Looking at the auth module.' },
      { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'git status' } }] } },
    { type: 'user', uuid: 'e3', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'clean' }] } },
    { type: 'summary', summary: 'not a message' },
  ]
  const state = {
    misuse, requests,
    cells: CELLS.slice(),
    me: { sub: 'u1', email: 'op@example.com', platformAdmin: false,
      tenants: [{ tenantId: 'acme', name: 'Acme', role: 'tadmin' }, { tenantId: 'beta', name: 'Beta', role: 'member' }] } as {
      sub: string; email: string; platformAdmin: boolean; tenants: { tenantId: string; name: string; role?: PanelRole }[] },
    /** Cells whose host holds no lease: forwarded routes return 503 `cell_unavailable`. */
    offline: new Set<string>(),
    /** Cells the user may not access: every cell route returns 403 `forbidden`. */
    forbidden: new Set<string>(),
    paused: false,
    tickets: [
      ticket('t1', undefined, { title: 'Fix login regression' }),
      ticket('t2', { stage: 'person', action: 'answer' }, { title: 'Question about docs',
        attention: { id: 'q1', question: 'Which branch should I target?' } }),
    ],
    overview, settings, prompts, transcript,
    bindings: new Map<string, ChatBinding[]>([['acme', [{ chatId: 'oc_team', cellId: 'acme--gh1', chatName: 'Team chat' }]]]),
    /** `GET settings` Sources (Policy form metadata). */
    sources: settingsSources(),
    /** When set, the next `PUT settings/policy` is refused with these cell issues (400), as the cell's zod check would. */
    policyIssues: undefined as Issue[] | undefined,
    collaborators: [{ id: 'alice' }, { id: 'bob' }, { id: 'carol' }],
    members: new Map<string, { id: string; name: string }[]>([['oc_team', [{ id: 'ou_ann', name: 'Ann' }, { id: 'ou_ben', name: 'Ben' }]],
      ['oc_ops', [{ id: 'ou_ops1', name: 'Olga' }]]]),
    // ---- panel-tenant / panel-platform data ----
    tenants: [
      { tenantId: 'acme', name: 'Acme', cognitoGroup: 'dshsa-tenant-acme', status: 'active', createdAt: AT },
      { tenantId: 'beta', name: 'Beta', cognitoGroup: 'dshsa-tenant-beta', status: 'active', createdAt: AT },
    ] as TenantView[],
    oauthConfigured: true,
    /** The signing-in GitHub user's login (`GET /user`). */
    githubLogin: 'op-gh',
    /**
     * Installations the signing-in GitHub user can access (what `/user/installations` would return), with the control check
     * panel-tenant would make (v6.2): `admin` is the user's org role from `/user/memberships/orgs/{org}` (`unavailable` when
     * GitHub refuses the call).
     */
    githubUser: [{ id: 77, account: 'acme-org', type: 'Organization', admin: 'yes' }, { id: 88, account: 'other-org', type: 'Organization', admin: 'yes' }] as
      { id: number; account: string; type: 'User' | 'Organization' | 'Bot'; admin?: 'yes' | 'no' | 'unavailable' }[],
    claims: new Map<number, InstallationClaim>([[77, claim(77, 'acme', 'acme-org')], [88, claim(88, 'beta', 'other-org', { claimedBy: 'b@example.com', githubLogin: 'b-gh' })]]),
    repos: new Map<number, SetupRepository[]>([[77, [
      { id: 1, name: 'widgets', owner: 'acme', fullName: 'acme/widgets', private: false, archived: false, defaultBranch: 'main' },
      { id: 2, name: 'gadgets', owner: 'acme', fullName: 'acme/gadgets', private: true, archived: false, defaultBranch: 'main' },
      { id: 5, name: 'tools', owner: 'acme', fullName: 'acme/tools', private: true, archived: false, defaultBranch: 'trunk' },
      { id: 6, name: 'legacy', owner: 'acme', fullName: 'acme/legacy', private: false, archived: true, defaultBranch: 'master' },
    ]]]),
    cellRecords: [
      { tenantId: 'acme', cellId: 'acme--gh1', status: 'active', repo: { owner: 'acme', name: 'widgets', id: 1, installationId: 77 } },
      { tenantId: 'acme', cellId: 'acme--gh2', status: 'paused', repo: { owner: 'acme', name: 'gadgets', id: 2, installationId: 77 } },
      { tenantId: 'beta', cellId: 'beta--gh3', status: 'active', repo: { owner: 'beta', name: 'site', id: 3, installationId: 88 } },
    ] as (SetupCell & { tenantId: string })[],
    nonces: new Map<string, string>(),
    nonceCount: 0,
    feishu: new Map<string, FeishuStatusView>([['acme', { set: true, domain: 'feishu', appId: 'cli_acme1', revision: AT,
      health: { state: 'ready', detail: 'Listening for bot events', at: AT } }]]),
    chats: new Map<string, SeenChatView[]>([['acme', [
      { chatId: 'oc_team', name: 'Team chat', direct: false, lastAt: '2026-10-30T11:00:00Z', cellId: 'acme--gh1', seen: true },
      { chatId: 'oc_ops', name: 'Ops room', direct: false, lastAt: '2026-10-30T10:30:00Z', unrouted: 2, seen: true },
    ]]]),
    users: new Map<string, DirectoryUser[]>([
      ['acme', [{ email: 'op@example.com', role: 'tadmin', status: 'CONFIRMED', enabled: true }, { email: 'dev@example.com', role: 'member', status: 'CONFIRMED', enabled: true }]],
      ['beta', [{ email: 'b@example.com', role: 'tadmin', status: 'CONFIRMED', enabled: true }]],
      ['', [{ email: 'root@example.com', role: 'admin', status: 'CONFIRMED', enabled: true }]],
    ]),
    githubApp: { app: { set: true, appId: '123456', slug: 'dshsa-agent', keyValid: true, installations: 2 }, oauth: { set: true, clientId: 'Iv23liAbcdef' },
      checklist: { setupUrl: 'https://panel.test/setup/github', callbackUrl: 'https://panel.test/setup/github/callback', redirectOnUpdate: true,
        permissions: ['Organization permissions → Members: Read-only'] } } as GithubAppView,
    /** Every secret value the panel sent; tests assert none is ever rendered back. */
    secrets: [] as string[],
    /** Count of forwarded requests per `METHOD route` on a cell, e.g. `count('POST tickets/t1/stop')`. */
    count(route: string, cellId = 'acme--gh1') {
      const [method, path] = route.split(' ')
      return requests.filter(item => item.method === method && item.path === `/v1/cells/${cellId}/api/${path}`).length
    },
    find(method: string, path: string) { return requests.filter(item => item.method === method && item.path === path) },
    fetch: undefined as unknown as typeof fetch,
  }

  /** The user's role in `tenantId` as panel-api derives it (platform admins are `admin` everywhere). */
  function roleOf(tenantId: string): PanelRole | undefined {
    if (!state.tenants.some(item => item.tenantId === tenantId && item.status === 'active') && !state.me.platformAdmin) return undefined
    if (state.me.platformAdmin) return 'admin'
    const listed = state.me.tenants.find(item => item.tenantId === tenantId)
    return listed ? listed.role ?? 'member' : undefined
  }
  const atLeast = (role: PanelRole | undefined, need: PanelRole) => !!role && RANK[role] >= RANK[need]
  /** `/v1/me` as panel-api builds it: active tenants only; a platform admin gets every active tenant with role `admin`. */
  function meView() {
    const active = (id: string) => state.tenants.some(item => item.tenantId === id && item.status === 'active')
    const tenants = state.me.platformAdmin
      ? state.tenants.filter(item => item.status === 'active').map(item => ({ tenantId: item.tenantId, name: item.name, role: 'admin' as const }))
      : state.me.tenants.filter(item => active(item.tenantId)).map(item => ({ ...item, role: item.role ?? 'member' }))
    return { ...state.me, tenants }
  }

  function overviewView(): OverviewView {
    const person = state.tickets.filter(item => item.stage === 'person').map(row)
    const problems: Problem[] = [...state.paused ? [{ kind: 'executor-paused' as const }] : [], ...state.overview.problems]
    return { ...state.overview, person, problems }
  }
  function forwarded(cellId: string, method: string, path: string, query: Record<string, string>, request: unknown): Reply {
    if (state.offline.has(cellId)) return fail(503, 'cell_unavailable', 'The cell has no live lease')
    const route = FORWARDED.find(item => {
      const [verb, pattern] = item.split(' ') as [string, string]
      const parts = pattern.split('/'), segments = path.split('/')
      return verb === method && parts.length === segments.length && parts.every((part, index) => part.startsWith(':') || part === segments[index])
    })
    if (!route) { misuse.push(`unknown forwarded route ${method} ${path}`); return fail(404, 'unknown_route') }
    const tenantId = state.cells.find(cell => cell.cellId === cellId)?.tenantId ?? ''
    if (method !== 'GET' && !MEMBER_WRITES.has(route) && !atLeast(roleOf(tenantId), 'tadmin')) return fail(403, 'forbidden', 'Forbidden')
    const id = decodeURIComponent(path.split('/')[1] ?? '')
    const index = state.tickets.findIndex(item => item.id === id)
    const found = state.tickets[index]
    const json = request as Record<string, unknown> | undefined
    switch (route) {
      case 'GET state': return answer<'GET state'>({
        setup: { machine: { stateDir: `/var/lib/dshsa/cells/${cellId}`, promptMaxChars: 20_000, admissionContextMaxPages: 5,
          admissionContextTimeoutMs: 10_000 }, problem: null, feishuProblem: null,
          accounts: { repository: 'acme/widgets', agent: 'dshsa-bot', feishu: null } },
        load: { running: 1, queued: 0, maxWorkers: 3 }, masterId: 'master', paused: state.paused, health: {} })
      case 'GET overview': return answer<'GET overview'>(overviewView())
      case 'GET tickets': {
        const filter = query.state ?? 'open'
        const items = state.tickets.filter(item => filter === 'open' ? item.state === 'open' : item.stage === filter).map(row)
        return answer<'GET tickets'>({ items, total: items.length, next_offset: null })
      }
      case 'GET tickets/:id': return found ? answer<'GET tickets/:id'>(found) : fail(404, 'Ticket not found')
      case 'POST tickets/:id/stop': {
        if (!found) return fail(404, 'Ticket not found')
        state.tickets[index] = { ...body(found), stage: 'ended', state: 'ended', actions: { retry: false, stop: false },
          ended: { at: '2026-10-30T11:00:00Z', by: 'human', outcome: 'stopped' } }
        return answer<'POST tickets/:id/stop'>({ stopped: true })
      }
      case 'POST tickets/:id/retry': return found ? answer<'POST tickets/:id/retry'>({ retried: true }) : fail(404, 'Ticket not found')
      case 'POST executor/pause': {
        if (typeof json?.paused !== 'boolean') { misuse.push(`executor/pause body ${JSON.stringify(request)}`); return fail(400, 'bad_request') }
        state.paused = json.paused
        return answer<'POST executor/pause'>({ paused: state.paused })
      }
      case 'POST triggers/:id/requeue': return answer<'POST triggers/:id/requeue'>({ queued: true })
      case 'POST decisions/:id/dismiss': return answer<'POST decisions/:id/dismiss'>({ dismissed: true })
      case 'GET settings': return answer<'GET settings'>({ policyVersion: 'abcdef0123', blocks: state.settings, sources: state.sources,
        environment: { root: '/mnt/work', variables: [] } })
      case 'PUT settings/:block': {
        if (id !== 'policy' && id !== 'eval' && id !== 'executor') return fail(404, 'Unknown settings block')
        const block = state.settings[id]
        if (typeof json?.revision !== 'number' || !('value' in (json ?? {}))) {
          misuse.push(`PUT settings/${id} body ${JSON.stringify(request)}`); return fail(400, 'bad_request')
        }
        if (json.revision !== block.revision) return fail(409, 'Settings changed elsewhere')
        if (id === 'policy' && state.policyIssues) {
          const issues = state.policyIssues
          state.policyIssues = undefined
          return { status: 400, body: { error: `Invalid settings: ${issues.map(issue => issue.path).join(', ')}`, issues } }
        }
        // The fake stores the value as sent; the host would validate it first.
        block.value = json.value as typeof block.value; block.revision += 1
        return answer<'PUT settings/:block'>({ revision: block.revision, restarting: false })
      }
      case 'GET prompts': return answer<'GET prompts'>({ revisions: [], next_offset: null, revision: state.prompts.revision, sessions: [],
        notificationPending: false, masterId: 'master', current: state.prompts, defaults: promptConfig(''),
        sections: ['communication', 'scope', 'delivery'], skillName: '^[a-z][a-z0-9-]*$', builtin: [], skillPrefix: 'dsh-superagent-',
        parts: [], defaultChanged: [] })
      case 'PUT prompts': {
        if (typeof json?.baseRevision !== 'number' || !('config' in (json ?? {}))) {
          misuse.push(`PUT prompts body ${JSON.stringify(request)}`); return fail(400, 'bad_request')
        }
        if (json.baseRevision !== state.prompts.revision) return fail(409, 'Prompts changed elsewhere')
        state.prompts = { ...state.prompts, revision: state.prompts.revision + 1, previousRevision: state.prompts.revision,
          config: json.config as PromptConfig }
        return answer<'PUT prompts'>({ revision: state.prompts.revision, context_delivery: 'pending' })
      }
      case 'POST policy-sync/:id': return answer<'POST policy-sync/:id'>({ policy: {} })
      case 'GET sources/github/collaborators': return answer<'GET sources/github/collaborators'>({ collaborators: state.collaborators })
      case 'GET sources/feishu/members': {
        const chat = query.chat ?? ''
        if (!/^oc_[A-Za-z0-9]+$/.test(chat)) { misuse.push(`feishu members chat ${chat}`); return fail(400, 'bad_request') }
        const tenant = state.cells.find(cell => cell.cellId === cellId)?.tenantId ?? ''
        if (!(state.bindings.get(tenant) ?? []).some(item => item.chatId === chat && item.cellId === cellId)) {
          return fail(403, 'chat_not_bound', 'This chat is not bound to this repository')
        }
        return answer<'GET sources/feishu/members'>({ members: state.members.get(chat) ?? [] })
      }
    }
  }

  /** control-api setup/claims.ts `cellsUsing`: the team's cells on an installation, except disabled ones. */
  function inUseBy(tenantId: string, installationId: number) {
    return state.cellRecords.filter(item => item.tenantId === tenantId && item.repo.installationId === installationId && item.status !== 'disabled')
      .map(item => ({ cellId: item.cellId, status: item.status, repo: `${item.repo.owner}/${item.repo.name}` }))
  }

  /** `/v1/tenants/{t}/setup/**` (control-api src/setup/tenant.ts): tenant admins of `t` and platform admins only. */
  function setup(method: string, tenantId: string, rest: string[], query: Record<string, string>, body: unknown): Reply {
    const tenant = state.tenants.find(item => item.tenantId === tenantId)
    if (!tenant || !atLeast(roleOf(tenantId), 'tadmin')) return fail(403, 'forbidden', 'You do not have access to this resource')
    const [a, b, c, d] = rest
    const route = `${method} ${rest.map(part => /^\d+$/.test(part) || part.includes('--') || part.startsWith('oc_') || part.includes('@') ? ':' : part).join('/')}`
    const bad = () => { misuse.push(`${route} body ${JSON.stringify(body)}`); return fail(400, 'bad_request') }
    const cells = () => state.cellRecords.filter(item => item.tenantId === tenantId)
    const strip = ({ tenantId: _t, ...cell }: SetupCell & { tenantId: string }): SetupCell => cell
    switch (route) {
      case 'GET ': {
        const claims = [...state.claims.values()].filter(item => item.tenantId === tenantId)
        return ok({ tenant: { tenantId, name: tenant.name }, role: roleOf(tenantId),
          github: { configured: state.oauthConfigured, installUrl: state.oauthConfigured ? 'https://github.com/apps/dshsa-agent/installations/new' : undefined },
          checklist: { appLinked: claims.some(item => item.status === 'active'), approvalPending: claims.some(item => item.status === 'pending'), repoAdded: cells().some(item => item.status !== 'disabled'),
            botConnected: state.feishu.get(tenantId)?.health?.state === 'ready', chatBound: (state.bindings.get(tenantId) ?? []).length > 0 },
          cells: cells().map(strip) })
      }
      case 'POST github/link-start': {
        if (!state.oauthConfigured) return fail(409, 'github_not_configured', 'A platform admin must finish Platform → GitHub App first')
        const nonce = NONCE(++state.nonceCount)
        state.nonces.set(nonce, tenantId)
        return ok({ url: `https://github.com/login/oauth/authorize?client_id=Iv23liAbcdef&redirect_uri=${encodeURIComponent('https://panel.test/setup/github/callback')}&state=${nonce}`,
          expiresInSec: 600 })
      }
      case 'POST github/link': {
        if (!shape(body, ['code', 'state'])) return bad()
        const { state: nonce } = body as { code: string; state: string }
        if (state.nonces.get(nonce) !== tenantId) return fail(400, 'invalid_state', 'This link expired or was already used; start “Link installations” again')
        state.nonces.delete(nonce)
        const login = state.githubLogin
        const installations = state.githubUser.map(install => {
          // control-api `control()`: a User install must be the user's own account; an Organization install needs an active admin.
          const decided: { status: 'active' | 'pending'; pendingReason?: string } = install.type === 'User'
            ? install.account.toLowerCase() === login.toLowerCase() ? { status: 'active' } : { status: 'pending', pendingReason: 'not_own_account' }
            : install.type !== 'Organization' ? { status: 'pending', pendingReason: 'unknown_account_type' }
            : install.admin === 'yes' ? { status: 'active' }
            : { status: 'pending', pendingReason: install.admin === 'no' ? 'not_org_admin' : 'membership_unavailable' }
          const held = state.claims.get(install.id)
          // onboarding `claim()`: another tenant's claim wins; a pending claim never replaces this tenant's active one.
          const keep = !!held && (held.tenantId !== tenantId || (held.status === 'active' && decided.status === 'pending'))
          const outcome = !keep ? decided.status : held!.tenantId !== tenantId ? 'other_tenant' as const : 'active' as const
          if (!keep) {
            state.claims.set(install.id, claim(install.id, tenantId, install.account, { status: decided.status,
              ...decided.pendingReason ? { pendingReason: decided.pendingReason } : {},
              accountType: install.type === 'Organization' ? 'Organization' : 'User', githubLogin: login, claimedBy: state.me.email }))
          }
          return { installationId: install.id, account: install.account, status: outcome, ...outcome === 'pending' ? { pendingReason: decided.pendingReason } : {} }
        })
        return ok({ installations })
      }
      case 'GET github/installations': return ok({ installations: [...state.claims.values()].filter(item => item.tenantId === tenantId) })
      case 'DELETE github/installations/:': {
        const id = Number(c)
        if (body !== undefined) return bad()
        if (state.claims.get(id)?.tenantId !== tenantId) return fail(403, 'not_claimed', 'This installation is not linked to your team')
        const using = inUseBy(tenantId, id)
        if (using.length) return fail(409, 'installation_in_use', `Repositories still use this installation (${using.map(item => item.repo).join(', ')}); disable them first`)
        state.claims.delete(id)
        return ok({ installationId: id, released: true })
      }
      case 'GET github/installations/:/repositories': {
        const id = Number(c)
        const held = state.claims.get(id)
        if (held?.tenantId !== tenantId) return fail(403, 'not_claimed', 'This installation is not linked to your team')
        if (held.status !== 'active') {
          // The panel must never ask: a pending claim shows no repository list.
          misuse.push(`repositories of pending installation ${id}`)
          return fail(403, 'claim_pending', 'This installation is waiting for platform approval')
        }
        const byRepo = new Map(cells().map(item => [item.repo.id, item]))
        return ok({ truncated: false, repositories: (state.repos.get(id) ?? []).map(repo => ({ ...repo,
          cell: byRepo.get(repo.id) ? { cellId: byRepo.get(repo.id)!.cellId, status: byRepo.get(repo.id)!.status } : undefined })) })
      }
      case 'POST cells': {
        if (!shape(body, ['installationId', 'repoId'])) return bad()
        const { installationId, repoId } = body as { installationId: unknown; repoId: unknown }
        if (typeof installationId !== 'number' || typeof repoId !== 'number') return bad()
        const held = state.claims.get(installationId)
        if (held?.tenantId !== tenantId) return fail(403, 'not_claimed', 'This installation is not linked to your team')
        if (held.status !== 'active') {
          misuse.push(`POST cells on pending installation ${installationId}`)
          return fail(403, 'claim_pending', 'This installation is waiting for platform approval')
        }
        const repo = state.repos.get(installationId)?.find(item => item.id === repoId)
        if (!repo) return fail(404, 'repo_not_found', 'That repository is not part of this installation')
        if (repo.archived) return fail(400, 'bad_request', 'Archived repositories cannot be added')
        const cellId = `${tenantId}--gh${repoId}`
        if (!state.cellRecords.some(item => item.cellId === cellId)) {
          state.cellRecords.push({ tenantId, cellId, status: 'active', repo: { owner: repo.owner, name: repo.name, id: repo.id, installationId } })
          state.cells.push({ cellId, tenantId, repo: { owner: repo.owner, name: repo.name, defaultBranch: repo.defaultBranch }, status: 'active' })
        }
        return ok({ cell: { cellId } })
      }
      case 'POST cells/:/pause': case 'POST cells/:/enable': case 'POST cells/:/disable': {
        const record = cells().find(item => item.cellId === b)
        if (!record) return fail(403, 'forbidden', 'You do not have access to this resource')
        record.status = c === 'pause' ? 'paused' : c === 'enable' ? 'active' : 'disabled'
        return ok({ cellId: record.cellId, status: record.status })
      }
      case 'GET feishu': return ok(state.feishu.get(tenantId) ?? { set: false })
      case 'PUT feishu': {
        if (!shape(body, ['domain', 'appId', 'appSecret'], ['encryptKey'])) return bad()
        const value = body as { domain: 'feishu' | 'lark'; appId: string; appSecret: string; encryptKey?: string }
        if (!/^cli_[A-Za-z0-9]+$/.test(value.appId) || value.appSecret.length < 8) return bad()
        state.secrets.push(value.appSecret, ...value.encryptKey ? [value.encryptKey] : [])
        state.feishu.set(tenantId, { set: true, domain: value.domain, appId: value.appId, revision: '2026-10-31T08:00:00Z',
          health: { state: 'starting', detail: 'Connecting', at: '2026-10-31T08:00:00Z' } })
        return ok({ set: true, domain: value.domain, appId: value.appId })
      }
      case 'GET chats': {
        const bound = new Map((state.bindings.get(tenantId) ?? []).map(item => [item.chatId, item]))
        const seen = state.chats.get(tenantId) ?? []
        return ok({ botSeen: seen.length > 0, chats: seen.map(chat => ({ ...chat, cellId: bound.get(chat.chatId)?.cellId })),
          cells: cells().filter(item => item.status !== 'disabled').map(item => ({ cellId: item.cellId, repo: `${item.repo.owner}/${item.repo.name}` })) })
      }
      case 'PUT chats/:': {
        if (!shape(body, ['cellId'])) return bad()
        const cellId = (body as { cellId: string }).cellId
        if (!cells().some(item => item.cellId === cellId)) return fail(400, 'bad_request', 'cellId is not a repository of this team')
        const chatId = b!
        const name = state.chats.get(tenantId)?.find(item => item.chatId === chatId)?.name
        state.bindings.set(tenantId, [...(state.bindings.get(tenantId) ?? []).filter(item => item.chatId !== chatId),
          { chatId, cellId, ...name ? { chatName: name } : {} }])
        return ok({ chatId, cellId })
      }
      case 'DELETE chats/:': {
        const list = state.bindings.get(tenantId) ?? []
        if (!list.some(item => item.chatId === b)) return fail(404, 'not_found', 'No such binding')
        state.bindings.set(tenantId, list.filter(item => item.chatId !== b))
        return ok({ removed: true })
      }
      case 'GET users': return ok({ users: state.users.get(tenantId) ?? [] })
      case 'POST users': {
        if (!shape(body, ['email', 'role'])) return bad()
        const value = body as { email: string; role: string }
        if (value.role !== 'member' && value.role !== 'tadmin') return bad()
        state.users.set(tenantId, [...(state.users.get(tenantId) ?? []).filter(item => item.email !== value.email),
          { email: value.email, role: value.role, status: 'FORCE_CHANGE_PASSWORD', enabled: true }])
        return ok(value)
      }
      case 'DELETE users/:': {
        if (b === state.me.email) return fail(400, 'bad_request', 'You cannot remove yourself')
        state.users.set(tenantId, (state.users.get(tenantId) ?? []).filter(item => item.email !== b))
        return ok({ removed: true })
      }
    }
    void d
    misuse.push(`unknown setup route ${route}`)
    return fail(404, 'not_found')
  }

  /** `/v1/admin/**` (control-api src/setup/platform.ts): platform admins only. */
  function admin(method: string, rest: string[], query: Record<string, string>, body: unknown): Reply {
    if (!state.me.platformAdmin) return fail(403, 'forbidden', 'You do not have access to this resource')
    const [a, b, c] = rest
    const bad = () => { misuse.push(`${method} /v1/admin/${rest.join('/')} body ${JSON.stringify(body)}`); return fail(400, 'bad_request') }
    if (a === 'tenants' && !b && method === 'GET') return ok({ tenants: state.tenants })
    if (a === 'tenants' && !b && method === 'POST') {
      if (!shape(body, ['tenantId', 'name'])) return bad()
      const { tenantId, name } = body as { tenantId: string; name: string }
      if (!/^[a-z][a-z0-9-]{2,30}$/.test(tenantId) || ['admin', 'tadmin', 'platform'].includes(tenantId)) return bad()
      if (state.tenants.some(item => item.tenantId === tenantId)) return fail(400, 'bad_request', `tenant ${tenantId} exists`)
      const tenant: TenantView = { tenantId, name, cognitoGroup: `dshsa-tenant-${tenantId}`, status: 'active', createdAt: AT }
      state.tenants.push(tenant)
      return ok({ tenant })
    }
    if (a === 'tenants' && b && (c === 'disable' || c === 'enable') && method === 'POST') {
      const tenant = state.tenants.find(item => item.tenantId === b)
      if (tenant) tenant.status = c === 'disable' ? 'disabled' : 'active'
      return ok({ tenantId: b, status: tenant?.status })
    }
    const scope = query.tenant ?? ''
    if (a === 'users' && !b && method === 'GET') return ok({ users: state.users.get(scope) ?? [] })
    if (a === 'users' && !b && method === 'POST') {
      const value = body as { email: string; role: string; tenantId?: string }
      if (value?.role === 'admin' ? !shape(body, ['email', 'role']) : !shape(body, ['email', 'role', 'tenantId'])) return bad()
      const key = value.role === 'admin' ? '' : value.tenantId!
      state.users.set(key, [...(state.users.get(key) ?? []).filter(item => item.email !== value.email),
        { email: value.email, role: value.role as PanelRole, status: 'FORCE_CHANGE_PASSWORD', enabled: true }])
      return ok({ email: value.email, role: value.role })
    }
    if (a === 'users' && b && !c && method === 'DELETE') {
      state.users.set(scope, (state.users.get(scope) ?? []).filter(item => item.email !== b))
      return ok({ removed: true })
    }
    if (a === 'github-app' && !b && method === 'GET') return ok(state.githubApp)
    if (a === 'github-app' && !b && method === 'PUT') {
      if (!shape(body, [], ['appId', 'privateKey', 'webhookSecret', 'clientId', 'clientSecret'])) return bad()
      const value = body as { appId?: string; privateKey?: string; webhookSecret?: string; clientId?: string; clientSecret?: string }
      if (value.privateKey && !value.appId) return fail(400, 'bad_request', 'appId: appId is required with privateKey')
      state.secrets.push(...[value.privateKey, value.webhookSecret, value.clientSecret].filter((item): item is string => !!item))
      const app = state.githubApp
      state.githubApp = { ...app, app: value.privateKey ? { ...app.app, set: true, appId: value.appId, keyValid: true } : app.app,
        oauth: value.clientId || value.clientSecret ? { set: true, clientId: value.clientId ?? app.oauth.clientId } : app.oauth }
      return ok(state.githubApp)
    }
    if (a === 'installations') {
      // platform.ts: every claim (`status=all`, the default) or pending only; approve → active (404 unless pending);
      // DELETE = reject/release (404 if none; 409 installation_in_use while the team's cells use it, unless `force=true`).
      if (!b && method === 'GET') {
        const status = query.status ?? 'all'
        if (status !== 'all' && status !== 'pending') { misuse.push(`GET /v1/admin/installations status=${status}`); return fail(400, 'bad_request', 'status is pending or all') }
        return ok({ installations: [...state.claims.values()].filter(item => status === 'all' || item.status === 'pending')
          .sort((x, y) => x.claimedAt.localeCompare(y.claimedAt))
          .map(item => ({ ...item, tenantName: state.tenants.find(t => t.tenantId === item.tenantId)?.name })) })
      }
      const id = Number(b)
      if (b && (!Number.isSafeInteger(id) || id <= 0)) { misuse.push(`installation id ${b}`); return fail(400, 'bad_request', 'Invalid installation id') }
      if (b && c === 'approve' && rest.length === 3 && method === 'POST') {
        if (!shape(body ?? {}, [])) return bad()
        const held = state.claims.get(id)
        if (held?.status !== 'pending') return fail(404, 'not_found', 'No pending claim for this installation')
        const { pendingReason: _reason, ...approved } = held
        state.claims.set(id, { ...approved, status: 'active', approvedBy: state.me.email, approvedAt: '2026-11-01T09:00:00Z' })
        return ok({ installationId: id, status: 'active' })
      }
      if (b && !c && method === 'DELETE') {
        if (query.force !== undefined && query.force !== 'true') { misuse.push(`release force=${query.force}`); return fail(400, 'bad_request') }
        const held = state.claims.get(id)
        if (!held) return fail(404, 'not_found', 'No such claim')
        const using = inUseBy(held.tenantId, id)
        if (using.length && !query.force) return fail(409, 'installation_in_use', `Repositories still use this installation (${using.map(item => item.repo).join(', ')}); disable them first`)
        state.claims.delete(id)
        return ok({ released: true, installationId: id, tenantId: held.tenantId, affectedCells: using })
      }
    }
    misuse.push(`unknown admin route ${method} /v1/admin/${rest.join('/')}`)
    return fail(404, 'not_found')
  }

  function handle(method: string, path: string, query: Record<string, string>, body: unknown): Reply {
    let match: RegExpExecArray | null
    if (method === 'GET' && path === '/v1/me') return ok(meView())
    if (method === 'GET' && path === '/v1/cells') {
      const visible = new Set(meView().tenants.map(item => item.tenantId))
      return ok({ cells: state.cells.filter(cell => visible.has(cell.tenantId)) })
    }
    if ((match = /^\/v1\/cells\/([^/]+)\/api\/(.+)$/.exec(path))) {
      const cellId = decodeURIComponent(match[1]!)
      if (state.forbidden.has(cellId) || !state.cells.some(cell => cell.cellId === cellId)) return fail(403, 'forbidden', 'Forbidden')
      return forwarded(cellId, method, match[2]!, query, body)
    }
    if (method === 'GET' && (match = /^\/v1\/cells\/([^/]+)\/tickets\/([^/]+)\/transcript$/.exec(path))) {
      if (state.forbidden.has(decodeURIComponent(match[1]!))) return fail(403, 'forbidden', 'Forbidden')
      return ok({ entries: state.transcript })
    }
    if (method === 'GET' && (match = /^\/v1\/tenants\/([^/]+)\/chat-bindings$/.exec(path))) {
      const tenantId = decodeURIComponent(match[1]!)
      if (!roleOf(tenantId)) return fail(403, 'forbidden', 'Forbidden')
      return ok({ bindings: state.bindings.get(tenantId) ?? [] })
    }
    if ((match = /^\/v1\/tenants\/([^/]+)\/setup(?:\/(.*))?$/.exec(path))) {
      return setup(method, decodeURIComponent(match[1]!), (match[2] ?? '').split('/').filter(Boolean).map(decodeURIComponent), query, body)
    }
    if ((match = /^\/v1\/admin\/(.+)$/.exec(path))) return admin(method, match[1]!.split('/').map(decodeURIComponent), query, body)
    misuse.push(`unknown route ${method} ${path}`)
    return fail(404, 'not_found')
  }

  state.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const method = (init.method ?? 'GET').toUpperCase()
    const headers = new Headers(init.headers)
    const label = `${method} ${url.pathname}`
    if (url.origin !== API) misuse.push(`request outside the panel API: ${url.href}`)
    if (headers.get('authorization') !== `Bearer ${ID_TOKEN}`) misuse.push(`missing or wrong bearer on ${label}`)
    if (headers.get('x-orchestrator-request') !== '1') misuse.push(`missing x-orchestrator-request on ${label}`)
    if ((method === 'GET' || method === 'DELETE') && init.body !== undefined) misuse.push(`body on ${label}`)
    let body: unknown
    if (init.body !== undefined) {
      if (headers.get('content-type') !== 'application/json') misuse.push(`non-JSON body on ${label}`)
      try { body = JSON.parse(String(init.body)) } catch { misuse.push(`unparseable body on ${label}`) }
    }
    const query = Object.fromEntries(url.searchParams)
    requests.push({ method, path: url.pathname, query, body })
    const reply = handle(method, url.pathname, query, body)
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return state
}
export type FakeApi = ReturnType<typeof createFakeApi>

/** The fake API of the running test (live binding, replaced before each test). */
export let api: FakeApi
/** Installs a fresh fake API before each test and fails the test if the panel misused it. */
export function useFakeApi() {
  beforeEach(() => { api = createFakeApi(); vi.stubGlobal('fetch', api.fetch) })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    expect(api.misuse, 'requests the panel-api allowlist rejects').toEqual([])
  })
}
