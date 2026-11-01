/**
 * Worker transcript reader [P2]: the Claude Agent SDK writes session transcripts as JSONL under the ticket AP's
 * `.claude/projects/` (design §4.10), which S3 Files syncs to the data bucket at the AP root path.
 */
import { accessPointRoot } from '@dshsa/contracts'
import { GetObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3'

export const TRANSCRIPT_MAX_BYTES = 1024 * 1024
export const TRANSCRIPT_MAX_ENTRIES = 500

export interface Transcript { entries: unknown[]; truncated: boolean; updatedAt?: string }
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

export class S3TranscriptStore implements TranscriptStore {
  constructor(private readonly s3: S3Client, private readonly bucket: string) {}

  async read(tenantId: string, cellId: string, ticketId: string) {
    const prefix = `${accessPointRoot(tenantId, cellId, ticketId).replace(/^\//, '')}/.claude/projects/`
    let newest: { Key: string; LastModified: Date; Size: number } | undefined
    let ContinuationToken: string | undefined
    do {
      const page = await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken }))
      for (const o of page.Contents ?? []) {
        if (!o.Key?.endsWith('.jsonl') || !o.LastModified) continue
        if (!newest || o.LastModified > newest.LastModified) newest = { Key: o.Key, LastModified: o.LastModified, Size: o.Size ?? 0 }
      }
      ContinuationToken = page.NextContinuationToken
    } while (ContinuationToken)
    if (!newest) return undefined
    const cut = newest.Size > TRANSCRIPT_MAX_BYTES
    const obj = await this.s3.send(new GetObjectCommand({
      Bucket: this.bucket, Key: newest.Key, Range: cut ? `bytes=-${TRANSCRIPT_MAX_BYTES}` : undefined,
    }))
    const text = await obj.Body?.transformToString('utf8') ?? ''
    return { ...parseJsonl(text, cut), updatedAt: newest.LastModified.toISOString() }
  }
}
