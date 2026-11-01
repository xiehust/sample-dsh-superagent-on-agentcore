/**
 * v6 onboarding (design onboarding §3 step 5): the repositories of a GitHub App installation a tenant claimed, for the panel's
 * "Add repository" list. Only the host holds the App private key, so panel-tenant asks the host
 * (`GET /tenants/{t}/github/installations/{id}/repositories`) instead of reading the key itself. The host never trusts the
 * caller for ownership: the installation must be claimed by tenant `t` in `dshsa-onboarding` (`ghinst#<id>`), read here.
 */
import { InstallationClaim } from '@dshsa/contracts'
import { appJwt, nextLink, GITHUB_API } from '@dshsa/sources/apis'
import { z } from 'zod'

export interface InstallationRepository { id: number; name: string; owner: string; fullName: string; private: boolean; archived: boolean; defaultBranch: string }
export type RepositoriesResult =
  | { ok: true; repositories: InstallationRepository[]; truncated: boolean }
  | { ok: false; status: 403 | 404 | 502; error: 'not_claimed' | 'installation_not_found' | 'github_error'; message: string }
type Fetch = (url: string, init: { method?: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>

export interface InstallationDeps {
  /** The `dshsa-onboarding` item `ghinst#<id>` (strongly consistent), or undefined. */
  claim(installationId: number): Promise<unknown>
  /** The platform App's id and private key, or undefined while it is not configured. */
  app(): Promise<{ appId: string; privateKey: string } | undefined>
  fetch?: Fetch
  now?: () => number
}
/** At most this many repositories are listed (`truncated` when an installation has more). */
export const MAX_REPOSITORIES = 1000
const PER_PAGE = 100
const RepositoryWire = z.looseObject({ id: z.number().int().positive(), name: z.string().min(1), full_name: z.string().min(1),
  owner: z.looseObject({ login: z.string().min(1) }), private: z.boolean(), archived: z.boolean().optional(), default_branch: z.string().min(1).optional() })
const PageWire = z.looseObject({ repositories: z.array(z.unknown()) })

function headers(token: string): Record<string, string> {
  return { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28', 'user-agent': 'dshsa' }
}
const failed = (status: 403 | 404 | 502, error: 'not_claimed' | 'installation_not_found' | 'github_error', message: string): RepositoriesResult =>
  ({ ok: false, status, error, message })

export async function installationRepositories(deps: InstallationDeps, tenantId: string, installationId: number, signal?: AbortSignal): Promise<RepositoriesResult> {
  const claim = InstallationClaim.safeParse(await deps.claim(installationId))
  // Missing, malformed, another tenant's, or not yet approved (v6.2 `pending`): one answer, so a caller learns nothing about
  // other tenants' installations, and only an explicitly `active` claim lists anything (fail closed).
  if (!claim.success || claim.data.status !== 'active' || claim.data.tenantId !== tenantId || claim.data.installationId !== installationId) {
    return failed(403, 'not_claimed', 'This installation is not linked to this team')
  }
  const app = await deps.app()
  if (!app) return failed(502, 'github_error', 'The GitHub App is not configured')
  const fetcher = deps.fetch ?? (fetch as unknown as Fetch)
  // A token for the whole installation that can only read metadata (no repository_ids: GitHub lists every repository).
  const minted = await fetcher(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, { method: 'POST',
    headers: { ...headers(appJwt(app.appId, app.privateKey, deps.now?.() ?? Date.now())), 'content-type': 'application/json' },
    body: JSON.stringify({ permissions: { metadata: 'read' } }), ...signal ? { signal } : {} })
  if (minted.status === 404) return failed(404, 'installation_not_found', 'GitHub does not know this installation (the App may be uninstalled)')
  if (!minted.ok) return failed(502, 'github_error', `GitHub installation token: HTTP ${minted.status}`)
  const token = z.object({ token: z.string().min(1) }).parse(JSON.parse(await minted.text())).token
  const repositories: InstallationRepository[] = []
  let url: string | undefined = `${GITHUB_API}/installation/repositories?per_page=${PER_PAGE}`
  let truncated = false
  while (url) {
    if (repositories.length >= MAX_REPOSITORIES) { truncated = true; break }
    const response = await fetcher(url, { headers: headers(token), ...signal ? { signal } : {} })
    if (response.status === 404) return failed(404, 'installation_not_found', 'GitHub does not know this installation')
    if (!response.ok) return failed(502, 'github_error', `GitHub repositories: HTTP ${response.status}`)
    const page = PageWire.parse(JSON.parse(await response.text()))
    for (const raw of page.repositories) {
      const repo = RepositoryWire.safeParse(raw)
      if (!repo.success) continue
      if (repositories.length >= MAX_REPOSITORIES) { truncated = true; break }
      repositories.push({ id: repo.data.id, name: repo.data.name, owner: repo.data.owner.login, fullName: repo.data.full_name, private: repo.data.private,
        archived: repo.data.archived ?? false, defaultBranch: repo.data.default_branch ?? 'main' })
    }
    url = nextLink(response.headers.get('link'))
    // The token goes only to this listing.
    if (url && !url.startsWith(`${GITHUB_API}/installation/repositories`)) return failed(502, 'github_error', 'GitHub pagination left the installation listing')
  }
  return { ok: true, repositories, truncated }
}
