/**
 * GitHub webhook payload → intake items. Pure; `githubKind.ingest` applies them to the cell.
 *
 * Every Trigger comes out of the ported DSH builders (`commentTrigger`, `issueTrigger`, `pullTrigger`) after adapting the
 * webhook object to the REST shape DSH's poll read, so a comment delivered by webhook and by the reconcile poll gets the
 * same Trigger id. Differences between webhook and REST objects, normalized here:
 * - review `state` is lower-case in webhooks (`approved`) and upper-case in REST (`APPROVED`);
 * - review objects in webhooks may carry `updated_at`, which REST's `pulls/<n>/reviews` never does (DSH's id uses `submitted_at`).
 */
import { z } from 'zod'
import type { Trigger } from '@dshsa/core'
import { CommentSchema, commentTrigger, IssueSchema, issueTrigger, isAgent, pullTrigger, UserSchema, type AgentIdentity,
  type GithubComment } from './trigger.ts'
import { PullSchema, type Pull } from './pull.ts'

/** Events the App subscribes to and the cell understands; the webhook Lambda forwards only these. */
export const GITHUB_EVENTS = ['issue_comment', 'issues', 'pull_request', 'pull_request_review', 'pull_request_review_comment',
  'check_suite', 'workflow_run', 'status'] as const
export type GithubEvent = typeof GITHUB_EVENTS[number]

export type Intake =
  /** A Trigger to receive; `observed` is false when only a mention, a known Thread or an observe switch admits it (see `wanted`). */
  | { type: 'trigger'; trigger: Trigger }
  /** A PR's state to reconcile with tickets (bind, close, auto-merge fact). */
  | { type: 'pull'; pull: Pull }
  /** CI changed for these PRs and/or this branch: re-read their checks with the DSH fingerprint/revision logic. */
  | { type: 'ci'; pulls: number[]; branch?: string }
  /** Name an Issue/PR Thread. */
  | { type: 'title'; number: number; title: string }
  /** The payload was too large for the queue; re-read this Issue/PR through the reconcile path. */
  | { type: 'refetch'; number?: number }

const WebIssue = IssueSchema.pick({ number: true, title: true, html_url: true, user: true, body: true, created_at: true, pull_request: true, state: true })
const WebPull = PullSchema.extend({ number: z.number(), title: z.string(), html_url: z.string(), created_at: z.string() })
const Head = { action: z.string().optional() }
const Schemas = {
  issue_comment: z.looseObject({ ...Head, issue: WebIssue, comment: CommentSchema }),
  issues: z.looseObject({ ...Head, issue: WebIssue }),
  pull_request: z.looseObject({ ...Head, pull_request: WebPull }),
  pull_request_review: z.looseObject({ ...Head, review: CommentSchema, pull_request: WebPull }),
  pull_request_review_comment: z.looseObject({ ...Head, comment: CommentSchema, pull_request: WebPull }),
  check_suite: z.looseObject({ ...Head, check_suite: z.looseObject({ head_branch: z.string().nullish(),
    pull_requests: z.array(z.looseObject({ number: z.number() })).default([]) }) }),
  workflow_run: z.looseObject({ ...Head, workflow_run: z.looseObject({ head_branch: z.string().nullish(),
    pull_requests: z.array(z.looseObject({ number: z.number() })).default([]) }) }),
  status: z.looseObject({ branches: z.array(z.looseObject({ name: z.string() })).default([]) }),
} satisfies Record<GithubEvent, z.ZodType>
const Truncated = z.looseObject({ dshsa: z.looseObject({ truncated: z.literal(true), number: z.number().optional() }) })

/** A webhook review in the shape `pulls/<n>/reviews` returns it. */
export function restReview(review: GithubComment): GithubComment {
  const { updated_at: _updated, ...rest } = review
  return { ...rest, ...review.state ? { state: review.state.toUpperCase() } : {} }
}
const commented = (action: string | undefined) => action === 'created' || action === 'edited' || action === 'submitted'
/** A Trigger only when it has text and the agent did not write it, as DSH's `intakeComments` does. */
function comment(item: GithubComment, ref: Parameters<typeof commentTrigger>[1], kind: Parameters<typeof commentTrigger>[2],
  agent: AgentIdentity): Intake[] {
  if (isAgent(item.user, agent)) return []
  const trigger = commentTrigger(item, ref, kind, agent)
  return trigger.text ? [{ type: 'trigger', trigger }] : []
}
const prOf = (pr: z.infer<typeof WebPull>): Pull => pr

/** Normalizes one webhook delivery; unknown events, unknown actions and unreadable payloads yield no items. */
export function webhookIntake(event: string, payload: unknown, agent: AgentIdentity): Intake[] {
  const truncated = Truncated.safeParse(payload)
  if (truncated.success) return [{ type: 'refetch', ...truncated.data.dshsa.number ? { number: truncated.data.dshsa.number } : {} }]
  if (!(event in Schemas)) return []
  const parsed = Schemas[event as GithubEvent].safeParse(payload)
  if (!parsed.success) return []
  const data = parsed.data as Record<string, unknown> & { action?: string }
  switch (event as GithubEvent) {
    case 'issue_comment': {
      const { issue, comment: item, action } = data as z.infer<typeof Schemas.issue_comment>
      if (!commented(action)) return []
      const isPr = !!issue.pull_request
      const ref = { number: issue.number, isPr, url: issue.html_url, ...isPr ? { prAuthor: UserSchema.parse(issue.user).login } : {} }
      return [...comment(item, ref, 'conversation', agent), { type: 'title', number: issue.number, title: issue.title }]
    }
    case 'issues': {
      const { issue, action } = data as z.infer<typeof Schemas.issues>
      // `issues` also fires for PRs only through `pull_request`; an Issue body becomes a Trigger only when it opens (DSH).
      const opened = action === 'opened' && !issue.pull_request && !isAgent(issue.user, agent)
      return [...opened ? [{ type: 'trigger' as const, trigger: issueTrigger(issue, agent) }] : [],
        { type: 'title', number: issue.number, title: issue.title }]
    }
    case 'pull_request': {
      const { pull_request: pr, action } = data as z.infer<typeof Schemas.pull_request>
      const opened = action === 'opened' && !isAgent(pr.user, agent)
      const items: Intake[] = opened ? [{ type: 'trigger', trigger: pullTrigger(pr, agent) }] : []
      return [...items, { type: 'pull', pull: prOf(pr) }, { type: 'title', number: pr.number, title: pr.title },
        ...action === 'synchronize' ? [{ type: 'ci' as const, pulls: [pr.number] }] : []]
    }
    case 'pull_request_review': {
      const { review, pull_request: pr, action } = data as z.infer<typeof Schemas.pull_request_review>
      if (!commented(action)) return []
      return comment(restReview(review), { number: pr.number, isPr: true, url: pr.html_url, prAuthor: pr.user.login }, 'review', agent)
    }
    case 'pull_request_review_comment': {
      const { comment: item, pull_request: pr, action } = data as z.infer<typeof Schemas.pull_request_review_comment>
      if (!commented(action)) return []
      return comment(item, { number: pr.number, isPr: true, url: pr.html_url, prAuthor: pr.user.login }, 'inline', agent)
    }
    case 'check_suite': case 'workflow_run': {
      const run = event === 'check_suite' ? (data as z.infer<typeof Schemas.check_suite>).check_suite
        : (data as z.infer<typeof Schemas.workflow_run>).workflow_run
      return [{ type: 'ci', pulls: run.pull_requests.map(pr => pr.number), ...run.head_branch ? { branch: run.head_branch } : {} }]
    }
    case 'status': {
      const { branches } = data as z.infer<typeof Schemas.status>
      return branches.map(branch => ({ type: 'ci' as const, pulls: [], branch: branch.name }))
    }
  }
}
/** The number of the Issue/PR a payload is about, kept when the Lambda must slim an oversized payload. */
export function payloadNumber(payload: unknown): number | undefined {
  const value = payload as { issue?: { number?: unknown }; pull_request?: { number?: unknown }; number?: unknown } | null
  const number = value?.issue?.number ?? value?.pull_request?.number ?? value?.number
  return typeof number === 'number' ? number : undefined
}
