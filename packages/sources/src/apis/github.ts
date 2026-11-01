/**
 * GitHub App authentication (RS256 app JWT → installation access token) and the repo-scoped REST client that replaces DSH's
 * `gh api` calls. Paths are relative to `repos/<owner>/<name>/` and may not escape it, as DSH's `Commands.path` enforced.
 */
import { createSign } from 'node:crypto'
import { z } from 'zod'
import { ApiError, type ApiInit, type GithubApi } from '@dshsa/core/host'
import { validItems, type Tally } from '../poll.ts'

export const GITHUB_API = 'https://api.github.com'
const VERSION = '2022-11-28'
export type Fetch = typeof fetch

/** The JSON stored in Secrets Manager `dshsa/github-app` (parent design §5, dd `SharedSecrets.githubApp`). */
export const GithubAppSecret = z.object({
  appId: z.union([z.string().min(1), z.number()]).transform(String),
  slug: z.string().min(1),
  privateKey: z.string().includes('PRIVATE KEY'),
  webhookSecret: z.string().min(20),
}).loose()
export type GithubAppSecret = z.infer<typeof GithubAppSecret>

const base64url = (value: string | Buffer): string => Buffer.from(value).toString('base64url')
/** An app JWT valid for 9 minutes, backdated 60 s for clock drift, as GitHub recommends. */
export function appJwt(appId: string, privateKey: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60
  const head = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const body = base64url(JSON.stringify({ iat, exp: iat + 600, iss: appId }))
  const signature = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey)
  return `${head}.${body}.${base64url(signature)}`
}

/** Permissions of the cell's own token: it comments, binds PRs and reads CI; it never pushes code (workers get their own). */
export const CELL_PERMISSIONS = { issues: 'write', pull_requests: 'write', contents: 'read', checks: 'read', statuses: 'read',
  actions: 'read', metadata: 'read' } as const
const TokenSchema = z.object({ token: z.string(), expires_at: z.string() })
export interface InstallationToken { token: string; expiresAt: string }

/** Mints installation tokens for one GitHub App and caches them until five minutes before they expire. */
export class GithubApp {
  private readonly cache = new Map<string, Promise<InstallationToken>>()
  constructor(private readonly secret: Pick<GithubAppSecret, 'appId' | 'privateKey'>, private readonly fetcher: Fetch = fetch,
    private readonly now: () => number = Date.now) {}
  /** A token for `installationId`, restricted to `repositoryIds` and `permissions` (both part of the cache key). */
  token(installationId: number, repositoryIds: number[], permissions: Record<string, string> = CELL_PERMISSIONS): Promise<InstallationToken> {
    const cacheKey = JSON.stringify([installationId, [...repositoryIds].sort(), permissions])
    const cached = this.cache.get(cacheKey)
    if (cached) {
      return cached.then(token => Date.parse(token.expiresAt) - this.now() > 5 * 60_000 ? token
        : (this.cache.delete(cacheKey), this.token(installationId, repositoryIds, permissions)))
    }
    const minted = this.mint(installationId, repositoryIds, permissions)
    this.cache.set(cacheKey, minted)
    minted.catch(() => { this.cache.delete(cacheKey) })
    return minted
  }
  private async mint(installationId: number, repositoryIds: number[], permissions: Record<string, string>): Promise<InstallationToken> {
    const response = await this.fetcher(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
      method: 'POST', headers: { ...headers(appJwt(this.secret.appId, this.secret.privateKey, this.now())), 'content-type': 'application/json' },
      body: JSON.stringify({ repository_ids: repositoryIds, permissions }),
    })
    const text = await response.text()
    if (!response.ok) throw new ApiError(`GitHub installation token: ${message(text, response.status)}`, response.status)
    const parsed = TokenSchema.parse(JSON.parse(text))
    return { token: parsed.token, expiresAt: parsed.expires_at }
  }
}
const headers = (token: string): Record<string, string> =>
  ({ accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': VERSION, 'user-agent': 'dshsa' })
function message(text: string, status: number): string {
  try { const value = JSON.parse(text) as { message?: unknown }; if (typeof value.message === 'string') return `${value.message} (HTTP ${status})` }
  catch { /* not JSON */ }
  return `HTTP ${status}`
}
/** Next page URL from a `Link` header, when GitHub has one. */
export const nextLink = (link: string | null | undefined): string | undefined => /<([^>]+)>;\s*rel="next"/.exec(link ?? '')?.[1]

/** `GithubApi` acting as an installation, restricted to one repository. */
export class GithubClient implements GithubApi {
  constructor(private readonly repository: string, private readonly token: () => Promise<string>, private readonly fetcher: Fetch = fetch) {}
  private url(path: string): string {
    const outside = /^\/|^[a-z]+:|(^|\/)\.\.?(\/|\?|$)/i.test(path)
    if (outside) throw new Error('GitHub calls are restricted to the configured repository')
    return `${GITHUB_API}/repos/${this.repository}${path ? `/${path}` : ''}`
  }
  private async send(url: string, init: ApiInit = {}): Promise<Response> {
    const body = init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body)
    return this.fetcher(url, { method: init.method ?? 'GET', headers: { ...headers(await this.token()),
      ...body !== undefined ? { 'content-type': 'application/json' } : {}, ...init.headers }, ...body !== undefined ? { body } : {} })
  }
  async raw(path: string, init?: ApiInit): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const response = await this.send(this.url(path), init)
    const body = await response.text()
    if (!response.ok && response.status !== 304) throw new ApiError(message(body, response.status), response.status)
    return { status: response.status, headers: Object.fromEntries(response.headers), body }
  }
  async request<T>(schema: z.ZodType<T>, path: string, init?: ApiInit): Promise<T> {
    const { body } = await this.raw(path, init)
    return schema.parse(body ? JSON.parse(body) : undefined)
  }
  async pages<T>(schema: z.ZodType<T>, path: string, tally?: Tally): Promise<T[]> {
    const items: unknown[] = []
    let url: string | undefined = this.url(path)
    for (let page = 0; url && page < 100; page++) {
      const response = await this.send(url)
      const text = await response.text()
      if (!response.ok) throw new ApiError(message(text, response.status), response.status)
      const value = JSON.parse(text) as unknown
      items.push(...Array.isArray(value) ? value : [])
      url = nextLink(response.headers.get('link'))
      // Pagination may not leave the repository.
      if (url && !url.startsWith(`${GITHUB_API}/repos/${this.repository}/`)) throw new Error('GitHub pagination left the repository')
    }
    return validItems(schema, items, tally)
  }
}
