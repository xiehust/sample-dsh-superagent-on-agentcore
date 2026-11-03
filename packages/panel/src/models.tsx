/**
 * Settings → Models (task 11-03-panel-redesign, design §6): the worker type, model and reasoning effort, and the Assessor and
 * Replier models, as forms built entirely from `GET models` (contracts v7 catalog). No model id is written here.
 * Each block keeps its own draft and the revision the edit started from, like the Policy form: Worker saves `executor`,
 * Assessor and Replier save `eval`, each merged into the latest stored block value so other fields stay as they are.
 */
import { useId, useState, type ReactNode } from 'react'
import { ApiError, errorText, usePoll } from './api.ts'
import { effortText } from './text.ts'
import type { CatalogModel, ModelCatalog, ModelSurface, RoleModel, SettingsView, SurfaceSpec, WorkerType } from './types.ts'
import { ErrorState, LoadState, useAction, usePanel } from './widgets.tsx'

/** Local copy of contracts `surfaceOf` for the worker (a value import would bundle contracts code); `satisfies` keeps it in step. */
const WORKER_SURFACE = { claude: 'claude-worker', codex: 'codex-worker' } as const satisfies Record<WorkerType, ModelSurface>
const PROVIDER = 'bedrock'
const CATALOG_MS = 60_000

type ExecutorValue = SettingsView['blocks']['executor']['value']
type EvalValue = SettingsView['blocks']['eval']['value']
type Block<V> = { value: V; revision: number }
/** Which row a cell refusal belongs to. */
type Row = 'workerType' | 'worker' | 'assessor' | 'replier'

/** A v7 catalog has `defaults` and `workerTypes`; an older host answers `{models: [{id, roles}]}`. */
export const isCatalog = (data: unknown): data is ModelCatalog =>
  !!data && typeof data === 'object' && 'defaults' in data && 'workerTypes' in data && Array.isArray((data as ModelCatalog).models)

const modelsFor = (catalog: ModelCatalog, surface: ModelSurface): CatalogModel[] => catalog.models.filter(model => model.surfaces[surface])
const specOf = (catalog: ModelCatalog, id: string | undefined, surface: ModelSurface): SurfaceSpec | undefined =>
  id === undefined ? undefined : catalog.models.find(model => model.id === id)?.surfaces[surface]
const labelOf = (catalog: ModelCatalog, id: string) => catalog.models.find(model => model.id === id)?.label ?? id
const validFor = (catalog: ModelCatalog, value: RoleModel | null, surface: ModelSurface) => {
  if (!value) return true
  const spec = specOf(catalog, value.model, surface)
  return !!spec && (value.reasoningEffort === undefined || (spec.efforts as readonly string[]).includes(value.reasoningEffort))
}
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
/** A model choice with only the fields the cell stores (`reasoningEffort` omitted when unset). */
const choice = (model: string, effort?: string): RoleModel => ({ provider: PROVIDER, model, ...effort ? { reasoningEffort: effort } : {} })
/** One role's model and effort selects (`<label> model`, `<label> effort`). `defaultId` adds the Default (`null`) option. */
function RolePicker({ label, catalog, surface, value, defaultId, readOnly, error, note, onChange }: {
  label: string; catalog: ModelCatalog; surface: ModelSurface; value: RoleModel | null; defaultId?: string | undefined; readOnly: boolean
  error?: string | undefined; note?: ReactNode; onChange: (value: RoleModel | null) => void
}) {
  const id = useId()
  const list = modelsFor(catalog, surface)
  const known = !value || list.some(model => model.id === value.model)
  const spec = specOf(catalog, value?.model ?? defaultId, surface)
  const effortKnown = !value?.reasoningEffort || !!spec?.efforts.includes(value.reasoningEffort as never)
  const invalid = !known || !effortKnown
  const pickModel = (next: string) => {
    if (next === '') { onChange(null); return }
    const nextSpec = specOf(catalog, next, surface)
    // An effort the new model does not accept on this surface is dropped rather than carried over.
    const keep = value?.reasoningEffort && nextSpec?.efforts.includes(value.reasoningEffort as never) ? value.reasoningEffort : undefined
    onChange(choice(next, keep))
  }
  return <li className="row model-row" data-state={invalid || error ? 'problem' : undefined}>
    <div className="model-role" id={`${id}-role`}>{label}</div>
    <div className="model-controls">
      <label className="model-field"><span>Model</span>
        <select aria-label={`${label} model`} value={value?.model ?? ''} disabled={readOnly} aria-invalid={!known || undefined}
          onChange={event => pickModel(event.target.value)}>
          {defaultId !== undefined && <option value="">Default ({labelOf(catalog, defaultId)})</option>}
          {!known && value && <option value={value.model}>{value.model} (not available)</option>}
          {list.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
        </select>
      </label>
      <label className="model-field"><span>Effort</span>
        <select aria-label={`${label} effort`} value={value?.reasoningEffort ?? ''} disabled={readOnly || !value} aria-invalid={!effortKnown || undefined}
          onChange={event => value && onChange(choice(value.model, event.target.value || undefined))}>
          <option value="">{spec?.defaultEffort ? `Default (${effortText(spec.defaultEffort)})` : 'Model default'}</option>
          {!effortKnown && value?.reasoningEffort && <option value={value.reasoningEffort}>{value.reasoningEffort} (not available)</option>}
          {(value ? spec?.efforts ?? [] : []).map(effort => <option key={effort} value={effort}>{effortText(effort)}</option>)}
        </select>
      </label>
      {!value && <p className="hint model-note">Uses the default model's effort.</p>}
      {invalid && <p className="error model-note">Choose a model this installation offers.</p>}
      {note}
      {error && <p className="error model-note" role="alert">{error}</p>}
    </div>
  </li>
}

/** Save state shared by both forms: the draft's base revision, a 409, a refusal placed on its row, or a general failure. */
function useBlockSave<V>(block: 'executor' | 'eval', rowOf: (field: string | undefined) => Row | undefined, done: string, reload: () => Promise<void>,
  unavailableText = 'This worker type is not deployed in this installation.') {
  const { client, cell, notify } = usePanel()
  const [conflict, setConflict] = useState(false)
  const [rowError, setRowError] = useState<{ row: Row; text: string }>()
  const [failure, setFailure] = useState<string>()
  const clear = () => { setConflict(false); setRowError(undefined); setFailure(undefined) }
  const save = useAction(async (value: V, revision: number, after: () => void) => {
    clear()
    await client.call(cell.cellId, 'PUT settings/:block', { block, body: { value: value as never, revision } })
    after(); notify(done); await reload()
  }, { onError: error => {
    if (error instanceof ApiError && error.kind === 'conflict') { setConflict(true); return }
    const row = error instanceof ApiError && error.code === 'modelUnavailable' ? rowOf(error.values.field) : undefined
    const text = error instanceof ApiError && error.values.reason === 'workerUnavailable' ? unavailableText : errorText(error)
    if (row) setRowError({ row, text }); else setFailure(text)
  } })
  return { save, conflict, rowError, failure, clear }
}

function SaveBar({ title, saveLabel, busy, invalid, onDiscard, onSave }: {
  title: string; saveLabel: string; busy: boolean; invalid: boolean; onDiscard: () => void; onSave: () => void
}) {
  return <div className="save-bar" role="region" aria-label={`${title} unsaved changes`}>
    <span>Unsaved changes</span>
    <button type="button" onClick={onDiscard} disabled={busy}>Discard</button>
    <button type="button" className="primary" disabled={busy || invalid} onClick={onSave}>{saveLabel}</button>
  </div>
}

function Refusals({ conflict, failure, onReload }: { conflict: boolean; failure: string | undefined; onReload: () => void }) {
  return <>
    {conflict && <div className="notice notice-conflict" role="alert">
      <span>Changed elsewhere since you started editing. Reload to get the latest version, then reapply your edit.</span>
      <button type="button" onClick={onReload}>Reload</button>
    </div>}
    {failure && <p className="error" role="alert">{failure}</p>}
  </>
}

function WorkerForm({ catalog, block, reload }: { catalog: ModelCatalog; block: Block<ExecutorValue>; reload: () => Promise<void> }) {
  const { canEdit } = usePanel()
  const name = useId()
  const stored = { workerType: block.value.workerType, model: block.value.model as RoleModel | null }
  const [draft, setDraft] = useState<typeof stored & { base: number; reset?: boolean }>()
  const current = draft ?? stored
  const dirty = canEdit && !!draft && (draft.workerType !== stored.workerType || !same(draft.model, stored.model))
  const surface = WORKER_SURFACE[current.workerType]
  const typeLabel = (type: WorkerType) => catalog.workerTypes.find(item => item.id === type)?.label ?? type
  // `workerType` refusals go on the type row, `model` ones on the Worker model row (contract §2 `values.field`).
  const { save, conflict, rowError, failure, clear } = useBlockSave<ExecutorValue>('executor', field => field === 'model' ? 'worker' : 'workerType',
    'Worker settings saved.', reload, `${typeLabel(current.workerType)} worker is not deployed in this installation.`)
  const discard = () => { setDraft(undefined); clear() }
  const change = (next: Partial<typeof stored> & { reset?: boolean }) => {
    clear(); setDraft({ ...current, reset: false, ...next, base: draft?.base ?? block.revision })
  }
  const switchType = (type: WorkerType) => {
    if (type === current.workerType) return
    // A model chosen for the other worker type does not run on this one: fall back to this type's default.
    const keep = validFor(catalog, current.model, WORKER_SURFACE[type])
    change({ workerType: type, model: keep ? current.model : null, reset: !keep })
  }
  const currentType = catalog.workerTypes.find(item => item.id === current.workerType)
  const unavailable = catalog.workerTypes.filter(item => !item.available)
  // Only a changed model is validated by the cell; an untouched stored value never blocks the save.
  const invalid = !validFor(catalog, current.model, surface) && (!!draft && !same(draft.model, stored.model) || current.workerType !== stored.workerType)
  return <div className="model-block">
    <ul className="list models" aria-label="Worker">
      <li className="row model-row" data-state={currentType && !currentType.available ? 'problem' : undefined}>
        <div className="model-role" id={`${name}-type`}>Worker type</div>
        <div className="model-controls">
          <div className="radio-row" role="radiogroup" aria-labelledby={`${name}-type`}>
            {catalog.workerTypes.map(type => <label key={type.id} className="radio" data-disabled={!type.available && type.id !== current.workerType || undefined}>
              <input type="radio" name={name} value={type.id} checked={current.workerType === type.id}
                disabled={!canEdit || save.busy || (!type.available && type.id !== current.workerType)} onChange={() => switchType(type.id)} />
              {type.label}
            </label>)}
          </div>
          {unavailable.map(type => <p key={type.id} className="hint model-note">{type.label}: not deployed in this installation.</p>)}
          {currentType && !currentType.available && <p className="error model-note">New {currentType.label} tickets fail until a {currentType.label} worker
            is deployed.</p>}
          {rowError?.row === 'workerType' && <p className="error model-note" role="alert">{rowError.text}</p>}
        </div>
      </li>
      <RolePicker label="Worker" catalog={catalog} surface={surface} value={current.model} defaultId={catalog.defaults.worker[current.workerType]}
        readOnly={!canEdit || save.busy} error={rowError?.row === 'worker' ? rowError.text : undefined} onChange={model => change({ model })}
        note={draft?.reset ? <p className="hint model-note" role="status">Model reset to the {typeLabel(current.workerType)} default.</p> : undefined} />
    </ul>
    <Refusals conflict={conflict} failure={failure} onReload={() => { discard(); void reload() }} />
    {dirty && <SaveBar title="Worker" saveLabel="Save worker" busy={save.busy} invalid={invalid} onDiscard={discard}
      onSave={() => { void save.run({ ...block.value, workerType: current.workerType, model: current.model }, draft!.base, () => setDraft(undefined)) }} />}
  </div>
}

function AssessorReplierForm({ catalog, block, reload }: { catalog: ModelCatalog; block: Block<EvalValue>; reload: () => Promise<void> }) {
  const { canEdit } = usePanel()
  const stored = { model: block.value.model as RoleModel | null, replyModel: block.value.replyModel as RoleModel | null }
  const [draft, setDraft] = useState<typeof stored & { base: number }>()
  const current = draft ?? stored
  const dirty = canEdit && !!draft && (!same(draft.model, stored.model) || !same(draft.replyModel, stored.replyModel))
  const rowOf = (field: string | undefined): Row | undefined => field === 'replyModel' ? 'replier' : field === 'model' ? 'assessor' : undefined
  const { save, conflict, rowError, failure, clear } = useBlockSave<EvalValue>('eval', rowOf, 'Assessor and Replier saved.', reload)
  const discard = () => { setDraft(undefined); clear() }
  const change = (next: Partial<typeof stored>) => { clear(); setDraft({ ...current, ...next, base: draft?.base ?? block.revision }) }
  // What the Assessor resolves to: its stored model, or the default when unset or no longer offered on Converse.
  const assessorValid = !!current.model && validFor(catalog, current.model, 'converse')
  const assessorId = assessorValid ? current.model!.model : catalog.defaults.eval
  const assessorEffort = (assessorValid ? current.model?.reasoningEffort : undefined) ?? specOf(catalog, assessorId, 'converse')?.defaultEffort
  // A stored id the catalog does not know at all is used as-is by the cell (contract §2), so the summary names it; seeding the Replier
  // still takes the default, which this installation offers.
  const asIs = !!current.model && !catalog.models.some(model => model.id === current.model!.model)
  const replierSummary = asIs ? `${current.model!.model}${current.model!.reasoningEffort ? `, ${current.model!.reasoningEffort}` : ''}`
    : `${labelOf(catalog, assessorId)}${assessorEffort ? `, ${effortText(assessorEffort).toLowerCase()}` : ''}`
  const sameAsAssessor = current.replyModel === null
  const changed = (key: 'model' | 'replyModel') => !!draft && !same(draft[key], stored[key])
  const invalid = (changed('model') && !validFor(catalog, current.model, 'converse'))
    || (changed('replyModel') && !validFor(catalog, current.replyModel, 'converse'))
  return <div className="model-block">
    <ul className="list models" aria-label="Assessor and Replier">
      <RolePicker label="Assessor" catalog={catalog} surface="converse" value={current.model} defaultId={catalog.defaults.eval}
        readOnly={!canEdit || save.busy} error={rowError?.row === 'assessor' ? rowError.text : undefined} onChange={model => change({ model })} />
      {sameAsAssessor ? <li className="row model-row">
        <div className="model-role">Replier</div>
        <div className="model-controls">
          <label className="check"><input type="checkbox" checked disabled={!canEdit || save.busy}
            onChange={() => change({ replyModel: choice(assessorId, assessorValid ? current.model?.reasoningEffort : undefined) })} />Same as Assessor</label>
          <span className="hint">{replierSummary}</span>
          {rowError?.row === 'replier' && <p className="error model-note" role="alert">{rowError.text}</p>}
        </div>
      </li> : <RolePicker label="Replier" catalog={catalog} surface="converse" value={current.replyModel} readOnly={!canEdit || save.busy}
        error={rowError?.row === 'replier' ? rowError.text : undefined} onChange={replyModel => change({ replyModel })}
        note={<label className="check model-note"><input type="checkbox" checked={false} disabled={!canEdit || save.busy}
          onChange={() => change({ replyModel: null })} />Same as Assessor</label>} />}
    </ul>
    <Refusals conflict={conflict} failure={failure} onReload={() => { discard(); void reload() }} />
    {dirty && <SaveBar title="Assessor and Replier" saveLabel="Save Assessor and Replier" busy={save.busy} invalid={invalid} onDiscard={discard}
      onSave={() => { void save.run({ ...block.value, model: current.model, replyModel: current.replyModel }, draft!.base, () => setDraft(undefined)) }} />}
  </div>
}

/** Stored choices as text, for a host that predates the v7 catalog. */
function OlderHost({ settings }: { settings: SettingsView }) {
  const text = (value: { model: string; reasoningEffort?: string | undefined } | null | undefined) =>
    value ? `${value.model}${value.reasoningEffort ? `, ${value.reasoningEffort}` : ''}` : 'Default'
  return <div className="notice" role="note">
    <span>Update the cell host to choose models here. Advanced (JSON) still works.</span>
    <dl className="kv">
      <div><dt>Worker</dt><dd>{text(settings.blocks.executor.value.model)}</dd></div>
      <div><dt>Assessor</dt><dd>{text(settings.blocks.eval.value.model)}</dd></div>
      <div><dt>Replier</dt><dd>{settings.blocks.eval.value.replyModel ? text(settings.blocks.eval.value.replyModel) : 'Same as Assessor'}</dd></div>
    </dl>
  </div>
}

export function ModelsForm({ settings, reload }: { settings: SettingsView; reload: () => Promise<void> }) {
  const { client, cell } = usePanel()
  const catalog = usePoll(() => client.call(cell.cellId, 'GET models'), [cell.cellId], CATALOG_MS)
  if (catalog.error && !catalog.data) return <ErrorState error={catalog.error} />
  if (!catalog.data) return <LoadState loading />
  if (!isCatalog(catalog.data)) return <OlderHost settings={settings} />
  return <>
    <p className="hint">Model and effort apply from each ticket's next turn, including running tickets. Worker type applies to new tickets.</p>
    <WorkerForm catalog={catalog.data} block={settings.blocks.executor} reload={reload} />
    <AssessorReplierForm catalog={catalog.data} block={settings.blocks.eval} reload={reload} />
    <p className="hint">Concurrency, ticket directory, prepare and blocked commands are in Advanced (JSON).</p>
  </>
}
