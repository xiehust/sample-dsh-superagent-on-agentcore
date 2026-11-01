/** Worker transcript viewer: Claude Agent SDK session entries rendered as plain text, with tool calls collapsed. */
import { useEffect, useState } from 'react'
import { when } from './text.ts'
import type { TranscriptBlock, TranscriptEntry, TranscriptView } from './types.ts'
import { LoadState, useAction, usePanel } from './widgets.tsx'

export type Part = { kind: 'text'; text: string } | { kind: 'tool'; name: string; detail: string }
  | { kind: 'result'; detail: string; error: boolean } | { kind: 'thinking'; detail: string }
export interface Message { key: string; role: string; at?: string; parts: Part[] }

const show = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? ''
function resultText(content: unknown): string {
  if (Array.isArray(content)) return content.map(item => item && typeof item === 'object' && 'text' in item ? String(item.text)
    : show(item)).join('\n')
  return show(content)
}
function part(block: TranscriptBlock): Part | undefined {
  switch (block.type) {
    case 'text': return { kind: 'text', text: String(block.text ?? '') }
    case 'thinking': return { kind: 'thinking', detail: String(block.thinking ?? '') }
    case 'tool_use': return { kind: 'tool', name: String(block.name ?? 'tool'), detail: show(block.input ?? {}) }
    case 'tool_result': return { kind: 'result', detail: resultText(block.content), error: block.is_error === true }
    default: return undefined
  }
}
/** Turns transcript lines into displayable messages; lines without a message (summaries, metadata) are skipped. */
export function messages(entries: TranscriptEntry[]): Message[] {
  return entries.flatMap((entry, index) => {
    const content = entry.message?.content
    if (content === undefined) return []
    const parts = typeof content === 'string' ? [{ kind: 'text' as const, text: content }]
      : Array.isArray(content) ? content.flatMap(block => block && typeof block === 'object' ? part(block) ?? [] : []) : []
    if (!parts.length) return []
    return [{ key: entry.uuid ?? String(index), role: entry.message?.role ?? entry.type ?? 'entry', at: entry.timestamp, parts }]
  })
}

function PartView({ part }: { part: Part }) {
  if (part.kind === 'text') return <p className="plain">{part.text}</p>
  const summary = part.kind === 'tool' ? `Tool call: ${part.name}` : part.kind === 'result' ? part.error ? 'Tool result (error)'
    : 'Tool result' : 'Thinking'
  return <details className={`fold fold-${part.kind}`}><summary>{summary}</summary><pre>{part.detail}</pre></details>
}

export function Transcript({ ticketId }: { ticketId: string }) {
  const { client, cell } = usePanel()
  const [view, setView] = useState<TranscriptView>()
  const [error, setError] = useState<unknown>()
  const load = useAction(async () => {
    try { setView(await client.transcript(cell.cellId, ticketId)); setError(undefined) } catch (failure) { setError(failure) }
  })
  useEffect(() => { void load.run() }, [cell.cellId, ticketId]) // eslint-disable-line react-hooks/exhaustive-deps
  const shown = view ? messages(view.entries ?? []) : []
  return <div className="transcript">
    <div className="row-actions"><button type="button" disabled={load.busy} onClick={() => { void load.run() }}>Refresh transcript</button></div>
    <LoadState error={error} loading={!view && !error} />
    {view && !shown.length && <p className="hint">No transcript yet.</p>}
    {view?.truncated && <p className="hint">Showing the latest entries only.</p>}
    <ol className="messages">{shown.map(message => <li key={message.key} className="message" data-role={message.role}>
      <div className="message-head"><span className="role">{message.role}</span>{message.at && <span className="hint">{when(message.at)}</span>}</div>
      {message.parts.map((item, index) => <PartView key={index} part={item} />)}
    </li>)}</ol>
  </div>
}
