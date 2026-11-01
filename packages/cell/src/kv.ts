/**
 * dshsa adapter of DSH `src/kv.ts`: the KV families the cell runtime owns. Source cursor families (github-*, feishu-*) live in
 * `@dshsa/sources`; the key primitives come from `@dshsa/core/host`.
 */
import { family, record, type Family, type Key } from '@dshsa/core/host'
import type { PromptVersion } from './app/prompts.ts'
import type { SettingsVersion } from './app/store.ts'
import type { SettingsSave } from './policy.ts'

export { family, record, type Family, type Key }
export const KV = {
  /** Store: current database schema version. */
  store: { schema: record<number>('schema') },
  /** Settings: current revision, per-block revision, and saved settings snapshots (including the current one). */
  settings: { revision: record<number>('settings-revision'),
    block: family<number, [block: SettingsSave]>('settings-block-revision:'),
    version: family<SettingsVersion, [revision: number]>('settings-version:') },
  /** Prompts: current revision and saved prompt versions. */
  prompts: { revision: record<number>('prompt-revision'), version: family<PromptVersion, [revision: number]>('prompt-version:'),
    /** The built-in text of a prompt part an override was edited from, by its `base`, which shows what an upgrade changed. */
    builtIn: family<string, [base: string]>('prompt-built-in:') },
  /** Per-Source resolved display names mapping a named ID (such as a Feishu chat ID) to its display name. */
  sources: { labels: family<Record<string, string>, [source: string]>('source-labels:') },
  /** dshsa: worker events already applied, by event id (idempotent queue handling, design §4). */
  workerEvents: family<string, [eventId: string]>('worker-event:'),
  /** dshsa: the lease fence this database was last written under; a smaller fence never writes again. */
  lease: { fence: record<number>('lease-fence') },
}
