/**
 * Panel types: the panel-api envelopes (`/v1/me`, `/v1/cells`, transcript, chat bindings) defined here, and the DSH management
 * views forwarded through `/v1/cells/{cellId}/api/*`, which come type-only from the cell host (`@dshsa/cell/api-types`).
 * Only `import type` is used for the cell package: a value import would bundle host code into the SPA.
 */
import type { OverviewView, SettingsBlock, SettingsView, TicketFilter, TicketListView, TicketPageView } from '@dshsa/cell/api-types'

// ---- panel-api (packages/control-api, design §4.1) ----

export interface RuntimeConfig {
  region: string
  userPoolId: string
  clientId: string
  /** Full https base of the Cognito hosted UI, e.g. `https://dshsa-123.auth.<region>.amazoncognito.com`. */
  domain: string
  apiUrl: string
}

/** Panel role in one tenant (contracts v6 `PanelRole`): member < tenant admin < platform admin. */
export type PanelRole = 'member' | 'tadmin' | 'admin'
export const ROLE_LABELS: Record<PanelRole, string> = { member: 'Member', tadmin: 'Team admin', admin: 'Platform admin' }
const RANK: Record<PanelRole, number> = { member: 1, tadmin: 2, admin: 3 }
/** Whether `role` meets `need` (member < tadmin < admin); an absent role never does. Display only: panel-api enforces it. */
export const atLeast = (role: PanelRole | undefined, need: PanelRole): boolean => !!role && RANK[role] >= RANK[need]

export interface MeView {
  sub: string
  email?: string
  platformAdmin?: boolean
  /** `role` is derived by panel-api from the verified groups; an absent role is treated as `member`. */
  tenants: { tenantId: string; name?: string; role?: PanelRole }[]
}

export interface CellView {
  cellId: string
  tenantId: string
  tenantName?: string
  repo?: { owner?: string; name?: string; defaultBranch?: string }
  status?: string
}
export interface CellListView { cells: CellView[] }

export interface ChatBinding { chatId: string; cellId: string; chatName?: string }
export interface ChatBindingListView { bindings: ChatBinding[] }

// ---- panel-tenant `/v1/tenants/{t}/setup/**` (control-api src/setup/tenant.ts) ----

/** `appLinked`: any `active` claim; `approvalPending` (v6.2): any claim waiting for platform approval. */
export interface SetupChecklist { appLinked: boolean; approvalPending?: boolean; repoAdded: boolean; botConnected: boolean; chatBound: boolean }
export type CellStatus = 'active' | 'paused' | 'disabled'
export interface SetupCell { cellId: string; status: CellStatus | string; repo: { owner: string; name: string; id: number; installationId: number } }
export interface SetupStatusView {
  tenant: { tenantId: string; name: string }
  role: PanelRole
  github: { configured: boolean; installUrl?: string }
  checklist: SetupChecklist
  cells: SetupCell[]
}
export interface LinkStartView { url: string; expiresInSec: number }
/**
 * Why a claim waits for platform approval (contracts v6.2 `InstallationClaim.pendingReason`, set by panel-tenant's control check).
 * Other strings are tolerated and shown generically.
 */
export type PendingReason = 'not_own_account' | 'not_org_admin' | 'membership_unavailable' | 'unknown_account_type'
/** `POST setup/github/link` outcome per installation: linked, waiting for platform approval, or held by another team. */
export type LinkStatus = 'active' | 'pending' | 'other_tenant'
export interface LinkResultView {
  installations: { installationId: number; account: string; status: LinkStatus; pendingReason?: PendingReason | string }[]
}
/**
 * contracts v6.2 `InstallationClaim`. Only `active` claims list repositories or add cells; anything else (in practice
 * `pending`) is shown as waiting for platform approval and its repositories are never requested.
 */
export interface InstallationClaim {
  key?: string
  installationId: number; tenantId: string
  status: 'active' | 'pending'
  account: string; accountType: 'User' | 'Organization'
  /** GitHub login whose user token proved access. */
  githubLogin: string
  pendingReason?: PendingReason | string
  claimedBy: string; claimedAt: string
  approvedBy?: string; approvedAt?: string
}
export interface InstallationListView { installations: InstallationClaim[] }
/** A cell that still uses an installation (control-api `setup/claims.ts`): any cell that is not disabled. */
export interface CellUsing { cellId: string; status: string; repo: string }
export interface UnlinkResultView { installationId: number; released: true }
/** Platform release: `affectedCells` are the team's cells that still use it (left unchanged; only after `force`). */
export interface ReleaseResultView { released: true; installationId: number; tenantId: string; affectedCells: CellUsing[] }
export interface SetupRepository {
  id: number; name: string; owner: string; fullName: string; private: boolean; archived: boolean; defaultBranch: string
  cell?: { cellId: string; status: string }
}
export interface RepositoryListView { truncated: boolean; repositories: SetupRepository[] }
export type FeishuDomain = 'feishu' | 'lark'
export interface ConnectorHealth { state: 'starting' | 'ready' | 'error'; detail: string; at: string }
/** Write-only: `set` says a secret exists; the secret itself is never returned. */
export interface FeishuStatusView { set: boolean; domain?: FeishuDomain; appId?: string; revision?: string; health?: ConnectorHealth }
export interface FeishuInput { domain: FeishuDomain; appId: string; appSecret: string; encryptKey?: string }
export interface SeenChatView { chatId: string; name?: string; direct: boolean; lastAt?: string; unrouted?: number; cellId?: string; seen: boolean }
export interface ChatListView { botSeen: boolean; chats: SeenChatView[]; cells: { cellId: string; repo: string }[] }
export interface DirectoryUser { email: string; role: PanelRole; status?: string; enabled?: boolean; createdAt?: string }
export interface UserListView { users: DirectoryUser[] }

// ---- panel-platform `/v1/admin/**` (control-api src/setup/platform.ts) ----

export interface TenantView {
  tenantId: string; name: string; cognitoGroup: string; status: 'active' | 'disabled'; createdAt: string
  feishu?: { domain: FeishuDomain; appId: string; revision?: string }
}
export interface TenantListView { tenants: TenantView[] }
export type InviteInput = { email: string; role: 'admin' } | { email: string; role: 'member' | 'tadmin'; tenantId: string }
export interface GithubAppView {
  app: { set: boolean; appId?: string; slug?: string; keyValid?: boolean; installations?: number; error?: string }
  oauth: { set: boolean; clientId?: string }
  /** `permissions` (v6.2): App permissions the claim check needs, e.g. `Organization permissions → Members: Read-only`. */
  checklist: { setupUrl: string; callbackUrl: string; redirectOnUpdate: boolean; permissions?: string[] }
}
/** `GET /v1/admin/installations?status=pending`: claims waiting for platform approval, oldest first. */
/** Platform list of every claim (active and pending), with the team's name when the team exists. */
export interface ClaimListView { installations: (InstallationClaim & { tenantName?: string })[] }
export interface GithubAppInput { appId?: string; privateKey?: string; webhookSecret?: string; clientId?: string; clientSecret?: string }

/** One JSONL line of a Claude Agent SDK session transcript, as parsed by panel-api. Unknown shapes are tolerated. */
export interface TranscriptEntry {
  type?: string
  uuid?: string
  timestamp?: string
  message?: { role?: string; content?: string | TranscriptBlock[] }
  [key: string]: unknown
}
export type TranscriptBlock =
  | { type: 'text'; text?: string }
  | { type: 'thinking'; thinking?: string }
  | { type: 'tool_use'; id?: string; name?: string; input?: unknown }
  | { type: 'tool_result'; tool_use_id?: string; content?: unknown; is_error?: boolean }
  | { type: string; [key: string]: unknown }
/** panel-api `GET /v1/cells/{cellId}/tickets/{ticketId}/transcript` (control-api `Transcript`). */
/** `agent` (contracts v7 §7): which worker wrote the transcript; absent (older control-api) means Claude. */
export interface TranscriptView { entries: TranscriptEntry[]; truncated?: boolean; updatedAt?: string; agent?: 'claude' | 'codex' }

// ---- DSH management views (forwarded through /v1/cells/{cellId}/api/*), from the cell host ----

export type { CatalogModel, Effort, ModelSurface, SurfaceSpec, WorkerType } from '@dshsa/cell/api-types'
export type { Api, ApiRequest, ApiResponse, DecisionListView, HistoryView, ModelCatalog, OverviewView, PromptConfig, PromptsView,
  PromptVersion, RouteParams, SearchView, Settings, SettingsBlock, SettingsView, SourceStatusView, StateView, ThreadDetailView,
  ThreadFilter, ThreadListView, TicketFilter, TicketListView, TicketPageView } from '@dshsa/cell/api-types'

/** Local copy of the cell's `TICKET_FILTERS` (importing the const would bundle host code); `satisfies` keeps it in step. */
export const TICKET_FILTERS = ['open', 'person', 'working', 'idle', 'ended'] as const satisfies readonly TicketFilter[]

/** A ticket as listed (`GET tickets`, `GET overview` person). */
export type TicketRow = TicketListView['items'][number]
/** The stage of a ticket row or page: `{stage, action}` for each stage variant. */
export type TicketStage = TicketRow extends infer Row ? Row extends unknown ? Pick<Row, Extract<keyof Row, 'stage' | 'action'>> : never : never
export type Problem = OverviewView['problems'][number]
export type InputView = TicketPageView['inputs'][number]
export type AssignmentView = TicketPageView['assignments'][number]
export type BasisFact = TicketPageView['basis']['facts'][number]
export type ActorView = TicketPageView['mandate']['actor']
/** Text the host returns in both languages. */
export type Localized = TicketPageView['channels'][number]['label']

/** The settings blocks the panel edits as JSON (Source blocks `source:<id>` are not edited here). */
export const SETTINGS_BLOCKS = ['policy', 'eval', 'executor'] as const satisfies readonly SettingsBlock[]
export type EditedBlock = typeof SETTINGS_BLOCKS[number]

/** One Source of `GET settings`, with its kind's Policy form metadata (`policy.fields`, admission `rows`). */
export type SourceSettings = SettingsView['sources'][number]
export type SourcePolicyView = NonNullable<SourceSettings['policy']>
export type FieldSpec = SourcePolicyView['fields'][number]
export type RowsField = Extract<FieldSpec, { type: 'rows' }>
export type RowColumn = RowsField['columns'][number]
export type AdmissionRowView = NonNullable<SourcePolicyView['rows']>[number]
export type AdmissionCell = keyof AdmissionRowView['cells']
/** A cell's 400 for an invalid settings block: zod issues with dotted paths (e.g. `sources.github.allowed.0.id`). */
export interface Issue { path: string; message: string }

/** A role's stored model choice (core `RoleModelSchema`); `null` in settings means the catalog default. */
export interface RoleModel { provider: string; model: string; reasoningEffort?: string }
