/**
 * OIDC authorization code + PKCE (S256) against the Cognito hosted UI. No client secret: the app client is public.
 * The API bearer is the **ID token**: the panel-api JWT authorizer's audience is the app client id, and panel-api needs the
 * `email` and `cognito:groups` claims, which Cognito access tokens do not carry. Tokens live in sessionStorage only
 * (cleared when the tab closes); the ID token is refreshed with the refresh token when its `exp` is within 60 s.
 */
import type { RuntimeConfig } from './types.ts'

export const SCOPES = 'openid email profile'
const SKEW_MS = 60_000
const TOKENS = 'dshsa.auth.tokens'
const PENDING = 'dshsa.auth.pending'

/** `expiresAt` (epoch ms) is the ID token's `exp`. */
export interface Tokens { idToken: string; accessToken?: string; refreshToken?: string; expiresAt: number }
interface Pending { state: string; verifier: string }

export class AuthError extends Error {
  constructor(readonly code: 'state_mismatch' | 'authorize_failed' | 'token_failed', message: string) { super(message) }
}

export function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
/** A random URL-safe string (43 chars for 32 bytes), valid as a PKCE verifier (RFC 7636 §4.1) and as `state`. */
export function randomString(bytes = 32, source: Pick<Crypto, 'getRandomValues'> = globalThis.crypto): string {
  return base64url(source.getRandomValues(new Uint8Array(bytes)))
}
/** `code_challenge = base64url(sha256(verifier))` (RFC 7636 §4.2, S256). */
export async function challengeOf(verifier: string, subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<string> {
  return base64url(new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
}

/** Decodes a JWT payload without verifying it (display and expiry bookkeeping only; the API verifies the signature). */
export function claimsOf(jwt: string | undefined): Record<string, unknown> | undefined {
  const payload = jwt?.split('.')[1]
  if (!payload) return undefined
  try {
    const binary = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    const value = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)))) as unknown
    return value && typeof value === 'object' ? value as Record<string, unknown> : undefined
  } catch { return undefined }
}

export interface AuthDeps {
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  fetch: typeof fetch
  navigate: (url: string) => void
  /** `window.location.origin`; the redirect and logout URI is `origin + '/'`. */
  origin: string
  crypto: Crypto
  now: () => number
}
const browser = (): AuthDeps => ({
  storage: sessionStorage, fetch: (...args) => fetch(...args), navigate: url => window.location.assign(url),
  origin: window.location.origin, crypto: globalThis.crypto, now: () => Date.now(),
})

export class Auth {
  private readonly deps: AuthDeps
  private readonly domain: string
  private refreshing: Promise<Tokens | undefined> | undefined
  constructor(private readonly config: Pick<RuntimeConfig, 'clientId' | 'domain'>, deps: Partial<AuthDeps> = {}) {
    this.deps = { ...browser(), ...deps }
    this.domain = config.domain.replace(/\/+$/, '')
  }
  get redirectUri(): string { return `${this.deps.origin}/` }

  /** Starts a login: stores a fresh `state` and verifier, then navigates to the hosted UI authorize endpoint. */
  async login(): Promise<void> {
    const pending: Pending = { state: randomString(32, this.deps.crypto), verifier: randomString(48, this.deps.crypto) }
    this.deps.storage.setItem(PENDING, JSON.stringify(pending))
    const query = new URLSearchParams({
      response_type: 'code', client_id: this.config.clientId, redirect_uri: this.redirectUri, scope: SCOPES, state: pending.state,
      code_challenge: await challengeOf(pending.verifier, this.deps.crypto.subtle), code_challenge_method: 'S256',
    })
    this.deps.navigate(`${this.domain}/oauth2/authorize?${query}`)
  }

  /**
   * Completes a login when `url` is the redirect back from the hosted UI. Returns false when `url` carries no code.
   * Rejects (and forgets the pending login) on an error response or a `state` that does not match the one this tab stored.
   */
  async completeLogin(url: URL): Promise<boolean> {
    const code = url.searchParams.get('code'), state = url.searchParams.get('state'), error = url.searchParams.get('error')
    if (!code && !error) return false
    const pending = this.read<Pending>(PENDING)
    this.deps.storage.removeItem(PENDING)
    if (error) throw new AuthError('authorize_failed', url.searchParams.get('error_description') || error)
    if (!pending || !state || state !== pending.state) throw new AuthError('state_mismatch', 'Login state did not match; please sign in again')
    const tokens = await this.token({ grant_type: 'authorization_code', client_id: this.config.clientId, code: code!,
      redirect_uri: this.redirectUri, code_verifier: pending.verifier })
    this.save(tokens)
    return true
  }

  /** A valid ID token (the API bearer), refreshed if it expires within 60 s; undefined when the user must sign in. */
  async idToken(): Promise<string | undefined> {
    const tokens = this.read<Tokens>(TOKENS)
    if (!tokens?.idToken) return undefined
    if (tokens.expiresAt - SKEW_MS > this.deps.now()) return tokens.idToken
    if (!tokens.refreshToken) { this.clear(); return undefined }
    this.refreshing ??= this.refresh(tokens.refreshToken).finally(() => { this.refreshing = undefined })
    return (await this.refreshing)?.idToken
  }

  /** Email claim of the ID token, for display only (panel-api validates the token itself). */
  email(): string | undefined {
    const email = claimsOf(this.read<Tokens>(TOKENS)?.idToken)?.email
    return typeof email === 'string' ? email : undefined
  }

  logout(): void {
    this.clear()
    const query = new URLSearchParams({ client_id: this.config.clientId, logout_uri: this.redirectUri })
    this.deps.navigate(`${this.domain}/logout?${query}`)
  }

  clear(): void { this.deps.storage.removeItem(TOKENS); this.deps.storage.removeItem(PENDING) }

  private async refresh(refreshToken: string): Promise<Tokens | undefined> {
    try {
      // Cognito does not rotate the refresh token, so keep the one we have when the response omits it.
      const tokens = await this.token({ grant_type: 'refresh_token', client_id: this.config.clientId, refresh_token: refreshToken })
      const next = { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken }
      this.save(next)
      return next
    } catch {
      this.clear()
      return undefined
    }
  }
  private async token(form: Record<string, string>): Promise<Tokens> {
    const response = await this.deps.fetch(`${this.domain}/oauth2/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString(),
    })
    const body = await response.json().catch(() => ({})) as { access_token?: string; id_token?: string; refresh_token?: string
      expires_in?: number; error?: string }
    if (!response.ok || !body.id_token) throw new AuthError('token_failed', body.error ?? `Token request failed (${response.status})`)
    const exp = claimsOf(body.id_token)?.exp
    const expiresAt = typeof exp === 'number' ? exp * 1000 : this.deps.now() + (body.expires_in ?? 3600) * 1000
    return { idToken: body.id_token, accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt }
  }
  private save(tokens: Tokens): void { this.deps.storage.setItem(TOKENS, JSON.stringify(tokens)) }
  private read<T>(key: string): T | undefined {
    const raw = this.deps.storage.getItem(key)
    if (!raw) return undefined
    try { return JSON.parse(raw) as T } catch { return undefined }
  }
}
