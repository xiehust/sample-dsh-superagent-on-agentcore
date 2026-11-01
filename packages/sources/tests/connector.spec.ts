import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CellEnvelope, ConnectorContext, TenantRecord } from '@dshsa/contracts'
import type { FeishuApi } from '@dshsa/core/host'
import { createFeishuConnector, STATE_KEY, type ConnectorState, type LiveClient, type LiveHandlers } from '../src/connector/index.ts'
import { fixture } from './fakes.ts'

const TENANT: TenantRecord = { tenantId: 'acme', name: 'Acme', cognitoGroup: 'dshsa-tenant-acme', status: 'active',
  feishu: { domain: 'feishu', appId: 'cli_app', secretArn: 'arn:aws:secretsmanager:ap-northeast-1:1:secret:dshsa/feishu/acme' }, createdAt: '2026-11-01T00:00:00Z' }
const raw = (messageId: string, chatId = 'oc_team') => {
  const event = structuredClone(fixture('feishu/receive.group-mention.json')) as { message: Record<string, unknown> }
  event.message.message_id = messageId; event.message.chat_id = chatId
  return event
}
const historyItem = (messageId: string, chatId = 'oc_team', extra: Record<string, unknown> = {}) =>
  ({ ...fixture('feishu/history.item.json') as object, message_id: messageId, chat_id: chatId, create_time: String(Date.now()), thread_id: undefined, ...extra })

class FakeLive implements LiveClient {
  handlers: LiveHandlers | undefined
  closed = false
  async start(handlers: LiveHandlers) { this.handlers = handlers }
  close() { this.closed = true }
}
type Params = Record<string, string>
function setup(options: { bound?: Record<string, string>; messages?: (params: Params) => unknown; kv?: ConnectorState } = {}) {
  const lives: FakeLive[] = []
  const enqueued: CellEnvelope[] = []
  const listed: Params[] = []
  const kv = new Map<string, string>(options.kv ? [[STATE_KEY, JSON.stringify(options.kv)]] : [])
  const bound = options.bound ?? { oc_team: 'acme--gh812345' }
  const api: FeishuApi = {
    async request(schema, _method, path, init) {
      if (path === '/open-apis/bot/v3/info') return schema.parse({ bot: { open_id: 'ou_bot', app_name: 'Agent' } })
      if (path === '/open-apis/im/v1/chats') return schema.parse({ items: [{ chat_id: 'oc_team', name: 'Team' }] })
      if (path === '/open-apis/im/v1/messages') { listed.push(init!.params!); return schema.parse(options.messages?.(init!.params!) ?? { items: [] }) }
      throw new Error(`unexpected ${path}`)
    },
  }
  const controller = new AbortController()
  const ctx: ConnectorContext = {
    tenant: TENANT, secrets: { appId: 'cli_app', appSecret: 'secret' },
    route: async chatId => bound[chatId], boundChats: async () => Object.keys(bound),
    enqueue: async (_cell, envelope) => { enqueued.push(envelope) },
    kv: { get: async key => kv.get(key), put: async (key, value) => { kv.set(key, value) } },
    log: { debug() {}, info() {}, warn() {}, error() {} }, signal: controller.signal,
  }
  const connector = createFeishuConnector(TENANT, { live: () => { const live = new FakeLive(); lives.push(live); return live },
    api: () => api, backfillMs: 30, retryMs: () => 10 })
  const state = () => JSON.parse(kv.get(STATE_KEY) ?? '{}') as ConnectorState
  return { connector, ctx, lives, enqueued, listed, kv, state, controller }
}
let running: { stop(): Promise<void> } | undefined
afterEach(async () => { await running?.stop(); running = undefined })

describe('Feishu Connector', () => {
  it('enqueues a bound chat\'s message on its cell queue and only records an unbound chat\'s', async () => {
    const t = setup()
    await t.connector.start(t.ctx); running = t.connector
    await vi.waitFor(() => expect(t.lives[0]?.handlers).toBeDefined())
    await t.lives[0]!.handlers!.onEvent(raw('om_1'))
    await t.lives[0]!.handlers!.onEvent(raw('om_2', 'oc_elsewhere'))
    await vi.waitFor(() => expect(t.state().chats.oc_elsewhere).toMatchObject({ routed: false, unrouted: 1 }))
    expect(t.enqueued).toEqual([{ v: 1, id: 'feishu:om_1', cellId: 'acme--gh812345', type: 'source.event', at: expect.any(String),
      body: { source: 'feishu', kind: 'im.message.receive_v1', deliveryId: 'om_1', payload: raw('om_1') } }])
    expect(t.state().chats.oc_team).toMatchObject({ routed: true, cellId: 'acme--gh812345', direct: false })
  })
  it('gives a message the same envelope id live and in backfill, and starts each chat\'s cursor at its first visit', async () => {
    let round = 0
    const t = setup({ messages: params => params.container_id_type === 'chat' ? { items: round++ === 0 ? [historyItem('om_1')] : [] } : { items: [] } })
    await t.connector.start(t.ctx); running = t.connector
    await vi.waitFor(() => expect(t.lives[0]?.handlers).toBeDefined())
    await t.lives[0]!.handlers!.onEvent(raw('om_1'))
    // The first backfill (after `ready`) only sets the cursor; the next one reads from it.
    await vi.waitFor(() => expect(t.listed.length).toBeGreaterThan(0), { timeout: 2000 })
    await vi.waitFor(() => expect(t.enqueued.length).toBe(2), { timeout: 2000 })
    expect(t.enqueued.map(item => item.id)).toEqual(['feishu:om_1', 'feishu:om_1'])
    expect(t.enqueued[1]!.body).toMatchObject({ kind: 'backfill.message', deliveryId: 'om_1' })
    const first = t.listed[0]!
    expect(Number(first.start_time)).toBeLessThanOrEqual(Number(first.end_time))
    await vi.waitFor(() => expect(Date.parse(t.state().history.oc_team!)).toBeGreaterThanOrEqual(Number(first.end_time) * 1000 - 5000))
  })
  it('keeps the cursor and reports an error when history pagination does not advance', async () => {
    const t = setup({ kv: { chats: {}, history: { oc_team: '2026-11-01T00:00:00.000Z' }, topics: {} },
      messages: () => ({ items: [], has_more: true }) })
    await t.connector.start(t.ctx); running = t.connector
    await vi.waitFor(() => expect(t.lives[0]?.handlers).toBeDefined())
    t.lives[0]!.handlers!.onState('ready')
    await vi.waitFor(() => expect(t.state().health).toMatchObject({ state: 'error', detail: expect.stringContaining('did not advance') }), { timeout: 2000 })
    expect(t.state().history.oc_team).toBe('2026-11-01T00:00:00.000Z')
  })
  it('restarts the long connection after it fails and backfills once it is back', async () => {
    const t = setup({ kv: { chats: {}, history: { oc_team: new Date(Date.now() - 60_000).toISOString() }, topics: {} } })
    await t.connector.start(t.ctx); running = t.connector
    await vi.waitFor(() => expect(t.lives[0]?.handlers).toBeDefined())
    t.lives[0]!.handlers!.onState('error', 'gateway closed')
    await vi.waitFor(() => expect(t.lives).toHaveLength(2))
    expect(t.lives[0]!.closed).toBe(true)
    const before = t.listed.length
    t.lives[1]!.handlers!.onState('reconnected')
    await vi.waitFor(() => expect(t.listed.length).toBeGreaterThan(before))
    expect(t.state().health?.state).toBe('ready')
  })
  it('drops the bot\'s own messages and stops cleanly', async () => {
    const t = setup()
    await t.connector.start(t.ctx); running = t.connector
    await vi.waitFor(() => expect(t.lives[0]?.handlers).toBeDefined())
    const mine = raw('om_mine') as { sender?: { sender_id: { open_id: string } } }
    mine.sender!.sender_id.open_id = 'ou_bot'
    await t.lives[0]!.handlers!.onEvent(mine)
    await t.connector.stop(); running = undefined
    expect(t.enqueued).toEqual([])
    expect(t.lives[0]!.closed).toBe(true)
  })
})
