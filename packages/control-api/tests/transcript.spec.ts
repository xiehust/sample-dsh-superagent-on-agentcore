import { readFileSync } from 'node:fs'
import { accessPointRoot, ticketKey } from '@dshsa/contracts'
import type { S3Client } from '@aws-sdk/client-s3'
import { describe, expect, it } from 'vitest'
import { S3TranscriptStore } from '../src/transcript.ts'

/** A real Codex 0.166.0 rollout (redacted), as the Codex worker writes it under `.codex/sessions/YYYY/MM/DD/`. */
const ROLLOUT = readFileSync(new URL('../../../.trellis/tasks/11-03-codex-worker/research/probe-rollout.jsonl', import.meta.url), 'utf8')
const ROOT = `tenants/acme/acme--gh1/${ticketKey('acme--gh1', 'T-1')}`
const CLAUDE = `${ROOT}/.claude/projects/`
const CODEX = `${ROOT}/.codex/sessions/`
const CLAUDE_TEXT = '{"type":"user"}\n{"type":"assistant"}\n'

interface Obj { Key: string; LastModified: Date; Size?: number; body?: string }
type Cmd = { constructor: { name: string }; input: Record<string, unknown> }
/** A fake S3 serving `objects` by prefix (two per list page, to exercise continuation) and their bodies on GetObject. */
function fakeS3(objects: Obj[], options: { deny?: string } = {}) {
  const calls: { name: string; input: Record<string, unknown> }[] = []
  const s3 = { send: async (cmd: Cmd) => {
    calls.push({ name: cmd.constructor.name, input: cmd.input })
    if (cmd.constructor.name === 'ListObjectsV2Command') {
      const prefix = cmd.input.Prefix as string
      if (options.deny && prefix.startsWith(options.deny)) throw Object.assign(new Error('denied'), { name: 'AccessDenied' })
      const matching = objects.filter(o => o.Key.startsWith(prefix))
      const start = Number(cmd.input.ContinuationToken ?? 0)
      const next = start + 2 < matching.length ? String(start + 2) : undefined
      return { Contents: matching.slice(start, start + 2).map(({ Key, LastModified, Size }) => ({ Key, LastModified, Size: Size ?? 10 })),
        ...next ? { NextContinuationToken: next } : {} }
    }
    const found = objects.find(o => o.Key === cmd.input.Key)
    return { Body: { transformToString: async () => found?.body ?? '' } }
  } } as unknown as S3Client
  return { s3, calls, read: () => new S3TranscriptStore(s3, 'dshsa-data-1').read('acme', 'acme--gh1', 'T-1') }
}
const at = (iso: string) => new Date(iso)
const claudeFiles: Obj[] = [
  { Key: `${CLAUDE}-proj/old.jsonl`, LastModified: at('2026-11-01T00:00:00Z'), body: '{"type":"old"}\n' },
  { Key: `${CLAUDE}-proj/new.jsonl`, LastModified: at('2026-11-01T01:00:00Z'), body: CLAUDE_TEXT },
  { Key: `${CLAUDE}-proj/notes.txt`, LastModified: at('2026-11-01T02:00:00Z') },
]
const codexFiles: Obj[] = [
  { Key: `${CODEX}2026/11/02/rollout-2026-11-02T10-00-00-aaa.jsonl`, LastModified: at('2026-11-02T10:00:00Z'), body: '{"type":"session_meta"}\n' },
  { Key: `${CODEX}2026/11/03/rollout-2026-11-03T11-13-32-01a1a11d.jsonl`, LastModified: at('2026-11-03T11:14:00Z'), body: ROLLOUT },
  { Key: `${CODEX}2026/11/03/scratch.json`, LastModified: at('2026-11-03T12:00:00Z') },
]

describe('S3TranscriptStore', () => {
  it('reads the newest Claude JSONL under the ticket AP root (contracts v4 layout)', async () => {
    const m = fakeS3(claudeFiles)
    const t = await m.read()
    expect(accessPointRoot('acme', 'acme--gh1', 'T-1')).toBe(`/${ROOT}`)
    expect(m.calls.filter(c => c.name === 'ListObjectsV2Command').map(c => c.input.Prefix)).toEqual(expect.arrayContaining([CLAUDE, CODEX]))
    expect(m.calls.find(c => c.name === 'GetObjectCommand')!.input.Key).toMatch(/new\.jsonl$/)
    expect(t).toEqual({ entries: [{ type: 'user' }, { type: 'assistant' }], truncated: false, updatedAt: '2026-11-01T01:00:00.000Z', agent: 'claude' })
  })
  it('reads the newest Codex rollout when only Codex wrote one', async () => {
    const t = await fakeS3(codexFiles).read()
    expect(t).toMatchObject({ agent: 'codex', truncated: false, updatedAt: '2026-11-03T11:14:00.000Z' })
    const lines = ROLLOUT.split('\n').filter(line => line.trim())
    expect(t!.entries).toHaveLength(lines.length)
    expect(t!.entries[0]).toMatchObject({ type: 'session_meta' })
    expect(t!.entries).toContainEqual(expect.objectContaining({ type: 'turn_context', payload: expect.objectContaining({ model: 'global.openai.gpt-6.1-terra' }) }))
  })
  it('picks the newest file across both agents', async () => {
    expect(await fakeS3([...claudeFiles, ...codexFiles]).read()).toMatchObject({ agent: 'codex', updatedAt: '2026-11-03T11:14:00.000Z' })
    const laterClaude = { Key: `${CLAUDE}-proj/resumed.jsonl`, LastModified: at('2026-11-04T00:00:00Z'), body: CLAUDE_TEXT }
    expect(await fakeS3([...claudeFiles, ...codexFiles, laterClaude]).read())
      .toEqual({ entries: [{ type: 'user' }, { type: 'assistant' }], truncated: false, updatedAt: '2026-11-04T00:00:00.000Z', agent: 'claude' })
  })
  it('returns nothing when neither agent wrote a transcript, and reads no object', async () => {
    const m = fakeS3([{ Key: `${CODEX}2026/11/03/scratch.json`, LastModified: at('2026-11-03T12:00:00Z') }])
    expect(await m.read()).toBeUndefined()
    expect(m.calls.some(c => c.name === 'GetObjectCommand')).toBe(false)
  })
  it('treats a denied Codex listing (grant not deployed yet) as empty, but not a denied Claude listing', async () => {
    expect(await fakeS3(claudeFiles, { deny: CODEX }).read()).toMatchObject({ agent: 'claude', updatedAt: '2026-11-01T01:00:00.000Z' })
    await expect(fakeS3(claudeFiles, { deny: CLAUDE }).read()).rejects.toThrow('denied')
  })
  it('reads only the tail of a rollout over the size limit', async () => {
    const big = { ...codexFiles[1]!, Size: 2 * 1024 * 1024 }
    const m = fakeS3([big])
    const t = await m.read()
    expect(m.calls.find(c => c.name === 'GetObjectCommand')!.input.Range).toBe(`bytes=-${1024 * 1024}`)
    expect(t).toMatchObject({ agent: 'codex', truncated: true })
  })
})
