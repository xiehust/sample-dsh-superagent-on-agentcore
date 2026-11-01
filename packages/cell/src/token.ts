/** Ticket token signer (parent design §4.3): ES256 JWS, signed by the KMS key `alias/dshsa-ticket-token`. Only cells issue tokens. */
import { randomUUID } from 'node:crypto'
import { KMSClient, SignCommand } from '@aws-sdk/client-kms'
import { TicketTokenAudience, TicketTokenClaims, TicketTokenIssuer, TicketTokenMaxTtlSec, TicketTokenKeyAlias, derToJose, signingInput,
  type TicketTokenSigner } from '@dshsa/contracts'

/** Signs a message with ECDSA P-256 / SHA-256 and returns the DER signature (as KMS `Sign` does). */
export interface DerSigner { readonly keyId: string; sign(message: Uint8Array): Promise<Uint8Array> }

export class KmsDerSigner implements DerSigner {
  constructor(readonly keyId: string = TicketTokenKeyAlias, private readonly client: KMSClient = new KMSClient({})) {}
  async sign(message: Uint8Array): Promise<Uint8Array> {
    const result = await this.client.send(new SignCommand({ KeyId: this.keyId, Message: message, MessageType: 'RAW', SigningAlgorithm: 'ECDSA_SHA_256' }))
    if (!result.Signature) throw new Error('KMS returned no signature')
    return result.Signature
  }
}

export class TicketTokens implements TicketTokenSigner {
  /** `kid` is the key id the verifiers fetch the public key for (a key ARN or id, not the alias, once resolved by the host). */
  constructor(private readonly signer: DerSigner, private readonly kid: string = signer.keyId, private readonly now: () => number = Date.now) {}
  async sign(claims: Omit<TicketTokenClaims, 'iss' | 'aud' | 'iat' | 'exp' | 'jti'>, ttlSec = TicketTokenMaxTtlSec): Promise<string> {
    const iat = Math.floor(this.now() / 1000)
    const full = TicketTokenClaims.parse({ ...claims, iss: TicketTokenIssuer, aud: TicketTokenAudience, iat, exp: iat + Math.min(ttlSec, TicketTokenMaxTtlSec),
      jti: randomUUID() })
    const input = signingInput({ alg: 'ES256', typ: 'JWT', kid: this.kid }, full)
    const der = await this.signer.sign(Buffer.from(input, 'utf8'))
    return `${input}.${derToJose(der).toString('base64url')}`
  }
}
