/** In-memory SourceContext and API fakes for Source tests. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReceiveResult, Thread, Ticket, Trigger } from '@dshsa/core'
import { threadKey } from '@dshsa/core'
import { ApiError, type CellInfo, type FeishuApi, type GithubApi, type Health, type SourceContext } from '@dshsa/core/host'

export const fixture = (path: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', path), 'utf8'))

export const CELL: CellInfo = {
  tenantId: 'acme', cellId: 'acme--gh812345', repository: 'acme/widgets', repoId: 812345, installationId: 4242, defaultBranch: 'main',
  app: { slug: 'dshsa-agent', login: 'dshsa-agent[bot]', userId: 99, noreply: '99+dshsa-agent[bot]@users.noreply.github.com' },
  feishu: { domain: 'feishu', appId: 'cli_app', botId: 'ou_bot', name: 'Agent' },
}
type Route = (path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => unknown
/** A GithubApi answering from `routes` (first matching prefix wins); unmatched paths are 404. */
export function fakeGithub(routes: Record<string, unknown | Route>): GithubApi & { calls: string[] } {
  const calls: string[] = []
  const answer = (path: string, init?: Parameters<Route>[1]) => {
    calls.push(`${init?.method ?? 'GET'} ${path}`)
    const hit = Object.keys(routes).filter(prefix => path.startsWith(prefix)).sort((a, b) => b.length - a.length)[0]
    if (hit === undefined) throw new ApiError(`Not Found ${path}`, 404)
    const value = routes[hit]
    return typeof value === 'function' ? (value as Route)(path, init) : value
  }
  return {
    calls,
    request: async (schema, path, init) => schema.parse(answer(path, init)),
    pages: async (schema, path) => (answer(path) as unknown[]).flatMap(item => { const parsed = schema.safeParse(item); return parsed.success ? [parsed.data] : [] }),
    raw: async (path, init) => {
      const value = answer(path, init)
      if (value && typeof value === 'object' && 'status' in value) return value as { status: number; headers: Record<string, string>; body: string }
      return { status: 200, headers: {}, body: JSON.stringify(value) }
    },
  }
}
export interface Fake extends SourceContext {
  stored: Trigger[]
  results: ReceiveResult[]
  threadMap: Map<string, Thread>
  kv: Map<string, unknown>
  reports: { entry: string; health: Health }[]
  bound: { id: string; thread: string; own: boolean }[]
  closed: { thread: string; outcome: string }[]
  openTickets: Ticket[]
}
export function fakeContext(options: { config?: Record<string, unknown>; feishuConfig?: Record<string, unknown>; github?: GithubApi;
  feishu?: FeishuApi; tickets?: Ticket[] } = {}): Fake {
  const stored: Trigger[] = []; const results: ReceiveResult[] = []
  const threadMap = new Map<string, Thread>(); const kv = new Map<string, unknown>()
  const reports: Fake['reports'] = []; const bound: Fake['bound'] = []; const closed: Fake['closed'] = []
  const openTickets = options.tickets ?? []
  const ctx: Fake = {
    stored, results, threadMap, kv, reports, bound, closed, openTickets,
    cell: CELL,
    apis: { github: options.github ?? fakeGithub({}), ...options.feishu ? { feishu: options.feishu } : {} },
    ready: Promise.resolve(),
    configured: () => true,
    config: <C extends Record<string, unknown>>(kind: string) =>
      (kind === 'github' ? { pollSeconds: 60, failuresBeforeError: 3, observeIssues: false, observePulls: false, observeComments: false, observeCi: false, repository: '', cli: '', ...options.config }
        : { chats: [], directMessages: true, otherChats: 'none', readPageSize: 20, linkTimeoutMs: 5000, cli: '', ...options.feishuConfig }) as unknown as C,
    receive(trigger) {
      if (stored.some(item => item.id === trigger.id)) { results.push('duplicate'); return 'duplicate' }
      stored.push(trigger)
      for (const ref of trigger.threads) {
        const k = threadKey(ref)
        if (!threadMap.has(k)) threadMap.set(k, { key: k, ref, createdAt: trigger.at, subscriptions: [], correlated: [], pending: [], meta: {} })
      }
      results.push('stored'); return 'stored'
    },
    atomic: work => work(),
    state: {
      get: key => kv.get(key) as never,
      set: (key, value) => { if (value === undefined) kv.delete(key); else kv.set(key, value) },
      keys: family => [...kv.keys()].filter(key => key.startsWith(family.prefix)) as never,
    },
    threads: {
      get: key => threadMap.get(key),
      subscribed: source => [...threadMap.values()].filter(thread => thread.ref.source === source && thread.subscriptions.length > 0),
      describe: () => {},
      patch: (key, meta) => { const thread = threadMap.get(key); if (thread) thread.meta = { ...thread.meta, ...meta } },
    },
    tickets: {
      get: id => openTickets.find(ticket => ticket.id === id),
      open: () => openTickets.filter(ticket => !ticket.ended),
      bindThread: (id, thread, own) => {
        bound.push({ id, thread: threadKey(thread), own })
        const ticket = openTickets.find(item => item.id === id)
        if (ticket) ticket.follows = [...ticket.follows ?? [], { thread: threadKey(thread), own }]
      },
      threadClosed: (thread, outcome) => { closed.push({ thread: threadKey(thread), outcome }) },
    },
    triggers: { get: id => stored.find(item => item.id === id), latest: thread => stored.filter(item => item.threads.some(ref => threadKey(ref) === thread)).at(-1) },
    notify: () => {},
    report: (entry, health) => { reports.push({ entry, health }) },
  }
  return ctx
}
/** A minimal open Ticket for PR binding tests. */
export const ticket = (id: string, fields: Partial<Ticket> = {}): Ticket => ({
  id, title: id, decisionId: 'd', mandate: {} as Ticket['mandate'], channels: [], assignments: [], inputs: [], undelivered: [],
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', origin: { triggerId: 'origin', triggerIds: ['origin'] }, ...fields,
})
