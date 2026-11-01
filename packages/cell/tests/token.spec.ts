import { generateKeyPairSync, sign as cryptoSign, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { TicketTokenClaims, decodeUnverified } from '@dshsa/contracts'
import { TicketTokens, type DerSigner } from '../src/token.ts'

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const fakeKms: DerSigner = { keyId: 'key-1', sign: async message => cryptoSign('sha256', message, { key: privateKey, dsaEncoding: 'der' }) }
const claims = { sub: 'a'.repeat(32), tid: 'acme', cid: 'acme--gh812345', tkt: 'ticket-1', asg: 'asg-1', rsid: `dshsa-${'b'.repeat(64)}` }

describe('TicketTokens', () => {
  it('issues an ES256 JWS that verifies with the public key and whose claims parse', async () => {
    const token = await new TicketTokens(fakeKms, 'key-1', () => 1_800_000_000_000).sign(claims)
    const [header, payload, signature] = token.split('.')
    expect(verify('sha256', Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature!, 'base64url'))).toBe(true)
    const decoded = decodeUnverified(token)
    expect(decoded.header).toEqual({ alg: 'ES256', typ: 'JWT', kid: 'key-1' })
    const parsed = TicketTokenClaims.parse(decoded.claims)
    expect(parsed).toMatchObject({ ...claims, iss: 'dshsa-cp', aud: 'dshsa-worker', iat: 1_800_000_000, exp: 1_800_007_200 })
  })
  it('caps the lifetime at 2 hours', async () => {
    const token = await new TicketTokens(fakeKms, 'key-1', () => 0).sign(claims, 10 * 3600)
    const parsed = TicketTokenClaims.parse(decodeUnverified(token).claims)
    expect(parsed.exp - parsed.iat).toBe(7200)
  })
})
