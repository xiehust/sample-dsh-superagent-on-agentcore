/**
 * Normalizes Feishu live events, chat history items, and topic replies into domain Triggers.
 * Ported from dsh-superagent `src/sources/feishu-trigger.ts` (MIT, DeepSeek Harness Team). `feishuTrigger`, ids and thread keys
 * are unchanged. New: `sdkEvent` flattens the raw `im.message.receive_v1` event the official SDK delivers into the shape
 * DSH's `lark-cli event consume` printed, and `historyAsEvent` turns a history API item into a raw receive_v1 event so the
 * Connector sends both through one path.
 */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '@dshsa/core'
import { absent, flagOr, listOf, textOr } from './wire.ts'

export const SOURCE = 'feishu'
/** Constructs a Feishu reply channel address; records `direct` explicitly because both group and direct chat IDs start with `oc_`. */
export const feishuChannel = (chatId: string, messageId: string, direct = false): ChannelRef =>
  ({ source: SOURCE, thread: `feishu:${chatId}`, address: { chatId, messageId, ...direct ? { direct: 'true' } : {} } })
/** A message in the flattened shape DSH's live consumer printed; the other read paths normalize into it. */
const EventSchema = z.object({ message_id: z.string(), chat_id: z.string(), chat_type: z.enum(['p2p', 'group']),
  sender_id: z.string(), sender_type: z.enum(['user', 'bot']), content: z.string(), create_time: z.string(),
  mentions: z.array(z.object({ id: z.string(), key: z.string().optional(), name: z.string().optional() })).default([]),
  root_id: z.string().optional(), parent_id: z.string().optional(), thread_id: z.string().optional(), message_app_link: z.url().optional() })
export type FeishuEvent = z.infer<typeof EventSchema>
export const feishuThreadId = (chatId: string, rootId: string | undefined, messageId: string): string => `${chatId}:${rootId ?? messageId}`
/** Deterministic trigger ID for a Feishu message; every read path for this message produces the same ID. */
export const feishuTriggerId = (messageId: string): string => key('feishu', messageId)
export const withMentionNames = (text: string, mentions: { key?: string | undefined; name?: string | undefined }[]): string =>
  mentions.reduce((result, mention) => mention.key && mention.name ? result.replaceAll(mention.key, `@${mention.name}`) : result, text)
/**
 * Parses a Feishu message timestamp into an ISO-8601 string: live events and the history API return epoch milliseconds as a
 * string, whereas topic/thread pages return a local timestamp string such as `2026-09-11 12:00`.
 */
export function feishuTime(value: string): string {
  const time = /^\d+$/.test(value) ? Number(value) : Date.parse(value)
  if (!Number.isFinite(time)) throw new Error(`Unreadable Feishu message time: ${value}`)
  return new Date(time).toISOString()
}
/** Converts a normalized Feishu event into a Trigger, returning undefined for messages sent by the bot itself. */
export function feishuTrigger(input: unknown, botId: string, botAppId: string): Trigger | undefined {
  const event = EventSchema.parse(input)
  if (event.sender_id === botId || event.sender_id === botAppId) return
  const direct = event.chat_type === 'p2p'
  const mentioned = event.mentions.some(mention => mention.id === botId || mention.id === botAppId)
  const thread = feishuThreadId(event.chat_id, event.root_id, event.message_id)
  return { id: feishuTriggerId(event.message_id), source: SOURCE, threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: event.sender_id }, human: event.sender_type === 'user',
    ...(direct ? { addressed: 'direct' as const } : mentioned ? { addressed: 'mention' as const } : {}),
    at: feishuTime(event.create_time), text: withMentionNames(event.content, event.mentions),
    channel: feishuChannel(event.chat_id, event.message_id, direct), ...(event.message_app_link ? { url: event.message_app_link } : {}),
    meta: { chatId: event.chat_id, messageId: event.message_id, direct, mentioned, ...(event.root_id ? { rootId: event.root_id } : {}),
      ...(event.parent_id ? { parentId: event.parent_id } : {}), ...(event.thread_id ? { threadId: event.thread_id } : {}) } }
}
export const feishuParent = (trigger: Trigger): string | undefined =>
  trigger.source === SOURCE && typeof trigger.meta.parentId === 'string' ? feishuTriggerId(trigger.meta.parentId) : undefined
export interface FeishuRef { triggerId: string; chatId: string; messageId: string; at?: string }
export function feishuRef(trigger: Trigger): FeishuRef | undefined {
  const meta = trigger.meta as { chatId?: string; messageId?: string }
  if (trigger.source !== SOURCE || !meta.chatId || !meta.messageId) return undefined
  return { triggerId: trigger.id, chatId: meta.chatId, messageId: meta.messageId, at: trigger.at }
}

/** A message from the history API; a deleted message may have no body/content. */
export const HistoricalMessageSchema = z.looseObject({
  message_id: z.string(), chat_id: z.string(), create_time: z.string(), msg_type: absent(z.string()),
  root_id: absent(z.string()), parent_id: absent(z.string()), thread_id: absent(z.string()),
  deleted: absent(z.boolean()), message_app_link: absent(z.string()),
  sender: z.looseObject({ id: textOr, id_type: absent(z.string()), sender_type: z.string() }),
  body: absent(z.looseObject({ content: absent(z.string()) })),
  // A mention whose id is withheld keeps its key and name (text substitution) and matches no one.
  mentions: absent(z.array(z.looseObject({ id: textOr, key: absent(z.string()), name: absent(z.string()) }))),
})
export type HistoricalMessage = z.infer<typeof HistoricalMessageSchema>
/** One page of the history API; items are validated individually so an unreadable item is skipped alone. */
export const HistoryPageSchema = z.looseObject({
  items: listOf(z.unknown()), has_more: flagOr, page_token: absent(z.string()),
})
/** The text of a message `content` JSON: a text message's `text`, else the JSON itself; plain-text system messages pass through. */
export function contentText(raw: string | undefined): string {
  let content: unknown
  try { content = JSON.parse(raw ?? '') }
  catch { content = raw ?? '' /* Feishu also returns plain-text system messages. */ }
  const plain = content && typeof content === 'object' && 'text' in content && typeof content.text === 'string' ? content.text : undefined
  return typeof content === 'string' ? content : plain ?? JSON.stringify(content)
}
export const historyText = (message: HistoricalMessage): string => contentText(message.body?.content)
export function historyEvent(message: HistoricalMessage, chatId: string, direct: boolean): unknown {
  return { message_id: message.message_id, chat_id: chatId, chat_type: direct ? 'p2p' : 'group', create_time: message.create_time,
    sender_id: message.sender.id, sender_type: message.sender.sender_type === 'user' ? 'user' : 'bot', content: historyText(message),
    mentions: message.mentions ?? [], root_id: message.root_id, parent_id: message.parent_id, thread_id: message.thread_id,
    message_app_link: message.message_app_link }
}

/**
 * The raw `im.message.receive_v1` event body as the official SDK (and the event subscription) delivers it.
 * Feishu sends `null` for fields it withholds (such as `sender_id.user_id` without the user-ID scope), so optional fields are nullish.
 */
const maybe = z.string().nullish()
export const ReceiveEventSchema = z.looseObject({
  sender: z.looseObject({ sender_id: z.looseObject({ open_id: maybe, user_id: maybe, union_id: maybe }).nullish(),
    sender_type: maybe }),
  message: z.looseObject({
    message_id: z.string(), root_id: maybe, parent_id: maybe, thread_id: maybe,
    chat_id: z.string(), chat_type: z.string(), message_type: maybe, content: maybe.transform(value => value ?? ''), create_time: z.string(),
    mentions: z.array(z.looseObject({ key: maybe, name: maybe,
      id: z.looseObject({ open_id: maybe, user_id: maybe, union_id: maybe }).nullish() })).nullish(),
    message_app_link: maybe,
  }),
})
export type ReceiveEvent = z.infer<typeof ReceiveEventSchema>
const nonEmpty = (value: string | null | undefined): string | undefined => value ? value : undefined
/** Flattens a raw receive_v1 event into the shape `feishuTrigger` reads. */
export function sdkEvent(raw: unknown): FeishuEvent {
  const { sender, message } = ReceiveEventSchema.parse(raw)
  return EventSchema.parse({ message_id: message.message_id, chat_id: message.chat_id, chat_type: message.chat_type === 'p2p' ? 'p2p' : 'group',
    sender_id: sender.sender_id?.open_id ?? '', sender_type: sender.sender_type === 'user' ? 'user' : 'bot',
    content: contentText(message.content), create_time: message.create_time,
    mentions: (message.mentions ?? []).flatMap(mention => mention.id?.open_id
      ? [{ id: mention.id.open_id, ...mention.key ? { key: mention.key } : {}, ...mention.name ? { name: mention.name } : {} }] : []),
    root_id: nonEmpty(message.root_id), parent_id: nonEmpty(message.parent_id), thread_id: nonEmpty(message.thread_id),
    ...message.message_app_link ? { message_app_link: message.message_app_link } : {} })
}
/** A history API item as a raw receive_v1 event, so live and backfill messages take one path and give one Trigger. */
export function historyAsEvent(message: HistoricalMessage, direct: boolean): ReceiveEvent {
  const appSender = message.sender.sender_type !== 'user'
  return {
    sender: { sender_id: { open_id: message.sender.id }, sender_type: appSender ? 'app' : 'user' },
    message: { message_id: message.message_id, chat_id: message.chat_id, chat_type: direct ? 'p2p' : 'group',
      ...message.msg_type ? { message_type: message.msg_type } : {}, content: message.body?.content ?? '', create_time: message.create_time,
      ...message.root_id ? { root_id: message.root_id } : {}, ...message.parent_id ? { parent_id: message.parent_id } : {},
      ...message.thread_id ? { thread_id: message.thread_id } : {}, ...message.message_app_link ? { message_app_link: message.message_app_link } : {},
      mentions: (message.mentions ?? []).map(mention => ({ ...mention.key ? { key: mention.key } : {}, ...mention.name ? { name: mention.name } : {},
        id: { open_id: mention.id } })) },
  }
}
/** The Trigger of a raw receive_v1 event, or undefined for the bot's own message. */
export const receiveTrigger = (raw: unknown, botId: string, appId: string): Trigger | undefined => feishuTrigger(sdkEvent(raw), botId, appId)
