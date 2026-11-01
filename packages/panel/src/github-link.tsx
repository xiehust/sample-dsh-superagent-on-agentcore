/**
 * GitHub setup routes (onboarding design §3). `/setup/github` is the App's Setup URL: its query (`installation_id`, which
 * GitHub documents as spoofable) is ignored. `/setup/github/callback` is the OAuth Redirect URI (formerly Callback URL): `code` + `state` are posted
 * once to panel-tenant, which verifies the installations with the user's GitHub token and binds them to the team.
 */
import { useEffect, useRef, useState } from 'react'
import { errorText } from './api.ts'
import { takeLink, type Route } from './routes.ts'
import { claimReasonText } from './text.ts'
import type { LinkResultView } from './types.ts'
import { Section, useShell } from './widgets.tsx'

const clearUrl = () => { try { window.history.replaceState(null, '', '/') } catch { /* not a browser */ } }

export function GithubInstalled() {
  const { go } = useShell()
  useEffect(clearUrl, [])
  return <Section title="GitHub App installed">
    <p>The GitHub App is installed (or its repository access changed).</p>
    <p className="hint">Next, link the installation to your team: Team setup → Repositories → <strong>Link installations</strong>.
      GitHub asks you to sign in, so the panel can check which installations your GitHub account can access.</p>
    <button type="button" className="primary" onClick={() => go('setup', 'repositories')}>Go to Repositories</button>
  </Section>
}

type Outcome = { kind: 'working' } | { kind: 'done'; tenantId: string; result: LinkResultView } | { kind: 'error'; message: string; tenantId?: string }

export function GithubCallback({ route }: { route: Extract<Route, { kind: 'github-callback' | 'github-callback-error' }> }) {
  const { client, go, selectTenant, me } = useShell()
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'working' })
  const started = useRef(false)
  useEffect(() => {
    // The code is single use: post it once (also under StrictMode) and drop it from the address bar right away.
    if (started.current) return
    started.current = true
    clearUrl()
    if (route.kind === 'github-callback-error') { setOutcome({ kind: 'error', message: route.message }); return }
    const tenantId = takeLink(route.state)
    if (!tenantId) {
      setOutcome({ kind: 'error', message: 'This GitHub sign-in was not started from this tab, or it was already used. Start “Link installations” again.' })
      return
    }
    client.setup.link(tenantId, { code: route.code, state: route.state })
      .then(result => setOutcome({ kind: 'done', tenantId, result }))
      .catch(error => setOutcome({ kind: 'error', message: errorText(error), tenantId }))
  }, [client, route])

  const back = (tenantId: string | undefined) => {
    if (tenantId && me.tenants.some(item => item.tenantId === tenantId)) selectTenant(tenantId)
    go('setup', 'repositories')
  }
  if (outcome.kind === 'working') return <Section title="Linking GitHub installations"><p className="hint" aria-busy="true">Checking with GitHub…</p></Section>
  if (outcome.kind === 'error') {
    return <Section title="Linking GitHub installations">
      <div className="notice notice-server" role="alert"><strong>Could not link installations</strong><span>{outcome.message}</span></div>
      <button type="button" onClick={() => back(outcome.tenantId)}>Back to Repositories</button>
    </Section>
  }
  const { installations } = outcome.result
  return <Section title="Linking GitHub installations" count={installations.length}>
    {installations.length ? <ul className="list">{installations.map(item => <li key={item.installationId} className="row">
      <div className="row-main"><div className="row-title">{item.account}</div></div>
      <div className="row-meta">{item.status === 'active'
        ? <span className="tag" data-state="ok">Linked to your team</span>
        : item.status === 'other_tenant'
          ? <span className="tag" data-state="warn">Belongs to another team. Ask a platform admin if that is wrong.</span>
          // `pending`, and anything unrecognised: never shown as linked.
          : <><span className="tag" data-state="warn">Waiting for platform approval</span>{' '}
            <span className="hint">{claimReasonText(item.pendingReason, item.account)}</span></>}</div>
    </li>)}</ul>
      : <p className="hint">Your GitHub account cannot access any installation of the App. Install the App first (Repositories → Install / configure
        the GitHub App), then link again.</p>}
    {installations.some(item => item.status !== 'active' && item.status !== 'other_tenant') && <p className="hint">
      An installation is linked right away only when your GitHub account owns it, or is an admin of its organization. Others wait until
      a platform admin approves them; their repositories cannot be added before that.</p>}
    <button type="button" className="primary" onClick={() => back(outcome.tenantId)}>Continue to Repositories</button>
  </Section>
}
