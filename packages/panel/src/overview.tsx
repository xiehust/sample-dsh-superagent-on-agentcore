/**
 * Overview: tickets waiting for a person, problems with their actions, executor load, and the last 24 h of flow.
 * Adapted from dsh-superagent `src/client/overview.tsx` (MIT, DeepSeek Harness superagent prototype).
 */
import type { ReactNode } from 'react'
import { usePoll } from './api.ts'
import { ignoreReasons, localized, reasonText, stageText, when } from './text.ts'
import type { DecisionListView, Problem, TicketRow } from './types.ts'
import { LoadState, PlainText, Section, Stat, useAction, usePanel } from './widgets.tsx'

function ProblemLine({ problem, reload }: { problem: Problem; reload: () => Promise<void> }) {
  const { client, cell, canEdit } = usePanel()
  const action = useAction(async (request: () => Promise<unknown>) => { await request(); await reload() })
  // Members read only (they may Stop/Retry tickets on the ticket page): problem actions are tenant-admin mutations.
  const button = (label: string, request: () => Promise<unknown>) => canEdit ? <button type="button" disabled={action.busy}
    onClick={() => { void action.run(request) }}>{label}</button> : null
  const row = (title: string, detail?: string, actions?: ReactNode) => <li className="row row-problem">
    <div className="row-main"><div className="row-title">{title}</div><PlainText text={detail} className="error" /></div>
    {actions && <div className="row-actions">{actions}</div>}
  </li>
  switch (problem.kind) {
    case 'setup': return row('Setup is incomplete', problem.detail || `${problem.place}: ${problem.code}`)
    case 'no-source': return row('No Source is running', 'Enable a Source for this cell.')
    case 'no-allowed': return row('Nobody is allowed to start work', 'Add senders to an allowed list in the Policy.')
    case 'source-error': return row(`${localized(problem.source.title, problem.source.id)} reports an error`, problem.source.health.detail)
    case 'executor-paused': return row('Processing is paused', 'Triggers are still recorded; Eval, dispatch and replies wait.',
      button('Resume', () => client.call(cell.cellId, 'POST executor/pause', { body: { paused: false } })))
    case 'runtime-error': return row(`Runtime error: ${problem.name}`, problem.detail)
    case 'eval-overdue': return row(`Eval overdue on “${problem.thread.title}”`)
    case 'eval-unavailable': return row(`Eval unavailable on “${problem.thread.title}”`, reasonText(problem.reason), <>
      {button('Evaluate again', () => client.call(cell.cellId, 'POST triggers/:id/requeue', { id: problem.triggerId }))}
      {button('Dismiss', () => client.call(cell.cellId, 'POST decisions/:id/dismiss', { id: problem.decisionId }))}
    </>)
    case 'outgoing': return row(`A ${problem.outgoing.channel.source} reply failed after ${problem.outgoing.attempts} attempts`,
      problem.outgoing.error)
    default: return row(`Problem: ${(problem as { kind: string }).kind}`)
  }
}

export function TicketLine({ ticket }: { ticket: TicketRow }) {
  const { openTicket } = usePanel()
  return <li className="row" data-stage={ticket.stage} data-action={'action' in ticket ? ticket.action : undefined}>
    <div className="row-main">
      <button type="button" className="link row-title" onClick={() => openTicket(ticket.id)}>{ticket.title || ticket.id}</button>
      <div className="row-meta"><span className="tag" data-stage={ticket.stage}
        data-action={'action' in ticket ? ticket.action : undefined}>{stageText(ticket)}</span>
        {ticket.threads[0] && <span>{ticket.threads[0].title}</span>}</div>
      {ticket.note && <PlainText text={ticket.note.text} className={ticket.note.error ? 'error' : 'hint'} />}
    </div>
  </li>
}

/** dshsa: how many recent ignores the Overview lists (the 24 h window of `GET decisions`). */
export const RECENT_IGNORES = 20
type Ignored = DecisionListView['items'][number]

function IgnoredLine({ decision }: { decision: Ignored }) {
  const sender = decision.sender ? localized(decision.sender.name, decision.sender.id) : ''
  return <li className="row" data-state="ignored">
    <div className="row-main">
      <PlainText text={decision.preview || decision.threadTitle || decision.thread} className="row-title" />
      <div className="row-meta"><span>{when(decision.at)}</span>{decision.source && <span className="tag">{decision.source}</span>}
        {sender && <span>{sender}</span>}{decision.strength === 'explicit' && <span>explicit</span>}</div>
      {ignoreReasons(decision.reason).map((text, index) => <PlainText key={index} text={text} className="hint" />)}
    </div>
  </li>
}

/** The last ignore Decisions of the past 24 h, newest first, with why each was ignored. Read-only, so members see it too. */
function RecentlyIgnored() {
  const { client, cell } = usePanel()
  const { data, error } = usePoll(() => client.call(cell.cellId, 'GET decisions',
    { query: { kind: 'ignore', window: '24h', limit: RECENT_IGNORES } }), [cell.cellId])
  return <Section title="Recently ignored" count={data?.items.length}>
    {!data ? <LoadState error={error} loading /> : data.items.length
      ? <ul className="list">{data.items.map(decision => <IgnoredLine key={decision.id} decision={decision} />)}</ul>
      : <p className="hint">Nothing was ignored in the last 24 hours.</p>}
  </Section>
}

export function OverviewPage() {
  const { client, cell } = usePanel()
  const { data, error, reload } = usePoll(() => client.call(cell.cellId, 'GET overview'), [cell.cellId])
  if (!data) return <LoadState error={error} loading />
  return <>
    {error && <LoadState error={error} loading={false} />}
    <Section title="Waiting for a person" count={data.person.length}>
      {data.person.length ? <ul className="list">{data.person.map(ticket => <TicketLine key={ticket.id} ticket={ticket} />)}</ul>
        : <p className="hint">Nothing needs you right now.</p>}
    </Section>
    {data.problems.length > 0 && <Section title="Problems" count={data.problems.length}>
      <ul className="list">{data.problems.map((problem, index) => <ProblemLine key={`${problem.kind}-${index}`} problem={problem}
        reload={reload} />)}</ul>
    </Section>}
    <div className="pair">
    <Section title="Executor">
      <div className="stats">
        <Stat label="Running" value={`${data.executor.running} / ${data.executor.maxWorkers}`} />
        <Stat label="Queued" value={data.executor.queued} />
        <Stat label="Idle" value={data.executor.idle} />
      </div>
    </Section>
    <Section title="Last 24 hours">
      <div className="stats">
        <Stat label="Received" value={data.flow.received} />
        <Stat label="Filtered" value={data.flow.filtered} />
        <Stat label="Evaluated" value={data.flow.judged} />
        <Stat label="Accepted" value={data.flow.accepted} />
        {data.flow.dropped > 0 && <Stat label="Dropped replies" value={data.flow.dropped} />}
      </div>
    </Section>
    </div>
    <RecentlyIgnored />
  </>
}
