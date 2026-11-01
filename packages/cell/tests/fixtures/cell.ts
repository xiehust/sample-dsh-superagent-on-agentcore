/** Test fixtures: a minimal Source kind (`chat`), fake APIs, a recording executor/assessor, and a cell on a temp SQLite file. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { CellEnvelope, Logger } from '@dshsa/contracts'
import type { CellInfo, SourceApis, SourceKind } from '@dshsa/core/host'
import { key, type Assignment, type Candidate, type OutboundMessage, type Ticket, type Trigger } from '../../src/core/index.ts'
import { CellRuntime, type CellOptions } from '../../src/cell.ts'

export const CELL_ID = 'acme--gh812345'
export const cellInfo: CellInfo = { tenantId: 'acme', cellId: CELL_ID, repository: 'acme/widgets', repoId: 812345, installationId: 77, defaultBranch: 'main',
  app: { slug: 'dshsa-agent', login: 'dshsa-agent[bot]', userId: 1, noreply: '1+dshsa-agent[bot]@users.noreply.github.com' } }
export const quiet: Logger = { debug() {}, info() {}, warn() {}, error: (m, d) => { if (process.env.DEBUG_CELL) console.error(m, d) } }
export const noApis: SourceApis = { github: {
  request: async () => { throw new Error('no network in tests') }, pages: async () => [], raw: async () => ({ status: 404, headers: {}, body: '' }) } }

/** A fake `github` kind message payload (a simplified shape; the real kind lives in @dshsa/sources), as an ingress would enqueue it. */
export interface ChatMessage { id: string; thread: string; from: string; text: string; at: string; mention?: boolean }
export const sent: OutboundMessage[] = []
export const chatKind: SourceKind<{ enabled?: boolean }> = {
  kind: 'github', title: { zh: 'fake github', en: 'fake github' }, description: { zh: '', en: '' }, schema: z.object({}).passthrough(), fields: [], health: ['github'],
  channel: { send: async (_host, message) => { sent.push(message); return 'sent' }, link: () => ({ url: '', label: { zh: 'chat', en: 'chat' } }) },
  policy: { schema: z.object({ allowed: z.array(z.object({ id: z.string(), name: z.string().optional() })).default([]) }).passthrough() as never, fields: [],
    explicit: { zh: '', en: '' } },
  async ingest(event, ctx) {
    const message = event.payload as ChatMessage
    const trigger: Trigger = { id: key('chat', message.id), source: 'github', threads: [{ source: 'github', id: message.thread }],
      actor: { source: 'github', id: message.from }, human: true, at: message.at, text: message.text,
      ...message.mention ? { addressed: 'mention' as const } : {},
      channel: { source: 'github', thread: `github:${message.thread}`, address: { message: message.id } }, meta: {} }
    await ctx.receive(trigger)
  },
}
export function chatEnvelope(message: ChatMessage): CellEnvelope {
  return { v: 1, id: `chat:${message.id}`, cellId: CELL_ID, type: 'source.event', at: message.at,
    body: { source: 'github', kind: 'chat.message', deliveryId: message.id, payload: message } } 
}

export interface Recorder { started: [Ticket, Assignment][]; delivered: string[]; stopped: string[]; candidates: Candidate[] }
export function makeCell(overrides: Partial<CellOptions> = {}, settings: unknown = { policy: { sources: { github: { allowed: [{ id: 'alice' }] } } } }) {
  const dir = mkdtempSync(join(tmpdir(), 'dshsa-cell-'))
  const recorder: Recorder = { started: [], delivered: [], stopped: [], candidates: [] }
  const lease = { fence: 1, valid: () => true, signal: new AbortController().signal }
  const cell = new CellRuntime({ cell: cellInfo, apis: noApis, dbPath: join(dir, 'orchestrator.sqlite'), kinds: [chatKind], lease, log: quiet,
    executor: () => ({ start: (ticket, assignment) => { recorder.started.push([ticket, assignment]) }, deliver: ticket => { recorder.delivered.push(ticket.id) },
      stop: ticket => { recorder.stopped.push(ticket.id) } }),
    assessor: () => ({ request: candidate => { recorder.candidates.push(candidate) } }),
    ...overrides })
  cell.store.saveSettings(settings)
  return { cell, recorder, cleanup: async () => { await cell.stop(); rmSync(dir, { recursive: true, force: true }) } }
}
