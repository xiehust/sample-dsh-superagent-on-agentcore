import { describe, expect, it } from 'vitest'
import { stsCallerSigner } from '../src/caller.ts'

const creds = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', sessionToken: 'tok' }
const at = new Date('2026-11-01T00:00:00Z')

describe('stsCallerSigner (contracts v3 §4.7)', () => {
  it('presigns GetCallerIdentity on the regional STS endpoint, 60 s, signing x-dshsa-target', async () => {
    const url = new URL(await stsCallerSigner(creds, 'ap-northeast-1', () => at)('acme--gh1'))
    expect(url.origin).toBe('https://sts.ap-northeast-1.amazonaws.com')
    expect(url.pathname).toBe('/')
    const q = url.searchParams
    expect(q.get('Action')).toBe('GetCallerIdentity')
    expect(q.get('Version')).toBe('2011-06-15')
    expect(q.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
    expect(q.get('X-Amz-Expires')).toBe('60')
    expect(q.get('X-Amz-Date')).toBe('20261101T000000Z')
    expect(q.get('X-Amz-Credential')).toBe('AKIDEXAMPLE/20261101/ap-northeast-1/sts/aws4_request')
    expect(q.get('X-Amz-Security-Token')).toBe('tok')
    expect(q.get('X-Amz-SignedHeaders')!.split(';').sort()).toEqual(['host', 'x-dshsa-target'])
    expect(q.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
  })
  it('binds the signature to the target cell', async () => {
    const sign = stsCallerSigner(creds, 'ap-northeast-1', () => at)
    const sig = async (cell: string) => new URL(await sign(cell)).searchParams.get('X-Amz-Signature')
    expect(await sig('acme--gh1')).toBe(await sig('acme--gh1'))
    expect(await sig('acme--gh1')).not.toBe(await sig('beta--gh2'))
  })
})
