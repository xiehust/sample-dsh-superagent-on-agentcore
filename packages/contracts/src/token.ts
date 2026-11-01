/** Ticket token (design §4.3): JWS compact, ES256, signed by KMS `alias/dshsa-ticket-token`. */
import { z } from 'zod'
import { CellId, TenantId } from './ids.ts'

export const TicketTokenIssuer = 'dshsa-cp'
export const TicketTokenAudience = 'dshsa-worker'
export const TicketTokenMaxTtlSec = 2 * 60 * 60
export const TicketTokenSkewSec = 60

export const TicketTokenClaims = z.object({
  iss: z.literal(TicketTokenIssuer),
  aud: z.literal(TicketTokenAudience),
  sub: z.string().regex(/^[0-9a-f]{32}$/),
  tid: TenantId,
  cid: CellId,
  tkt: z.string().min(1),
  asg: z.string().min(1),
  rsid: z.string().min(33),
  iat: z.number().int(),
  exp: z.number().int(),
  jti: z.string().min(8),
}).refine(c => c.exp > c.iat && c.exp - c.iat <= TicketTokenMaxTtlSec, { message: 'token ttl out of range' })
export type TicketTokenClaims = z.infer<typeof TicketTokenClaims>

export const TicketTokenHeader = z.object({ alg: z.literal('ES256'), typ: z.literal('JWT'), kid: z.string().min(1) })

/** Implemented in packages/cell (KMS Sign). */
export interface TicketTokenSigner {
  sign(claims: Omit<TicketTokenClaims, 'iss' | 'aud' | 'iat' | 'exp' | 'jti'>, ttlSec?: number): Promise<string>
}
/** Implemented by broker and worker-api (KMS public key, cached). Throws on any failure. */
export interface TicketTokenVerifier {
  verify(token: string, nowSec?: number): Promise<TicketTokenClaims>
}

const b64url = (input: string): string => Buffer.from(input, 'utf8').toString('base64url')
/** The signing input `base64url(header).base64url(payload)`; the KMS signature (DER) must be converted to raw r||s (64 bytes). */
export function signingInput(header: z.infer<typeof TicketTokenHeader>, claims: TicketTokenClaims): string {
  return `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`
}
/** Decode without verifying, e.g. for logging. Never use for authorization. */
export function decodeUnverified(token: string): { header: unknown; claims: unknown } {
  const [h, p] = token.split('.')
  if (!h || !p) throw new Error('malformed token')
  return { header: JSON.parse(Buffer.from(h, 'base64url').toString('utf8')), claims: JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) }
}

/** Convert an ECDSA DER signature (as KMS returns it) to JOSE raw r||s for ES256 (64 bytes). */
export function derToJose(der: Uint8Array, size = 32): Buffer {
  const buf = Buffer.from(der)
  let offset = 0
  if (buf[offset++] !== 0x30) throw new Error('bad DER: no sequence')
  let seqLen = buf[offset++]!
  if (seqLen & 0x80) offset += seqLen & 0x7f
  const readInt = (): Buffer => {
    if (buf[offset++] !== 0x02) throw new Error('bad DER: no integer')
    const len = buf[offset++]!
    let int = buf.subarray(offset, offset + len)
    offset += len
    while (int.length > size && int[0] === 0) int = int.subarray(1)
    if (int.length > size) throw new Error('bad DER: integer too long')
    return Buffer.concat([Buffer.alloc(size - int.length), int])
  }
  const r = readInt()
  const s = readInt()
  return Buffer.concat([r, s])
}
