/** Model choice per role (design §4.11, contracts v7): the cell's settings resolved against the catalog and its defaults. */
import { resolveModel, type ModelSettings } from '@dshsa/contracts'

export type ModelRole = 'eval' | 'reply'
export type { ModelSettings }
/** The Bedrock model id for `role` (reply falls back to the eval model, then to the catalog default). */
export function modelFor(role: ModelRole, settings?: ModelSettings): string {
  return resolveModel(role, settings).model
}
/** The model and reasoning effort `role` calls with; `effort` is undefined when none should be sent. */
export function modelChoice(role: ModelRole, settings?: ModelSettings): { model: string; effort?: string } {
  const { model, effort } = resolveModel(role, settings)
  return { model, ...effort ? { effort } : {} }
}
