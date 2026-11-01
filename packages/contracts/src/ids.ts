/** Identifier derivations (design §4.1). Python mirror: python/dshsa_contracts.py — keep both in sync with tests/vectors.json. */
import { createHash } from 'node:crypto'
import { z } from 'zod'

export const TenantId = z.string().regex(/^[a-z][a-z0-9-]{2,30}$/)
export type TenantId = z.infer<typeof TenantId>
export const CellId = z.string().regex(/^[a-z][a-z0-9-]{2,30}--gh\d+$/)
export type CellId = z.infer<typeof CellId>

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

export function cellId(tenantId: string, githubRepoId: number | string): string {
  const id = `${TenantId.parse(tenantId)}--gh${String(githubRepoId)}`
  return CellId.parse(id)
}
export function tenantOfCell(cell: string): string {
  return CellId.parse(cell).split('--gh')[0]!
}
/** Stable per-ticket key used for storage, the token `sub`, and the AP path. */
export const ticketKey = (cell: string, ticketId: string): string => sha256(`${cell}/${ticketId}`).slice(0, 32)
/** AgentCore runtimeSessionId (must be ≥ 33 chars). */
export const runtimeSessionId = (cell: string, ticketId: string): string => `dshsa-${sha256(`${cell}/${ticketId}`)}`
/** v4: S3 Files AP root paths allow at most 4 components, so the layout is `/tenants/<tenantId>/<cellId>/<ticketKey>`. */
export const accessPointRoot = (tenantId: string, cell: string, ticketId: string): string =>
  `/tenants/${tenantId}/${cell}/${ticketKey(cell, ticketId)}`
/** S3 key prefix of a ticket's files in the data bucket (the FS maps the bucket root). */
export const ticketDataPrefix = (tenantId: string, cell: string, ticketId: string): string =>
  `${accessPointRoot(tenantId, cell, ticketId).slice(1)}/`
export const MAX_AP_PATH_COMPONENTS = 4
export const cellQueueName = (cell: string): string => `dshsa-cell-${cell}.fifo`

export const routeKey = {
  github: (installationId: number | string, repoId: number | string): string => `gh#${installationId}#${repoId}`,
  feishu: (tenantId: string, chatId: string): string => `fs#${tenantId}#${chatId}`,
}
/** v6: `dshsa-onboarding` keys. */
export const onboardingKey = {
  githubInstall: (installationId: number | string): string => `ghinst#${installationId}`,
  githubState: (nonce: string): string => `ghstate#${nonce}`,
}
export const leaseKey = {
  cell: (cell: string): string => `cell#${cell}`,
  connector: (tenantId: string): string => `connector#${tenantId}`,
  /** v6: a host task's presence lease (endpoint discovery for tenant-level internal routes); `owner` is the task ARN. */
  host: (owner: string): string => `host#${owner}`,
}
/** v6: prefix of presence leases, for `begins_with` scans. */
export const HOST_LEASE_PREFIX = 'host#'
