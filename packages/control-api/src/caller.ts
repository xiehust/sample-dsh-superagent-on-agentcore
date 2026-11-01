/**
 * Internal HTTP caller proof (parent design §4.7, contracts v3): a presigned `sts:GetCallerIdentity` URL, valid 60 s, that
 * signs `x-dshsa-target: <cellId>`. The host replays it against regional STS and admits only the panel-api role. Signing is
 * local (no AWS call); the credentials are the Lambda role's.
 */
import { createHash, createHmac, type Hash, type Hmac } from 'node:crypto'
import { InternalApiCallerTtlSec, InternalApiTargetHeader, REGION } from '@dshsa/contracts'
import { SignatureV4 } from '@smithy/signature-v4'
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider, SourceData } from '@smithy/types'

const bytes = (data: SourceData): string | Uint8Array =>
  typeof data === 'string' ? data : data instanceof Uint8Array ? data : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data)

/** Node crypto as the SigV4 `Checksum` (`new Sha256()` hashes, `new Sha256(key)` HMACs). */
class Sha256 {
  private impl: Hash | Hmac
  private readonly secret?: string | Uint8Array
  constructor(secret?: SourceData) { this.secret = secret === undefined ? undefined : bytes(secret); this.impl = this.fresh() }
  private fresh(): Hash | Hmac { return this.secret === undefined ? createHash('sha256') : createHmac('sha256', this.secret) }
  update(data: SourceData): void { this.impl.update(bytes(data)) }
  async digest(): Promise<Uint8Array> { return new Uint8Array(this.impl.digest()) }
  reset(): void { this.impl = this.fresh() }
}

export type CallerSigner = (cellId: string) => Promise<string>

export function stsCallerSigner(credentials: AwsCredentialIdentity | AwsCredentialIdentityProvider, region: string = REGION,
  now: () => Date = () => new Date()): CallerSigner {
  const signer = new SignatureV4({ service: 'sts', region, credentials, sha256: Sha256, applyChecksum: false })
  const hostname = `sts.${region}.amazonaws.com`
  return async cellId => {
    const signed = await signer.presign({
      method: 'GET', protocol: 'https:', hostname, path: '/',
      query: { Action: 'GetCallerIdentity', Version: '2011-06-15' },
      headers: { host: hostname, [InternalApiTargetHeader]: cellId },
    }, { expiresIn: InternalApiCallerTtlSec, signingDate: now(), signableHeaders: new Set([InternalApiTargetHeader]) })
    const url = new URL(`https://${hostname}/`)
    for (const [key, value] of Object.entries(signed.query ?? {})) {
      for (const v of Array.isArray(value) ? value : [value]) if (v !== null && v !== undefined) url.searchParams.append(key, v)
    }
    return url.href
  }
}
