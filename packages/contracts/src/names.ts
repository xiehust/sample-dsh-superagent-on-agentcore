/** AWS resource names (design §3, §4.2, §4.9). Everything is prefixed `dshsa-`. */
export const PREFIX = 'dshsa'
export const REGION = 'ap-northeast-1'

export const Tables = {
  tenants: 'dshsa-tenants',
  cells: 'dshsa-cells',
  routes: 'dshsa-routes',
  leases: 'dshsa-leases',
  ticketStorage: 'dshsa-ticket-storage',
  /** v6: GitHub installation claims and OAuth state nonces (pk `key`, TTL `ttl`, GSI `byTenant`); never route-shaped. */
  onboarding: 'dshsa-onboarding',
} as const
export const OnboardingByTenantIndex = 'byTenant'
export const CellsByTenantIndex = 'byTenant'
export const RoutesByTenantIndex = 'byTenant'

export const CognitoGroups = {
  tenant: (tenantId: string): string => `dshsa-tenant-${tenantId}`,
  platformAdmin: 'dshsa-platform-admin',
  /** v6: tenant admin of one tenant (always also in `tenant(t)`); a distinct prefix, as tenant ids may contain `-`. */
  tenantAdmin: (tenantId: string): string => `dshsa-tadmin-${tenantId}`,
} as const
/** v6: tenant ids `tenantAdd` refuses (the TenantId schema is unchanged so stored records keep parsing). */
export const RESERVED_TENANT_IDS: readonly string[] = ['admin', 'tadmin', 'platform']
/** v6: the panel role panel-api derives from verified claims and forwards to the cell in `PanelRoleHeader`. */
export type PanelRole = 'member' | 'tadmin' | 'admin'
export const PanelRoleHeader = 'x-dshsa-role'

export const Stacks = {
  shared: 'dshsa-shared', worker: 'dshsa-worker', host: 'dshsa-host', ingress: 'dshsa-ingress', panel: 'dshsa-panel',
} as const

export const Buckets = {
  data: (account: string): string => `dshsa-data-${account}`,
  state: (account: string): string => `dshsa-state-${account}`,
  panel: (account: string): string => `dshsa-panel-${account}`,
}
export const StateKeys = {
  litestream: (cell: string): string => `cells/${cell}/`,
  connectorKv: (tenantId: string): string => `connectors/${tenantId}/kv.json`,
}

export const TicketTokenKeyAlias = 'alias/dshsa-ticket-token'
export const Secrets = {
  githubApp: 'dshsa/github-app',
  /** @deprecated v3 */
  internalApi: 'dshsa/internal-api',
  feishuBot: (tenantId: string): string => `dshsa/feishu/${tenantId}`,
  /** v6: GitHub App OAuth client `{clientId, clientSecret}`, separate from the App private key. */
  githubOauth: 'dshsa/github-oauth',
} as const
/** v6: CloudWatch log group of panel setup mutations (one AuditEntry per line). */
export const PanelAuditLogGroup = '/dshsa/panel-admin'

export const Models = {
  eval: 'global.anthropic.claude-sonnet-5-5',
  reply: 'global.anthropic.claude-sonnet-5-5',
  worker: 'global.anthropic.claude-opus-5-5',
} as const

export const WorkerPosix = { uid: 1000, gid: 1000 } as const
export const ManagedTag = { key: 'dshsa:managed', value: 'true' } as const
/** v3 (design §4.7): presigned sts:GetCallerIdentity URL proving the caller's IAM role; it must sign `x-dshsa-target`. */
/** @deprecated v3: replaced by InternalApiCallerHeader; kept until cell/control-api/worker-api migrate. */
export const InternalApiHeader = 'x-dshsa-internal'
export const InternalApiCallerHeader = 'x-dshsa-caller'
export const InternalApiTargetHeader = 'x-dshsa-target'
export const InternalApiCallerTtlSec = 60
export const stsRegionalEndpoint = (region: string = REGION): string => `https://sts.${region}.amazonaws.com/`
/** worker-api: the ticket token header (the private API itself is AWS_IAM). */
export const TicketTokenHeaderName = 'x-dshsa-ticket-token'
export const InternalApiPort = 8080
