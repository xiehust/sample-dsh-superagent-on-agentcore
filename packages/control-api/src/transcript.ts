/**
 * Worker transcript reader [P2]: the Claude Agent SDK writes session transcripts as JSONL under the ticket AP's
 * `.claude/projects/` (design §4.10), which S3 Files syncs to the data bucket at the AP root path. v7: a Codex worker writes
 * rollouts under `.codex/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl` (appended on resume); the newest file of either
 * agent wins and `agent` names whose it is.
 */
import { accessPointRoot } from '@dshsa/contracts'
import { GetObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3'

export const TRANSCRIPT_MAX_BYTES = 1024 * 1024
export const TRANSCRIPT_MAX_ENTRIES = 500

export type TranscriptAgent = 'claude' | 'codex'
/** `agent` absent = claude (hosts before v7). */
export interface Transcript { entries: unknown[]; truncated: boolean; updatedAt?: string; agent?: TranscriptAgent }
export interface TranscriptStore { read(tenantId: string, cellId: string, ticketId: string): Promise<Transcript | undefined> }

/** Parses JSONL text, dropping a partial first line when the text was cut from the front, and keeps the newest entries. */
export function parseJsonl(text: string, cutFront: boolean): Transcript {
  const lines = text.split('\n')
  if (cutFront) lines.shift()
  const entries: unknown[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    try { entries.push(JSON.parse(line)) } catch { /* a line still being written */ }
  }
  const truncated = cutFront || entries.length > TRANSCRIPT_MAX_ENTRIES
  return { entries: entries.slice(-TRANSCRIPT_MAX_ENTRIES), truncated }
}

interface Listed { Key: string; LastModified: Date; Size: number }
/**
 * Where each agent's transcripts live under the ticket AP root; the panel-api grant covers exactly these prefixes. The Codex
 * grant is newer (v7): until it is deployed its listing is denied, which must not break Claude transcripts, so it counts as empty.
 */
const TRANSCRIPT_DIRS: readonly { agent: TranscriptAgent; dir: string; deniedIsEmpty: boolean }[] = [
  { agent: 'claude', dir: '.claude/projects/', deniedIsEmpty: false },
  { agent: 'codex', dir: '.codex/sessions/', deniedIsEmpty: true },
]
const denied = (error: unknown) => (error as { name?: string } | undefined)?.name === 'AccessDenied'

export class S3TranscriptStore implements TranscriptStore {
  constructor(private readonly s3: S3Client, private readonly bucket: string) {}

  async read(tenantId: string, cellId: string, ticketId: string): Promise<Transcript | undefined> {
    const root = accessPointRoot(tenantId, cellId, ticketId).replace(/^\//, '')
    const found = await Promise.all(TRANSCRIPT_DIRS.map(async ({ agent, dir, deniedIsEmpty }) => ({ agent,
      newest: await this.newest(`${root}/${dir}`).catch((error: unknown) => { if (deniedIsEmpty && denied(error)) return undefined; throw error }) })))
    let pick: { agent: TranscriptAgent; newest: Listed } | undefined
    for (const { agent, newest } of found) if (newest && (!pick || newest.LastModified > pick.newest.LastModified)) pick = { agent, newest }
    if (!pick) return undefined
    const { agent, newest } = pick
    const cut = newest.Size > TRANSCRIPT_MAX_BYTES
    const obj = await this.s3.send(new GetObjectCommand({
      Bucket: this.bucket, Key: newest.Key, Range: cut ? `bytes=-${TRANSCRIPT_MAX_BYTES}` : undefined,
    }))
    const text = await obj.Body?.transformToString('utf8') ?? ''
    return { ...parseJsonl(text, cut), updatedAt: newest.LastModified.toISOString(), agent }
  }

  /** The most recently modified `.jsonl` object under `prefix`, across all list pages. */
  private async newest(prefix: string): Promise<Listed | undefined> {
    let newest: Listed | undefined
    let ContinuationToken: string | undefined
    do {
      const page = await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken }))
      for (const o of page.Contents ?? []) {
        if (!o.Key?.endsWith('.jsonl') || !o.LastModified) continue
        if (!newest || o.LastModified > newest.LastModified) newest = { Key: o.Key, LastModified: o.LastModified, Size: o.Size ?? 0 }
      }
      ContinuationToken = page.NextContinuationToken
    } while (ContinuationToken)
    return newest
  }
}
