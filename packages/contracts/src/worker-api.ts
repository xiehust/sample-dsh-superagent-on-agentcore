/** Worker → control plane (design §4.5). Private API GW, `Authorization: Bearer <ticket token>`. */
import { z } from 'zod'

export const ReportState = z.enum(['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped'])
export type ReportState = z.infer<typeof ReportState>

/** DSH thread key `<source>:<id>`. */
export const ThreadKey = z.string().regex(/^[a-z]+:.+$/)

const base = { id: z.string().min(1), ticketKey: z.string().regex(/^[0-9a-f]{32}$/), assignmentId: z.string().min(1), at: z.string() }
export const WorkerEvent = z.discriminatedUnion('type', [
  /** Acknowledge one original human request (DSH orchestrator_ack); `triggerId` names the message acknowledged. */
  z.object({ ...base, type: z.literal('ack'), body: z.object({ text: z.string().min(1), triggerId: z.string().min(1) }) }),
  z.object({ ...base, type: z.literal('report'), body: z.object({
    state: ReportState, text: z.string(),
    /** DSH human_action: a question for a person; `null` clears the pending one, omitted keeps it. */
    question: z.string().min(1).max(1000).nullable().optional(),
    /** DSH question_for_trigger_id: the human message that raised the question (asked where that person wrote). */
    askedBy: z.string().min(1).optional(),
    /** DSH reply_to_trigger_id: the human message this report answers. */
    answers: z.string().min(1).optional(),
    /** DSH pr_number: the ticket's pull request; `null` clears it. The cell binds the PR thread through the GitHub source. */
    prNumber: z.number().int().positive().nullable().optional(),
    links: z.array(z.object({ url: z.string().url(), label: z.string().optional() })).optional(),
  }) }),
  z.object({ ...base, type: z.literal('handback'), body: z.object({ triggerIds: z.array(z.string()).min(1), reason: z.string() }) }),
  /** `thread` is a DSH thread key `<source>:<id>`, e.g. `github:42` or `feishu:<chat>:<root>`. */
  z.object({ ...base, type: z.literal('thread.follow'), body: z.object({ thread: ThreadKey, reason: z.string().min(1).max(300) }) }),
  z.object({ ...base, type: z.literal('thread.unrelated'), body: z.object({ thread: ThreadKey, reason: z.string().min(1).max(300) }) }),
  z.object({ ...base, type: z.literal('inputs.read'), body: z.object({ inputIds: z.array(z.string()).min(1) }) }),
  z.object({ ...base, type: z.literal('turn.ended'), body: z.object({ reason: z.string() }) }),
  z.object({ ...base, type: z.literal('token.refresh'), body: z.object({}) }),
])
export type WorkerEvent = z.infer<typeof WorkerEvent>
export type WorkerEventType = WorkerEvent['type']

export const WorkerApi = {
  events: '/v1/events',
  read: '/v1/read',
  githubCredentials: '/v1/credentials/github',
  tokenRefresh: '/v1/token/refresh',
} as const

export const ReadRequest = z.object({ resource: z.string().regex(/^(github|feishu)\/.+/) })
export const ReadResponse = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), content: z.string(), mediaType: z.string() }),
  z.object({ ok: z.literal(false), error: z.string(), message: z.string() }),
])
export const GithubCredentialsResponse = z.object({ token: z.string().min(1), expiresAt: z.string() })
export const TokenRefreshResponse = z.object({ token: z.string().min(1) })
export const OkResponse = z.object({ ok: z.literal(true) })
/** Errors: 401 bad/expired token, 403 out of scope, 409 assignment not running, 503 cell unavailable. */

/** Local proxy the gateway exposes to the non-root agent; it injects the Bearer token (design §4.3). */
export const GatewayProxy = { host: '127.0.0.1', port: 8090, prefix: '/cp' } as const
