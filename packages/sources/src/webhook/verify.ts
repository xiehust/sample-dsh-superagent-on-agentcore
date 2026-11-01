/** GitHub webhook signature check (`X-Hub-Signature-256`), over the raw body, in constant time. */
import { createHmac, timingSafeEqual } from 'node:crypto'

/** True when `signature` (`sha256=<hex>`) is the HMAC-SHA256 of `body` under `secret`. An empty secret never verifies. */
export function verifySignature(body: Buffer, signature: string | undefined, secret: string): boolean {
  if (!secret || !signature?.startsWith('sha256=')) return false
  const given = Buffer.from(signature.slice('sha256='.length), 'hex')
  const expected = createHmac('sha256', secret).update(body).digest()
  return given.length === expected.length && timingSafeEqual(given, expected)
}
export const sign = (body: Buffer | string, secret: string): string => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
