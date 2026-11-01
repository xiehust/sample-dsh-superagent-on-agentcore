/**
 * Feishu/Lark source kind for a dshsa cell.
 * Ported from dsh-superagent `src/sources/feishu.ts` (MIT, DeepSeek Harness Team). Deltas:
 * - Intake: the tenant-level Connector (`../connector`) owns the long connection and the 60 s backfill, and enqueues each
 *   message of a chat bound to this cell as a `source.event`; `ingest` turns it into the DSH Trigger (same id, same thread key).
 *   The cell runs no Feishu loop.
 * - The bot `lark-cli` field is gone: the tenant's bot credentials live in Secrets Manager. `cli` stays in the schema, unused,
 *   so stored DSH settings still parse.
 * - Binding a chat to the cell (panel) adds it to `chats`; `scope`, the admission rows and replies read `chats` as DSH did.
 */
import { z } from 'zod'
import type { SourceEventBody } from '@dshsa/contracts'
import { threadKey, type Trigger } from '@dshsa/core'
import { sourceContext, type FeishuApi, type Localized, type SourceContext, type SourceHost, type SourceKind } from '@dshsa/core/host'
import { KV } from '../kv.ts'
import { feishuChatLink, feishuLink, sendFeishu } from './channel.ts'
import { feishuThreadContext } from './read.ts'
import { feishuTriggerId, receiveTrigger, SOURCE } from './trigger.ts'
import { absent, flagOr, listOf, textOr } from './wire.ts'

/** `source.event` kinds the Connector sends: a live event, and a history item converted to the live event's shape. */
export const FEISHU_EVENT_KINDS = ['im.message.receive_v1', 'backfill.message'] as const
const MembersPage = z.looseObject({ items: listOf(z.looseObject({ member_id: z.string(), name: textOr })),
  has_more: flagOr, page_token: absent(z.string()) })
const ChatsPage = z.looseObject({ items: listOf(z.looseObject({ chat_id: z.string(), name: absent(z.string()) })),
  has_more: flagOr, page_token: absent(z.string()) })
const FeishuConfigSchema = z.object({
  cli: z.string().trim().default(''),
  readPageSize: z.number().int().min(1).max(50).default(20),
  linkTimeoutMs: z.number().int().min(1).max(90000).default(5000),
  chats: z.array(z.object({ chatId: z.string().regex(/^oc_[a-zA-Z0-9]+$/), name: z.string().trim().max(60).optional(), listen: z.enum(['mentions', 'all']) }).strict())
    .refine(chats => new Set(chats.map(chat => chat.chatId)).size === chats.length, 'Duplicate chat IDs')
    .default([]),
  directMessages: z.boolean().default(true),
  otherChats: z.enum(['none', 'mentions']).default('none'),
}).strict()
export type FeishuConfig = z.infer<typeof FeishuConfigSchema>
const feishuOf = (ctx: Pick<SourceContext, 'apis'>): FeishuApi => {
  if (!ctx.apis.feishu) throw new Error('The tenant has no Feishu bot')
  return ctx.apis.feishu
}
/** Every page of a Feishu list endpoint. */
async function allPages<T extends { has_more: boolean; page_token?: string | undefined; items: unknown[] }>(api: FeishuApi,
  schema: z.ZodType<T>, path: string, params: Record<string, string>, signal?: AbortSignal): Promise<T['items']> {
  const items: T['items'] = []
  let token: string | undefined
  const seen = new Set<string>()
  do {
    signal?.throwIfAborted()
    const page = await api.request(schema, 'GET', path, { params: { page_size: '100', ...params, ...token ? { page_token: token } : {} } })
    items.push(...page.items)
    if (page.has_more && (!page.page_token || seen.has(page.page_token))) throw new Error('Feishu pagination did not advance')
    token = page.has_more ? page.page_token : undefined
    if (token) seen.add(token)
  } while (token)
  return items
}
/** A Feishu chat id (`oc_…`), the only kind of id `chatMembers` accepts. */
const ChatId = z.string().regex(/^oc_[A-Za-z0-9]+$/)
/**
 * The people in a chat as `[{id: ou_…, name}]` (`GET /im/v1/chats/:id/members?member_id_type=open_id`, every page), in
 * Feishu's order and without duplicates. The open_ids are the ones this bot sees, which is what the Feishu Policy's
 * `allowed` entries need; bots in the chat are not listed. Needs the bot's "Obtain group members" scope.
 */
export async function chatMembers(api: FeishuApi, chatId: string, signal?: AbortSignal): Promise<{ id: string; name: string }[]> {
  const chat = ChatId.parse(chatId)
  const members = await allPages(api, MembersPage, `/open-apis/im/v1/chats/${encodeURIComponent(chat)}/members`, { member_id_type: 'open_id' }, signal)
  const seen = new Map<string, string>()
  for (const member of members) if (member.member_id.startsWith('ou_') && !seen.has(member.member_id)) seen.set(member.member_id, member.name)
  return [...seen].map(([id, name]) => ({ id, name }))
}
/** Refreshes the map of chats the bot has joined (`chat_id -> name`); throws on failure so the stored list remains intact. */
export async function refreshChatNames(ctx: SourceContext, signal?: AbortSignal): Promise<Record<string, string>> {
  const chats = await allPages(feishuOf(ctx), ChatsPage, '/open-apis/im/v1/chats', {}, signal)
  const names = Object.fromEntries(chats.filter(chat => chat.name).map(chat => [chat.chat_id, chat.name!]))
  ctx.state.set(KV.sources.labels(SOURCE), names)
  return names
}
async function receive(ctx: SourceContext, trigger: Trigger): Promise<void> {
  await ctx.receive(trigger)
  const chatId = String(trigger.meta.chatId ?? '')
  if (!chatId) return
  const chats = ctx.state.get(KV.feishu.chats) ?? {}
  if (chats[chatId] !== (trigger.meta.direct === true)) ctx.state.set(KV.feishu.chats, { ...chats, [chatId]: trigger.meta.direct === true })
  const name = ctx.state.get(KV.sources.labels(SOURCE))?.[chatId] ?? chatId
  const chat = trigger.meta.direct === true ? { value: { zh: '私聊', en: 'Direct message' } } : { value: name }
  const url = feishuChatLink(ctx.cell.feishu?.domain ?? 'feishu', chatId)
  for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { url, facts: { chat } })
}
/** Applies one Connector delivery; idempotent, since the Trigger id is `key('feishu', message_id)` on every path. */
export async function ingestFeishu(event: SourceEventBody, ctx: SourceContext): Promise<void> {
  if (event.source !== SOURCE || !(FEISHU_EVENT_KINDS as readonly string[]).includes(event.kind)) return
  const bot = ctx.cell.feishu
  if (!bot) throw new Error('The tenant has no Feishu bot')
  // A message read while the Source is off is dropped, as DSH dropped events read while disabled.
  if (!ctx.config<FeishuConfig>(SOURCE)) return
  const trigger = receiveTrigger(event.payload, bot.botId, bot.appId)
  if (trigger) await receive(ctx, trigger)
}

export const feishuKind: SourceKind<FeishuConfig> = {
  kind: SOURCE,
  refreshLabels: (host: SourceHost, signal?: AbortSignal) => refreshChatNames(sourceContext(host, feishuKind), signal),
  title: { zh: '飞书', en: 'Feishu' },
  description: { zh: '接收绑定到这个仓库的群和私聊里发给机器人的消息；租户的连接器负责长连接和补收。', en: 'Receives messages to the bot in the chats and direct messages bound to this repository; the tenant\'s connector keeps the long connection and recovers history.' },
  schema: FeishuConfigSchema,
  fields: [
    { key: 'chats', type: 'rows', label: { zh: '接收的群', en: 'Chats' },
      hint: { zh: '“仅 @”只接收 @ 机器人的消息和已有工单的线程；“全部消息”也接收其余消息，评估可以按规则从中推断工作，需要机器人有读取全部消息的权限。', en: '"@ only" receives messages that mention the bot and Threads that have Tickets; "All" also receives the rest, from which Eval may infer work under the rules; the bot needs permission to read all messages.' },
      columns: [
        { key: 'chatId', type: 'text', label: { zh: '群', en: 'Chat' }, pattern: 'oc_[a-zA-Z0-9]+', choose: { zh: '选择机器人已加入的群', en: 'Choose a chat the bot has joined' }, refresh: { zh: '刷新群列表', en: 'Refresh chats' } },
        { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [{ value: 'mentions', label: { zh: '仅 @', en: '@ only' } }, { value: 'all', label: { zh: '全部消息', en: 'All' } }] },
      ] },
    { key: 'otherChats', type: 'select', label: { zh: '其他群', en: 'Other chats' }, options: [{ value: 'none', label: { zh: '不接收', en: 'Not received' } }, { value: 'mentions', label: { zh: '仅 @', en: '@ only' } }],
      hint: { zh: '绑定到这个仓库、但没列在上面的群。“仅 @”接收那里 @ 机器人的消息；谁的消息能发起工作看策略里的准入。', en: 'Chats bound to this repository that are not listed above. "@ only" receives messages there that mention the bot; whose messages may originate work is the Policy\'s admission.' } },
    { key: 'directMessages', type: 'switch', label: { zh: '接收私聊', en: 'Direct messages' } },
    { key: 'readPageSize', type: 'number', advanced: true, min: 1, max: 50, label: { zh: '每页消息数', en: 'Messages per page' }, hint: { zh: '智能体读取线程和群历史时，每页的消息数。', en: 'Messages per page when agents read Threads and chat history.' } },
  ],
  health: ['feishu', 'history'],
  scope({ meta }, config) {
    if (meta.direct === true) return config.directMessages ? { listened: true, observed: false, row: 'direct' } : { listened: false, reason: 'direct_messages_not_allowed' }
    const chat = config.chats.find(item => item.chatId === meta.chatId)
    if (chat) return { listened: true, observed: chat.listen === 'all', row: chat.chatId }
    return config.otherChats === 'mentions' ? { listened: true, observed: false, row: 'other' } : { listened: false, reason: 'chat_not_allowed' }
  },
  // A reply goes only to a chat the Source still receives.
  channel: {
    allowed: (address, config) =>
      feishuKind.scope!({ meta: { chatId: address.chatId ?? '', direct: address.direct === 'true' } }, config).listened,
    send: sendFeishu, link: feishuLink,
  },
  threadContext: feishuThreadContext,
  find: query => ({ threads: [], terms: [...new Set(query.match(/om_[A-Za-z0-9_-]+/g) ?? [])] }),
  // A message's Trigger is named after the message, so the one it answers is named after its parent.
  repliesTo: trigger => typeof trigger.meta.parentId === 'string' ? feishuTriggerId(trigger.meta.parentId) : undefined,
  policy: {
    unnamed: { person: { zh: '飞书用户', en: 'Feishu user' }, bot: { zh: '飞书机器人', en: 'Feishu bot' } },
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(/^ou_[a-zA-Z0-9]+$/), name: z.string().trim().max(100).optional() }).strict())
        .refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate open_ids').default([]),
      syncChat: z.string().regex(/^(oc_[a-zA-Z0-9]+)?$/).default(''),
      bots: z.array(z.object({ id: z.string().regex(/^(cli|ou)_[a-zA-Z0-9]+$/), name: z.string().trim().max(100).optional() }).strict())
        .refine(bots => new Set(bots.map(bot => bot.id)).size === bots.length, 'Duplicate bot ids').optional(),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的飞书用户', en: 'Feishu users who may originate work' },
        columns: [{ key: 'id', type: 'text', label: { zh: 'open_id', en: 'open_id' }, pattern: 'ou_[a-zA-Z0-9]+' }, { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
      { key: 'syncChat', type: 'text', pattern: '(oc_[a-zA-Z0-9]+)?', label: { zh: '同步来源群', en: 'Sync chat' }, choose: { zh: '不同步', en: 'Do not sync' },
        hint: { zh: '同步时，名单变成这个群里的人：新成员加入，离开的人移除，名字取群里的名字。启动时和点同步时进行。', en: 'Syncing makes the list the people in this chat: new members join, people who left are removed, and names follow the chat. It runs at startup and on Sync.' } },
      { key: 'bots', type: 'rows', label: { zh: '消息可以成为候选的机器人', en: 'Bots whose messages may become candidates' },
        hint: { zh: '名单里的机器人在接收的群里发的消息成为推断的候选，交给评估；它们不能发起明确的请求，也不能停止工单。其他机器人的消息不接收。', en: 'Messages of a bot on this list, in chats the Source receives, become inferred candidates for an assessment; they never make an explicit request or stop a ticket. Other bots\' messages are not admitted.' },
        columns: [{ key: 'id', type: 'text', label: { zh: 'App ID 或 open_id', en: 'App ID or open_id' }, pattern: '(cli|ou)_[a-zA-Z0-9]+' },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
    ],
    explicit: { zh: '名单内的人 @ 机器人或私聊机器人，总是明确的请求，不需要配置。', en: 'Someone on the list who mentions the bot or messages it directly always makes an explicit request; that needs no setting.' },
    rows(stored) {
      const config = FeishuConfigSchema.parse(stored)
      const mentions = { zh: '仅 @', en: '@ only' }
      return [
        ...config.chats.map(chat => ({ id: chat.chatId, label: chat.name || chat.chatId, note: chat.listen === 'all' ? { zh: '全部消息', en: 'All' } : mentions,
          cells: { listedUnaddressed: chat.listen === 'all', unlistedAddressed: true, unlistedUnaddressed: chat.listen === 'all' } })),
        { id: 'other', label: { zh: '其他群', en: 'Other chats' }, note: config.otherChats === 'mentions' ? mentions : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.otherChats === 'mentions', unlistedUnaddressed: false } },
        { id: 'direct', label: { zh: '私聊', en: 'Direct messages' }, note: config.directMessages ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.directMessages, unlistedUnaddressed: false } },
      ]
    },
    sync: {
      label: { zh: '立即同步', en: 'Sync now' },
      ready: part => !!part.syncChat,
      async run(host, part, signal) {
        const api = feishuOf(sourceContext(host, feishuKind))
        const chat = String(part.syncChat)
        const members = await chatMembers(api, chat, signal)
        // Preserve existing member order so policy version hashes stay stable; update names in place and append new members.
        const users = new Map(members.map(user => [user.id, user.name]))
        const known = new Set(part.allowed.map(entry => entry.id))
        return { ...part, allowed: [...part.allowed.filter(entry => users.has(entry.id)).map(entry => ({ ...entry, name: users.get(entry.id)! })),
          ...members.filter(user => !known.has(user.id))] }
      },
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_FEISHU_BOT', description: { zh: '飞书机器人的名字；智能体通过控制面读写飞书，不直接持有凭据', en: 'The Feishu bot\'s name; the agent reads and writes Feishu through the control plane and holds no credentials' } },
      { key: 'DSH_SUPERAGENT_FEISHU_CHAT', description: { zh: '接下工单的飞书群 chat_id；工单不是从飞书来的时为空', en: 'chat_id of the Feishu chat that started the ticket; empty when the ticket did not start on Feishu' } },
    ],
    values: ({ cell, trigger }) => ({ DSH_SUPERAGENT_FEISHU_BOT: cell.feishu ? cell.feishu.name || cell.feishu.botId : '',
      DSH_SUPERAGENT_FEISHU_CHAT: trigger?.source === SOURCE ? String(trigger.meta.chatId ?? '') : '' }),
  },
  facts: (cell): Record<string, Localized | string> => cell?.feishu ? { bot: { zh: `当前机器人 ${cell.feishu.name || cell.feishu.botId}`, en: `Current bot ${cell.feishu.name || cell.feishu.botId}` } } : {},
  ingest: (event, ctx) => ingestFeishu(event, ctx),
}

/** A chat bound to this cell in `dshsa-routes` (`fs#<tenantId>#<chatId>` → cellId), with the name the binding recorded. */
export interface BoundChat { chatId: string; chatName?: string | undefined }
/**
 * The Feishu config with `chats` following the cell's route bindings (routes are the single authority for binding):
 * a bound chat missing from `chats` is added as `@ only`, a listed chat keeps the listen mode and name a person set, and a
 * chat no longer bound is removed. Returns the same object when nothing changes, so the host saves (origin `sync`) only then.
 */
export function syncBoundChats(config: FeishuConfig, bound: readonly BoundChat[]): FeishuConfig {
  const valid = bound.filter(chat => /^oc_[a-zA-Z0-9]+$/.test(chat.chatId))
  const ids = new Set(valid.map(chat => chat.chatId))
  const kept = config.chats.filter(chat => ids.has(chat.chatId))
  const listed = new Set(kept.map(chat => chat.chatId))
  const added = valid.filter(chat => !listed.has(chat.chatId))
    .map(chat => ({ chatId: chat.chatId, name: (chat.chatName ?? chat.chatId).slice(0, 60), listen: 'mentions' as const }))
  if (!added.length && kept.length === config.chats.length) return config
  return { ...config, chats: [...kept, ...added] }
}
