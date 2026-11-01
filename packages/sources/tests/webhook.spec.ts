import { describe, expect, it } from 'vitest'
import { CellEnvelope } from '@dshsa/contracts'
import { handleWebhook, MAX_ENVELOPE, type HttpEvent, type Route, type WebhookDeps } from '../src/webhook/core.ts'
import { awsDeps } from '../src/webhook/handler.ts'
import { sign, verifySignature } from '../src/webhook/verify.ts'
import { fixture } from './fakes.ts'

const SECRET = 'a-webhook-secret-of-forty-characters-xx'
const ROUTE: Route = { cellId: 'acme--gh812345', queueUrl: 'https://sqs.ap-northeast-1.amazonaws.com/123456789012/dshsa-cell-acme--gh812345.fifo', status: 'active' }
function deps(overrides: Partial<WebhookDeps> = {}) {
  const sent: { queueUrl: string; envelope: CellEnvelope }[] = []
  const logs: string[] = []
  const routes: string[] = []
  const value: WebhookDeps = {
    secret: async () => SECRET,
    route: async key => { routes.push(key); return key === 'gh#4242#812345' ? ROUTE : undefined },
    send: async (queueUrl, envelope) => { sent.push({ queueUrl, envelope }) },
    log: message => { logs.push(message) },
    now: () => new Date('2026-11-01T10:06:01.000Z'),
    ...overrides,
  }
  return { value, sent, logs, routes }
}
const request = (name: string, payload: unknown, options: { secret?: string; base64?: boolean; signature?: string; delivery?: string } = {}): HttpEvent => {
  const body = JSON.stringify(payload)
  return {
    requestContext: { http: { method: 'POST' } },
    headers: { 'x-github-event': name, 'x-github-delivery': options.delivery ?? '72d3162e-cc78-11e3-81ab-4c9367dc0958', 'content-type': 'application/json',
      'x-hub-signature-256': options.signature ?? sign(body, options.secret ?? SECRET) },
    body: options.base64 ? Buffer.from(body).toString('base64') : body, isBase64Encoded: !!options.base64,
  }
}
const comment = fixture('github/issue_comment.created.json')

describe('verifySignature', () => {
  it('accepts only the HMAC of the exact body under the secret', () => {
    const body = Buffer.from('{"a":1}')
    expect(verifySignature(body, sign(body, SECRET), SECRET)).toBe(true)
    expect(verifySignature(Buffer.from('{"a":2}'), sign(body, SECRET), SECRET)).toBe(false)
    expect(verifySignature(body, sign(body, 'other-secret-other-secret'), SECRET)).toBe(false)
    expect(verifySignature(body, 'sha1=abc', SECRET)).toBe(false)
    expect(verifySignature(body, sign(body, ''), '')).toBe(false)
  })
})

describe('webhook Lambda', () => {
  it('enqueues a verified delivery on its cell\'s FIFO queue as a source.event envelope', async () => {
    const t = deps()
    const result = await handleWebhook(request('issue_comment', comment, { base64: true }), t.value)
    expect(result.statusCode).toBe(202)
    expect(t.routes).toEqual(['gh#4242#812345'])
    expect(t.sent).toHaveLength(1)
    const { queueUrl, envelope } = t.sent[0]!
    expect(queueUrl).toBe(ROUTE.queueUrl)
    expect(CellEnvelope.parse(envelope)).toEqual({ v: 1, id: 'github:72d3162e-cc78-11e3-81ab-4c9367dc0958', cellId: 'acme--gh812345',
      type: 'source.event', at: '2026-11-01T10:06:01.000Z',
      body: { source: 'github', kind: 'issue_comment', deliveryId: '72d3162e-cc78-11e3-81ab-4c9367dc0958', payload: comment } })
  })
  it('refuses a missing or wrong signature with 401 and enqueues nothing', async () => {
    const t = deps()
    expect((await handleWebhook(request('issue_comment', comment, { secret: 'not-the-secret-not-the-secret' }), t.value)).statusCode).toBe(401)
    const unsigned = request('issue_comment', comment); delete unsigned.headers!['x-hub-signature-256']
    expect([(await handleWebhook(unsigned, t.value)).statusCode, JSON.parse((await handleWebhook(unsigned, t.value)).body)]).toEqual([401, { error: 'signature_required' }])
    expect((await handleWebhook({ requestContext: { http: { method: 'POST' } } }, t.value)).statusCode).toBe(401)
    const signedNoDelivery = request('issue_comment', comment); delete signedNoDelivery.headers!['x-github-delivery']
    expect((await handleWebhook(signedNoDelivery, t.value)).statusCode).toBe(400)
    expect(t.sent).toEqual([])
    expect(t.routes).toEqual([])
  })
  it('fails closed with 503 while the secret cannot be read', async () => {
    const t = deps({ secret: async () => { throw new Error('AccessDenied') } })
    expect((await handleWebhook(request('issue_comment', comment), t.value)).statusCode).toBe(503)
    expect(t.sent).toEqual([])
  })
  it('rereads a rotated secret once before refusing', async () => {
    let calls = 0
    const rotated = 'a-rotated-webhook-secret-of-many-chars'
    const t = deps({ secret: async fresh => { calls++; return fresh ? rotated : SECRET } })
    expect((await handleWebhook(request('issue_comment', comment, { secret: rotated }), t.value)).statusCode).toBe(202)
    expect(calls).toBe(2)
  })
  it('answers ping, ignores events the cell does not read, and answers an unrouted repository 202 without enqueueing', async () => {
    const t = deps()
    expect((await handleWebhook(request('ping', fixture('github/ping.json')), t.value)).statusCode).toBe(200)
    expect(JSON.parse((await handleWebhook(request('star', { action: 'created' }), t.value)).body)).toEqual({ ignored: 'event' })
    const other = structuredClone(comment) as { repository: { id: number } }
    other.repository.id = 1
    const result = await handleWebhook(request('issue_comment', other), t.value)
    expect([result.statusCode, JSON.parse(result.body)]).toEqual([202, { ignored: 'unrouted' }])
    expect(t.logs).toContain('webhook.unrouted')
    expect(t.sent).toEqual([])
  })
  it('does not route to a paused cell', async () => {
    const t = deps({ route: async () => ({ ...ROUTE, status: 'paused' }) })
    expect(JSON.parse((await handleWebhook(request('issue_comment', comment), t.value)).body)).toEqual({ ignored: 'cell_inactive' })
    expect(t.sent).toEqual([])
  })
  it('slims a payload too large for the queue to what the cell needs to re-read it', async () => {
    const t = deps()
    const big = structuredClone(comment) as { comment: { body: string } }
    big.comment.body = 'x'.repeat(MAX_ENVELOPE)
    expect((await handleWebhook(request('issue_comment', big), t.value)).statusCode).toBe(202)
    expect(t.sent[0]!.envelope.body).toMatchObject({ payload: { dshsa: { truncated: true, number: 12 }, action: 'created',
      installation: { id: 4242 }, repository: { id: 812345 } } })
    expect(Buffer.byteLength(JSON.stringify(t.sent[0]!.envelope))).toBeLessThan(MAX_ENVELOPE)
  })
  it('answers 500 when the queue refuses, so GitHub can redeliver', async () => {
    const t = deps({ send: async () => { throw new Error('throttled') } })
    expect((await handleWebhook(request('issue_comment', comment), t.value)).statusCode).toBe(500)
  })
  it('refuses a placeholder secret from Secrets Manager and caches routes', async () => {
    let gets = 0
    const aws = awsDeps({ SECRET_ID: 'dshsa/github-app', ROUTES_TABLE: 'dshsa-routes', CELLS_TABLE: 'dshsa-cells' }, {
      secrets: { send: async () => ({ SecretString: JSON.stringify({ appId: '', webhookSecret: '' }) }) },
      dynamo: { send: async (command: { input: { TableName: string } }) => { gets++
        return command.input.TableName === 'dshsa-routes' ? { Item: { cellId: { S: ROUTE.cellId } } } : { Item: { queueUrl: { S: ROUTE.queueUrl }, status: { S: 'active' } } } } },
      sqs: { send: async () => ({}) },
    } as never)
    await expect(aws.secret()).rejects.toThrow('not set')
    expect((await handleWebhook(request('issue_comment', comment), { ...aws, log: () => {} })).statusCode).toBe(503)
    expect(await aws.route('gh#4242#812345')).toEqual(ROUTE)
    expect(await aws.route('gh#4242#812345')).toEqual(ROUTE)
    expect(gets).toBe(2)
  })
})
