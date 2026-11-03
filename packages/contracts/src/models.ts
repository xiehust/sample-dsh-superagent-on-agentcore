/**
 * Model catalog and per-role model resolution (design §4.11, contracts v7). The panel builds every model picker from this
 * catalog (cell `GET models`); the cell validates settings saves against it; assess and the executor resolve the model and
 * reasoning effort each call sends. Python mirror: `dshsa_contracts.py` (`MODEL_CATALOG`, `check_model`); shared vectors in
 * `tests/vectors.json`.
 */
import { z } from 'zod'

/** Worker agent type: chosen per cell (`settings.executor.workerType`), fixed per ticket when its first assignment starts. */
export const WorkerType = z.enum(['claude', 'codex'])
export type WorkerType = z.infer<typeof WorkerType>
export const WORKER_TYPES = WorkerType.options
/** Reasoning effort values across surfaces; each model lists the subset it accepts per surface. */
export const Effort = z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
export type Effort = z.infer<typeof Effort>
/** Where a model is called: Converse (assessor, replier), the Claude Agent SDK worker, the Codex app-server worker. */
export const MODEL_SURFACES = ['converse', 'claude-worker', 'codex-worker'] as const
export type ModelSurface = typeof MODEL_SURFACES[number]
export type ModelRole = 'eval' | 'reply' | 'worker'

export interface SurfaceSpec {
  efforts: readonly Effort[]
  /** Sent when the cell set no effort. Absent → no effort is sent (the model's or CLI's own default). */
  defaultEffort?: Effort
  /** converse only: the model accepts a forced `toolChoice: { tool }` (Claude Sonnet/Opus 5.5 do not). */
  forceTool?: boolean
  /** converse only: the model accepts an explicit `cachePoint` in `system` (GPT-6 Luna rejects it and caches implicitly). */
  promptCache?: boolean
}
export interface CatalogModel {
  /** Bedrock inference-profile id. */
  id: string
  label: string
  family: 'anthropic' | 'openai'
  /** Panel grouping hint only. */
  tier: 'large' | 'medium' | 'small'
  surfaces: Partial<Record<ModelSurface, SurfaceSpec>>
}

const CLAUDE: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const GPT: readonly Effort[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max']
/** Codex `turn/start.effort` (0.166.0) without `ultra`, which turns on sub-agents. */
const CODEX: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** Live-verified 2026-11-03 in ap-northeast-1 (Converse probes and codex 0.166.0 turns). */
export const MODEL_CATALOG: readonly CatalogModel[] = [
  { id: 'global.anthropic.claude-opus-5-5', label: 'Claude Opus 5.5', family: 'anthropic', tier: 'large',
    surfaces: { 'claude-worker': { efforts: CLAUDE } } },
  { id: 'global.anthropic.claude-sonnet-5-5', label: 'Claude Sonnet 5.5', family: 'anthropic', tier: 'medium',
    surfaces: { converse: { efforts: CLAUDE, promptCache: true }, 'claude-worker': { efforts: CLAUDE } } },
  { id: 'global.anthropic.claude-haiku-5-5', label: 'Claude Haiku 5.5', family: 'anthropic', tier: 'small',
    surfaces: { converse: { efforts: CLAUDE, forceTool: true, promptCache: true }, 'claude-worker': { efforts: CLAUDE } } },
  { id: 'global.openai.gpt-6-astra', label: 'GPT-6 Astra', family: 'openai', tier: 'large',
    surfaces: { 'codex-worker': { efforts: CODEX } } },
  { id: 'global.openai.gpt-6.1-sol', label: 'GPT-6.1 Sol', family: 'openai', tier: 'large',
    surfaces: { 'codex-worker': { efforts: CODEX } } },
  { id: 'global.openai.gpt-6.1-terra', label: 'GPT-6.1 Terra', family: 'openai', tier: 'medium',
    surfaces: { converse: { efforts: GPT, forceTool: true, promptCache: true }, 'codex-worker': { efforts: CODEX, defaultEffort: 'high' } } },
  { id: 'global.openai.gpt-6-luna', label: 'GPT-6 Luna', family: 'openai', tier: 'small',
    surfaces: { converse: { efforts: GPT, defaultEffort: 'low', forceTool: true, promptCache: false } } },
]

export const DEFAULT_MODELS = {
  eval: 'global.openai.gpt-6-luna',
  reply: 'global.openai.gpt-6-luna',
  worker: { claude: 'global.anthropic.claude-opus-5-5', codex: 'global.openai.gpt-6.1-terra' },
} as const satisfies { eval: string; reply: string; worker: Record<WorkerType, string> }

export const WORKER_TYPE_LABELS: Record<WorkerType, string> = { claude: 'Claude Agent', codex: 'Codex' }

export const catalogModel = (id: string): CatalogModel | undefined => MODEL_CATALOG.find(model => model.id === id)
export const surfaceOf = (role: ModelRole, workerType: WorkerType = 'claude'): ModelSurface =>
  role === 'worker' ? `${workerType}-worker` : 'converse'
export const surfaceSpec = (id: string, surface: ModelSurface): SurfaceSpec | undefined => catalogModel(id)?.surfaces[surface]

export type ModelProblem = 'unknownModel' | 'wrongSurface' | 'badEffort'
/** Why `id` (with `effort`) cannot be used on `surface`, or null when it can. */
export function checkModel(surface: ModelSurface, id: string, effort?: string): ModelProblem | null {
  const model = catalogModel(id)
  if (!model) return 'unknownModel'
  const spec = model.surfaces[surface]
  if (!spec) return 'wrongSurface'
  if (effort !== undefined && !(spec.efforts as readonly string[]).includes(effort)) return 'badEffort'
  return null
}

/** The part of a RoleModel (`@dshsa/core` `RoleModelSchema`) resolution reads. */
interface StoredModel { model: string; reasoningEffort?: string | undefined }
/** The part of cell settings resolution reads; every field optional so pre-v7 settings resolve too. */
export interface ModelSettings {
  eval?: { model?: StoredModel | null; replyModel?: StoredModel | null }
  executor?: { model?: StoredModel | null; workerType?: WorkerType }
}
export interface ResolvedModel {
  model: string
  /** Undefined → send none. */
  effort?: Effort
  surface: ModelSurface
  /** `stored`: the cell's choice (possibly a pre-v7 id outside the catalog, used as-is); `default`: the catalog default. */
  source: 'stored' | 'default' | 'fallback'
}

/**
 * The model and effort `role` uses under `settings`. `workerType` overrides `settings.executor.workerType` (the ticket's sticky
 * type). Reply falls back to the eval model. A stored id outside the catalog is used as-is without effort (a worker id only for
 * the cell's own worker type); a catalog id on the wrong surface (a ticket of the cell's previous worker type, or hand-edited
 * data) falls back to the surface default. A stored effort the surface does not list is replaced by the surface default, if any.
 */
export function resolveModel(role: ModelRole, settings?: ModelSettings, workerType?: WorkerType): ResolvedModel {
  const type = workerType ?? settings?.executor?.workerType ?? 'claude'
  const surface = surfaceOf(role, type)
  const stored = role === 'worker' ? settings?.executor?.model
    : role === 'reply' ? settings?.eval?.replyModel ?? settings?.eval?.model : settings?.eval?.model
  const fallbackId = role === 'worker' ? DEFAULT_MODELS.worker[type] : DEFAULT_MODELS[role]
  const withEffort = (model: string, effort: string | undefined, source: ResolvedModel['source']): ResolvedModel => {
    const spec = surfaceSpec(model, surface)
    const chosen = effort !== undefined && spec && (spec.efforts as readonly string[]).includes(effort) ? effort as Effort : spec?.defaultEffort
    return { model, surface, source, ...chosen ? { effort: chosen } : {} }
  }
  if (stored?.model) {
    const model = catalogModel(stored.model)
    // A pre-v7 id outside the catalog was chosen for the cell's own worker type: a ticket of another type uses its default.
    const storedFor = role !== 'worker' || type === (settings?.executor?.workerType ?? 'claude')
    if (!model) return storedFor ? { model: stored.model, surface, source: 'stored' } : withEffort(fallbackId, undefined, 'fallback')
    if (model.surfaces[surface]) return withEffort(stored.model, stored.reasoningEffort, 'stored')
    return withEffort(fallbackId, undefined, 'fallback')
  }
  return withEffort(fallbackId, undefined, 'default')
}

/** `GET models` (cell API): the catalog, the defaults, and which worker types this installation runs. */
export interface ModelCatalogView {
  models: readonly CatalogModel[]
  defaults: typeof DEFAULT_MODELS
  workerTypes: { id: WorkerType; label: string; available: boolean }[]
}
