/** Renders the panel against the fake API with a client that sends the fake's ID token. */
import { render } from '@testing-library/react'
import { StrictMode } from 'react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { createClient } from '../src/api.ts'
import { App } from '../src/app.tsx'
import type { Route } from '../src/routes.ts'
import { API, ID_TOKEN } from './fake-api.ts'

/** `strict` renders inside React StrictMode, as `main.tsx` does (effects run twice on mount). */
export function renderPanel({ signedOut = false, route, strict = false }: { signedOut?: boolean; route?: Route; strict?: boolean } = {}) {
  const onUnauthorized = vi.fn()
  const onLogout = vi.fn()
  /** Leaving the SPA (GitHub OAuth authorize) is recorded instead of performed. */
  const navigate = vi.fn<(url: string) => void>()
  const client = createClient({ apiUrl: API, token: async () => signedOut ? undefined : ID_TOKEN, onUnauthorized })
  const user = userEvent.setup()
  const app = <App client={client} email="op@example.com" onLogout={onLogout} navigate={navigate} {...route ? { route } : {}} />
  const view = render(strict ? <StrictMode>{app}</StrictMode> : app)
  return { ...view, user, onUnauthorized, onLogout, navigate, client }
}

/** Opens a tab (and a Team setup section) the way a returning user would land on it. */
export function openTab(tab: string, section?: string) {
  sessionStorage.setItem('dshsa.panel.tab', tab)
  if (section) sessionStorage.setItem('dshsa.panel.setup', section)
}
