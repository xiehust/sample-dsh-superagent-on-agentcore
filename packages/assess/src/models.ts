/** Model choice per role (parent design §3): the contracts defaults, overridden per cell by `settings.eval.model`. */
import { Models } from '@dshsa/contracts'

export type ModelRole = 'eval' | 'reply'
/** The part of a cell's settings that names a model (`RoleModelSchema`: `{ provider, model, reasoningEffort? }`, or null). */
export interface ModelSettings { eval?: { model?: { model: string } | null } }
/** The Bedrock model id for `role`: the cell's eval model when one is set (it serves both roles, as DSH's main Session did), else the default. */
export function modelFor(role: ModelRole, settings?: ModelSettings): string {
  return settings?.eval?.model?.model || Models[role]
}
