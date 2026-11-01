/**
 * dshsa adapter of DSH `src/app/migration.ts`. Cells are created fresh on AWS, so no database predates schema 11: opening an
 * older one is refused. `migrateSettings` (the settings-shape migration that `policy.spec` covers) is kept verbatim.
 */
import type { Store } from './store.ts'

export const SCHEMA_VERSION = 11
/** The oldest database schema version this build can open; dshsa cells start at schema 11. */
export const OLDEST_SCHEMA = 11
export const tooOld = (version: number): string =>
  `Orchestrator database schema ${version} predates schema ${OLDEST_SCHEMA}, which dshsa cells cannot migrate; start with a new state directory`
/** Never reached: `Store` calls it only for a schema between OLDEST_SCHEMA and SCHEMA_VERSION. */
export function migrateTo11(_store: Store): void { throw new Error('dshsa cells start at schema 11') }

type Stored = Record<string, unknown>
const isObject = (value: unknown): value is Stored => !!value && typeof value === 'object' && !Array.isArray(value)

// --- verbatim from DSH src/app/migration.ts ---
interface Member { name?: string; feishuId?: string; github?: string }
/**
 * Convert legacy flat settings (chat lists in Policy, top-level pause flag) or pre-schema-11 domain settings into current domain blocks:
 * strips fields replaced by rule instructions and prompts (Executor reviewers and branch prefix, rule `visual` flag, `autoMergeLineLimit`, Source `authority`, GitHub `mergeCli`), extracts `paused` to the top level, and splits cross-source `members` into per-source `policy.sources` entries.
 */
export function migrateSettings(value: unknown): unknown {
  if (!isObject(value)) return value
  if (!('members' in value || 'allowedChats' in value || 'admission' in value)) return withoutRemovedFields(value)
  const old = value as { models?: { orchestrator?: unknown; worker?: unknown }; paused?: boolean; allowedChats?: string[]; members?: unknown[];
    allowDirectMessages?: boolean; pollSeconds?: number; maxWorkers?: number; admission?: { mode?: string; chats?: string[]; timeoutSeconds?: number; rules?: unknown[] } }
  const chats = new Map<string, 'mentions' | 'all'>()
  for (const chatId of old.allowedChats ?? []) chats.set(chatId, 'mentions')
  // Observed chats were active only when admission was enabled.
  if (old.admission?.mode !== 'off') for (const chatId of old.admission?.chats ?? []) chats.set(chatId, 'all')
  const feishu = { chats: [...chats].map(([chatId, listen]) => ({ chatId, listen })), directMessages: old.allowDirectMessages ?? true }
  return withoutRemovedFields({
    sources: { feishu: { enabled: true, config: feishu }, github: { enabled: true, config: { pollSeconds: old.pollSeconds ?? 60 } } },
    policy: { ...(old.members ? { members: old.members } : {}), ...(old.admission?.rules ? { rules: old.admission.rules } : {}) },
    eval: { ...(old.admission?.mode ? { mode: old.admission.mode } : {}), ...(old.admission?.timeoutSeconds ? { timeoutSeconds: old.admission.timeoutSeconds } : {}),
      model: old.models?.orchestrator ?? null },
    executor: { model: old.models?.worker ?? null, ...(old.maxWorkers ? { maxWorkers: old.maxWorkers } : {}), paused: old.paused ?? false },
  })
}
function withoutRemovedFields(value: Stored): Stored {
  const { executor, policy, sources, ...rest } = value as { executor?: Stored; policy?: Stored; sources?: Record<string, Stored> }
  // `paused` is now a top-level setting rather than a field on `executor`.
  const { reviewer: _reviewer, visualReviewer: _visualReviewer, branchPrefix: _branchPrefix, paused, ...kept } = executor ?? {}
  const { members, memberChat, autoMergeLineLimit: _limit, rules: storedRules, ...policyRest } = policy ?? {}
  const rules = Array.isArray(storedRules) ? storedRules.map((rule: unknown) => { if (!isObject(rule)) return rule; const { visual: _visual, ...fields } = rule; return fields })
    : storedRules
  const people = Array.isArray(members) ? members as Member[] : undefined
  const parts = people ? {
    feishu: { allowed: people.filter(member => member.feishuId).map(member => ({ id: member.feishuId!, ...(member.name ? { name: member.name } : {}) })),
      ...(memberChat ? { syncChat: memberChat } : {}) },
    github: { allowed: people.filter(member => member.github).map(member => ({ id: member.github! })) },
  } : undefined
  // The GitHub Source no longer configures a dedicated merge account; auto-merge policy now lives in prompts.
  const withoutMerge = (id: string, config: unknown) => { if (id !== 'github' || !isObject(config)) return config; const { mergeCli: _mergeCli, ...fields } = config; return fields }
  const instances = sources ? Object.fromEntries(Object.entries(sources).map(([id, instance]) => {
    const { authority: _authority, ...fields } = instance
    return [id, 'config' in fields ? { ...fields, config: withoutMerge(id, fields.config) } : fields]
  })) : undefined
  // Rewrite environment variable prefixes from the project's earlier names in `prepare` commands.
  if (typeof kept.prepare === 'string') kept.prepare = kept.prepare.replace(/\bDSH_(?:TAG|GO|FREELANCER)_/g, 'DSH_SUPERAGENT_')
  return { ...rest, ...(typeof paused === 'boolean' ? { paused } : {}), ...(executor ? { executor: kept } : {}),
    ...(instances ? { sources: instances } : {}),
    ...(policy ? { policy: { ...policyRest, ...(rules ? { rules } : {}), ...(parts ? { sources: parts } : {}) } } : {}) }
}
