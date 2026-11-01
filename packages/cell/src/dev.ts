/**
 * Local mode (`pnpm --filter @dshsa/cell dev`): one host with one cell against in-process fakes — an in-memory lease table,
 * catalog and FIFO queue, a fake AgentCore runtime and provisioner, a scripted model, a local P-256 key for ticket tokens —
 * and the real CellRuntime, GitHub/Feishu Source kinds and internal HTTP. Nothing reaches AWS, GitHub or Feishu.
 *
 *   POST http://127.0.0.1:8080/dev/enqueue   body: a CellEnvelope (parent design §4.6)
 *   GET  http://127.0.0.1:8080/acme--gh1/api/tickets   (header x-dshsa-caller: dev)
 */
import { createServer } from 'node:http'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CellEnvelope, type CellRecord, type InvocationRequest, type TenantRecord } from '@dshsa/contracts'
import type { SourceKind } from '@dshsa/core/host'
import { githubKind } from '@dshsa/sources'
import { HostProcess } from './host.ts'
import { MemoryLeaseStore } from './lease.ts'
import { MemoryCellQueue } from './queue.ts'
import { NoReplication } from './litestream.ts'
import { TicketTokens } from './token.ts'
import { handler } from './server.ts'
import { CallerRefused } from './caller.ts'
import { jsonLog } from './main.ts'
import type { Catalog } from './aws/catalog.ts'
import type { ModelClient } from '@dshsa/assess'

const CELL = 'acme--gh1'
const now = new Date().toISOString()
const record: CellRecord = { cellId: CELL, tenantId: 'acme', status: 'active', queueUrl: 'https://sqs.local/dshsa-cell-acme--gh1.fifo', stateBucketPrefix: '',
  createdAt: now, repo: { owner: 'acme', name: 'widgets', id: 1, installationId: 1, defaultBranch: 'main' } }
const tenant: TenantRecord = { tenantId: 'acme', name: 'Acme', cognitoGroup: 'dshsa-tenant-acme', status: 'active', createdAt: now }
const catalog: Catalog = { activeCells: async () => [record], cell: async id => id === CELL ? record : undefined, feishuTenants: async () => [],
  tenant: async () => tenant, route: async () => undefined, boundChats: async () => [], cellChats: async () => [] }
const queue = new MemoryCellQueue()
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const tokens = new TicketTokens({ keyId: 'dev-key', sign: async message => sign('sha256', message, { key: privateKey, dsaEncoding: 'der' }) })
/** Accepts every explicit request; never sends a reply. */
const model: ModelClient = { call: async request => request.tool.name === 'orchestrator_route'
  ? { kind: 'accept', trigger_id: (JSON.parse(request.prompt) as { trigger_id: string }).trigger_id, title: 'Dev ticket', worktree_name: 'dev-ticket', acknowledgement: 'On it (dev).' }
  : { send: false } }
const apis = { github: { request: async () => { throw new Error('dev: no GitHub') }, pages: async () => [], raw: async () => ({ status: 304, headers: {}, body: '' }) } }

const dir = mkdtempSync(join(tmpdir(), 'dshsa-dev-'))
const host = new HostProcess({ owner: 'dev', endpoint: 'http://127.0.0.1:8080', dataDir: dir, maxCells: 1, maxConnectors: 0, log: jsonLog,
  leases: new MemoryLeaseStore(), catalog, replicator: new NoReplication(), queueFor: () => queue, tokens, model,
  provisioner: { ensure: async request => { jsonLog.info('dev provisioner ensure', request) } },
  runtime: { invoke: async (sessionId, request: InvocationRequest) => {
    jsonLog.info('dev InvokeAgentRuntime', { sessionId, action: request.action, inputs: request.inputs.map(input => input.id) })
    return { ok: true, accepted: request.inputs.map(input => input.id), state: 'running' }
  } },
  sourcesFor: async () => ({ cell: { tenantId: 'acme', cellId: CELL, repository: 'acme/widgets', repoId: 1, installationId: 1, defaultBranch: 'main',
    app: { slug: 'dshsa-dev', login: 'dshsa-dev[bot]', userId: 1, noreply: '1+dshsa-dev[bot]@users.noreply.github.com' } }, apis,
    kinds: [{ ...githubKind, run: undefined } as SourceKind] }) })

// Local mode only: the caller header `dev` stands in for a presigned STS URL (nothing listens beyond 127.0.0.1).
const internal = handler({ verify: async presigned => { if (presigned !== 'dev') throw new CallerRefused('dev caller required'); return 'dev' }, cells: host, log: jsonLog })
createServer((req, res) => {
  if (req.url === '/dev/enqueue' && req.method === 'POST') {
    let body = ''
    req.on('data', chunk => { body += String(chunk) })
    req.on('end', () => {
      try { const envelope = CellEnvelope.parse(JSON.parse(body)); queue.send(JSON.stringify(envelope), envelope.id); res.writeHead(202).end('{"queued":true}') }
      catch (error) { res.writeHead(400).end(JSON.stringify({ error: String(error) })) }
    })
    return
  }
  internal(req, res).catch((error: unknown) => { res.writeHead(500).end(String(error)) })
}).listen(8080, '127.0.0.1', () => { jsonLog.info('dev host listening', { url: 'http://127.0.0.1:8080', cell: CELL, dataDir: dir }) })
const stop = new AbortController()
process.once('SIGINT', () => { stop.abort() })
void host.run(stop.signal).then(() => process.exit(0))
