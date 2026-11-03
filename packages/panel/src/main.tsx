/** Entry: load `/config.json`, complete or start the Cognito login, then render the panel. */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createClient } from './api.ts'
import { App } from './app.tsx'
import { Auth } from './auth.ts'
import { loadConfig } from './config.ts'
import { isLoginCallback, rememberReturn, routeOf, takeReturn } from './routes.ts'
import { applyTheme, storedTheme } from './theme.ts'
// Self-hosted fonts (CSP `font-src 'self'`): Vite emits the woff2 files as same-origin assets.
import '@fontsource-variable/atkinson-hyperlegible-next'
import '@fontsource/atkinson-hyperlegible-mono/latin-400.css'
import './styles.css'

applyTheme(storedTheme(), false)

const root = createRoot(document.getElementById('root')!)

function Fatal({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <main className="app"><div className="notice" role="alert"><strong>The panel could not start</strong><span>{message}</span></div>
    {onRetry && <button type="button" onClick={onRetry}>Sign in again</button>}</main>
}

async function start() {
  let auth: Auth | undefined
  try {
    const config = await loadConfig()
    auth = new Auth(config)
    const url = new URL(window.location.href)
    // Only `/` is the Cognito redirect URI: `/setup/github/callback` carries GitHub's `code`/`state`, which are not ours to use.
    if (isLoginCallback(url)) {
      try { await auth.completeLogin(url) } finally {
        // Drop `code` and `state` from the address bar whether the exchange succeeded or not, and go back to a setup URL
        // that was open when the login started.
        window.history.replaceState(null, '', takeReturn() ?? '/')
      }
    }
    if (!await auth.idToken()) { rememberReturn(url); await auth.login(); return }
    const route = routeOf(new URL(window.location.href))
    const session = auth
    let redirecting = false
    // The ID token is the bearer: panel-api reads `email` and `cognito:groups` from it.
    const client = createClient({ apiUrl: config.apiUrl, token: () => session.idToken(),
      onUnauthorized: () => {
        if (redirecting) return
        redirecting = true; session.clear(); rememberReturn(new URL(window.location.href)); void session.login()
      } })
    root.render(<StrictMode><App client={client} email={session.email()} route={route} onLogout={() => session.logout()} /></StrictMode>)
  } catch (error) {
    const session = auth
    root.render(<Fatal message={error instanceof Error ? error.message : String(error)}
      {...session ? { onRetry: () => { session.clear(); void session.login() } } : {}} />)
  }
}
void start()
