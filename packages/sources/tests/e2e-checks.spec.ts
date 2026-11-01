import { describe, expect, it } from 'vitest'
import { a6NoTicket, checkIngressDenies, issueCommentDelivery, urlArgument } from '../e2e/ingress.ts'
import { handleWebhook, type WebhookDeps } from '../src/webhook/core.ts'
import { verifySignature } from '../src/webhook/verify.ts'

const URL_ = 'https://abc.execute-api.ap-northeast-1.amazonaws.com/github/webhook'
const SECRET = 'a-webhook-secret-of-forty-characters-xx'
/** API Gateway in front of the real handler: only POST /github/webhook is routed. */
function gateway(deps: Partial<WebhookDeps> = {}, open = false): typeof fetch {
  const full: WebhookDeps = { secret: async () => SECRET, route: async () => ({ cellId: 'e2e1--gh1', queueUrl: 'q', status: 'active' }),
    send: async () => {}, log: () => {}, ...deps }
  return (async (url: string, init: RequestInit) => {
    if (url !== URL_ || init.method !== 'POST') return new Response('{"message":"Not Found"}', { status: 404 })
    if (open) return new Response('{"queued":true}', { status: 202 })
    const result = await handleWebhook({ requestContext: { http: { method: 'POST' } }, headers: init.headers as Record<string, string>, body: String(init.body) }, full)
    return new Response(result.body, { status: result.statusCode })
  }) as typeof fetch
}

describe('deploy-time ingress check', () => {
  it('takes the first URL argument and ignores the rest, such as a # comment zsh passed through', () => {
    const url = 'https://abc.execute-api.ap-northeast-1.amazonaws.com/github/webhook'
    expect(urlArgument([])).toEqual({ ignored: [] })
    expect(urlArgument(['#', 'must', 'print'])).toEqual({ ignored: ['#', 'must', 'print'] })
    expect(urlArgument([url, '#', 'note'])).toEqual({ url, ignored: ['#', 'note'] })
    expect(urlArgument(['file:///etc/passwd'])).toEqual({ ignored: ['file:///etc/passwd'] })
  })
  it('passes when every anonymous or forged request is refused by the signature gate', async () => {
    const results = await checkIngressDenies(URL_, gateway())
    expect(results.filter(result => !result.ok)).toEqual([])
    expect(results).toHaveLength(5)
  })
  it('passes while the secret is a placeholder, since the gate then refuses everything with 503', async () => {
    const results = await checkIngressDenies(URL_, gateway({ secret: async () => { throw new Error('not set') } }))
    expect(results.every(result => result.ok)).toBe(true)
  })
  it('fails for an endpoint that accepts anonymous deliveries, or a 401 that is not the gate\'s', async () => {
    expect((await checkIngressDenies(URL_, gateway({}, true))).filter(result => !result.ok).map(result => result.name)).toEqual([
      'anonymous POST (no signature) is refused by the gate', 'POST with a forged signature is refused by the gate',
      'POST signed over a different body is refused by the gate'])
    const bare401 = (async () => new Response('Unauthorized', { status: 401 })) as unknown as typeof fetch
    expect((await checkIngressDenies(URL_, bare401))[0]!.ok).toBe(false)
  })
})

describe('A6 step', () => {
  const base = { webhookUrl: URL_, webhookSecret: SECRET, slug: 'dshsa-agent', cellId: 'e2e1--gh1', installationId: 1, repoId: 900, repoFullName: 'e2e/e2e1', timeoutMs: 50 }
  it('signs deliveries the gate accepts', () => {
    const delivery = issueCommentDelivery(base, 7, 'alice', 'hi')
    expect(verifySignature(Buffer.from(delivery.body), delivery.headers['x-hub-signature-256'], SECRET)).toBe(true)
  })
  function cell(options: { recorded: boolean; tickets?: number }) {
    const calls: string[] = []
    const markers: string[] = []
    const fetcher = (async (_url: string, init: RequestInit) => {
      markers.push(JSON.parse(String(init.body)).comment.body as string)
      return new Response('{"queued":true}', { status: 202 })
    }) as typeof fetch
    const cellApi = async (path: string) => {
      calls.push(path)
      if (path === 'settings') return Response.json({ blocks: { policy: { value: { rules: [], sources: {} }, revision: 3 } } })
      if (path === 'settings/policy') return Response.json({ revision: 4 })
      if (path.startsWith('search')) {
        const term = decodeURIComponent(path.split('q=')[1]!)
        return Response.json({ items: options.recorded && term.endsWith('stranger') ? [{ id: 't' }] : [], tickets: [] })
      }
      if (path.startsWith('tickets')) return Response.json({ items: Array.from({ length: options.tickets ?? 0 }, (_, i) => ({ title: `t${i}` })) })
      return new Response('', { status: 404 })
    }
    return { calls, markers, fetcher, cellApi }
  }
  it('passes when the stranger\'s mention is recorded and no ticket exists', async () => {
    const t = cell({ recorded: true })
    await a6NoTicket({ ...base, ...t })
    expect(t.markers[0]).toMatch(/^@dshsa-agent /)
    expect(t.calls).toContain('settings/policy')
  }, 20_000)
  it('fails when a ticket exists, or when nothing reached the cell', async () => {
    await expect(a6NoTicket({ ...base, ...cell({ recorded: true, tickets: 1 }) })).rejects.toThrow('open ticket')
    await expect(a6NoTicket({ ...base, ...cell({ recorded: false }) })).rejects.toThrow('never recorded')
  }, 30_000)
})
