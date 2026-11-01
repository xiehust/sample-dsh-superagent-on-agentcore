import { describe, expect, it } from 'vitest'
import { key } from '@dshsa/core'
import { githubKind, ingestGithub, reconcileRound, webhookIntake, type Intake } from '../src/index.ts'
import { agentOf } from '../src/github/kind.ts'
import { CELL, fakeContext, fakeGithub, fixture, ticket } from './fakes.ts'

const agent = agentOf(CELL)
const triggers = (items: Intake[]) => items.flatMap(item => item.type === 'trigger' ? [item.trigger] : [])
const event = (kind: string, file = `${kind}.json`) => ({ source: 'github' as const, kind: kind.split('.')[0]!, deliveryId: 'd-1', payload: fixture(`github/${file}`) })

describe('webhook → Trigger (ids as the DSH prototype derives them)', () => {
  it('turns an issue comment into the DSH conversation Trigger', () => {
    const [trigger] = triggers(webhookIntake('issue_comment', fixture('github/issue_comment.created.json'), agent))
    expect(trigger).toEqual({
      id: key('github-comment', 'https://github.com/acme/widgets/issues/12#issuecomment-7001', '7001', '2026-11-01T10:06:00Z'),
      source: 'github', threads: [{ source: 'github', id: '12' }], actor: { source: 'github', id: 'alice' }, human: true,
      at: '2026-11-01T10:06:00Z', text: '@dshsa-agent can you also fix the footer?', addressed: 'mention',
      channel: { source: 'github', thread: 'github:12', address: { number: '12', url: 'https://github.com/acme/widgets/issues/12#issuecomment-7001' } },
      url: 'https://github.com/acme/widgets/issues/12#issuecomment-7001',
      meta: { number: 12, isPr: false, commentId: 7001, kind: 'conversation' },
    })
  })
  it('gives an edit a new Trigger, as DSH does through updated_at', () => {
    const [created] = triggers(webhookIntake('issue_comment', fixture('github/issue_comment.created.json'), agent))
    const [edited] = triggers(webhookIntake('issue_comment', fixture('github/issue_comment.edited.json'), agent))
    expect(edited!.id).toBe(key('github-comment', created!.url!, '7001', '2026-11-01T10:07:00Z'))
    expect(edited!.id).not.toBe(created!.id)
  })
  it('skips the agent\'s own comments', () => {
    expect(triggers(webhookIntake('issue_comment', fixture('github/issue_comment.by-agent.json'), agent))).toEqual([])
  })
  it('turns an opened Issue into the github-issue Trigger addressed by an @slug mention', () => {
    const [trigger] = triggers(webhookIntake('issues', fixture('github/issues.opened.json'), agent))
    expect(trigger).toMatchObject({ id: key('github-issue', '12'), text: 'Fix the header\n\n@dshsa-agent please fix the header',
      addressed: 'mention', human: true, meta: { number: 12, isPr: false, kind: 'issue' } })
  })
  it('turns a person\'s opened PR into the pull Trigger, and the App\'s own PR into no Trigger but a PR observation', () => {
    const [human] = triggers(webhookIntake('pull_request', fixture('github/pull_request.opened.human.json'), agent))
    expect(human).toMatchObject({ id: key('github-issue', '16'), addressed: 'mention', meta: { number: 16, isPr: true, prAuthor: 'alice', kind: 'pull' } })
    const own = webhookIntake('pull_request', fixture('github/pull_request.opened.json'), agent)
    expect(triggers(own)).toEqual([])
    expect(own.map(item => item.type)).toEqual(['pull', 'title'])
  })
  it('reads a webhook review as REST would: upper-case state and submitted_at as the version', () => {
    const [trigger] = triggers(webhookIntake('pull_request_review', fixture('github/pull_request_review.submitted.json'), agent))
    expect(trigger).toMatchObject({
      id: key('github-comment', 'https://github.com/acme/widgets/pull/15#pullrequestreview-8001', '8001', '2026-11-01T11:30:00Z'),
      at: '2026-11-01T11:30:00Z', text: 'APPROVED review of commit abc123def4567890abc123def4567890abc12345\n\nLooks good',
      meta: { number: 15, isPr: true, prAuthor: 'dshsa-agent[bot]', kind: 'review', commentId: 8001 } })
    expect(trigger).not.toHaveProperty('addressed')
  })
  it('turns an inline review comment into the inline Trigger with its place', () => {
    const [trigger] = triggers(webhookIntake('pull_request_review_comment', fixture('github/pull_request_review_comment.created.json'), agent))
    expect(trigger).toMatchObject({ id: key('github-comment', 'https://github.com/acme/widgets/pull/15#discussion_r8101', '8101', '2026-11-01T11:31:00Z'),
      addressed: 'mention', text: 'src/header.ts:4\n a\n b\n+c\n\n@dshsa-agent rename this', meta: { kind: 'inline', path: 'src/header.ts', line: 4 } })
  })
  it('asks for a CI re-read of the PRs and branch a check suite names, and ignores unknown events and payloads', () => {
    expect(webhookIntake('check_suite', fixture('github/check_suite.completed.json'), agent)).toEqual([{ type: 'ci', pulls: [15], branch: 'agent/fix-header' }])
    expect(webhookIntake('ping', fixture('github/ping.json'), agent)).toEqual([])
    expect(webhookIntake('issue_comment', { action: 'created' }, agent)).toEqual([])
    expect(webhookIntake('issue_comment', { dshsa: { truncated: true, number: 12 } }, agent)).toEqual([{ type: 'refetch', number: 12 }])
  })
})

describe('githubKind.ingest', () => {
  it('receives a mention, drops an unaddressed comment on an unknown Thread, and takes later comments on a known one', async () => {
    const ctx = fakeContext()
    const quiet = structuredClone(fixture('github/issue_comment.created.json')) as { comment: { id: number; body: string; html_url: string }; issue: { number: number } }
    quiet.comment.body = 'unrelated chatter'; quiet.comment.id = 7100; quiet.issue.number = 30
    await ingestGithub({ source: 'github', kind: 'issue_comment', deliveryId: 'q', payload: quiet }, ctx)
    expect(ctx.stored).toHaveLength(0)
    await ingestGithub(event('issue_comment', 'issue_comment.created.json'), ctx)
    const later = structuredClone(fixture('github/issue_comment.created.json')) as typeof quiet
    later.comment.body = 'and the footer colour'; later.comment.id = 7101
    await ingestGithub({ source: 'github', kind: 'issue_comment', deliveryId: 'l', payload: later }, ctx)
    expect(ctx.stored.map(trigger => trigger.meta.commentId)).toEqual([7001, 7101])
  })
  it('collapses a redelivered webhook and the reconcile read of the same comment into one Trigger', async () => {
    const created = fixture('github/issue_comment.created.json') as { comment: Record<string, unknown> }
    const github = fakeGithub({
      'issues?state=all': [],
      'issues/comments?': [created.comment],
      'pulls/comments?': [],
    })
    const ctx = fakeContext({ github })
    // The streams start from the first round; backdate their start so the comment counts as fresh.
    for (const id of ['issues', 'comments', 'review-comments']) {
      ctx.kv.set(`github-stream:${id}`, { since: '2026-11-01T09:00:00Z', started: { issues: '2026-11-01T09:00:00Z', pulls: '2026-11-01T09:00:00Z', comments: '2026-11-01T09:00:00Z' } })
    }
    await ingestGithub(event('issue_comment', 'issue_comment.created.json'), ctx)
    await ingestGithub(event('issue_comment', 'issue_comment.created.json'), ctx)
    await reconcileRound(ctx)
    expect(ctx.stored).toHaveLength(1)
    expect(ctx.results).toEqual(['stored', 'duplicate', 'duplicate'])
    expect(ctx.reports.at(-1)).toMatchObject({ entry: 'github', health: { state: 'ready' } })
  })
  it('binds the App\'s PR on the ticket\'s branch and reports its merge', async () => {
    const open = ticket('t1', { execution: { name: 'fix-header' } as never })
    const ctx = fakeContext({ tickets: [open] })
    await ingestGithub(event('pull_request', 'pull_request.opened.json'), ctx)
    expect(ctx.bound).toEqual([{ id: 't1', thread: 'github:15', own: true }])
    await ingestGithub(event('pull_request', 'pull_request.closed.json'), ctx)
    expect(ctx.closed).toEqual([{ thread: 'github:15', outcome: 'merged' }])
  })
  it('re-reads CI of a followed PR on a check suite and emits a CI Trigger once the checks change', async () => {
    const pr = (fixture('github/pull_request.opened.json') as { pull_request: Record<string, unknown> }).pull_request
    let conclusion = 'success'
    const github = fakeGithub({
      'pulls/15': pr,
      'commits/abc123def4567890abc123def4567890abc12345/check-runs': () => ({ check_runs: [{ name: 'test', status: 'completed', conclusion }] }),
      'commits/abc123def4567890abc123def4567890abc12345/statuses': [],
    })
    const followed = ticket('t1', { follows: [{ thread: 'github:15', own: true }] })
    const ctx = fakeContext({ github, tickets: [followed] })
    await ingestGithub(event('check_suite', 'check_suite.completed.json'), ctx)
    expect(ctx.stored).toHaveLength(0)
    conclusion = 'failure'
    await ingestGithub(event('check_suite', 'check_suite.completed.json'), ctx)
    expect(ctx.stored).toEqual([expect.objectContaining({ id: key('github-ci', '15', '1'), human: false, meta: expect.objectContaining({ ci: true, revision: 1 }) })])
  })
  it('names the GitHub kind and its health entry as DSH does', () => {
    expect(githubKind.kind).toBe('github')
    expect(githubKind.health).toEqual(['github'])
    expect(githubKind.environment!.values({ cell: CELL, config: githubKind.schema.parse({}) })).toMatchObject({
      DSH_SUPERAGENT_GITHUB_REPOSITORY: 'acme/widgets', DSH_SUPERAGENT_GITHUB_ACCOUNT: 'dshsa-agent[bot]' })
  })
})
