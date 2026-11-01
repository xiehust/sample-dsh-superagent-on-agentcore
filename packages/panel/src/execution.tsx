/**
 * Execution: ticket list by stage filter, ticket detail with Stop/Retry, and the worker transcript.
 * Adapted from dsh-superagent `src/client/execution.tsx` and `src/client/ticket.tsx` (MIT, DeepSeek Harness superagent prototype).
 */
import { useState, type ReactNode } from 'react'
import { usePoll } from './api.ts'
import { TicketLine } from './overview.tsx'
import { FILTER_LABELS, localized, reasonText, safeHref, stageText, when } from './text.ts'
import { TICKET_FILTERS, type BasisFact, type InputView, type TicketFilter, type TicketPageView } from './types.ts'
import { Transcript } from './transcript.tsx'
import { ConfirmButton, LoadState, PlainText, Section, usePanel } from './widgets.tsx'

const PAGE = 20
export function TicketList() {
  const { client, cell } = usePanel()
  const [filter, setFilter] = useState<TicketFilter>('open')
  const [limit, setLimit] = useState(PAGE)
  const { data, error } = usePoll(() => client.call(cell.cellId, 'GET tickets', { query: { state: filter, limit } }),
    [cell.cellId, filter, limit])
  return <>
    <div className="filters" role="group" aria-label="Ticket filter">
      {TICKET_FILTERS.map(value => <button key={value} type="button" className="pill" aria-pressed={filter === value}
        onClick={() => { setFilter(value); setLimit(PAGE) }}>{FILTER_LABELS[value]}</button>)}
    </div>
    <LoadState error={error} loading={!data} />
    {data && (data.items.length ? <ul className="list">{data.items.map(ticket => <TicketLine key={ticket.id} ticket={ticket} />)}</ul>
      : <p className="hint">No tickets.</p>)}
    {data?.next_offset != null && <button type="button" onClick={() => setLimit(limit + PAGE)}>Load more</button>}
  </>
}

function KeyValues({ rows }: { rows: [string, ReactNode][] }) {
  return <dl className="kv">{rows.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
}
/** A mandate basis fact as text: facts without a value (`followup`, `observation`, `bot`) hold by being present. */
const fact = (item: BasisFact): string => {
  if (!('value' in item)) return 'yes'
  return Array.isArray(item.value) ? item.value.map(rule => rule.name).join(', ') : item.value
}
const actorText = (actor: TicketPageView['mandate']['actor']) => `${actor.source} · ${localized(actor.name, actor.id)}`
function inputText(input: InputView): string {
  if (input.trigger) return `${localized(input.trigger.actor.name, input.trigger.actor.id)}: ${input.trigger.preview}`
  // Only trigger inputs carry a `note`; every other kind has `text` once rendered by the host.
  return input.text ?? ('note' in input ? input.note : undefined) ?? input.kind
}
function Link({ href, children }: { href: string | undefined; children: ReactNode }) {
  const safe = safeHref(href)
  return safe ? <a href={safe} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>
}

export function TicketDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { client, cell } = usePanel()
  const { data, error, reload } = usePoll(() => client.call(cell.cellId, 'GET tickets/:id', { id }), [cell.cellId, id])
  const [transcript, setTranscript] = useState(false)
  const back = <button type="button" className="link" onClick={onBack}>← All tickets</button>
  if (!data) return <>{back}<LoadState error={error} loading /></>
  const after = async (request: Promise<unknown>) => { await request; await reload() }
  const undelivered = data.inputs.filter(input => !input.delivered)
  const halted = data.stage === 'person' && (data.action === 'blocked' || data.action === 'failed')
  return <>
    {back}
    {error && <LoadState error={error} loading={false} />}
    <header className="page-head">
      <h2>{data.title || data.id}</h2>
      <div className="row-actions">
        {data.actions.retry && <ConfirmButton label="Retry" title="Retry this ticket?" message={`The worker restarts “${data.title}”.`}
          onConfirm={() => after(client.call(cell.cellId, 'POST tickets/:id/retry', { id }))} />}
        {data.actions.stop && <ConfirmButton danger label="Stop" title="Stop this ticket?"
          message={`“${data.title}” ends and its worker stops. It will not resume on its own.`}
          onConfirm={() => after(client.call(cell.cellId, 'POST tickets/:id/stop', { id }))} />}
      </div>
    </header>
    <div className="row-meta">
      <span className="tag" data-stage={data.stage}>{stageText(data)}</span>
      <span>Mandate: {data.mandate.strength}</span>
      <span>Requested by: {actorText(data.mandate.actor)}</span>
      <span>Updated: {when(data.updatedAt)}</span>
    </div>
    {data.ended && <p className="hint">Ended {when(data.ended.at)}: {reasonText(data.ended.outcome)}{data.ended.reason
      ? ` (${reasonText(data.ended.reason)})` : ''}</p>}
    {data.attention && <div className="banner"><strong>Question for a person</strong><PlainText text={data.attention.question} />
      {data.channels[0] && <Link href={data.channels[0].url}>Answer in {data.channels[0].source}</Link>}</div>}
    {halted && data.summary && <div className="banner banner-danger"><strong>{data.action === 'failed' ? 'Failed' : 'Blocked'}</strong>
      <PlainText text={data.summary} /></div>}
    {data.deliveryError && <div className="banner banner-danger"><strong>Reply delivery failed</strong><PlainText text={data.deliveryError} /></div>}
    <Section title="Mandate">
      <KeyValues rows={[
        ...data.decision ? [['Trigger', data.decision.preview || '—'] as [string, ReactNode],
          ['Decision', `${data.decision.outcome} ${reasonText(data.decision.reason)}`.trim()] as [string, ReactNode]] : [],
        ['Scope', data.mandate.scope || '—'],
        ...data.basis.facts.map((item): [string, ReactNode] => [item.name, fact(item)]),
        ...data.mandate.policyVersion ? [['Policy version', <code>{data.mandate.policyVersion.slice(0, 8)}</code>] as [string, ReactNode]] : [],
      ]} />
    </Section>
    {undelivered.length > 0 && <Section title="Undelivered inputs" count={undelivered.length}>
      <p className="hint">{data.paused ? 'Processing is paused; inputs are delivered on resume.'
        : 'Delivered to the worker at its next step.'}</p>
      <ul className="list">{undelivered.map(input => <li key={input.id} className="row"><div className="row-main">
        <PlainText text={inputText(input)} /><div className="row-meta"><span>{input.kind}</span><span>{when(input.at)}</span></div>
      </div></li>)}</ul>
    </Section>}
    <Section title="Assignments" count={data.assignments.length}>
      {data.assignments.length ? <table className="table">
        <thead><tr><th>#</th><th>State</th><th>Report</th><th>Started</th><th>Ended</th><th>Reason</th></tr></thead>
        <tbody>{data.assignments.map((item, index) => <tr key={item.id}>
          <td>{index + 1}</td><td>{item.state}</td><td>{item.report?.state ?? ''}</td><td>{when(item.startedAt ?? item.createdAt)}</td>
          <td>{when(item.endedAt ?? item.turnEndedAt)}</td><td>{reasonText(item.endedReason)}</td>
        </tr>)}</tbody>
      </table> : <p className="hint">Not started yet.</p>}
    </Section>
    {data.channels.length > 0 && <Section title="Channels">
      <ul className="plain-list">{data.channels.map((channel, index) => <li key={index}>
        <Link href={channel.url}>{localized(channel.label, channel.url)}</Link></li>)}</ul>
    </Section>}
    <Section title="Transcript" actions={<button type="button" aria-expanded={transcript}
      onClick={() => setTranscript(!transcript)}>{transcript ? 'Hide transcript' : 'Show transcript'}</button>}>
      {transcript && <Transcript ticketId={data.id} />}
    </Section>
  </>
}

export function ExecutionPage({ ticketId, onSelect }: { ticketId?: string | undefined; onSelect: (id: string | undefined) => void }) {
  return ticketId ? <TicketDetail id={ticketId} onBack={() => onSelect(undefined)} /> : <TicketList />
}
