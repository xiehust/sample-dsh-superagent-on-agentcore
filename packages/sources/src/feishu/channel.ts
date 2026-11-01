/**
 * Feishu outbound channel: posts threaded bot replies and constructs chat deep links.
 * Ported from dsh-superagent `src/sources/feishu-channel.ts` (MIT, DeepSeek Harness Team): `lark-cli im +messages-reply
 * --markdown --reply-in-thread --idempotency-key <id>` becomes the reply API with `uuid` = the outgoing message's id.
 */
import { z } from 'zod'
import type { OutboundMessage } from '@dshsa/core'
import { FeishuError, type ChannelLink, type ChannelLinks, type SourceContext } from '@dshsa/core/host'
import { checkedImText } from '@dshsa/core/text'
import { feishuTriggerId } from './trigger.ts'

/** Feishu or Lark AppLink that opens a chat; used when the message's own link was not delivered with the event. */
export const feishuChatLink = (brand: 'feishu' | 'lark', chatId: string): string =>
  `https://applink.${brand === 'lark' ? 'larksuite.com' : 'feishu.cn'}/client/chat/open?openChatId=${encodeURIComponent(chatId)}`
/**
 * True when Feishu permanently rejects a reply because the target message was recalled, withdrawn, or not found.
 * Only a Feishu response carrying one of these error codes means the target message is gone; timeouts or crashes do not.
 */
const gone = (error: unknown): boolean => error instanceof FeishuError && (error.code === 230011
  || /withdrawn/i.test(error.message) || (Math.floor(error.code / 100) === 2300 && /not found/i.test(error.message)))
/** A Markdown reply as the `post` message lark-cli's `--markdown` sends: one `md` element. */
export const markdownPost = (text: string): string => JSON.stringify({ zh_cn: { content: [[{ tag: 'md', text }]] } })
/** Feishu keeps at most one message per `uuid` within an hour; outgoing message ids are short deterministic hashes. */
export const replyUuid = (id: string): string => id.slice(0, 50)
/** Replies in the topic of the target message; Feishu keeps at most one reply per idempotency key (the outgoing message's `message.id`). */
export async function sendFeishu(host: Pick<SourceContext, 'apis' | 'cell'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const messageId = message.channel.address.messageId
  if (!messageId) throw new Error('Missing Feishu reply target')
  const api = host.apis.feishu
  if (!api) throw new Error('The tenant has no Feishu bot')
  const text = checkedImText(message.text)
  try {
    await api.request(z.unknown(), 'POST', `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`,
      { data: { msg_type: 'post', content: markdownPost(text), reply_in_thread: true, uuid: replyUuid(message.id) } })
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
  return 'sent'
}
/** Fallback chat link on the bot's brand; the message's own deep link on its Trigger is preferred when available. */
export const feishuLink = (address: Record<string, string>, links: ChannelLinks): ChannelLink => ({
  url: feishuChatLink(links.feishu?.domain ?? 'feishu', address.chatId ?? ''), label: { zh: '飞书消息', en: 'Feishu message' },
  ...address.messageId ? { triggerId: feishuTriggerId(address.messageId) } : {},
})
