/** dshsa shim for DSH `src/setup.ts`: the shape of a setup problem the copied views display (the host reports cell problems this way). */
export type SetupPlace = 'deployment' | 'github' | 'feishu'
export interface SetupProblem { place: SetupPlace; code: string; values: Record<string, string>; detail: string }
