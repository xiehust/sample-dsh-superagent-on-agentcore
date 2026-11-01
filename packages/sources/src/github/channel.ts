/**
 * GitHub outbound channel: posts issue/PR comments and review thread replies as the App.
 * Ported from dsh-superagent `src/sources/github-channel.ts` (MIT, DeepSeek Harness Team); `gh api` → `apis.github`.
 */
import { z } from 'zod'
import type { OutboundMessage } from '@dshsa/core'
import { ApiError, type ChannelLink, type ChannelLinks, type SourceContext } from '@dshsa/core/host'
import { sameName } from '@dshsa/core/text'
import { githubAddress, githubPage } from './trigger.ts'

const CommentSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), in_reply_to_id: z.number().nullish(), user: z.looseObject({ login: z.string() }).nullish(),
})
/** True when an issue is permanently deleted (410) or locked (403); 404 is retried because it can indicate temporary permission loss on a private repo. */
const gone = (error: unknown): boolean => error instanceof ApiError
  && (error.status === 410 || (error.status === 403 && /locked/i.test(error.message)))
const missing = (error: unknown): boolean => error instanceof ApiError && (error.status === 404 || error.status === 410)
/** Posts a comment or review-thread reply with an embedded HTML marker so retries do not create duplicate comments. */
export async function sendGithub(host: Pick<SourceContext, 'apis' | 'cell'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { github } = host.apis
  const { repository, app } = host.cell
  const number = Number(message.channel.address.number)
  if (!number) throw new Error('Missing GitHub reply target')
  try {
    // Retained trigger URLs also route replies queued before thread-aware delivery.
    const address = githubAddress(message.channel.address.url ?? '', repository)
    let rootId: number | undefined
    if (address?.pr && address.discussion && address.number === number) {
      // Fall back to a top-level PR comment if the target inline review comment was deleted.
      const source = await github.request(CommentSchema, `pulls/comments/${address.discussion}`)
        .catch((error: unknown) => { if (missing(error)) return undefined; throw error })
      rootId = source ? source.in_reply_to_id ?? source.id : undefined
    }
    const path = rootId === undefined ? `issues/${number}/comments` : `pulls/${number}/comments`
    const marker = `<!-- dsh-superagent:${message.id} -->`
    const mine = (comment: z.infer<typeof CommentSchema>) => sameName(comment.user?.login ?? '', app.login)
      && (rootId === undefined || comment.in_reply_to_id === rootId) && (comment.body ?? '').includes(marker)
    if ((await github.pages(CommentSchema, `${path}?per_page=100`)).some(mine)) return 'sent'
    const target = rootId === undefined ? path : `${path}/${rootId}/replies`
    await github.request(z.unknown(), target, { method: 'POST', body: { body: `${message.text}\n\n${marker}` } })
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}
export function githubLink(address: Record<string, string>, links: ChannelLinks): ChannelLink {
  const number = address.number ?? ''
  const review = !!links.repository && !!githubAddress(address.url ?? '', links.repository)?.discussion
  return { url: address.url ?? (links.repository ? githubPage(links.repository, Number(number)) : ''),
    label: review ? { zh: `GitHub #${number} 的 review 讨论`, en: `Review discussion on GitHub #${number}` }
      : { zh: `GitHub #${number}`, en: `GitHub #${number}` } }
}
