import { accessPointRoot, ticketKey } from '@dshsa/contracts'
import type { S3Client } from '@aws-sdk/client-s3'
import { describe, expect, it } from 'vitest'
import { S3TranscriptStore } from '../src/transcript.ts'

describe('S3TranscriptStore', () => {
  it('reads the newest JSONL under the ticket AP root (contracts v4 layout)', async () => {
    const calls: { name: string; input: Record<string, unknown> }[] = []
    const s3 = { send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      calls.push({ name: cmd.constructor.name, input: cmd.input })
      if (cmd.constructor.name === 'ListObjectsV2Command') {
        const p = cmd.input.Prefix as string
        return { Contents: [
          { Key: `${p}-proj/old.jsonl`, LastModified: new Date('2026-11-01T00:00:00Z'), Size: 10 },
          { Key: `${p}-proj/new.jsonl`, LastModified: new Date('2026-11-01T01:00:00Z'), Size: 10 },
          { Key: `${p}-proj/notes.txt`, LastModified: new Date('2026-11-01T02:00:00Z'), Size: 10 },
        ] }
      }
      return { Body: { transformToString: async () => '{"type":"user"}\n{"type":"assistant"}\n' } }
    } } as unknown as S3Client
    const t = await new S3TranscriptStore(s3, 'dshsa-data-1').read('acme', 'acme--gh1', 'T-1')
    expect(accessPointRoot('acme', 'acme--gh1', 'T-1')).toBe(`/tenants/acme/acme--gh1/${ticketKey('acme--gh1', 'T-1')}`)
    expect(calls[0]!.input.Prefix).toBe(`tenants/acme/acme--gh1/${ticketKey('acme--gh1', 'T-1')}/.claude/projects/`)
    expect(calls[1]!.input.Key).toMatch(/new\.jsonl$/)
    expect(t).toEqual({ entries: [{ type: 'user' }, { type: 'assistant' }], truncated: false, updatedAt: '2026-11-01T01:00:00.000Z' })
  })
})
