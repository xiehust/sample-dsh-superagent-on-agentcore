/**
 * GitHub App user authorization for the panel's install flow (11-01-sa-panel-onboarding design §3): exchange the OAuth `code`
 * for a user access token, then list the installations of *our* App that this user can access (`GET /user/installations`).
 * The `installation_id` GitHub puts on the Setup URL can be spoofed; this listing is the check that the user really has access.
 *
 * The user token is used once in memory and never stored or logged: it is wrapped in `GithubUserToken`, whose string, JSON and
 * inspect forms are redacted, and no error message here includes it. `revokeUserToken` ends it right after use.
 */
import { inspect } from 'node:util'
import { z } from 'zod'
import { GITHUB_API, nextLink, type Fetch } from './github.ts'

export const GITHUB_WEB = 'https://github.com'
const VERSION = '2022-11-28'
const TIMEOUT_MS = 10_000
const REDACTED = '[redacted GitHub user token]'

/** A GitHub user access token that does not print: `String()`, `JSON.stringify` and `console.log` show only a placeholder. */
export class GithubUserToken {
  readonly #value: string
  /** When GitHub issued an expiring token (`expires_in`); undefined for a non-expiring one. */
  readonly expiresAt: string | undefined
  constructor(value: string, expiresAt?: string) { this.#value = value; this.expiresAt = expiresAt }
  /** The raw token, for an `Authorization` header only. */
  reveal(): string { return this.#value }
  toString(): string { return REDACTED }
  toJSON(): string { return REDACTED }
  [inspect.custom](): string { return REDACTED }
}

/**
 * A failed exchange or listing. `code` is GitHub's OAuth error (`bad_verification_code` for an expired, used or wrong code;
 * `redirect_uri_mismatch`; `incorrect_client_credentials`) or `http_<status>` / `bad_response` / `timeout`.
 */
export class GithubOAuthError extends Error {
  constructor(message: string, readonly code: string, readonly status?: number) { super(message) }
  /** The code was expired, already used or never valid: the user should start the "Link installations" step again. */
  get expiredCode(): boolean { return this.code === 'bad_verification_code' }
}

const TokenGranted = z.looseObject({ access_token: z.string().min(1), token_type: z.string().nullish(), expires_in: z.number().nullish() })
const TokenRefused = z.looseObject({ error: z.string().min(1), error_description: z.string().nullish() })
const InstallationsPage = z.looseObject({
  installations: z.array(z.looseObject({
    id: z.number().int().positive(),
    app_id: z.number().int().nullish(),
    account: z.looseObject({ login: z.string().min(1), type: z.string().nullish() }).nullish(),
  })).nullish().transform(value => value ?? []),
})
export interface UserInstallation { id: number; account: { login: string; type: string } }

async function call(fetcher: Fetch, url: string, init: RequestInit, what: string): Promise<Response> {
  try { return await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) }) }
  catch (error) {
    const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    throw new GithubOAuthError(`${what}: ${timeout ? 'timed out' : 'request failed'}`, timeout ? 'timeout' : 'network')
  }
}
async function json(response: Response, what: string): Promise<unknown> {
  try { return JSON.parse(await response.text()) as unknown }
  catch { throw new GithubOAuthError(`${what}: HTTP ${response.status}, not JSON`, 'bad_response', response.status) }
}

export interface OAuthExchange { clientId: string; clientSecret: string; code: string; redirectUri: string }
/** Exchanges the `code` from the OAuth callback for a user access token (`POST github.com/login/oauth/access_token`). */
export async function oauthExchange(input: OAuthExchange, fetcher: Fetch = fetch, now = Date.now): Promise<GithubUserToken> {
  for (const [name, value] of Object.entries(input)) {
    if (typeof value !== 'string' || !value) throw new GithubOAuthError(`GitHub OAuth: ${name} is required`, 'bad_request')
  }
  const what = 'GitHub OAuth code exchange'
  const response = await call(fetcher, `${GITHUB_WEB}/login/oauth/access_token`, {
    method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: input.clientId, client_secret: input.clientSecret, code: input.code, redirect_uri: input.redirectUri }),
  }, what)
  const body = await json(response, what)
  if (!response.ok) throw new GithubOAuthError(`${what}: HTTP ${response.status}`, `http_${response.status}`, response.status)
  // GitHub answers an OAuth error with 200 and an `error` field.
  const refused = TokenRefused.safeParse(body)
  if (refused.success) {
    const description = refused.data.error_description ? `: ${refused.data.error_description.slice(0, 200)}` : ''
    throw new GithubOAuthError(`${what} refused (${refused.data.error})${description}`, refused.data.error, response.status)
  }
  const granted = TokenGranted.safeParse(body)
  if (!granted.success) throw new GithubOAuthError(`${what}: unexpected response`, 'bad_response', response.status)
  const { access_token: token, expires_in: expiresIn } = granted.data
  return new GithubUserToken(token, expiresIn ? new Date(now() + expiresIn * 1000).toISOString() : undefined)
}

/**
 * The installations of App `appId` that the token's user can access (`GET /user/installations`, every page), as
 * `[{id, account: {login, type}}]`. Installations of other Apps the user authorized are dropped.
 */
export async function userInstallations(token: GithubUserToken, appId: string | number, fetcher: Fetch = fetch): Promise<UserInstallation[]> {
  const app = Number(appId)
  if (!Number.isInteger(app) || app <= 0) throw new GithubOAuthError('GitHub installations: a numeric App id is required', 'bad_request')
  const what = 'GitHub user installations'
  const found = new Map<number, UserInstallation>()
  let url: string | undefined = `${GITHUB_API}/user/installations?per_page=100`
  for (let pages = 0; url; pages++) {
    if (pages >= 50) throw new GithubOAuthError(`${what}: too many pages`, 'bad_response')
    if (!url.startsWith(`${GITHUB_API}/user/installations?`)) throw new GithubOAuthError(`${what}: pagination left /user/installations`, 'bad_response')
    const response = await call(fetcher, url, { headers: { accept: 'application/vnd.github+json', 'x-github-api-version': VERSION,
      authorization: `Bearer ${token.reveal()}` } }, what)
    if (!response.ok) {
      const code = response.status === 401 ? 'bad_credentials' : `http_${response.status}`
      throw new GithubOAuthError(`${what}: HTTP ${response.status}`, code, response.status)
    }
    const page = InstallationsPage.safeParse(await json(response, what))
    if (!page.success) throw new GithubOAuthError(`${what}: unexpected response`, 'bad_response', response.status)
    for (const installation of page.data.installations) {
      if (installation.app_id !== app || !installation.account) continue
      found.set(installation.id, { id: installation.id, account: { login: installation.account.login, type: installation.account.type ?? 'User' } })
    }
    url = nextLink(response.headers.get('link'))
  }
  return [...found.values()]
}

/** GET a `/user…` endpoint with the user token; `undefined` for a status in `absent`. */
async function userGet(token: GithubUserToken, path: string, what: string, fetcher: Fetch, absent: number[] = []): Promise<unknown> {
  const response = await call(fetcher, `${GITHUB_API}${path}`, { headers: { accept: 'application/vnd.github+json', 'x-github-api-version': VERSION,
    authorization: `Bearer ${token.reveal()}` } }, what)
  if (absent.includes(response.status)) return undefined
  if (!response.ok) {
    const code = response.status === 401 ? 'bad_credentials' : `http_${response.status}`
    throw new GithubOAuthError(`${what}: HTTP ${response.status}`, code, response.status)
  }
  return json(response, what)
}

const UserSchema = z.looseObject({ login: z.string().min(1), id: z.number().int().positive() })
/** The GitHub account the user token belongs to (`GET /user`). Compare logins case-insensitively: GitHub logins are. */
export async function githubUserLogin(token: GithubUserToken, fetcher: Fetch = fetch): Promise<{ login: string; id: number }> {
  const what = 'GitHub user'
  const user = UserSchema.safeParse(await userGet(token, '/user', what, fetcher))
  if (!user.success) throw new GithubOAuthError(`${what}: unexpected response`, 'bad_response')
  return { login: user.data.login, id: user.data.id }
}

/** A GitHub organization login: 1–39 letters, digits or single hyphens, not starting with a hyphen. */
const OrgLogin = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/
const MembershipSchema = z.looseObject({
  state: z.string().nullish(), role: z.string().nullish(),
  organization: z.looseObject({ login: z.string().nullish() }).nullish(),
})
export interface OrgMembership { state: 'active' | 'pending'; role: 'admin' | 'member' }
/**
 * The token user's membership of `org` (`GET /user/memberships/orgs/{org}`), or `undefined` when GitHub answers 404 or 403:
 * not a member, or the App lacks Organization permissions → Members: read. Fails closed on anything unexpected: only
 * `state: "active"` is active and only `role: "admin"` is admin (`billing_manager` and unknown roles read as `member`), and
 * an answer about a different organization is refused.
 */
export async function orgMembership(token: GithubUserToken, org: string, fetcher: Fetch = fetch): Promise<OrgMembership | undefined> {
  if (!OrgLogin.test(org)) throw new GithubOAuthError('GitHub org membership: not an organization login', 'bad_request')
  const what = 'GitHub org membership'
  const body = await userGet(token, `/user/memberships/orgs/${encodeURIComponent(org)}`, what, fetcher, [403, 404])
  if (body === undefined) return undefined
  const membership = MembershipSchema.safeParse(body)
  if (!membership.success) throw new GithubOAuthError(`${what}: unexpected response`, 'bad_response')
  const about = membership.data.organization?.login
  if (about && about.toLowerCase() !== org.toLowerCase()) throw new GithubOAuthError(`${what}: answered for another organization`, 'bad_response')
  return { state: membership.data.state === 'active' ? 'active' : 'pending', role: membership.data.role === 'admin' ? 'admin' : 'member' }
}

/** Revokes a user token once it has served its purpose (`DELETE /applications/{client_id}/token`); best effort, never throws. */
export async function revokeUserToken(token: GithubUserToken, client: { clientId: string; clientSecret: string }, fetcher: Fetch = fetch): Promise<boolean> {
  try {
    const response = await fetcher(`${GITHUB_API}/applications/${encodeURIComponent(client.clientId)}/token`, {
      method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': VERSION, 'content-type': 'application/json',
        authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64')}` },
      body: JSON.stringify({ access_token: token.reveal() }),
    })
    return response.status === 204
  } catch { return false }
}
