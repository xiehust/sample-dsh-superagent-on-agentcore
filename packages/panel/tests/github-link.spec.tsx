import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { githubAuthorizeUrl, githubInstallUrl, isLoginCallback, rememberLink, rememberReturn, routeOf, takeLink, takeReturn } from '../src/routes.ts'
import { api, useFakeApi } from './fake-api.ts'
import { openTab, renderPanel } from './render.tsx'

useFakeApi()
let replace: ReturnType<typeof vi.spyOn>
beforeEach(() => { replace = vi.spyOn(window.history, 'replaceState') })
afterEach(() => { replace.mockRestore() })

const STATE = `s${'A'.repeat(40)}`
const PANEL = 'https://panel.test'

describe('routes', () => {
  it('parses the setup and callback paths', () => {
    expect(routeOf(new URL(`${PANEL}/`))).toEqual({ kind: 'panel' })
    expect(routeOf(new URL(`${PANEL}/setup/github?installation_id=1&setup_action=install`))).toEqual({ kind: 'github-installed' })
    expect(routeOf(new URL(`${PANEL}/setup/github/callback?code=abc&state=${STATE}`))).toEqual({ kind: 'github-callback', code: 'abc', state: STATE })
    expect(routeOf(new URL(`${PANEL}/setup/github/callback?error=access_denied&error_description=Denied`)))
      .toEqual({ kind: 'github-callback-error', message: 'GitHub said: Denied' })
    expect(routeOf(new URL(`${PANEL}/setup/github/callback?code=abc&state=short`)).kind).toBe('github-callback-error')
  })

  it('only `/` is the Cognito login callback', () => {
    expect(isLoginCallback(new URL(`${PANEL}/?code=c&state=s`))).toBe(true)
    expect(isLoginCallback(new URL(`${PANEL}/setup/github/callback?code=c&state=${STATE}`))).toBe(false)
    expect(isLoginCallback(new URL(`${PANEL}/`))).toBe(false)
  })

  it('remembers a setup URL across the login redirect, once, and nothing else', () => {
    rememberReturn(new URL(`${PANEL}/setup/github/callback?code=c&state=${STATE}`))
    expect(takeReturn()).toBe(`/setup/github/callback?code=c&state=${STATE}`)
    expect(takeReturn()).toBeUndefined()
    rememberReturn(new URL(`${PANEL}/elsewhere?x=1`))
    expect(takeReturn()).toBeUndefined()
    sessionStorage.setItem('dshsa.panel.return', 'https://evil.example/setup/github')
    expect(takeReturn()).toBeUndefined()
    // Tampered values: protocol-relative, backslash, dot segments, other paths; a fragment is dropped.
    for (const value of ['//evil.example/setup/github', '/\\evil.example/setup/github', '/setup/github/../../elsewhere',
      '/setup/github/callback/../../../x', '/setup/githubx', 'javascript:alert(1)//setup/github']) {
      sessionStorage.setItem('dshsa.panel.return', value)
      expect(takeReturn(), value).toBeUndefined()
    }
    sessionStorage.setItem('dshsa.panel.return', '/setup/github?installation_id=1#frag')
    expect(takeReturn()).toBe('/setup/github?installation_id=1')
  })

  it('follows only the GitHub OAuth authorize page and offers only a github.com/apps install link', () => {
    const good = `https://github.com/login/oauth/authorize?client_id=Iv23li1&redirect_uri=x&state=${STATE}`
    expect(githubAuthorizeUrl(good)).toEqual({ url: good, state: STATE })
    for (const bad of [`http://github.com/login/oauth/authorize?client_id=I&state=${STATE}`,
      `https://github.com.evil.example/login/oauth/authorize?client_id=I&state=${STATE}`,
      `https://evil@github.com/login/oauth/authorize?client_id=I&state=${STATE}`,
      `https://github.com:8443/login/oauth/authorize?client_id=I&state=${STATE}`,
      `https://github.com/login/oauth/authorize/../../evil?client_id=I&state=${STATE}`,
      `https://github.com/apps/x?client_id=I&state=${STATE}`,
      'https://github.com/login/oauth/authorize?client_id=I&state=short', `https://github.com/login/oauth/authorize?state=${STATE}`,
      `javascript:alert(1)`, '', undefined]) expect(githubAuthorizeUrl(bad), String(bad)).toBeUndefined()
    expect(githubInstallUrl('https://github.com/apps/dshsa-agent/installations/new')).toBe('https://github.com/apps/dshsa-agent/installations/new')
    for (const bad of ['https://evil.example/apps/x/installations/new', 'http://github.com/apps/x', 'https://github.com/login/oauth/authorize',
      'https://github.com/apps/../evil', 'javascript:alert(1)', undefined]) expect(githubInstallUrl(bad), String(bad)).toBeUndefined()
  })

  it('a link state maps to its team once', () => {
    rememberLink(STATE, 'acme')
    expect(takeLink(STATE)).toBe('acme')
    expect(takeLink(STATE)).toBeUndefined()
  })
})

describe('/setup/github/callback', () => {
  it('posts code and state for the remembered team, clears the URL, and shows each installation', async () => {
    api.nonces.set(STATE, 'acme')
    rememberLink(STATE, 'acme')
    const { user } = renderPanel({ route: { kind: 'github-callback', code: 'gh-code', state: STATE } })
    const section = (await screen.findByRole('heading', { name: /^Linking GitHub installations/ })).closest('section')!
    await within(section).findByText('Linked to your team')
    expect(api.find('POST', '/v1/tenants/acme/setup/github/link')).toHaveLength(1)
    expect(api.find('POST', '/v1/tenants/acme/setup/github/link')[0]!.body).toEqual({ code: 'gh-code', state: STATE })
    expect(replace).toHaveBeenCalledWith(null, '', '/')
    expect(sessionStorage.getItem(`dshsa.panel.ghlink.${STATE}`)).toBeNull()
    expect(within(section).getByText('acme-org')).toBeTruthy()
    expect(within(within(section).getByText('other-org').closest('li')!).getByText(/Belongs to another team/)).toBeTruthy()
    expect(screen.queryByRole('tablist')).toBeNull()
    await user.click(within(section).getByRole('button', { name: 'Continue to Repositories' }))
    expect(await screen.findByRole('heading', { name: /^Linked installations/ })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Team setup' }).getAttribute('aria-selected')).toBe('true')
  })

  it('shows linked, waiting for platform approval (with the reason) and another team per installation', async () => {
    api.claims.delete(77)
    api.githubUser = [
      { id: 77, account: 'acme-org', type: 'Organization', admin: 'yes' },
      { id: 88, account: 'other-org', type: 'Organization', admin: 'yes' },
      { id: 99, account: 'big-org', type: 'Organization', admin: 'no' },
      { id: 100, account: 'someone', type: 'User' },
      { id: 101, account: 'quiet-org', type: 'Organization', admin: 'unavailable' },
    ]
    api.nonces.set(STATE, 'acme')
    rememberLink(STATE, 'acme')
    renderPanel({ route: { kind: 'github-callback', code: 'gh-code', state: STATE } })
    const section = (await screen.findByRole('heading', { name: /^Linking GitHub installations/ })).closest('section')!
    await within(section).findByText('Linked to your team')
    const rowOf = (account: string) => within(within(section).getByText(account).closest('li')!)
    expect(rowOf('acme-org').getByText('Linked to your team')).toBeTruthy()
    expect(rowOf('other-org').getByText(/Belongs to another team/)).toBeTruthy()
    expect(rowOf('other-org').queryByText('Waiting for platform approval')).toBeNull()
    for (const [account, reason] of [['big-org', 'you are not an admin of big-org'], ['someone', "installed on another person's account"],
      ['quiet-org', 'GitHub did not confirm your org role (the App may lack Organization → Members: read)']] as const) {
      expect(rowOf(account).getByText('Waiting for platform approval')).toBeTruthy()
      expect(rowOf(account).getByText(reason)).toBeTruthy()
      expect(rowOf(account).queryByText('Linked to your team')).toBeNull()
    }
    expect(within(section).getByText(/Others wait until a platform admin approves them/)).toBeTruthy()
    expect([99, 100, 101].map(id => api.claims.get(id)?.status)).toEqual(['pending', 'pending', 'pending'])
    expect(api.claims.get(88)?.tenantId).toBe('beta')
  })

  it('re-linking without proof keeps an active claim linked', async () => {
    api.githubUser = [{ id: 77, account: 'acme-org', type: 'Organization', admin: 'no' }]
    api.nonces.set(STATE, 'acme')
    rememberLink(STATE, 'acme')
    renderPanel({ route: { kind: 'github-callback', code: 'gh-code', state: STATE } })
    await screen.findByText('Linked to your team')
    expect(screen.queryByText('Waiting for platform approval')).toBeNull()
    expect(api.claims.get(77)?.status).toBe('active')
  })

  it('posts the single-use code once under StrictMode', async () => {
    api.nonces.set(STATE, 'acme')
    rememberLink(STATE, 'acme')
    // Hold the link POST open, so the page is seen while it is in flight (the second StrictMode effect has run by then).
    let release!: () => void, posted = 0
    const held = new Promise<void>(resolve => { release = resolve })
    const real = api.fetch
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/github/link')) { posted += 1; await held }
      return real(input, init)
    }) as typeof fetch)
    renderPanel({ strict: true, route: { kind: 'github-callback', code: 'gh-code', state: STATE } })
    await waitFor(() => expect(posted).toBe(1))
    // Both StrictMode effect runs are done once the POST is out; flush what they rendered.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
    expect(screen.getByText('Checking with GitHub…')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    release()
    await screen.findByText('Linked to your team')
    expect(api.find('POST', '/v1/tenants/acme/setup/github/link')).toHaveLength(1)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('links for the team the state was issued to, not the one selected', async () => {
    api.me.tenants[1]!.role = 'tadmin'
    sessionStorage.setItem('dshsa.panel.tenant', 'acme')
    api.nonces.set(STATE, 'beta')
    rememberLink(STATE, 'beta')
    renderPanel({ route: { kind: 'github-callback', code: 'gh-code', state: STATE } })
    await screen.findByText('Continue to Repositories')
    expect(api.find('POST', '/v1/tenants/beta/setup/github/link')).toHaveLength(1)
    expect(api.find('POST', '/v1/tenants/acme/setup/github/link')).toHaveLength(0)
  })

  it('refuses a state this tab did not start, without calling the API', async () => {
    renderPanel({ route: { kind: 'github-callback', code: 'gh-code', state: STATE } })
    expect(await screen.findByText(/not started from this tab, or it was already used/)).toBeTruthy()
    expect(api.requests.some(request => request.path.endsWith('/github/link'))).toBe(false)
    expect(replace).toHaveBeenCalledWith(null, '', '/')
  })

  it('shows the server refusal of a replayed state', async () => {
    rememberLink(STATE, 'acme') // remembered here, but panel-tenant has no such nonce (used or expired)
    renderPanel({ route: { kind: 'github-callback', code: 'gh-code', state: STATE } })
    expect(await screen.findByText(/This link expired or was already used/)).toBeTruthy()
  })

  it('shows a GitHub error', async () => {
    renderPanel({ route: { kind: 'github-callback-error', message: 'The user has denied your application access.' } })
    expect(await screen.findByText('The user has denied your application access.')).toBeTruthy()
    expect(api.requests.some(request => request.path.includes('/setup/github/link'))).toBe(false)
  })

  it('round trip: Link installations, GitHub redirects back, the installation is linked', async () => {
    openTab('setup', 'repositories')
    api.claims.delete(77)
    const first = renderPanel()
    await first.user.click(await screen.findByRole('button', { name: 'Link installations' }))
    await waitFor(() => expect(first.navigate).toHaveBeenCalled())
    const state = new URL(first.navigate.mock.calls[0]![0]).searchParams.get('state')!
    cleanup()
    // GitHub sends the browser to the Callback URL in the same tab.
    renderPanel({ route: routeOf(new URL(`${PANEL}/setup/github/callback?code=fresh&state=${state}`)) })
    await screen.findByText('Linked to your team')
    expect(api.claims.get(77)?.tenantId).toBe('acme')
  })
})

describe('/setup/github', () => {
  it('ignores the query, says what to do next, and returns to Repositories', async () => {
    const { user } = renderPanel({ route: { kind: 'github-installed' } })
    expect(await screen.findByText(/The GitHub App is installed/)).toBeTruthy()
    expect(replace).toHaveBeenCalledWith(null, '', '/')
    expect(api.requests.some(request => request.path.includes('/setup/github'))).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Go to Repositories' }))
    expect(await screen.findByRole('heading', { name: /^Linked installations/ })).toBeTruthy()
  })
})
