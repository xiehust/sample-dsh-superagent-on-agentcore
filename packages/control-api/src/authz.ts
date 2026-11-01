/** Panel principal from the API Gateway JWT authorizer claims, and tenant access rules (design §4.1, parent §5 Panel). */
import { CognitoGroups, type TenantRecord } from '@dshsa/contracts'

export const PLATFORM_ADMIN_GROUP = CognitoGroups.platformAdmin
export const tenantGroup = CognitoGroups.tenant

export interface Principal { sub: string; email?: string; groups: string[]; platformAdmin: boolean }

/**
 * `cognito:groups` reaches an HTTP API JWT authorizer as an array, or flattened to the string `"[a b]"` / `"a,b"`.
 * Group names never contain spaces, commas or brackets (CLI-created), so splitting on them is safe.
 */
export function parseGroups(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((g): g is string => typeof g === 'string' && g.length > 0)
  if (typeof raw !== 'string') return []
  return raw.replace(/^\[|\]$/g, '').split(/[\s,]+/).map(g => g.trim()).filter(Boolean)
}

export function principalFrom(claims: Record<string, unknown> | undefined): Principal | undefined {
  const sub = claims?.sub
  if (typeof sub !== 'string' || !sub) return undefined
  const groups = parseGroups(claims?.['cognito:groups'])
  const email = typeof claims?.email === 'string' ? claims.email : typeof claims?.username === 'string' ? claims.username : undefined
  return { sub, email, groups, platformAdmin: groups.includes(PLATFORM_ADMIN_GROUP) }
}

/** A member of the tenant's group (or a platform admin) may act on an active tenant. Disabled tenants are closed to all. */
export function canAccessTenant(principal: Principal, tenant: TenantRecord | undefined): tenant is TenantRecord {
  if (!tenant || tenant.status !== 'active') return false
  return principal.platformAdmin || principal.groups.includes(tenant.cognitoGroup)
}

/** Tenant ids a principal's groups may name (verified against each tenant's `cognitoGroup` by the caller). */
export function candidateTenantIds(principal: Principal): string[] {
  const prefix = tenantGroup('')
  return principal.groups.filter(g => g.startsWith(prefix)).map(g => g.slice(prefix.length))
}
