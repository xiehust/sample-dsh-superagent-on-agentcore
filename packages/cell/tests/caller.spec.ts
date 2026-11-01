import { describe, expect, it, vi } from 'vitest'
import { CallerRefused, CallerVerifier, assumedRole, checkPresigned } from '../src/caller.ts'

const NOW = Date.UTC(2026, 10, 1, 3, 0, 0)
const amzDate = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
function presigned(overrides: Record<string, string | null> = {}, host = 'sts.ap-northeast-1.amazonaws.com'): string {
  const params: Record<string, string | null> = { Action: 'GetCallerIdentity', Version: '2011-06-15', 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': 'AKIA/20261101/ap-northeast-1/sts/aws4_request', 'X-Amz-Date': amzDate(NOW - 1000), 'X-Amz-Expires': '60',
    'X-Amz-SignedHeaders': 'host;x-dshsa-target', 'X-Amz-Signature': 'ab'.repeat(32), ...overrides }
  const query = Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
  return `https://${host}/?${query}`
}
const sts = (arn: string, status = 200) => vi.fn(async (_url: string, _init: { headers: Record<string, string> }) =>
  ({ ok: status === 200, status, text: async () => status === 200 ? `<GetCallerIdentityResponse><GetCallerIdentityResult><Arn>${arn}</Arn><UserId>X</UserId><Account>123456789012</Account></GetCallerIdentityResult></GetCallerIdentityResponse>` : '<Error/>' }))
const policy = { region: 'ap-northeast-1', account: '123456789012', roles: { api: 'dshsa-panel-api', worker: 'dshsa-worker-api', tenant: 'dshsa-panel-tenant' } }
const PANEL = 'arn:aws:sts::123456789012:assumed-role/dshsa-panel-api/dshsa-panel-api-fn'

describe('checkPresigned', () => {
  it('accepts a regional GetCallerIdentity URL that signs the target', () => {
    expect(checkPresigned(presigned(), 'ap-northeast-1', NOW).expiresAt).toBe(NOW - 1000 + 60_000)
  })
  it.each([
    ['another host', presigned({}, 'evil.example.com')],
    ['the global STS endpoint', presigned({}, 'sts.amazonaws.com')],
    ['another region', presigned({}, 'sts.us-west-2.amazonaws.com')],
    ['another action', presigned({ Action: 'AssumeRole' })],
    ['a duplicated action', `${presigned()}&Action=GetCallerIdentity`],
    ['a long expiry', presigned({ 'X-Amz-Expires': '900' })],
    ['an unsigned target', presigned({ 'X-Amz-SignedHeaders': 'host' })],
    ['an expired URL', presigned({ 'X-Amz-Date': amzDate(NOW - 120_000) })],
    ['plain http', presigned().replace('https:', 'http:')],
  ])('refuses %s', (_name, url) => {
    expect(() => checkPresigned(url, 'ap-northeast-1', NOW)).toThrow(CallerRefused)
  })
})

describe('CallerVerifier', () => {
  it('sends the path cellId as x-dshsa-target and accepts the allowed role for the area', async () => {
    const fetcher = sts(PANEL)
    const verifier = new CallerVerifier(policy, fetcher, () => NOW)
    await expect(verifier.verify(presigned(), 'acme--gh1', 'api')).resolves.toBe(PANEL)
    expect(fetcher.mock.calls[0]![1].headers['x-dshsa-target']).toBe('acme--gh1')
  })
  it('refuses the panel role on worker routes, other accounts, users, and STS failures', async () => {
    await expect(new CallerVerifier(policy, sts(PANEL), () => NOW).verify(presigned(), 'acme--gh1', 'worker')).rejects.toThrow(CallerRefused)
    await expect(new CallerVerifier(policy, sts('arn:aws:sts::111111111111:assumed-role/dshsa-panel-api/x'), () => NOW).verify(presigned(), 'acme--gh1', 'api')).rejects.toThrow(CallerRefused)
    await expect(new CallerVerifier(policy, sts('arn:aws:iam::123456789012:user/dshsa-panel-api'), () => NOW).verify(presigned(), 'acme--gh1', 'api')).rejects.toThrow(CallerRefused)
    await expect(new CallerVerifier(policy, sts(PANEL, 403), () => NOW).verify(presigned(), 'acme--gh1', 'api')).rejects.toThrow(CallerRefused)
    await expect(new CallerVerifier(policy, sts(PANEL), () => NOW).verify(undefined, 'acme--gh1', 'api')).rejects.toThrow(CallerRefused)
  })
  it('caches per URL and cell, so the same URL for another cell asks STS again', async () => {
    const fetcher = sts(PANEL)
    const verifier = new CallerVerifier(policy, fetcher, () => NOW)
    const url = presigned()
    await verifier.verify(url, 'acme--gh1', 'api')
    await verifier.verify(url, 'acme--gh1', 'api')
    expect(fetcher).toHaveBeenCalledTimes(1)
    await verifier.verify(url, 'acme--gh2', 'api')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('parses assumed-role ARNs only', () => {
    expect(assumedRole(PANEL)).toEqual({ account: '123456789012', role: 'dshsa-panel-api' })
    expect(assumedRole('arn:aws:iam::123456789012:role/dshsa-panel-api')).toBeUndefined()
  })
})
