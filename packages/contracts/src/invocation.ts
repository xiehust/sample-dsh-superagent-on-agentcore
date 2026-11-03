/** Cell → worker: AgentCore InvokeAgentRuntime payload (design §4.4). Responses are always HTTP 200. */
import { z } from 'zod'
import { WorkerType } from './models.ts'
import { CellId, TenantId } from './ids.ts'

export const InvocationAction = z.enum(['start', 'deliver', 'stop', 'status'])
export type InvocationAction = z.infer<typeof InvocationAction>

export const WorkerInput = z.object({
  id: z.string().min(1),
  kind: z.enum(['trigger', 'policy', 'resume', 'text']),
  at: z.string(),
  text: z.string(),
  source: z.enum(['github', 'feishu']).optional(),
  url: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
})
export type WorkerInput = z.infer<typeof WorkerInput>

export const WorkerTicket = z.object({
  tenantId: TenantId,
  cellId: CellId,
  ticketId: z.string().min(1),
  assignmentId: z.string().min(1),
  title: z.string(),
  scope: z.string(),
  mandate: z.record(z.string(), z.unknown()),
  note: z.string().optional(),
})
export type WorkerTicket = z.infer<typeof WorkerTicket>

export const WorkerConfig = z.object({
  model: z.string().min(1),
  systemPrompt: z.string(),
  skills: z.array(z.object({ name: z.string().min(1), content: z.string() })),
  env: z.record(z.string(), z.string()),
  repo: z.object({ fullName: z.string().regex(/^[^/]+\/[^/]+$/), defaultBranch: z.string().min(1), cloneUrl: z.string().url() }),
  /** v7: reasoning effort for the worker's model; absent → the agent's own default. Workers drop (and log) a value they don't know. */
  effort: z.string().min(1).optional(),
  /** v7: the agent this ticket runs on (sticky per ticket); a worker of another type answers `bad_request`. Absent = claude. */
  agent: WorkerType.optional(),
})
export type WorkerConfig = z.infer<typeof WorkerConfig>

export const InvocationRequest = z.object({
  v: z.literal(1),
  action: InvocationAction,
  token: z.string().min(1),
  ticket: WorkerTicket,
  inputs: z.array(WorkerInput).default([]),
  /** Required for start and deliver. */
  config: WorkerConfig.optional(),
}).refine(r => (r.action !== 'start' && r.action !== 'deliver') || r.config !== undefined, { message: 'config is required for start/deliver' })
export type InvocationRequest = z.infer<typeof InvocationRequest>

export const WorkerState = z.enum(['idle', 'running', 'stopped'])
/**
 * The worker image's content version. Every InvocationResponse (ok or not) carries it as `workerVersion`; a response without
 * it comes from an image older than the field, so it is stale too. infra publishes the version of the image the runtime's
 * DEFAULT endpoint serves in SSM `parameter` (updated only after the runtime). A live session whose `workerVersion` differs
 * still runs an old microVM: the cell stops it (StopRuntimeSession) once it is idle, and the next invoke starts a fresh one.
 */
export const WorkerVersion = { field: 'workerVersion', env: 'DSHSA_WORKER_VERSION', parameter: '/dshsa-worker/version',
  /** v7: the SSM parameter each worker runtime's version is published under (`parameter` = `parameters.claude`). */
  parameters: { claude: '/dshsa-worker/version', codex: '/dshsa-worker-codex/version' } } as const satisfies {
  field: string; env: string; parameter: string; parameters: Record<WorkerType, string> }
const workerVersion = z.string().min(1).optional()
export const InvocationResponse = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), accepted: z.array(z.string()), state: WorkerState, workerVersion }),
  z.object({ ok: z.literal(false), error: z.string().min(1), message: z.string(), workerVersion }),
])
export type InvocationResponse = z.infer<typeof InvocationResponse>
/** Error codes a worker may return. */
export const InvocationErrors = ['unauthorized', 'bound_to_other_ticket', 'mount_failed', 'bad_request', 'internal'] as const
