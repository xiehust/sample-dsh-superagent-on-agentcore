/**
 * Settings: Pause/Resume, Models (worker type, model and effort; Assessor and Replier; the Eval/Executor JSON under Advanced), the
 * Policy (a form driven by each Source's `policy.fields`, plus the raw JSON), the prompt config as a JSON editor with optimistic
 * revisions, and the tenant's Feishu chat bindings (read-only here; Team setup → Chats changes them). Members see everything read-only.
 * Save semantics (`{value, revision}`, 409 on a stale revision, a save bar only while dirty) follow dsh-superagent
 * `src/client/draft.tsx` and `src/client/settings-kit.tsx` (MIT, DeepSeek Harness superagent prototype).
 */
import { useState, type FormEvent } from 'react'
import { ApiError, errorText, usePoll } from './api.ts'
import { ModelsForm } from './models.tsx'
import { PolicySection } from './policy-form.tsx'
import type { CellView, PromptConfig, SettingsView } from './types.ts'
import { LoadState, ReadOnlyNote, Section, useAction, usePanel, useShell } from './widgets.tsx'

const pretty = (value: unknown) => JSON.stringify(value, null, 2) ?? ''

/**
 * A JSON textarea bound to a server value at a revision. The revision an edit starts from is kept, so a save after
 * someone else saved fails with 409 instead of overwriting their change. `readOnly` shows the value without a save path.
 */
export function JsonEditor({ title, value, revision, save, reload, readOnly = false }: {
  title: string; value: unknown; revision: number; save: (value: unknown, revision: number) => Promise<unknown>; reload: () => Promise<void>
  readOnly?: boolean
}) {
  const saved = pretty(value)
  const [draft, setDraft] = useState<{ text: string; base: number }>()
  const [conflict, setConflict] = useState(false)
  const [failure, setFailure] = useState<string>()
  const text = draft?.text ?? saved
  const dirty = !readOnly && draft !== undefined && draft.text !== saved
  let parsed: unknown, invalid: string | undefined
  try { parsed = JSON.parse(text) } catch (error) { invalid = error instanceof Error ? error.message : 'Invalid JSON' }
  const discard = () => { setDraft(undefined); setConflict(false); setFailure(undefined) }
  const submit = useAction(async () => {
    setFailure(undefined)
    await save(parsed, draft?.base ?? revision)
    discard()
    await reload()
  }, { onError: error => error instanceof ApiError && error.kind === 'conflict' ? setConflict(true) : setFailure(errorText(error)
    + (error instanceof ApiError && error.issues.length ? ` (${error.issues.map(issue => `${issue.path}: ${issue.message}`).join('; ')})` : '')) })
  const onSubmit = (event: FormEvent) => { event.preventDefault(); if (!invalid && !readOnly) void submit.run() }
  return <form className="editor" onSubmit={onSubmit}>
    <label className="editor-label">
      <span>{title}</span><span className="hint">revision {draft?.base ?? revision}</span>
      <textarea aria-label={`${title} JSON`} className="code" rows={Math.min(24, Math.max(6, text.split('\n').length + 1))}
        spellCheck={false} value={text} disabled={submit.busy} readOnly={readOnly}
        onChange={event => { if (!readOnly) setDraft({ text: event.target.value, base: draft?.base ?? revision }) }} />
    </label>
    {dirty && invalid && <p className="error" role="alert">Not valid JSON: {invalid}</p>}
    {conflict && <div className="notice notice-conflict" role="alert">
      <span>Changed elsewhere since you started editing. Reload to get the latest version, then reapply your edit.</span>
      <button type="button" onClick={() => { discard(); void reload() }}>Reload</button>
    </div>}
    {failure && <p className="error" role="alert">{failure}</p>}
    {dirty && <div className="save-bar" role="region" aria-label={`${title} unsaved changes`}>
      <span>Unsaved changes</span>
      <button type="button" onClick={discard} disabled={submit.busy}>Discard</button>
      <button type="submit" className="primary" disabled={!!invalid || submit.busy}>Save</button>
    </div>}
  </form>
}

function Processing() {
  const { client, cell, canEdit } = usePanel()
  const { data, error, reload } = usePoll(() => client.call(cell.cellId, 'GET state'), [cell.cellId])
  const toggle = useAction(async (paused: boolean) => { await client.call(cell.cellId, 'POST executor/pause', { body: { paused } }); await reload() })
  return <Section title="Processing">
    <LoadState error={error} loading={!data} />
    {data && <div className="row-meta">
      <span className="tag" data-state={data.paused ? 'paused' : 'running'}>{data.paused ? 'Paused' : 'Running'}</span>
      <span className="hint">{data.paused ? 'Triggers are recorded, but Eval, dispatch and replies wait.' : 'Eval and workers are running.'}</span>
      {canEdit && <button type="button" disabled={toggle.busy} onClick={() => { void toggle.run(!data.paused) }}>
        {data.paused ? 'Resume processing' : 'Pause processing'}</button>}
    </div>}
  </Section>
}

/** Models (design §6): the form built from `GET models`, or the Eval and Executor blocks as JSON under Advanced. */
function ModelsSection({ data, reload, save }: {
  data: SettingsView; reload: () => Promise<void>; save: (block: 'eval' | 'executor') => (value: unknown, revision: number) => Promise<unknown>
}) {
  const { canEdit } = usePanel()
  const [tab, setTab] = useState<'form' | 'json'>('form')
  return <>
    <div className="filters" role="group" aria-label="Models editor">
      <button type="button" className="pill" aria-pressed={tab === 'form'} onClick={() => setTab('form')}>Form</button>
      <button type="button" className="pill" aria-pressed={tab === 'json'} onClick={() => setTab('json')}>Advanced (JSON)</button>
    </div>
    {tab === 'form' ? <ModelsForm settings={data} reload={reload} /> : <>
      <JsonEditor title="Eval" value={data.blocks.eval.value} revision={data.blocks.eval.revision} reload={reload} save={save('eval')}
        readOnly={!canEdit} />
      <JsonEditor title="Executor (model, workers)" value={data.blocks.executor.value} revision={data.blocks.executor.revision}
        reload={reload} save={save('executor')} readOnly={!canEdit} />
    </>}
  </>
}

function Blocks() {
  const { client, cell, canEdit } = usePanel()
  const { data, error, reload } = usePoll(() => client.call(cell.cellId, 'GET settings'), [cell.cellId])
  const save = (block: 'policy' | 'eval' | 'executor') => (value: unknown, revision: number) =>
    client.call(cell.cellId, 'PUT settings/:block', { block, body: { value, revision } })
  return <>
    <Section title="Models">
      <LoadState error={error} loading={!data} />
      {data && <ModelsSection data={data} reload={reload} save={save} />}
    </Section>
    <Section title="Policy">
      <LoadState error={error} loading={!data} />
      {data && <PolicySection settings={data} reload={reload} jsonEditor={<JsonEditor title="Policy" value={data.blocks.policy.value}
        revision={data.blocks.policy.revision} reload={reload} save={save('policy')} readOnly={!canEdit} />} />}
    </Section>
  </>
}

/** The editor only checks JSON syntax; the host validates the `PromptConfig` (an unknown key or a missing section is a 400). */
function Prompts() {
  const { client, cell, canEdit } = usePanel()
  const { data, error, reload } = usePoll(() => client.call(cell.cellId, 'GET prompts'), [cell.cellId])
  return <Section title="Prompts">
    <LoadState error={error} loading={!data} />
    {data && <JsonEditor title="Prompt config" value={data.current.config} revision={data.current.revision} reload={reload} readOnly={!canEdit}
      save={(config, baseRevision) => client.call(cell.cellId, 'PUT prompts', { body: { config: config as PromptConfig, baseRevision } })} />}
  </Section>
}

const cellLabel = (cell: CellView | undefined, id: string) => cell?.repo?.owner && cell.repo.name ? `${cell.repo.owner}/${cell.repo.name}` : id

function ChatBindings() {
  const { client, cell, tenantCells, canEdit } = usePanel()
  const { go } = useShell()
  const tenantId = cell.tenantId
  const { data, error } = usePoll(() => client.bindings.list(tenantId), [tenantId])
  return <Section title="Feishu chat bindings" count={data?.length}
    actions={canEdit && <button type="button" onClick={() => go('setup', 'chats')}>Manage chats</button>}>
    <p className="hint">Messages in a bound chat go to its repository. {canEdit ? 'Bind and unbind chats in Team setup → Chats.' : ''}</p>
    <LoadState error={error} loading={!data} />
    {data && (data.length ? <table className="table">
      <thead><tr><th>Chat</th><th>Repository</th></tr></thead>
      <tbody>{data.map(binding => <tr key={binding.chatId}>
        <td>{binding.chatName || <code>{binding.chatId}</code>}</td>
        <td>{cellLabel(tenantCells.find(item => item.cellId === binding.cellId), binding.cellId)}</td>
      </tr>)}</tbody>
    </table> : <p className="hint">No chats are bound.</p>)}
  </Section>
}

export function SettingsPage() {
  const { canEdit } = usePanel()
  return <>
    {!canEdit && <ReadOnlyNote />}
    <Processing />
    <Blocks />
    <Prompts />
    <ChatBindings />
  </>
}
