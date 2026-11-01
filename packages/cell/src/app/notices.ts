/**
 * dshsa adapter of DSH `src/app/notices.ts`: only the settings and prompt notices (verbatim). There is no main Session on
 * AWS, so the notices are recorded for the panel instead of being injected into a Session.
 */

/**
 * A background notice tuple for the main Session: `[name, value, summary]`, where `name` is the coalescing key in
 * `Effects` (a newer notice with the same `name` overwrites an unsent waiting one, rather than permanently deduplicating future notices).
 */
export type Notice = readonly [name: string, value: Record<string, unknown>, summary: string]
/** Builds a notice for a saved prompt configuration revision, coalescing under `'prompts'`. */
export const promptsNotice = (revision: number): Notice =>
  ['prompts', { prompt_config_saved: revision, effect: 'next-request', read: `prompts/${revision}` }, `Prompt configuration saved (revision ${revision})`]
/**
 * Builds a notice for a saved settings block with the changed dot-separated paths (coalescing per block under
 * `settings:<block>`), or for the whole settings on legacy saves that recorded no block.
 */
export const settingsNotice = (block?: string, changed: string[] = []): Notice => block
  ? [`settings:${block}`, { settings_saved: block, changed, read: `settings/${block}` }, `Settings saved: ${block}`]
  : ['settings', { settings_saved: true, read: 'settings' }, 'Settings saved']
/** Returns up to 20 dot-separated paths where two values differ (e.g. `eval.mode` or `policy.rules.1.enabled`). */
export function changedPaths(before: unknown, after: unknown, path = ''): string[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return []
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return [path]
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
  const at = (value: object, name: string) => (value as Record<string, unknown>)[name]
  return keys.flatMap(name => changedPaths(at(before, name), at(after, name), path ? `${path}.${name}` : name)).slice(0, 20)
}
