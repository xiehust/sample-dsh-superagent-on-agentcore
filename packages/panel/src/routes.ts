/**
 * SPA routes outside the tabbed panel (onboarding design §3): the GitHub App Setup URL `/setup/github` and the OAuth
 * Redirect URI (formerly Callback URL) `/setup/github/callback`. CloudFront serves index.html for any path; the Cognito redirect URI is `/`, so a
 * setup URL reached while signed out is remembered across the login round trip (sessionStorage, this tab only).
 */

export type Route =
  | { kind: 'panel' }
  | { kind: 'github-installed' }
  | { kind: 'github-callback'; code: string; state: string }
  | { kind: 'github-callback-error'; message: string }

export const SETUP_PATH = '/setup/github'
export const CALLBACK_PATH = '/setup/github/callback'
const RETURN_KEY = 'dshsa.panel.return'
const LINK_PREFIX = 'dshsa.panel.ghlink.'
/** The OAuth `state` nonce panel-tenant issues (base64url, 32–128 chars). */
const STATE = /^[A-Za-z0-9_-]{32,128}$/

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const store = (): Store | undefined => { try { return sessionStorage } catch { return undefined } }
const path = (url: URL) => url.pathname.replace(/\/+$/, '') || '/'

export function routeOf(url: URL): Route {
  const at = path(url)
  if (at === SETUP_PATH) return { kind: 'github-installed' }
  if (at === CALLBACK_PATH) {
    const code = url.searchParams.get('code'), state = url.searchParams.get('state'), error = url.searchParams.get('error')
    // GitHub's own error text is shown as plain text under a fixed prefix, and capped (the query is attacker-reachable).
    if (error) return { kind: 'github-callback-error', message: `GitHub said: ${(url.searchParams.get('error_description') || error).slice(0, 200)}` }
    if (!code || !state || !STATE.test(state) || code.length > 200) {
      return { kind: 'github-callback-error', message: 'GitHub did not return a usable sign-in. Start “Link installations” again.' }
    }
    return { kind: 'github-callback', code, state }
  }
  return { kind: 'panel' }
}

/** Whether `url` is the Cognito redirect back to `/` (only that path may carry the Cognito `code`/`state`). */
export const isLoginCallback = (url: URL) => path(url) === '/' && (url.searchParams.has('code') || url.searchParams.has('error'))

/** Before a login redirect: remember a setup URL (path + query) so it is restored after Cognito returns to `/`. */
export function rememberReturn(url: URL, storage: Store | undefined = store()): void {
  const at = path(url)
  if (at !== SETUP_PATH && at !== CALLBACK_PATH) return
  try { storage?.setItem(RETURN_KEY, `${at}${url.search}`) } catch { /* storage unavailable */ }
}
const LOCAL = 'https://panel.invalid'
/**
 * The remembered setup URL, once (it is removed). Only a same-origin relative URL whose path is exactly one of the two setup
 * paths is ever returned, rebuilt from its parsed path and query (no fragment), so a tampered value cannot redirect elsewhere.
 */
export function takeReturn(storage: Store | undefined = store()): string | undefined {
  try {
    const value = storage?.getItem(RETURN_KEY) ?? undefined
    storage?.removeItem(RETURN_KEY)
    if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return undefined
    const url = new URL(value, LOCAL)
    if (url.origin !== LOCAL || (url.pathname !== SETUP_PATH && url.pathname !== CALLBACK_PATH)) return undefined
    return `${url.pathname}${url.search}`
  } catch { return undefined }
}

/**
 * The GitHub OAuth authorize URL panel-tenant returned at link-start, if it is exactly
 * `https://github.com/login/oauth/authorize?…` with a `client_id` and a well-formed `state`; anything else is refused, so the
 * panel never follows the API to another page.
 */
export function githubAuthorizeUrl(value: string | undefined): { url: string; state: string } | undefined {
  try {
    const url = new URL(value ?? '')
    const state = url.searchParams.get('state') ?? ''
    if (url.protocol !== 'https:' || url.host !== 'github.com' || url.username || url.password || url.pathname !== '/login/oauth/authorize'
      || !url.searchParams.get('client_id') || !STATE.test(state)) return undefined
    return { url: url.href, state }
  } catch { return undefined }
}
/** The App install link from `GET setup`, if it is `https://github.com/apps/<slug>[/installations/new]`; otherwise undefined. */
export function githubInstallUrl(value: string | undefined): string | undefined {
  try {
    const url = new URL(value ?? '')
    if (url.protocol !== 'https:' || url.host !== 'github.com' || url.username || url.password
      || !/^\/apps\/[A-Za-z0-9][A-Za-z0-9-]{0,99}(\/installations\/new)?\/?$/.test(url.pathname)) return undefined
    return url.href
  } catch { return undefined }
}

/** At link-start: remember which tenant the OAuth `state` was issued for (GitHub returns to this tab). */
export function rememberLink(state: string, tenantId: string, storage: Store | undefined = store()): void {
  try { storage?.setItem(`${LINK_PREFIX}${state}`, tenantId) } catch { /* storage unavailable */ }
}
/** At the callback: the tenant for `state`, once (single use, like the nonce itself). */
export function takeLink(state: string, storage: Store | undefined = store()): string | undefined {
  try {
    const value = storage?.getItem(`${LINK_PREFIX}${state}`) ?? undefined
    storage?.removeItem(`${LINK_PREFIX}${state}`)
    return value || undefined
  } catch { return undefined }
}
