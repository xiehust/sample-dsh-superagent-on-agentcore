/** Cell queue envelope (design §4.6). SQS FIFO per cell: MessageGroupId = cellId, MessageDeduplicationId = id. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { CellId, TenantId } from './ids.ts'
import { WorkerEvent } from './worker-api.ts'

export const SourceName = z.enum(['github', 'feishu'])
export type SourceName = z.infer<typeof SourceName>

export const SourceEventBody = z.object({
  source: SourceName,
  /** GitHub `X-GitHub-Event` (e.g. `issue_comment`), `reconcile.<kind>` for poll results, or Feishu event type (e.g. `im.message.receive_v1`, `backfill.message`). */
  kind: z.string().min(1),
  /** GitHub `X-GitHub-Delivery`, Feishu event_id, or a deterministic id for poll/backfill items. */
  deliveryId: z.string().min(1),
  payload: z.unknown(),
})
export type SourceEventBody = z.infer<typeof SourceEventBody>

export const WorkerEventBody = z.object({
  event: WorkerEvent,
  verified: z.object({ tid: TenantId, cid: CellId, tkt: z.string(), asg: z.string() }),
})
export type WorkerEventBody = z.infer<typeof WorkerEventBody>

export const AdminCommandBody = z.object({
  command: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  requestId: z.string().min(1),
  actor: z.object({ sub: z.string(), email: z.string().optional() }),
})

const head = { v: z.literal(1), id: z.string().min(1).max(128), cellId: CellId, at: z.string() }
export const CellEnvelope = z.discriminatedUnion('type', [
  z.object({ ...head, type: z.literal('source.event'), body: SourceEventBody }),
  z.object({ ...head, type: z.literal('worker.event'), body: WorkerEventBody }),
  z.object({ ...head, type: z.literal('admin.command'), body: AdminCommandBody }),
])
export type CellEnvelope = z.infer<typeof CellEnvelope>

/** SQS FIFO dedup ids are ≤128 chars of [A-Za-z0-9!-~]; envelope ids are built to fit. */
export const envelopeId = {
  source: (source: SourceName, deliveryId: string): string => `${source}:${deliveryId}`.slice(0, 128),
  /** `we-` + sha256(`<ticketKey>/<eventId>`)[:40]: scoped per ticket, so retries of one event collapse and equal event ids on two
   *  tickets do not. Byte-identical to worker-api `envelope_id` (worker/src/dshsa_worker/worker_api.py); pinned by tests/vectors.json. */
  worker: (ticketKey: string, eventId: string): string =>
    `we-${createHash('sha256').update(`${ticketKey}/${eventId}`, 'utf8').digest('hex').slice(0, 40)}`,
}
