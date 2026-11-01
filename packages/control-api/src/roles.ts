/**
 * Panel roles (onboarding design §1, contracts v6 `PanelRole`): derived per tenant from the verified Cognito groups, never from
 * anything the client sends. A tenant admin must also be a member of the tenant's group; a disabled tenant grants no role.
 */
import { CognitoGroups, type PanelRole, type TenantRecord } from '@dshsa/contracts'
import { type Principal, canAccessTenant } from './authz.ts'

const RANK: Record<PanelRole, number> = { member: 1, tadmin: 2, admin: 3 }

/** The principal's role in `tenant`, or undefined when it has none (no access, unknown or disabled tenant). */
export function roleIn(principal: Principal, tenant: TenantRecord | undefined): PanelRole | undefined {
  if (!canAccessTenant(principal, tenant)) return undefined
  if (principal.platformAdmin) return 'admin'
  return principal.groups.includes(CognitoGroups.tenantAdmin(tenant.tenantId)) ? 'tadmin' : 'member'
}

/** Whether `role` meets `need` (member < tadmin < admin). An absent role never does. */
export const atLeast = (role: PanelRole | undefined, need: PanelRole): boolean => !!role && RANK[role] >= RANK[need]
