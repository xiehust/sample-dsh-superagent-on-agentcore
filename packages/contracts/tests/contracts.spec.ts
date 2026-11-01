import { generateKeyPairSync, sign, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import vectors from './vectors.json' with { type: 'json' }
import {
  AuditEntry, CellEnvelope, CognitoGroups, InstallationClaim, InvocationRequest, InvocationResponse, PanelRoleHeader, RESERVED_TENANT_IDS,
  RouteRecord, Secrets, SetupState, Tables, TenantRecord, TicketTokenClaims, WorkerEvent, WorkerVersion, onboardingKey, leaseKey, HOST_LEASE_PREFIX, LeaseRecord, GithubOauthSecret,
  accessPointRoot, cellId, decodeUnverified, derToJose, envelopeId, runtimeSessionId, signingInput, tenantOfCell, ticketKey,
} from '../src/index.ts'

describe('ids', () => {
  for (const c of vectors.cases) {
    it(`derives ids for ${c.tenantId}/${c.ticketId}`, () => {
      const cell = cellId(c.tenantId, c.githubRepoId)
      expect(cell).toBe(c.cellId)
      expect(tenantOfCell(cell)).toBe(c.tenantId)
      expect(ticketKey(cell, c.ticketId)).toBe(c.ticketKey)
      expect(runtimeSessionId(cell, c.ticketId)).toBe(c.runtimeSessionId)
      expect(runtimeSessionId(cell, c.ticketId).length).toBeGreaterThanOrEqual(33)
      expect(accessPointRoot(c.tenantId, cell, c.ticketId)).toBe(c.accessPointRoot)
      expect(accessPointRoot(c.tenantId, cell, c.ticketId).split('/').filter(Boolean).length).toBeLessThanOrEqual(4)
    })
  }
  it('rejects bad tenant ids', () => {
    expect(() => cellId('Acme', 1)).toThrow()
    expect(() => cellId('a', 1)).toThrow()
    expect(() => cellId('acme/../x', 1)).toThrow()
  })
})

const c0 = vectors.cases[0]!
const claims = {
  iss: 'dshsa-cp', aud: 'dshsa-worker', sub: c0.ticketKey, tid: c0.tenantId, cid: c0.cellId, tkt: c0.ticketId,
  asg: 'asg-1', rsid: c0.runtimeSessionId, iat: 1_000, exp: 1_000 + 3600, jti: 'jti-12345678',
} as const

describe('ticket token', () => {
  it('accepts valid claims and rejects long ttl', () => {
    expect(TicketTokenClaims.parse(claims)).toEqual(claims)
    expect(() => TicketTokenClaims.parse({ ...claims, exp: claims.iat + 3 * 3600 })).toThrow()
    expect(() => TicketTokenClaims.parse({ ...claims, aud: 'other' })).toThrow()
  })
  it('DER signature converts to a JOSE signature node can verify', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const input = signingInput({ alg: 'ES256', typ: 'JWT', kid: 'k' }, claims)
    for (let i = 0; i < 20; i++) {
      const der = sign('sha256', Buffer.from(input), privateKey)
      const jose = derToJose(der)
      expect(jose.length).toBe(64)
      expect(verify('sha256', Buffer.from(input), { key: publicKey, dsaEncoding: 'ieee-p1363' }, jose)).toBe(true)
    }
    const token = `${input}.${derToJose(sign('sha256', Buffer.from(input), privateKey)).toString('base64url')}`
    expect(decodeUnverified(token).claims).toEqual(claims)
  })
})

describe('wire schemas', () => {
  const ticket = { tenantId: 'acme', cellId: c0.cellId, ticketId: 't', assignmentId: 'a', title: 'x', scope: 'y', mandate: {} }
  const config = { model: 'm', systemPrompt: '', skills: [], env: {}, repo: { fullName: 'o/r', defaultBranch: 'main', cloneUrl: 'https://github.com/o/r.git' } }
  it('invocation requires config for start/deliver', () => {
    expect(InvocationRequest.parse({ v: 1, action: 'start', token: 't', ticket, config }).inputs).toEqual([])
    expect(() => InvocationRequest.parse({ v: 1, action: 'deliver', token: 't', ticket })).toThrow()
    expect(InvocationRequest.parse({ v: 1, action: 'stop', token: 't', ticket }).action).toBe('stop')
    expect(InvocationResponse.parse({ ok: false, error: 'mount_failed', message: '' }).ok).toBe(false)
  })
  it('worker events and envelopes round-trip', () => {
    const event = WorkerEvent.parse({ id: 'e1', ticketKey: c0.ticketKey, assignmentId: 'a', at: '2026-11-01T00:00:00Z', type: 'report',
      body: { state: 'ready', text: 'PR opened', links: [{ url: 'https://github.com/o/r/pull/1' }] } })
    const env = CellEnvelope.parse({ v: 1, id: envelopeId.worker(event.ticketKey, event.id), cellId: c0.cellId, at: event.at, type: 'worker.event',
      body: { event, verified: { tid: 'acme', cid: c0.cellId, tkt: 't', asg: 'a' } } })
    expect(JSON.parse(JSON.stringify(env))).toEqual(env)
    expect(() => WorkerEvent.parse({ ...event, type: 'report', body: { state: 'done', text: '' } })).toThrow()
    expect(envelopeId.source('github', 'x'.repeat(300)).length).toBe(128)
    const ack = { id: 'e2', ticketKey: c0.ticketKey, assignmentId: 'a', at: event.at, type: 'ack' }
    expect(() => WorkerEvent.parse({ ...ack, body: { text: 'on it' } })).toThrow()
    expect(WorkerEvent.parse({ ...ack, body: { text: 'on it', triggerId: 'tr1' } }).type).toBe('ack')
    const r = WorkerEvent.parse({ ...event, body: { state: 'progress', text: 's', question: null, prNumber: 7, answers: 'tr1' } })
    expect(r.type === 'report' && r.body.question).toBeNull()
    expect(() => WorkerEvent.parse({ ...ack, type: 'thread.follow', body: { thread: 'nocolon', reason: 'x' } })).toThrow()
  })
})

// Golden envelopes that worker-api (Python) emits; worker/tests/unit/test_worker_api.py checks the same file from the producer side.
describe('golden worker.event envelopes', () => {
  const g = vectors.workerEventEnvelope
  it('scopes worker envelope ids per ticket and keeps them SQS-safe', () => {
    const id = envelopeId.worker(g.claims.sub, 'e1')
    expect(id).toMatch(/^we-[0-9a-f]{40}$/)
    expect(envelopeId.worker(g.claims.sub, 'e1')).toBe(id)
    expect(envelopeId.worker('0'.repeat(32), 'e1')).not.toBe(id)
    expect(envelopeId.worker(g.claims.sub, 'x'.repeat(10_000)).length).toBe(43)
  })
  for (const c of g.cases) {
    it(`parses ${c.event.type} exactly as worker-api builds it`, () => {
      const env = CellEnvelope.parse(c.envelope)
      expect(env).toEqual(c.envelope) // nothing stripped or added: body is exactly {event, verified}
      expect(Object.keys(c.envelope.body).sort()).toEqual(['event', 'verified'])
      expect(WorkerEvent.parse(c.event)).toEqual(c.event)
      expect(env.type === 'worker.event' && env.body.event).toEqual(c.event)
      expect(env.cellId).toBe(g.claims.cid)
      expect(env.id).toBe(envelopeId.worker(g.claims.sub, c.event.id)) // same derivation as worker-api envelope_id
      expect(env.id.length).toBeLessThanOrEqual(128)
      expect(env.id).toMatch(/^[\x21-\x7e]+$/) // SQS FIFO MessageDeduplicationId charset
      expect(() => CellEnvelope.parse({ ...c.envelope, body: { ...c.event, verified: c.envelope.body.verified } })).toThrow()
    })
  }
})

describe('invocation responses carry the worker version', () => {
  const g = vectors.invocationResponses
  for (const c of g.cases) {
    it(`parses ${c.call[0]} ${c.legacy ? '(legacy, no version)' : 'with workerVersion'}`, () => {
      expect(InvocationResponse.parse(c.response)).toEqual(c.response)
      expect((c.response as Record<string, unknown>)[WorkerVersion.field]).toBe(c.legacy ? undefined : g.workerVersion)
    })
  }
  it('rejects an empty version and names the SSM parameter in the dshsa- namespace', () => {
    expect(() => InvocationResponse.parse({ ok: true, accepted: [], state: 'idle', workerVersion: '' })).toThrow()
    expect(WorkerVersion.parameter).toMatch(/^\/dshsa-/)
  })
})

describe('v6 panel onboarding', () => {
  it('names a tenant admin group that the tenant-group prefix never parses as a tenant', () => {
    expect(CognitoGroups.tenantAdmin('e2ea')).toBe('dshsa-tadmin-e2ea')
    expect(CognitoGroups.tenantAdmin('e2ea').startsWith('dshsa-tenant-')).toBe(false)
    expect(RESERVED_TENANT_IDS).toEqual(expect.arrayContaining(['admin', 'tadmin']))
  })
  it('keys onboarding items apart from routes', () => {
    expect(onboardingKey.githubInstall(177432084)).toBe('ghinst#177432084')
    expect(leaseKey.host('arn:aws:ecs:r:1:task/c/abc')).toBe('host#arn:aws:ecs:r:1:task/c/abc')
    expect(leaseKey.host('x').startsWith(HOST_LEASE_PREFIX)).toBe(true)
    expect(LeaseRecord.parse({ leaseKey: leaseKey.host('t1'), owner: 't1', endpoint: 'http://10.0.0.1:8080', fence: 1, expiresAt: 1 }).leaseKey).toBe('host#t1')
    expect(onboardingKey.githubState('n'.repeat(32))).toBe(`ghstate#${'n'.repeat(32)}`)
    expect(RouteRecord.safeParse({ routeKey: 'ghinst#1', tenantId: 'acme', cellId: 'acme--gh1', updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'x' }).success).toBe(false)
  })
  it('parses claims, state, audit entries and the optional Feishu revision', () => {
    const claim = { key: 'ghinst#7', tenantId: 'acme', installationId: 7, status: 'active', account: 'octo-org', accountType: 'Organization',
      githubLogin: 'octo', claimedBy: 'sub-1', claimedAt: '2026-11-01T00:00:00Z' }
    expect(InstallationClaim.parse(claim).installationId).toBe(7)
    expect(InstallationClaim.parse({ ...claim, status: 'pending', pendingReason: 'not_org_admin' }).status).toBe('pending')
    // No status is not "active": a claim must say it explicitly, so a host check fails closed.
    const { status: _status, ...unstated } = claim
    expect(InstallationClaim.safeParse(unstated).success).toBe(false)
    expect(SetupState.safeParse({ key: 'ghstate#short', tenantId: 'acme', sub: 's', ttl: 1 }).success).toBe(false)
    expect(AuditEntry.parse({ at: '2026-11-01T00:00:00Z', actor: { sub: 's' }, role: 'tadmin', op: 'tenant.cell.add', tenantId: 'acme', target: 'acme--gh1', ok: true }).ok).toBe(true)
    expect(AuditEntry.safeParse({ at: '2026-11-01T00:00:00Z', actor: { sub: 's' }, role: 'root', op: 'x', ok: true }).success).toBe(false)
    const tenant = { tenantId: 'acme', name: 'A', cognitoGroup: 'dshsa-tenant-acme', status: 'active', createdAt: '2026-11-01T00:00:00Z' }
    expect(TenantRecord.parse({ ...tenant, feishu: { domain: 'feishu', appId: 'cli_x', secretArn: 'arn:x' } }).feishu?.revision).toBeUndefined()
    expect(TenantRecord.parse({ ...tenant, feishu: { domain: 'lark', appId: 'cli_x', secretArn: 'arn:x', revision: '2026-11-01T00:00:00Z' } }).feishu?.revision).toBeDefined()
    expect(Tables.onboarding).toBe('dshsa-onboarding')
    expect(PanelRoleHeader).toBe('x-dshsa-role')
    expect(Secrets.githubOauth).toBe('dshsa/github-oauth')
    expect(GithubOauthSecret.parse({ clientId: 'Iv1.x', clientSecret: 's', appId: '5564096', slug: 'dshsa-agent' })).toMatchObject({ appId: '5564096', slug: 'dshsa-agent' })
    expect(GithubOauthSecret.safeParse({ clientId: 'Iv1.x', clientSecret: 's', slug: 'Iv23liRR37pV3z4Ie6Ba' }).success).toBe(false)
  })
})
