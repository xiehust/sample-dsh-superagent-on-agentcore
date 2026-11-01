/** Installation-claim helpers shared by panel-tenant (unlink) and panel-platform (release). */
import type { CellRecord } from '@dshsa/contracts'
import { type HttpResult, json } from '../http.ts'

export interface CellUsing { cellId: string; status: CellRecord['status']; repo: string }

/** Cells that still use an installation: every cell except a disabled one (a paused cell resumes on the same installation). */
export const cellsUsing = (cells: CellRecord[], installationId: number): CellUsing[] => cells
  .filter(c => c.repo.installationId === installationId && c.status !== 'disabled')
  .map(c => ({ cellId: c.cellId, status: c.status, repo: `${c.repo.owner}/${c.repo.name}` }))

export const inUse = (cells: CellUsing[]): HttpResult => json(409, {
  error: 'installation_in_use', cells,
  message: `Repositories still use this installation (${cells.map(c => c.repo).join(', ')}); disable them first`,
})
