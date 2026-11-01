/**
 * dshsa shim for DSH `src/deployment.ts`, so the copied views keep their imports: the cell's `CellInfo` stands in for the
 * resolved `Deployment`, and no Source field restarts anything (accounts come from the cell record, not from settings).
 */
import type { CellInfo } from '@dshsa/core/host'
export type Deployment = CellInfo
export const SETUP_FIELDS: Readonly<Record<string, readonly string[]>> = {}
