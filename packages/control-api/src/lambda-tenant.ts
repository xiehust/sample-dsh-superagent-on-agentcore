/** panel-tenant Lambda entry (onboarding design §2): `/v1/tenants/{t}/setup/**`. Env is set by infra/lib/panel.ts. */
import { S3Client } from '@aws-sdk/client-s3'
import { defaultProvider } from '@aws-sdk/credential-provider-node'
import { githubUserLogin, oauthExchange, orgMembership, revokeUserToken, userInstallations } from '@dshsa/sources/apis'
import * as ops from './admin/ops.ts'
import { stsCallerSigner } from './caller.ts'
import { fetchForwarder } from './forward.ts'
import type { HttpEvent, HttpResult } from './http.ts'
import { DynamoRepo } from './repo.ts'
import { adminClients, docClient, env, jsonLog } from './setup/clients.ts'
import { S3ConnectorState } from './setup/connector-state.ts'
import { DynamoHostDirectory, hostClient } from './setup/host.ts'
import { DynamoOnboarding } from './setup/onboarding.ts'
import { type TenantDeps, handleTenantSetup } from './setup/tenant.ts'

const db = docClient()
const c = adminClients(db)
const deps: TenantDeps = {
  repo: new DynamoRepo(db, {
    tenants: env('TABLE_TENANTS'), cells: env('TABLE_CELLS'), routes: env('TABLE_ROUTES'), leases: env('TABLE_LEASES'),
    ticketStorage: env('TABLE_TICKET_STORAGE'), onboarding: env('TABLE_ONBOARDING'),
  }),
  ops: {
    cellAdd: input => ops.cellAdd(c, input),
    cellSetStatus: (cellId, status) => ops.cellSetStatus(c, cellId, status),
    feishuSet: input => ops.feishuSet(c, input),
    chatBind: (t, chat, cell, name) => ops.chatBind(c, t, chat, cell, name),
    chatUnbind: (t, chat) => ops.chatUnbind(c, t, chat),
    tenantUsers: t => ops.tenantUsers(c, t),
    userInvite: (email, t, role) => ops.userInvite(c, email, t, role),
    userRemove: (email, t) => ops.userRemove(c, email, t),
    githubOauth: () => ops.githubOauth(c),
  },
  onboarding: new DynamoOnboarding(db, env('TABLE_ONBOARDING')),
  host: hostClient({
    directory: new DynamoHostDirectory(db, env('TABLE_LEASES')),
    callerProof: stsCallerSigner(defaultProvider(), process.env.AWS_REGION), forward: fetchForwarder, now: () => Date.now(),
  }),
  connector: new S3ConnectorState(new S3Client({}), env('STATE_BUCKET')),
  github: { exchange: input => oauthExchange(input), installations: (token, appId) => userInstallations(token, appId),
    login: token => githubUserLogin(token), membership: (token, org) => orgMembership(token, org), revoke: (token, client) => revokeUserToken(token, client) },
  panelUrl: env('PANEL_URL'),
  now: () => Date.now(),
  audit: line => console.log(line),
  log: jsonLog,
}

export const handler = (event: HttpEvent): Promise<HttpResult> => handleTenantSetup(event, deps)
