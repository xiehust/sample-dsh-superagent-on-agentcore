/**
 * Policy form (onboarding design §5). Each Source's part of the Policy is rendered from the metadata its kind publishes in
 * `GET settings` (`sources[].policy.fields`, admission `rows`, optional `sync`), so a new field or Source needs no panel change.
 * Pickers fill the `allowed` list from GitHub collaborators and from members of the Feishu chats bound to this cell. Saving is
 * the existing `PUT settings/policy` with the revision the edit started from (409 → "changed elsewhere"); the cell's 400 issues
 * are shown under the field their path names (`sources.<source>.<field>.<row>.<column>`).
 * Field semantics follow dsh-superagent `src/client/settings-kit.tsx` and `src/sources/kind.ts` (MIT, DeepSeek Harness superagent prototype).
 */
import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { ApiError, errorText, usePoll } from './api.ts'
import { localized } from './text.ts'
import type { AdmissionCell, AdmissionRowView, ChatBinding, FieldSpec, Issue, RowColumn, RowsField, SettingsView, SourceSettings } from './types.ts'
import { useAction, usePanel } from './widgets.tsx'

type Row = Record<string, string>
type AdmissionTable = Record<string, Partial<Record<AdmissionCell, string>>>
type Part = Record<string, unknown> & { admission?: AdmissionTable }
interface PolicyValue { sources?: Record<string, Part>; [key: string]: unknown }
interface Person { id: string; name?: string | undefined }
type PolicySource = SourceSettings & { policy: NonNullable<SourceSettings['policy']> }

/** Local copies of the core admission constants (a value import would bundle host code). */
export const ADMISSION_CELLS = ['listedUnaddressed', 'unlistedAddressed', 'unlistedUnaddressed'] as const satisfies readonly AdmissionCell[]
const ADMISSION_OPTIONS: Record<AdmissionCell, readonly string[]> = { listedUnaddressed: ['inferred', 'ignore'],
  unlistedAddressed: ['explicit', 'inferred', 'ignore'], unlistedUnaddressed: ['inferred', 'ignore'] }
const ADMISSION_DEFAULTS: Record<AdmissionCell, string> = { listedUnaddressed: 'inferred', unlistedAddressed: 'ignore', unlistedUnaddressed: 'ignore' }
const CELL_LABELS: Record<AdmissionCell, string> = { listedUnaddressed: 'On the list, not addressed',
  unlistedAddressed: 'Not on the list, addressed', unlistedUnaddressed: 'Not on the list, not addressed' }
const ADMISSION_LABELS: Record<string, string> = { explicit: 'Explicit request', inferred: 'Candidate for Eval', ignore: 'Ignore' }
const MODES = [
  { value: 'off', label: 'Off', hint: 'Only explicit requests from people on the lists start work.' },
  { value: 'observe', label: 'Observe', hint: 'Eval also assesses candidates, but only records what it would accept.' },
  { value: 'auto', label: 'Auto', hint: 'Eval may start work it infers from candidates, under the enabled rules.' },
] as const

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const fullMatch = (pattern: string | undefined, value: string) => {
  if (!pattern) return true
  try { return new RegExp(`^(?:${pattern})$`).test(value) } catch { return true }
}
const rowsOf = (value: unknown): Row[] => Array.isArray(value)
  ? value.map(item => item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([key, cell]) => [key, String(cell ?? '')])) : {})
  : []
const fieldKey = (sourceId: string, key: string) => `${sourceId}.${key}`
const hasPolicy = (source: SourceSettings): source is PolicySource => !!source.policy

/** Client-side checks of one field from its metadata (patterns, required columns, duplicate row keys). */
export function fieldProblems(field: FieldSpec, value: unknown): string[] {
  if (field.type === 'rows') {
    const rows = rowsOf(value)
    const key = field.columns[0]!.key
    const out: string[] = []
    rows.forEach((row, index) => {
      for (const column of field.columns) {
        const cell = row[column.key] ?? ''
        const name = localized(column.label, column.key)
        if (column.type === 'select') {
          if (!column.options.some(option => option.value === cell)) out.push(`Row ${index + 1} · ${name}: choose a value`)
        } else if (!cell) {
          if (!column.optional) out.push(`Row ${index + 1} · ${name}: required`)
        } else if (!fullMatch(column.pattern, cell)) out.push(`Row ${index + 1} · ${name}: “${cell}” is not valid`)
      }
    })
    const seen = new Set<string>()
    for (const row of rows) {
      const id = row[key]
      if (id && seen.has(id)) out.push(`“${id}” is listed twice`)
      if (id) seen.add(id)
    }
    return out
  }
  if (field.type === 'text' && typeof value === 'string' && value && !fullMatch(field.pattern, value)) return [`“${value}” is not valid`]
  return []
}

/** Groups a cell's 400 issues by `source.field`; anything else (no Source prefix) is general. */
export function groupIssues(issues: Issue[], sources: PolicySource[]): { fields: Map<string, string[]>; general: string[] } {
  const fields = new Map<string, string[]>(), general: string[] = []
  for (const issue of issues) {
    const [root, sourceId, key, row, column] = issue.path.split('.')
    const source = sources.find(item => item.id === sourceId)
    const field = source?.policy.fields.find(item => item.key === key)
    if (root !== 'sources' || !source || (!field && key !== 'admission')) { general.push(`${issue.path || 'Policy'}: ${issue.message}`); continue }
    const columnLabel = field?.type === 'rows' ? field.columns.find(item => item.key === column) : undefined
    const at = [row !== undefined && /^\d+$/.test(row) ? `Row ${Number(row) + 1}` : key === 'admission' ? row : undefined,
      columnLabel ? localized(columnLabel.label, column) : key === 'admission' ? column : undefined].filter(Boolean).join(' · ')
    const list = fields.get(fieldKey(source.id, key!)) ?? []
    list.push(`${at ? `${at}: ` : ''}${issue.message}`)
    fields.set(fieldKey(source.id, key!), list)
  }
  return { fields, general }
}

export function PolicySection({ settings, reload, jsonEditor }: { settings: SettingsView; reload: () => Promise<void>; jsonEditor: ReactNode }) {
  const { client, cell } = usePanel()
  const [tab, setTab] = useState<'form' | 'json'>('form')
  const bindings = usePoll(() => client.bindings.list(cell.tenantId), [cell.tenantId], 60_000)
  const bound = (bindings.data ?? []).filter(binding => binding.cellId === cell.cellId)
  return <>
    <div className="filters" role="group" aria-label="Policy editor">
      <button type="button" className="pill" aria-pressed={tab === 'form'} onClick={() => setTab('form')}>Form</button>
      <button type="button" className="pill" aria-pressed={tab === 'json'} onClick={() => setTab('json')}>Advanced (JSON)</button>
    </div>
    {tab === 'form' ? <>
      <EvalMode block={settings.blocks.eval} reload={reload} />
      <PolicyForm value={settings.blocks.policy.value as PolicyValue} revision={settings.blocks.policy.revision}
        sources={settings.sources.filter(hasPolicy)} bound={bound} reload={reload} />
    </> : jsonEditor}
  </>
}

function EvalMode({ block, reload }: { block: SettingsView['blocks']['eval']; reload: () => Promise<void> }) {
  const { client, cell, canEdit, notify } = usePanel()
  const [draft, setDraft] = useState<{ mode: string; replyOnIgnore: boolean; base: number }>()
  const [conflict, setConflict] = useState(false)
  const stored: { mode: string; replyOnIgnore: boolean } = { mode: block.value.mode, replyOnIgnore: block.value.replyOnIgnore }
  const current = draft ?? stored
  const { mode } = current
  const dirty = canEdit && draft !== undefined && (draft.mode !== stored.mode || draft.replyOnIgnore !== stored.replyOnIgnore)
  const change = (next: Partial<typeof stored>) => setDraft({ ...current, ...next, base: draft?.base ?? block.revision })
  const save = useAction(async () => {
    await client.call(cell.cellId, 'PUT settings/:block', { block: 'eval', body: { value: { ...block.value, mode, replyOnIgnore: current.replyOnIgnore },
      revision: draft?.base ?? block.revision } })
    setDraft(undefined); notify('Eval settings saved.'); await reload()
  }, { onError: error => error instanceof ApiError && error.kind === 'conflict' ? setConflict(true) : notify(errorText(error)) })
  return <div className="field">
    <label className="field-label">Eval mode
      <select value={mode} disabled={!canEdit || save.busy} onChange={event => change({ mode: event.target.value })}>
        {MODES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select></label>
    <p className="hint">{MODES.find(item => item.value === mode)?.hint}</p>
    <label className="field-label"><input type="checkbox" checked={current.replyOnIgnore} disabled={!canEdit || save.busy}
      onChange={event => change({ replyOnIgnore: event.target.checked })} /> Reply when an explicit request is ignored</label>
    <p className="hint">A listed sender who mentions or messages the agent without a clear task gets one short reply on how to ask
      (at most one per conversation in 10 minutes). Others always get silence.</p>
    {conflict && <div className="notice notice-conflict" role="alert"><span>Changed elsewhere since you started editing. Reload to get the latest
      version.</span><button type="button" onClick={() => { setDraft(undefined); setConflict(false); void reload() }}>Reload</button></div>}
    {dirty && <div className="row-actions"><button type="button" onClick={() => setDraft(undefined)}>Discard</button>
      <button type="button" className="primary" disabled={save.busy} onClick={() => { void save.run() }}>Save Eval settings</button></div>}
  </div>
}

function PolicyForm({ value, revision, sources, bound, reload }: {
  value: PolicyValue; revision: number; sources: PolicySource[]; bound: ChatBinding[]; reload: () => Promise<void>
}) {
  const { client, cell, canEdit, notify } = usePanel()
  const [draft, setDraft] = useState<{ value: PolicyValue; base: number }>()
  const [conflict, setConflict] = useState(false)
  const [issues, setIssues] = useState<Issue[]>([])
  const [failure, setFailure] = useState<string>()
  const current = draft?.value ?? value
  const dirty = canEdit && draft !== undefined && !same(draft.value, value)
  const local = new Map(sources.flatMap(source => source.policy.fields.map(field =>
    [fieldKey(source.id, field.key), fieldProblems(field, current.sources?.[source.id]?.[field.key])] as const)))
  const invalid = [...local.values()].some(list => list.length > 0)
  const server = groupIssues(issues, sources)
  const update = (id: string, next: (part: Part) => Part) => {
    setIssues([]); setFailure(undefined)
    setDraft(previous => {
      const base = previous?.value ?? value
      return { value: { ...base, sources: { ...base.sources, [id]: next(base.sources?.[id] ?? {}) } }, base: previous?.base ?? revision }
    })
  }
  const discard = () => { setDraft(undefined); setConflict(false); setIssues([]); setFailure(undefined) }
  const save = useAction(async () => {
    await client.call(cell.cellId, 'PUT settings/:block', { block: 'policy', body: { value: current, revision: draft?.base ?? revision } })
    discard(); notify('Policy saved.'); await reload()
  }, { onError: error => {
    if (error instanceof ApiError && error.kind === 'conflict') setConflict(true)
    else if (error instanceof ApiError && error.issues.length) setIssues(error.issues)
    else setFailure(errorText(error))
  } })
  const submit = (event: FormEvent) => { event.preventDefault(); if (canEdit && !invalid) void save.run() }
  if (!sources.length) return <p className="hint">No Source of this repository has Policy fields.</p>
  return <form className="policy-form" onSubmit={submit} aria-label="Policy form">
    <p className="hint">Rules are edited in Advanced (JSON). Revision {draft?.base ?? revision}.</p>
    {sources.map(source => {
      const errors = (key: string) => [...dirty ? local.get(fieldKey(source.id, key)) ?? [] : [], ...server.fields.get(fieldKey(source.id, key)) ?? []]
      return <SourcePolicy key={source.id} source={source} part={current.sources?.[source.id] ?? {}} errors={errors} bound={bound}
        dirty={dirty} reload={reload} onChange={next => update(source.id, next)} />
    })}
    {server.general.length > 0 && <div className="notice notice-server" role="alert"><strong>The cell refused the Policy</strong>
      {server.general.map(text => <span key={text}>{text}</span>)}</div>}
    {conflict && <div className="notice notice-conflict" role="alert">
      <span>Changed elsewhere since you started editing. Reload to get the latest version, then reapply your edit.</span>
      <button type="button" onClick={() => { discard(); void reload() }}>Reload</button>
    </div>}
    {failure && <p className="error" role="alert">{failure}</p>}
    {dirty && <div className="save-bar" role="region" aria-label="Policy form unsaved changes">
      <span>Unsaved changes</span>
      <button type="button" onClick={discard} disabled={save.busy}>Discard</button>
      <button type="submit" className="primary" disabled={invalid || save.busy}>Save</button>
    </div>}
  </form>
}

function SourcePolicy({ source, part, errors, bound, dirty, reload, onChange }: {
  source: PolicySource; part: Part; errors: (key: string) => string[]; bound: ChatBinding[]; dirty: boolean; reload: () => Promise<void>
  onChange: (next: (part: Part) => Part) => void
}) {
  const { client, cell, canEdit, notify } = usePanel()
  const { policy } = source
  const title = localized(source.title, source.id)
  const sync = useAction(async () => {
    await client.call(cell.cellId, 'POST policy-sync/:id', { id: source.id }); notify(`${title}: list synced.`); await reload()
  })
  const set = (key: string, next: unknown) => onChange(previous => {
    const copy = { ...previous }
    if (next === undefined) delete copy[key]; else copy[key] = next
    return copy
  })
  return <fieldset className="source-policy" aria-label={`${title} policy`}>
    <legend>{title}</legend>
    {!source.value.enabled && <p className="hint">This Source is off; its Policy applies when it is on.</p>}
    <p className="hint">Explicit request: {localized(policy.explicit)}</p>
    {policy.fields.map(field => <PolicyField key={field.key} source={source} field={field} value={part[field.key]} bound={bound}
      errors={errors(field.key)} onChange={next => set(field.key, next)} />)}
    {policy.rows && policy.rows.length > 0 && <AdmissionEditor title={title} rows={policy.rows} table={part.admission ?? {}}
      errors={errors('admission')} onChange={table => set('admission', table)} />}
    {policy.sync && canEdit && <div className="row-actions">
      <button type="button" disabled={sync.busy || dirty || !policy.sync.ready} onClick={() => { void sync.run() }}>{localized(policy.sync.label, 'Sync now')}</button>
      {dirty && <span className="hint">Save or discard your changes first.</span>}
    </div>}
  </fieldset>
}

function Errors({ title, label, errors }: { title: string; label: string; errors: string[] }) {
  return errors.length ? <ul className="field-errors" role="alert" aria-label={`${title} · ${label} errors`}>
    {errors.map(text => <li key={text} className="error">{title} · {label}: {text}</li>)}
  </ul> : null
}

function PolicyField({ source, field, value, errors, bound, onChange }: {
  source: PolicySource; field: FieldSpec; value: unknown; errors: string[]; bound: ChatBinding[]; onChange: (value: unknown) => void
}) {
  const { canEdit } = usePanel()
  const id = useId()
  const title = localized(source.title, source.id)
  const label = localized(field.label, field.key)
  const hint = field.hint && <p className="hint">{localized(field.hint)}</p>
  if (field.type === 'rows') {
    return <div className="field" role="group" aria-labelledby={`${id}-label`}>
      <div className="field-label" id={`${id}-label`}>{label}</div>{hint}
      <RowsEditor source={source} field={field} label={label} rows={rowsOf(value)} bound={bound} readOnly={!canEdit}
        onChange={rows => onChange(rows.map(row => Object.fromEntries(Object.entries(row).filter(([, cell]) => cell !== ''))))} />
      <Errors title={title} label={label} errors={errors} />
    </div>
  }
  let control: ReactNode
  switch (field.type) {
    case 'switch': control = <input id={id} type="checkbox" checked={value === true} disabled={!canEdit} onChange={event => onChange(event.target.checked)} />; break
    case 'select': control = <select id={id} value={String(value ?? field.options[0]?.value ?? '')} disabled={!canEdit} onChange={event => onChange(event.target.value)}>
      {field.options.map(option => <option key={option.value} value={option.value}>{localized(option.label, option.value)}</option>)}</select>; break
    case 'number': control = <input id={id} type="number" min={field.min} max={field.max} value={typeof value === 'number' ? value : ''} disabled={!canEdit}
      onChange={event => onChange(event.target.value === '' ? undefined : Number(event.target.value))} />; break
    case 'fact': control = <span id={id}>{localized(source.facts[field.key] as never, '—')}</span>; break
    case 'text': {
      const text = typeof value === 'string' ? value : ''
      if (field.choose) {
        // `choose` picks from the Source's resolved labels (for Feishu: chat names) and the chats bound to this repository.
        const choices = new Map<string, string>(Object.entries(source.labels ?? {}))
        for (const binding of bound) choices.set(binding.chatId, binding.chatName || choices.get(binding.chatId) || binding.chatId)
        if (text && !choices.has(text)) choices.set(text, text)
        control = <select id={id} value={text} disabled={!canEdit || field.readonly} onChange={event => onChange(event.target.value)}>
          <option value="">{localized(field.choose)}</option>
          {[...choices].map(([key, name]) => <option key={key} value={key}>{name}</option>)}
        </select>
      } else {
        control = <input id={id} value={text} spellCheck={false} readOnly={field.readonly} disabled={!canEdit}
          aria-invalid={!!text && !fullMatch(field.pattern, text)} onChange={event => onChange(event.target.value)} />
      }
      break
    }
  }
  return <div className="field">
    <label className="field-label" htmlFor={id}>{label}</label>{control}{hint}
    <Errors title={title} label={label} errors={errors} />
  </div>
}

function cellControl(column: RowColumn, value: string, label: string, readOnly: boolean, onChange: (value: string) => void) {
  if (column.type === 'select') {
    return <select aria-label={label} value={value} disabled={readOnly} onChange={event => onChange(event.target.value)}>
      {!column.options.some(option => option.value === value) && <option value="">—</option>}
      {column.options.map(option => <option key={option.value} value={option.value}>{localized(option.label, option.value)}</option>)}
    </select>
  }
  return <input aria-label={label} value={value} spellCheck={false} disabled={readOnly} placeholder={column.optional ? 'optional' : ''}
    aria-invalid={value ? !fullMatch(column.pattern, value) : !column.optional} onChange={event => onChange(event.target.value)} />
}

const emptyRow = (field: RowsField): Row => Object.fromEntries(field.columns.map(column => [column.key, column.type === 'select' ? column.options[0]?.value ?? '' : '']))
/** A row for a picked person: the first column is the id; a `name` column (Feishu) gets the display name. */
const personRow = (field: RowsField, person: Person): Row => {
  const row = emptyRow(field)
  row[field.columns[0]!.key] = person.id
  if (person.name && field.columns.some(column => column.key === 'name')) row.name = person.name
  return row
}

function RowsEditor({ source, field, label, rows, bound, readOnly, onChange }: {
  source: PolicySource; field: RowsField; label: string; rows: Row[]; bound: ChatBinding[]; readOnly: boolean; onChange: (rows: Row[]) => void
}) {
  const key = field.columns[0]!.key
  const existing = new Set(rows.map(row => row[key]).filter(Boolean) as string[])
  const add = (people: Person[]): number => {
    const have = new Set(existing), next = [...rows]
    for (const person of people) if (!have.has(person.id)) { have.add(person.id); next.push(personRow(field, person)) }
    if (next.length !== rows.length) onChange(next)
    return next.length - rows.length
  }
  const edit = (index: number, column: string, value: string) => onChange(rows.map((row, at) => at === index ? { ...row, [column]: value } : row))
  return <>
    {rows.length ? <table className="table rows-table">
      <thead><tr>{field.columns.map(column => <th key={column.key}>{localized(column.label, column.key)}</th>)}<th /></tr></thead>
      <tbody>{rows.map((row, index) => <tr key={index}>
        {field.columns.map(column => <td key={column.key}>{cellControl(column, row[column.key] ?? '',
          `${label} row ${index + 1} ${localized(column.label, column.key)}`, readOnly, value => edit(index, column.key, value))}</td>)}
        <td>{!readOnly && <button type="button" className="link" aria-label={`Remove ${row.name || row[key] || `row ${index + 1}`} from ${label}`}
          onClick={() => onChange(rows.filter((_, at) => at !== index))}>Remove</button>}</td>
      </tr>)}</tbody>
    </table> : <p className="hint">Nobody is listed.</p>}
    {!readOnly && <div className="row-actions picker-actions">
      <button type="button" aria-label={`Add a row to ${label}`} onClick={() => onChange([...rows, emptyRow(field)])}>Add row</button>
      {field.key === 'allowed' && source.kind === 'github' && <CollaboratorPicker existing={existing} add={add} />}
      {field.key === 'allowed' && source.kind === 'feishu' && <ChatMemberPicker chats={bound} existing={existing} add={add} />}
    </div>}
  </>
}

function PickList({ title, people, existing, add, onClose }: {
  title: string; people: Person[]; existing: Set<string>; add: (people: Person[]) => number; onClose: () => void
}) {
  const missing = people.filter(person => !existing.has(person.id))
  return <div className="pick-list" role="group" aria-label={title}>
    <div className="row-actions"><strong>{title}</strong>
      <button type="button" disabled={!missing.length} onClick={() => add(missing)}>Add all ({missing.length})</button>
      <button type="button" className="link" onClick={onClose}>Close</button></div>
    {people.length ? <ul className="plain-list">{people.map(person => <li key={person.id} className="row-meta">
      <span>{person.name ? `${person.name} (${person.id})` : person.id}</span>
      {existing.has(person.id) ? <span className="hint">Listed</span>
        : <button type="button" aria-label={`Add ${person.name || person.id}`} onClick={() => add([person])}>Add</button>}
    </li>)}</ul> : <p className="hint">Nobody found.</p>}
  </div>
}

function CollaboratorPicker({ existing, add }: { existing: Set<string>; add: (people: Person[]) => number }) {
  const { client, cell } = usePanel()
  const [people, setPeople] = useState<Person[]>()
  const load = useAction(async () => setPeople((await client.call(cell.cellId, 'GET sources/github/collaborators')).collaborators))
  return people ? <PickList title="Repository collaborators" people={people} existing={existing} add={add} onClose={() => setPeople(undefined)} />
    : <button type="button" disabled={load.busy} onClick={() => { void load.run() }}>Add from repo collaborators</button>
}

function ChatMemberPicker({ chats, existing, add }: { chats: ChatBinding[]; existing: Set<string>; add: (people: Person[]) => number }) {
  const { client, cell, notify } = usePanel()
  const [open, setOpen] = useState<{ chat: ChatBinding; people: Person[] }>()
  const members = async (chat: ChatBinding) => (await client.call(cell.cellId, 'GET sources/feishu/members', { query: { chat: chat.chatId } })).members
  const name = (chat: ChatBinding) => chat.chatName || chat.chatId
  const addAll = useAction(async (chat: ChatBinding) => {
    const added = add(await members(chat))
    notify(added ? `Added ${added} ${added === 1 ? 'person' : 'people'} from ${name(chat)}.` : `Everyone in ${name(chat)} is already listed.`)
  })
  const pick = useAction(async (chat: ChatBinding) => setOpen({ chat, people: await members(chat) }))
  if (!chats.length) return <span className="hint">Bind a chat to this repository (Team setup → Chats) to add its members.</span>
  return <>
    {chats.map(chat => <span key={chat.chatId} className="row-actions">
      <button type="button" disabled={addAll.busy} onClick={() => { void addAll.run(chat) }}>Add all members of {name(chat)}</button>
      <button type="button" disabled={pick.busy} onClick={() => { void pick.run(chat) }}>Pick from {name(chat)}</button>
    </span>)}
    {open && <PickList title={`Members of ${name(open.chat)}`} people={open.people} existing={existing} add={add} onClose={() => setOpen(undefined)} />}
  </>
}

function AdmissionEditor({ title, rows, table, errors, onChange }: {
  title: string; rows: AdmissionRowView[]; table: AdmissionTable; errors: string[]; onChange: (table: AdmissionTable | undefined) => void
}) {
  const { canEdit } = usePanel()
  const set = (row: string, cell: AdmissionCell, value: string) => {
    const next: AdmissionTable = { ...table, [row]: { ...table[row] } }
    // A cell left at its default is not stored, so the Policy only records deliberate choices.
    if (value === ADMISSION_DEFAULTS[cell]) delete next[row]![cell]; else next[row]![cell] = value
    if (!Object.keys(next[row]!).length) delete next[row]
    onChange(Object.keys(next).length ? next : undefined)
  }
  return <div className="field">
    <div className="field-label">Admission</div>
    <p className="hint">What a message becomes, by where it arrives and who sends it. Someone on the list who addresses the agent always makes an
      explicit request.</p>
    <table className="table admission">
      <thead><tr><th>Where</th>{ADMISSION_CELLS.map(cell => <th key={cell}>{CELL_LABELS[cell]}</th>)}</tr></thead>
      <tbody>{rows.map(row => {
        const name = localized(row.label, row.id)
        return <tr key={row.id}>
          <td>{name}<div className="hint">{localized(row.note)}</div></td>
          {ADMISSION_CELLS.map(cell => <td key={cell}>{row.cells[cell]
            ? <select aria-label={`${title} · ${name}: ${CELL_LABELS[cell]}`} disabled={!canEdit}
              value={table[row.id]?.[cell] ?? ADMISSION_DEFAULTS[cell]} onChange={event => set(row.id, cell, event.target.value)}>
              {ADMISSION_OPTIONS[cell].map(option => <option key={option} value={option}>{ADMISSION_LABELS[option]}</option>)}
            </select> : <span className="hint">—</span>}</td>)}
        </tr>
      })}</tbody>
    </table>
    <Errors title={title} label="Admission" errors={errors} />
  </div>
}
