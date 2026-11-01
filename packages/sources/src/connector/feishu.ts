/**
 * Tenant-level Feishu/Lark Connector (parent design §4.8, research/00-synthesis.md §7).
 *
 * One per tenant, single-active under the host's `connector#<tenantId>` lease. It keeps the bot's long connection (Feishu
 * delivers each event of an app to one of its connections only, so there must be exactly one), backfills chat history every
 * 60 s with DSH's cursor rules (`feishu-loops.ts`), and routes each message by its chat:
 * - a chat bound to a cell (`dshsa-routes` `fs#<tenantId>#<chatId>`): enqueue a `source.event` on that cell's queue;
 * - an unbound chat: record it in the Connector's KV (so the panel can offer it for binding) and do nothing else.
 * Envelope ids are `feishu:<message_id>` on the live and the backfill path alike, so the FIFO queue drops the second copy within
 * its five-minute window and the cell's Trigger id (`key('feishu', message_id)`) drops any later one.
 */
import { z } from 'zod'
import type { CellEnvelope, Connector, ConnectorContext, FeishuSecrets, TenantRecord } from '@dshsa/contracts'
import { envelopeId } from '@dshsa/contracts'
import type { FeishuApi } from '@dshsa/core/host'
import { FeishuClient, feishuBotInfo } from '../apis/feishu.ts'
import { cursorAt, pause, POLL_HORIZON_MS } from '../poll.ts'
import { listMessages } from '../feishu/read.ts'
import { feishuTime, historyAsEvent, sdkEvent, type HistoricalMessage } from '../feishu/trigger.ts'
import { absent, listOf } from '../feishu/wire.ts'
import { larkLiveClient } from './lark.ts'

export type LiveState = 'ready' | 'reconnecting' | 'reconnected' | 'error'
export interface LiveHandlers {
  onEvent(raw: unknown): Promise<void>
  onState(state: LiveState, detail?: string): void
}
/** The long connection: `start` resolves once connected (or throws); `onState('error')` means the client gave up. */
export interface LiveClient { start(handlers: LiveHandlers): Promise<void>; close(): void }
export type LiveClientFactory = (tenant: TenantRecord, secrets: FeishuSecrets) => LiveClient
export interface FeishuConnectorOptions {
  live?: LiveClientFactory
  api?: (tenant: TenantRecord, secrets: FeishuSecrets) => FeishuApi
  backfillMs?: number
  /** Restart delay after the live client fails: DSH `consumerRetry` by default. */
  retryMs?: (previous: number | undefined, ranMs: number) => number
  now?: () => number
}
/** Wait before restarting the live client: 1 s after a run that stayed up for a minute, otherwise exponential backoff up to 60 s (DSH). */
export const consumerRetry = (previous: number | undefined, ranMs: number): number =>
  previous === undefined || ranMs >= 60_000 ? 1000 : Math.min(previous * 2, 60_000)

/** What the Connector remembers about a chat; `routed` is false for a chat no cell is bound to. */
export interface ChatRecord { direct: boolean; name?: string; lastAt?: string; routed?: boolean; unrouted?: number; cellId?: string }
export interface ConnectorState {
  chats: Record<string, ChatRecord>
  /** DSH `feishu-history:<chat>`: the backfill cursor of each chat. */
  history: Record<string, string>
  /** DSH `feishu-history-threads:<chat>`: active topics, by id, with when each was last seen. */
  topics: Record<string, Record<string, string>>
  health?: { state: 'starting' | 'ready' | 'error'; detail: string; at: string }
}
export const STATE_KEY = 'state'
const empty = (): ConnectorState => ({ chats: {}, history: {}, topics: {} })
const ChatsPage = z.looseObject({ items: listOf(z.looseObject({ chat_id: z.string(), name: absent(z.string()) })) })
const EVENT = 'im.message.receive_v1'
const BACKFILL = 'backfill.message'

export function createFeishuConnector(tenant: TenantRecord, options: FeishuConnectorOptions = {}): Connector {
  const live = options.live ?? larkLiveClient
  const backfillMs = options.backfillMs ?? 60_000
  const retry = options.retryMs ?? consumerRetry
  const now = options.now ?? Date.now
  let controller: AbortController | undefined
  let running: Promise<unknown> | undefined
  let client: LiveClient | undefined

  return {
    key: `connector#${tenant.tenantId}`,
    async start(ctx: ConnectorContext): Promise<void> {
      if (controller) throw new Error('The connector is already running')
      if (!tenant.feishu) throw new Error(`Tenant ${tenant.tenantId} has no Feishu bot`)
      controller = new AbortController()
      const signal = AbortSignal.any([controller.signal, ctx.signal])
      const domain = tenant.feishu.domain
      const api = options.api?.(tenant, ctx.secrets) ?? new FeishuClient({ domain, appId: ctx.secrets.appId, appSecret: ctx.secrets.appSecret })
      const bot = await feishuBotInfo(api)
      const state: ConnectorState = { ...empty(), ...JSON.parse(await ctx.kv.get(STATE_KEY) ?? '{}') as Partial<ConnectorState> }
      // Writes are serialized; only the lease owner runs, so the last write wins.
      let saving = Promise.resolve()
      let dirty = false
      const save = (): Promise<void> => {
        dirty = true
        saving = saving.then(async () => {
          if (!dirty) return
          dirty = false
          await ctx.kv.put(STATE_KEY, JSON.stringify(state)).catch(error => { dirty = true; ctx.log.warn('feishu.kv.save', { error: String(error) }) })
        })
        return saving
      }
      const report = (health: 'starting' | 'ready' | 'error', detail: string) => {
        state.health = { state: health, detail, at: new Date(now()).toISOString() }
        ctx.log[health === 'error' ? 'warn' : 'info']('feishu.health', { tenant: tenant.tenantId, state: health, detail })
      }
      const own = (sender: string) => sender === bot.openId || sender === ctx.secrets.appId

      /** Routes one message (raw receive_v1 shape); returns whether it was enqueued. */
      const route = async (raw: unknown, kind: typeof EVENT | typeof BACKFILL): Promise<boolean> => {
        let event
        try { event = sdkEvent(raw) } catch (error) { ctx.log.warn('feishu.event.unreadable', { error: String(error) }); return false }
        if (own(event.sender_id)) return false
        const chatId = event.chat_id
        const direct = event.chat_type === 'p2p'
        const record = state.chats[chatId] ?? { direct }
        record.direct = direct
        record.lastAt = feishuTime(event.create_time)
        const cellId = await ctx.route(chatId)
        state.chats[chatId] = record
        if (!cellId) {
          record.routed = false
          record.unrouted = (record.unrouted ?? 0) + 1
          delete record.cellId
          ctx.log.info('feishu.unrouted', { tenant: tenant.tenantId, chatId, messageId: event.message_id, direct })
          return false
        }
        record.routed = true
        record.cellId = cellId
        const envelope: CellEnvelope = { v: 1, id: envelopeId.source('feishu', event.message_id), cellId, type: 'source.event',
          at: new Date(now()).toISOString(), body: { source: 'feishu', kind, deliveryId: event.message_id, payload: raw } }
        await ctx.enqueue(cellId, envelope)
        return true
      }

      let backfilling: Promise<void> | undefined
      /** One backfill round; a round that is already running is joined rather than doubled. */
      const backfill = (): Promise<void> => backfilling ??= backfillRound().finally(() => { backfilling = undefined })
      const backfillRound = async (): Promise<void> => {
        const errors: string[] = []
        // Names are a display aid for the panel's binding list; a failed read keeps the stored ones.
        try {
          const page = await api.request(ChatsPage, 'GET', '/open-apis/im/v1/chats', { params: { page_size: '100' } })
          for (const chat of page.items) {
            const record = state.chats[chat.chat_id] ??= { direct: false }
            if (chat.name) record.name = chat.name
          }
        } catch (error) { ctx.log.debug('feishu.chats.refresh', { error: String(error) }) }
        const bound = new Set(await ctx.boundChats())
        const chats = new Map<string, boolean>([...bound].map(chatId => [chatId, state.chats[chatId]?.direct ?? false]))
        for (const [chatId, record] of Object.entries(state.chats)) {
          if (record.direct && bound.has(chatId)) chats.set(chatId, true)
          if (record.routed && !bound.has(chatId)) { record.routed = false; delete record.cellId }
        }
        for (const [chatId, direct] of chats) {
          if (signal.aborted) return
          const started = new Date(now()).toISOString()
          const since = state.history[chatId]
          // The first visit sets the cursor only: earlier history is not taken in, as in DSH.
          if (since === undefined) { state.history[chatId] = started; continue }
          try {
            await backfillChat(chatId, direct, since, started)
            if (!signal.aborted) state.history[chatId] = cursorAt(started)
          } catch (error) { if (!signal.aborted) errors.push(`${chatId}: ${String(error)}`) }
        }
        if (signal.aborted) return
        if (errors.length) report('error', errors.join('\n')); else if (state.health?.state !== 'error' || connected) report('ready', 'Listening and recovered bound chats')
        await save()
      }
      /** DSH `backfillChat`: the chat between `since` and `until`, then each active topic, before the cursor moves. */
      const backfillChat = async (chatId: string, direct: boolean, since: string, until: string): Promise<void> => {
        const topics = { ...state.topics[chatId] }
        const scan = async (kind: 'chat' | 'thread', id: string): Promise<void> => {
          let page: string | undefined
          const pages = new Set<string>()
          do {
            signal.throwIfAborted()
            const seconds = (time: string) => String(Math.floor(Date.parse(time) / 1000))
            const result = await listMessages(api, { container_id_type: kind, container_id: id, start_time: seconds(since), end_time: seconds(until),
              sort_type: 'ByCreateTimeAsc', page_size: '50', ...page ? { page_token: page } : {} })
            for (const message of result.items as HistoricalMessage[]) {
              const outside = message.chat_id !== chatId || (kind === 'thread' && message.thread_id !== id)
              if (outside) throw new Error('Feishu history returned a message outside the requested chat or thread')
              if (message.deleted) continue
              const at = feishuTime(message.create_time)
              if (message.thread_id && !(Date.parse(topics[message.thread_id] ?? '') >= Date.parse(at))) topics[message.thread_id] = at
              await route(historyAsEvent(message, direct), BACKFILL)
            }
            const stuck = result.has_more && (!result.page_token || pages.has(result.page_token))
            if (stuck) throw new Error('Feishu history pagination did not advance')
            page = result.has_more ? result.page_token : undefined
            if (page) pages.add(page)
          } while (page)
        }
        await scan('chat', chatId)
        // A quiet topic is forgotten after the polling horizon (the cell's subscriptions are not visible here).
        for (const [id, seen] of Object.entries(topics)) if (Date.parse(until) - Date.parse(seen) >= POLL_HORIZON_MS) delete topics[id]
        state.topics[chatId] = topics
        for (const id of Object.keys(topics)) await scan('thread', id)
        state.topics[chatId] = topics
      }

      let connected = false
      const supervise = async (): Promise<void> => {
        let delay: number | undefined
        while (!signal.aborted) {
          const began = now()
          const failed = new Promise<string>(resolve => {
            const current = live(tenant, ctx.secrets)
            client = current
            let chain = Promise.resolve()
            const handlers: LiveHandlers = {
              onEvent: raw => (chain = chain.then(async () => { await route(raw, EVENT); await save() })
                .catch(error => { ctx.log.warn('feishu.event.failed', { error: String(error) }) })),
              onState: (value, detail) => {
                if (value === 'ready' || value === 'reconnected') {
                  connected = true
                  report('ready', 'Listening for bot events')
                  // Close the gap the connection was down for.
                  void backfill().catch(error => { ctx.log.warn('feishu.backfill.failed', { error: String(error) }) })
                } else if (value === 'reconnecting') { connected = false; report('starting', 'Reconnecting') }
                else { connected = false; resolve(detail ?? 'The Feishu long connection failed') }
              },
            }
            current.start(handlers).then(() => { if (!connected) handlers.onState('ready') }, error => resolve(String(error)))
            signal.addEventListener('abort', () => resolve('stopped'), { once: true })
          })
          const reason = await failed
          client?.close()
          client = undefined
          if (signal.aborted) return
          report('error', reason)
          delay = retry(delay, now() - began)
          await pause(delay, signal)
        }
      }
      const loop = async (): Promise<void> => {
        while (!signal.aborted) {
          await pause(backfillMs, signal)
          if (signal.aborted) return
          await backfill().catch(error => { report('error', String(error)) })
        }
      }
      report('starting', 'Connecting')
      running = Promise.allSettled([supervise(), loop()]).then(async () => { await backfilling?.catch(() => {}); await save() })
    },
    async stop(): Promise<void> {
      controller?.abort()
      client?.close()
      await running
      controller = undefined
      running = undefined
    },
  }
}
