/**
 * Calls a host's tenant-level internal route (onboarding design §3 step 5, agreed with 5c): any live host task serves
 * `/tenants/<t>/…`, authenticated by a presigned STS proof of `dshsa-panel-tenant` that signs `x-dshsa-target: tenant:<t>`.
 */
import { HOST_LEASE_PREFIX, Lease, leaseKey } from '@dshsa/contracts'
import { type DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb'
import type { Principal } from '../authz.ts'
import { type Forwarder, forwardHeaders, liveEndpoint } from '../forward.ts'
import type { PanelRole } from '@dshsa/contracts'

export const tenantTarget = (tenantId: string): string => `tenant:${tenantId}`

export interface HostDirectory {
  /** A live host endpoint for `tenantId`: a host presence lease, else the tenant's Connector, else any cell lease. */
  endpoint(tenantId: string, now: number): Promise<string | undefined>
}

type RawLease = { leaseKey?: unknown; endpoint?: unknown; expiresAt?: unknown }
const live = (lease: RawLease, now: number): string | undefined =>
  typeof lease.endpoint === 'string' && typeof lease.expiresAt === 'number'
    ? liveEndpoint({ leaseKey: String(lease.leaseKey), owner: 'x', fence: 0, endpoint: lease.endpoint, expiresAt: lease.expiresAt }, now)
    : undefined

/** Picks an endpoint from a scan of `dshsa-leases` (a small table: one row per cell, Connector and host task). */
export class DynamoHostDirectory implements HostDirectory {
  constructor(private readonly db: DynamoDBDocumentClient, private readonly table: string, private readonly random: () => number = Math.random) {}
  async endpoint(tenantId: string, now: number) {
    const leases: RawLease[] = []
    let ExclusiveStartKey: Record<string, unknown> | undefined
    do {
      const page = await this.db.send(new ScanCommand({
        TableName: this.table, ProjectionExpression: 'leaseKey, endpoint, expiresAt', ExclusiveStartKey,
        FilterExpression: 'expiresAt > :t', ExpressionAttributeValues: { ':t': now + Lease.stopBeforeExpiryMs },
      }))
      leases.push(...(page.Items ?? []) as RawLease[])
      ExclusiveStartKey = page.LastEvaluatedKey
    } while (ExclusiveStartKey)
    return pickHost(leases, tenantId, now, this.random)
  }
}

export function pickHost(leases: RawLease[], tenantId: string, now: number, random: () => number = Math.random): string | undefined {
  const endpoints = (match: (key: string) => boolean) =>
    leases.filter(l => typeof l.leaseKey === 'string' && match(l.leaseKey)).map(l => live(l, now)).filter((e): e is string => !!e)
  for (const group of [endpoints(k => k.startsWith(HOST_LEASE_PREFIX)), endpoints(k => k === leaseKey.connector(tenantId)), endpoints(k => k.startsWith('cell#'))]) {
    if (group.length) return group[Math.floor(random() * group.length)]
  }
  return undefined
}

export interface HostRepository { id: number; name: string; owner: string; fullName: string; private: boolean; archived: boolean; defaultBranch: string }
export type RepositoriesResult =
  | { ok: true; repositories: HostRepository[]; truncated: boolean }
  | { ok: false; reason: 'host_unavailable' | 'not_claimed' | 'installation_not_found' | 'github_error' | 'auth_rejected' }

export interface HostClient {
  repositories(tenantId: string, installationId: number, actor: Principal, role: PanelRole): Promise<RepositoriesResult>
}

export function hostClient(deps: { directory: HostDirectory; callerProof(target: string): Promise<string>; forward: Forwarder; now(): number }): HostClient {
  return {
    async repositories(tenantId, installationId, actor, role) {
      const endpoint = await deps.directory.endpoint(tenantId, deps.now())
      if (!endpoint) return { ok: false, reason: 'host_unavailable' }
      const target = tenantTarget(tenantId)
      let res
      try {
        res = await deps.forward({
          method: 'GET', url: `${endpoint}/tenants/${encodeURIComponent(tenantId)}/github/installations/${installationId}/repositories`,
          headers: forwardHeaders(await deps.callerProof(target), target, actor, false, role),
        })
      } catch { return { ok: false, reason: 'host_unavailable' } }
      if (res.status === 401) return { ok: false, reason: 'auth_rejected' }
      if (res.status === 403) return { ok: false, reason: 'not_claimed' }
      if (res.status === 404) return { ok: false, reason: 'installation_not_found' }
      if (res.status !== 200) return { ok: false, reason: res.status >= 500 && res.status !== 502 ? 'host_unavailable' : 'github_error' }
      const body = JSON.parse(res.body) as { repositories?: HostRepository[]; truncated?: boolean }
      return { ok: true, repositories: Array.isArray(body.repositories) ? body.repositories : [], truncated: !!body.truncated }
    },
  }
}
