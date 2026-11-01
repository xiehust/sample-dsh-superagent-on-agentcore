/** panel-platform Lambda entry (onboarding design §2): `/v1/admin/**`, platform admins only. Env is set by infra/lib/panel.ts. */
import * as ops from './admin/ops.ts'
import type { HttpEvent, HttpResult } from './http.ts'
import { adminClients, docClient, env, jsonLog } from './setup/clients.ts'
import { DynamoOnboarding } from './setup/onboarding.ts'
import { type PlatformDeps, handlePlatform } from './setup/platform.ts'

const db = docClient()
const c = adminClients(db)
const onboarding = new DynamoOnboarding(db, env('TABLE_ONBOARDING'))
const deps: PlatformDeps = {
  ops: {
    tenantList: () => ops.tenantList(c),
    tenantAdd: (t, name) => ops.tenantAdd(c, t, name),
    tenantSetStatus: (t, status) => ops.tenantSetStatus(c, t, status),
    tenantUsers: t => ops.tenantUsers(c, t),
    platformAdmins: () => ops.platformAdmins(c),
    userInvite: (email, t, role) => ops.userInvite(c, email, t, role, { ensureGroups: true }),
    userAddAdmin: email => ops.userAddAdmin(c, email),
    userRemove: (email, t) => ops.userRemove(c, email, t),
    adminRemove: email => ops.adminRemove(c, email),
    githubAppSet: input => ops.githubAppSet(c, input),
    githubOauthSet: input => ops.githubOauthSet(c, input),
    githubAppStatus: () => ops.githubAppStatus(c),
    releaseClaim: (id, t) => onboarding.releaseClaim(id, t),
    getClaim: id => onboarding.getClaim(id),
    listPendingClaims: () => onboarding.listPending(),
    listAllClaims: () => onboarding.listAllClaims(),
    tenantCells: t => ops.cellList(c, t),
    approveClaim: (id, by, at) => onboarding.approveClaim(id, by, at),
  },
  panelUrl: env('PANEL_URL'),
  now: () => Date.now(),
  audit: line => console.log(line),
  log: jsonLog,
}

export const handler = (event: HttpEvent): Promise<HttpResult> => handlePlatform(event, deps)
