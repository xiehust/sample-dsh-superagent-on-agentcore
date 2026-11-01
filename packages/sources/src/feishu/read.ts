/**
 * Trigger-scoped Feishu context reader; retrieved messages are returned for model inspection without entering intake.
 * Ported from dsh-superagent `src/sources/feishu-read.ts` and `feishu-image.ts` (MIT, DeepSeek Harness Team). The lark-cli
 * shortcuts (`+messages-mget`, `+threads-messages-list`, `+messages-resources-download`) become the OpenAPI calls they wrap;
 * every message is read in the history API shape. Resource strings (`feishu/<trigger-id>/<section>[/<cursor>]`) are unchanged,
 * so worker-api can serve `orchestrator_read feishu/...` with `feishuRead`.
 */
import { z } from 'zod'
import type { Trigger } from '@dshsa/core'
import type { ContextMessage, FeishuApi, ImageAttachment, ThreadContext } from '@dshsa/core/host'
import { validItems } from '../poll.ts'
import { listOf } from './wire.ts'
import { feishuRef, feishuTime, HistoricalMessageSchema, HistoryPageSchema, historyText, withMentionNames, type FeishuRef,
  type HistoricalMessage } from './trigger.ts'

const messageId = z.string().regex(/^om_[a-zA-Z0-9_-]+$/)
const ItemsSchema = z.looseObject({ items: listOf(z.unknown()) })

/** Resource references are anchored to an accepted trigger instead of arbitrary chat or message IDs. */
export function feishuReferences(ref: FeishuRef) {
  const read = (section: string) => `feishu/${ref.triggerId}/${section}`
  return { skill: 'dsh-superagent-feishu', message: read('message'), root: read('root'), parent: read('parent'), thread: read('thread'),
    around: read('around') }
}
/** Validates a model-supplied resource string before any network request; only `thread` and `around` take pagination cursors. */
export function feishuResource(resource: string) {
  const match = /^feishu\/([^/]+)\/(message|root|parent|thread|around)(?:\/([^/]+))?$/.exec(resource)
  if (!match || (match[3] && match[2] !== 'thread' && match[2] !== 'around')) {
    throw new Error('Use feishu/<trigger-id>/message, /root, /parent, /thread or /around; follow returned next_resource for another page')
  }
  return { triggerId: match[1]!, section: match[2]!, cursor: match[3] ? decodeURIComponent(match[3]) : undefined }
}
/** Reads one message by id (`GET im/v1/messages/<id>`), in the history API shape. */
export async function getMessage(api: FeishuApi, id: string): Promise<HistoricalMessage | undefined> {
  const result = await api.request(ItemsSchema, 'GET', `/open-apis/im/v1/messages/${messageId.parse(id)}`)
  return validItems(HistoricalMessageSchema, result.items).find(item => item.message_id === id)
}
async function sourceOf(api: FeishuApi, ref: FeishuRef): Promise<HistoricalMessage> {
  const source = await getMessage(api, ref.messageId)
  if (!source || source.deleted) throw new Error('The source Feishu message is unavailable or deleted; retained trigger text is still readable')
  if (source.chat_id !== ref.chatId) throw new Error('Feishu source chat does not match the accepted trigger')
  return source
}
/** Lists a chat or topic (`GET im/v1/messages`); items failing the schema are skipped and counted. */
export async function listMessages(api: FeishuApi, params: Record<string, string>) {
  const page = HistoryPageSchema.parse(await api.request(z.unknown(), 'GET', '/open-apis/im/v1/messages', { params }))
  const tally = { skipped: 0 }
  return { ...page, items: validItems(HistoricalMessageSchema, page.items, tally), skipped: tally.skipped }
}

export interface FeishuPage<M> { status: string; thread_id?: string; messages: M[]; next_resource: string | null; skipped?: number }
export interface FeishuOne<M> { status: string; message: M | null }
/** Fetches one message or a bounded topic page of a Trigger's source message with explicit pagination continuation. */
export async function readFeishu(api: FeishuApi, ref: FeishuRef, resource: string, pageSize: number,
  order: 'asc' | 'desc' = 'asc'): Promise<FeishuPage<HistoricalMessage> | FeishuOne<HistoricalMessage>> {
  const request = feishuResource(resource)
  if (request.triggerId !== ref.triggerId) throw new Error('A Feishu source trigger is required')
  if (request.section === 'around') throw new Error('The chat around a message is read with feishuRead')
  const source = await sourceOf(api, ref)
  if (request.section === 'thread') {
    if (!source.thread_id) return { status: 'no_thread', messages: [], next_resource: null }
    const result = await listMessages(api, { container_id_type: 'thread', container_id: source.thread_id,
      sort_type: order === 'asc' ? 'ByCreateTimeAsc' : 'ByCreateTimeDesc', page_size: String(pageSize),
      ...request.cursor ? { page_token: request.cursor } : {} })
    const outside = result.items.some(message => message.chat_id !== source.chat_id || (message.thread_id && message.thread_id !== source.thread_id))
    if (outside) throw new Error('Feishu returned messages outside the source thread')
    if (result.has_more && (!result.page_token || result.page_token === request.cursor)) throw new Error('Feishu thread pagination did not advance; history is incomplete')
    return { status: 'available', thread_id: source.thread_id, messages: result.items, ...result.skipped ? { skipped: result.skipped } : {},
      next_resource: result.has_more ? `feishu/${ref.triggerId}/thread/${encodeURIComponent(result.page_token!)}` : null }
  }
  const target = request.section === 'root' ? source.root_id : request.section === 'parent' ? source.parent_id : source.message_id
  if (!target) return { status: `no_${request.section}`, message: null }
  const message = target === source.message_id ? source : await getMessage(api, target)
  if (!message) throw new Error('The requested Feishu message is unavailable; do not infer its contents')
  if (message.chat_id !== source.chat_id) throw new Error('Feishu returned a message outside the source chat')
  return { status: message.deleted ? 'deleted' : 'available', message }
}
function isoTime(value: string): string {
  try { return feishuTime(value) } catch { return value }
}
/** Formats a history API message for model inspection; the history API identifies senders by `open_id` (or app id) only. */
export function historyView(message: HistoricalMessage): ContextMessage {
  return { id: message.message_id, from: message.sender.id, at: isoTime(message.create_time),
    text: message.deleted ? '' : withMentionNames(historyText(message), message.mentions ?? []),
    ...message.sender.sender_type !== 'user' ? { bot: true } : {}, ...message.deleted ? { deleted: true } : {},
    ...message.parent_id ? { reply_to: message.parent_id } : {}, ...message.message_app_link ? { url: message.message_app_link } : {} }
}
/** Reads chat messages surrounding `ref.at` (five before and five after on initial read, then pages of ten older messages). */
async function chatAround(api: FeishuApi, ref: FeishuRef, cursor: string | undefined, before = 5, after = 5): Promise<FeishuPage<ContextMessage>> {
  const time = Date.parse(ref.at ?? '')
  if (!Number.isFinite(time)) throw new Error('The source Feishu message has no time to read the chat around')
  const list = async (parameters: Record<string, string>) => {
    const page = await listMessages(api, { container_id_type: 'chat', container_id: ref.chatId, ...parameters })
    return { ...page, items: page.items.filter(item => item.chat_id === ref.chatId) }
  }
  // Feishu takes whole seconds; the source message counts among the earlier items, so `before + 1` holds it and those before it.
  const earlier = await list({ end_time: String(Math.ceil(time / 1000)), sort_type: 'ByCreateTimeDesc', page_size: String(cursor ? 10 : before + 1),
    ...cursor ? { page_token: cursor } : {} })
  const later = cursor || !after ? []
    : (await list({ start_time: String(Math.floor(time / 1000)), sort_type: 'ByCreateTimeAsc', page_size: String(after + 1) })).items
  const seen = new Set<string>()
  const messages = [...earlier.items.reverse(), ...later].filter(item => !seen.has(item.message_id) && seen.add(item.message_id))
    .map(historyView)
  const more = earlier.has_more && earlier.page_token && earlier.page_token !== cursor
  const next = more ? `feishu/${ref.triggerId}/around/${encodeURIComponent(earlier.page_token!)}` : null
  return { status: 'available', messages, next_resource: next }
}
export async function feishuRead(api: FeishuApi, ref: FeishuRef, resource: string,
  pageSize: number): Promise<FeishuPage<ContextMessage> | FeishuOne<ContextMessage>> {
  const request = feishuResource(resource)
  if (request.section === 'around') {
    if (request.triggerId !== ref.triggerId) throw new Error('A Feishu source trigger is required')
    await sourceOf(api, ref)
    return chatAround(api, ref, request.cursor)
  }
  const result = await readFeishu(api, ref, resource, pageSize)
  if ('messages' in result) return { ...result, messages: result.messages.map(historyView) }
  return { status: result.status, message: result.message ? historyView(result.message) : null }
}
function sourceRef(trigger: Trigger): FeishuRef {
  const ref = feishuRef(trigger)
  if (!ref) throw new Error('A Feishu source trigger is required')
  return ref
}
const feishuOf = (apis: { feishu?: FeishuApi }): FeishuApi => {
  if (!apis.feishu) throw new Error('The tenant has no Feishu bot')
  return apis.feishu
}

/** Extracts Feishu image keys from message text so keys remain paired with the originating message; arbitrary remote IDs are not accepted. */
export function admissionImageKeys(text: string): string[] {
  return [...new Set(text.match(/\bimg_[a-zA-Z0-9_-]+\b/g) ?? [])]
}
const MEDIA: Record<string, ImageAttachment['mediaType']> = { 'image/png': 'image/png', 'image/jpeg': 'image/jpeg', 'image/jpg': 'image/jpeg',
  'image/gif': 'image/gif', 'image/webp': 'image/webp' }
/** Magic numbers, since Feishu may answer `application/octet-stream`. */
function sniff(data: Buffer): ImageAttachment['mediaType'] | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg'
  if (data.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif'
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return undefined
}
/** Downloads one image of a message in the Trigger's chat for a stateless assessment; the key must appear in that message. */
export async function readAdmissionImage(api: FeishuApi, ref: FeishuRef, text: string, imageKey: string, maxBytes = 5 * 1024 * 1024): Promise<ImageAttachment> {
  if (!admissionImageKeys(text).includes(imageKey)) throw new Error('Choose an image key from this source message')
  const id = messageId.parse(ref.messageId)
  if (!api.download) throw new Error('Image reading is unavailable: this Feishu client cannot download resources')
  const file = await api.download(`/open-apis/im/v1/messages/${id}/resources/${encodeURIComponent(imageKey)}`, { type: 'image' }, maxBytes)
  const mediaType = MEDIA[file.contentType.split(';')[0]!.trim().toLowerCase()] ?? sniff(file.data)
  if (!mediaType) throw new Error('The downloaded resource is not a supported PNG/JPEG/WebP/GIF image')
  return { mediaType, data: file.data.toString('base64') }
}

export const feishuThreadContext: ThreadContext<{ readPageSize: number }> = {
  messageId: trigger => String(trigger.meta.messageId ?? ''),
  read: async (apis, trigger, part, cursor, config) => {
    const api = feishuOf(apis)
    const ref = sourceRef(trigger)
    const resource = `feishu/${trigger.id}/${part}${cursor ? '/' + encodeURIComponent(cursor) : ''}`
    const body = await feishuRead(api, ref, resource, config.readPageSize)
    if (part === 'thread' && body.status === 'no_thread') {
      // Fall back to preceding chat messages when the trigger message does not belong to a topic thread.
      const around = await chatAround(api, ref, undefined, 5, 0)
      return { messages: around.messages, body: { status: 'chat_neighbours', messages: around.messages }, status: 'chat_neighbours' }
    }
    const messages = 'messages' in body ? body.messages : body.message ? [body.message] : []
    const next = 'next_resource' in body && body.next_resource ? decodeURIComponent(body.next_resource.split('/').at(-1)!) : undefined
    return { messages, next, body: { ...body }, status: body.status }
  },
  images: admissionImageKeys,
  image: (apis, trigger, message, imageKey) => readAdmissionImage(feishuOf(apis), { ...sourceRef(trigger), messageId: message.id }, message.text, imageKey),
}
