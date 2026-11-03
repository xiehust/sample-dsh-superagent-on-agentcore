/**
 * Worker transcript viewer: Claude Agent SDK session entries, or Codex rollout lines (`view.agent === 'codex'`, contracts v7 §7),
 * rendered as plain text with tool calls collapsed. Codex line shapes: codex-worker design §12 (codex 0.166.0).
 */
import { useEffect, useState } from 'react'
import { when } from './text.ts'
import type { TranscriptBlock, TranscriptEntry, TranscriptView } from './types.ts'
import { LoadState, useAction, usePanel } from './widgets.tsx'

export type Part = { kind: 'text'; text: string; tone?: 'commentary' } | { kind: 'tool'; name: string; detail: string }
  | { kind: 'result'; detail: string; error: boolean } | { kind: 'thinking'; detail: string }
export interface Message { key: string; role: string; at?: string; parts: Part[] }
/** A turn boundary of a Codex rollout: `label` names it ("Turn 2", "Turn 2 finished in 42 s"), `detail` its model and effort. */
export interface TurnMark { key: string; label: string; detail?: string }
export type Shown = ({ kind: 'message' } & Message) | ({ kind: 'turn' } & TurnMark)

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

type Json = Record<string, unknown>
const record = (value: unknown): Json | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined
const str = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined
/** The `text` of each item in a Codex content list (`text` / `Text` / `inputText` items alike). */
const texts = (value: unknown): string => Array.isArray(value)
  ? value.flatMap(item => typeof record(item)?.text === 'string' ? [record(item)!.text as string] : []).join('\n') : ''
const seconds = (ms: number) => ms < 10_000 ? String(Number((ms / 1000).toFixed(2))) : String(Math.round(ms / 1000))

/** One displayable item for a Codex `item_completed` line; unknown item types become a generic fold with the item JSON. */
function codexItem(item: Json, key: string, at: string | undefined): Message | undefined {
  const parts: Part[] = []
  switch (item.type) {
    case 'UserMessage': { const text = texts(item.content); return text ? { key, role: 'user', at, parts: [{ kind: 'text', text }] } : undefined }
    case 'AgentMessage': {
      const text = texts(item.content)
      return text ? { key, role: 'assistant', at, parts: [{ kind: 'text', text, ...item.phase === 'commentary' ? { tone: 'commentary' as const } : {} }] } : undefined
    }
    case 'DynamicToolCall':
      parts.push({ kind: 'tool', name: str(item.tool) ?? 'tool', detail: show(item.arguments ?? {}) },
        { kind: 'result', detail: texts(item.content_items), error: item.success === false })
      return { key, role: 'tool', at, parts }
    default: return { key, role: 'tool', at, parts: [{ kind: 'tool', name: str(item.type) ?? 'item', detail: show(item) }] }
  }
}

/**
 * Turns Codex rollout lines into messages and turn marks. `turn_context` (model, effort) is joined to its turn by `turn_id`:
 * codex writes it after `task_started`. `response_item` (the raw model conversation), `session_meta`, token and state lines are
 * skipped, and so is any line that is not an object of the expected shape.
 */
export function codexMessages(entries: TranscriptEntry[]): Shown[] {
  const contexts = new Map<string, { model?: string | undefined; effort?: string | undefined }>()
  for (const entry of entries) {
    const payload = record(record(entry)?.payload)
    const id = str(payload?.turn_id)
    if (entry?.type === 'turn_context' && payload && id) contexts.set(id, { model: str(payload.model), effort: str(payload.effort) })
  }
  const numbers = new Map<string, number>()
  let turns = 0
  const out: Shown[] = []
  entries.forEach((entry, index) => {
    // A rollout line is parsed JSON: `null` or a scalar is possible, and is skipped like any other malformed line.
    const payload = record(record(entry)?.payload)
    if (entry?.type !== 'event_msg' || !payload) return
    // The index keeps keys unique if a resumed rollout ever repeats an ordinal.
    const key = `${typeof entry.ordinal === 'number' ? entry.ordinal : ''}:${index}`
    const at = str(entry.timestamp)
    const id = str(payload.turn_id)
    if (payload.type === 'task_started') {
      turns += 1
      if (id) numbers.set(id, turns)
      const context = id ? contexts.get(id) : undefined
      const detail = context?.model ? `Model ${context.model}${context.effort ? `, effort ${context.effort}` : ''}` : undefined
      out.push({ kind: 'turn', key, label: `Turn ${turns}`, ...detail ? { detail } : {} })
    } else if (payload.type === 'task_complete') {
      const number = (id && numbers.get(id)) || turns
      const ms = typeof payload.duration_ms === 'number' ? payload.duration_ms : undefined
      out.push({ kind: 'turn', key, label: `Turn ${number} finished${ms === undefined ? '' : ` in ${seconds(ms)} s`}` })
    } else if (payload.type === 'item_completed') {
      const item = record(payload.item)
      const message = item && codexItem(item, key, at)
      if (message) out.push({ kind: 'message', ...message })
    }
  })
  return out
}

function PartView({ part }: { part: Part }) {
  if (part.kind === 'text') return part.tone === 'commentary'
    ? <div className="commentary"><span className="commentary-label">Progress</span><p className="plain">{part.text}</p></div>
    : <p className="plain">{part.text}</p>
  const summary = part.kind === 'tool' ? `Tool call: ${part.name}` : part.kind === 'result' ? part.error ? 'Tool result (error)'
    : 'Tool result' : 'Thinking'
  const error = part.kind === 'result' && part.error ? ' fold-error' : ''
  return <details className={`fold fold-${part.kind}${error}`}><summary>{summary}</summary><pre>{part.detail}</pre></details>
}

export function Transcript({ ticketId }: { ticketId: string }) {
  const { client, cell } = usePanel()
  const [view, setView] = useState<TranscriptView>()
  const [error, setError] = useState<unknown>()
  const load = useAction(async () => {
    try { setView(await client.transcript(cell.cellId, ticketId)); setError(undefined) } catch (failure) { setError(failure) }
  })
  useEffect(() => { void load.run() }, [cell.cellId, ticketId]) // eslint-disable-line react-hooks/exhaustive-deps
  const codex = view?.agent === 'codex'
  const shown: Shown[] = !view ? [] : codex ? codexMessages(view.entries ?? [])
    : messages(view.entries ?? []).map(message => ({ kind: 'message' as const, ...message }))
  return <div className="transcript">
    <div className="row-actions"><button type="button" disabled={load.busy} onClick={() => { void load.run() }}>Refresh transcript</button></div>
    <LoadState error={error} loading={!view && !error} />
    {view && !shown.length && <p className="hint">No transcript yet.</p>}
    {view?.truncated && <p className="hint">Showing the latest entries only.</p>}
    {codex && shown.length > 0 && <p className="hint">Codex worker</p>}
    <ol className="messages">{shown.map(item => item.kind === 'turn'
      ? <li key={item.key} className="turn" role="separator" aria-label={item.label}><strong>{item.label}</strong>
        {item.detail && <span>{item.detail}</span>}</li>
      : <li key={item.key} className="message" data-role={item.role}>
        <div className="message-head"><span className="role">{item.role}</span>{item.at && <span className="hint">{when(item.at)}</span>}</div>
        {item.parts.map((part, index) => <PartView key={index} part={part} />)}
      </li>)}</ol>
  </div>
}
