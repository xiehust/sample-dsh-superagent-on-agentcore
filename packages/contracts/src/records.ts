/** DynamoDB item shapes (design §4.2). */
import { z } from 'zod'
import { CellId, TenantId } from './ids.ts'

const Iso = z.string().datetime({ offset: true })

export const FeishuDomain = z.enum(['feishu', 'lark'])
export type FeishuDomain = z.infer<typeof FeishuDomain>
export const feishuOpenApiBase = (domain: FeishuDomain): string =>
  domain === 'feishu' ? 'https://open.feishu.cn' : 'https://open.larksuite.com'

export const TenantRecord = z.object({
  tenantId: TenantId,
  name: z.string().min(1),
  cognitoGroup: z.string().min(1),
  status: z.enum(['active', 'disabled']),
  /** v6 `revision`: time of the last `feishu set`; hosts restart the tenant's Connector when it changes. */
  feishu: z.object({ domain: FeishuDomain, appId: z.string().min(1), secretArn: z.string().min(1), revision: Iso.optional() }).optional(),
  createdAt: Iso,
})
export type TenantRecord = z.infer<typeof TenantRecord>

export const RepoRef = z.object({
  owner: z.string().min(1), name: z.string().min(1), id: z.number().int().positive(),
  installationId: z.number().int().positive(), defaultBranch: z.string().min(1),
})
export type RepoRef = z.infer<typeof RepoRef>

export const CellRecord = z.object({
  cellId: CellId,
  tenantId: TenantId,
  repo: RepoRef,
  queueUrl: z.string().url(),
  status: z.enum(['active', 'paused', 'disabled']),
  stateBucketPrefix: z.string(),
  createdAt: Iso,
})
export type CellRecord = z.infer<typeof CellRecord>

export const RouteRecord = z.object({
  routeKey: z.string().regex(/^(gh#\d+#\d+|fs#[a-z][a-z0-9-]{2,30}#.+)$/),
  /** GSI `byTenant` (design §4.2, v2). */
  tenantId: TenantId,
  cellId: CellId,
  /** Feishu routes only: the chat's display name when it was bound. */
  chatName: z.string().optional(),
  updatedAt: Iso,
  updatedBy: z.string().min(1),
})
export type RouteRecord = z.infer<typeof RouteRecord>

export const LeaseRecord = z.object({
  leaseKey: z.string().regex(/^(cell|connector|host)#.+$/),
  owner: z.string().min(1),
  endpoint: z.string().url().optional(),
  fence: z.number().int().nonnegative(),
  expiresAt: z.number().int(),
})
export type LeaseRecord = z.infer<typeof LeaseRecord>
export const Lease = { ttlMs: 30_000, renewEveryMs: 10_000, stopBeforeExpiryMs: 5_000 } as const

export const TicketStorageRecord = z.object({
  ticketKey: z.string().regex(/^[0-9a-f]{32}$/),
  tenantId: TenantId,
  cellId: CellId,
  ticketId: z.string().min(1),
  runtimeSessionId: z.string().min(33),
  fileSystemId: z.string().min(1),
  accessPointId: z.string().min(1),
  rootPath: z.string().regex(/^\/tenants\/[a-z][a-z0-9-]{2,30}\/[a-z][a-z0-9-]{2,30}--gh\d+\/[0-9a-f]{32}$/),
  posixUid: z.literal(1000),
  posixGid: z.literal(1000),
  status: z.enum(['active', 'disabled', 'deleted']),
  createdAt: Iso,
})
export type TicketStorageRecord = z.infer<typeof TicketStorageRecord>

/** v6: a GitHub App installation bound to one tenant through the panel's verified install flow (design onboarding §3). */
export const InstallationClaim = z.object({
  key: z.string().regex(/^ghinst#\d+$/),
  tenantId: TenantId,
  installationId: z.number().int().positive(),
  /**
   * v6.2: `active` only when the claimer proved control: a User installation on the claimer's own GitHub account, or an
   * Organization installation where the claimer is an active org **admin**. Otherwise `pending` until a platform admin
   * approves. Required (no default): anything that is not explicitly `active` lists no repositories (fail closed).
   */
  status: z.enum(['active', 'pending']),
  /** The installation's GitHub account (user or organization) and its type. */
  account: z.string().min(1),
  accountType: z.enum(['User', 'Organization']),
  /** GitHub login whose user token proved access to the installation. */
  githubLogin: z.string().min(1),
  /** Why it is pending, e.g. `not_org_admin`, `not_own_account`. */
  pendingReason: z.string().max(100).optional(),
  claimedBy: z.string().min(1),
  claimedAt: Iso,
  approvedBy: z.string().min(1).optional(),
  approvedAt: Iso.optional(),
})
export type InstallationClaim = z.infer<typeof InstallationClaim>

/** v6: a single-use OAuth `state` nonce, bound to the tenant and the Cognito `sub` that started the link; `ttl` in epoch seconds. */
export const SetupState = z.object({
  key: z.string().regex(/^ghstate#[A-Za-z0-9_-]{32,128}$/),
  tenantId: TenantId,
  sub: z.string().min(1),
  ttl: z.number().int().positive(),
})
export type SetupState = z.infer<typeof SetupState>

/** v6: the App's OAuth client; `appId`/`slug` are mirrored by `github app-set` so panel-tenant never reads the App private key. */
export const GithubOauthSecret = z.object({ clientId: z.string().min(1), clientSecret: z.string().min(1),
  appId: z.string().regex(/^\d+$/).optional(), slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional() })
export type GithubOauthSecret = z.infer<typeof GithubOauthSecret>

/** v6: one panel setup mutation in `/dshsa/panel-admin`; never a secret value or message text. */
export const AuditEntry = z.object({
  at: Iso,
  actor: z.object({ sub: z.string().min(1), email: z.string().optional() }),
  role: z.enum(['member', 'tadmin', 'admin']),
  op: z.string().regex(/^[a-z]+(\.[a-z-]+)+$/),
  tenantId: TenantId.optional(),
  target: z.string().max(200).optional(),
  ok: z.boolean(),
  error: z.string().max(300).optional(),
})
export type AuditEntry = z.infer<typeof AuditEntry>
