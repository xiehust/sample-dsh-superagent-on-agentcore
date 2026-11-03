/**
 * Panel context and small shared widgets.
 * `useAction` and `ConfirmButton` are adapted from dsh-superagent `src/client/provider.tsx` and `src/client/widgets.tsx`
 * (MIT, DeepSeek Harness superagent prototype).
 */
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ApiError, errorText, type Client } from './api.ts'
import { applyTheme, storedTheme, THEME_LABELS, THEMES, type Theme } from './theme.ts'
import type { CellView, MeView, PanelRole } from './types.ts'

export const TABS = ['overview', 'execution', 'settings', 'setup', 'platform'] as const
export type Tab = typeof TABS[number]
export const SETUP_SECTIONS = ['repositories', 'feishu', 'chats', 'users'] as const
export type SetupSection = typeof SETUP_SECTIONS[number]

/** The shell around every page: the selected tenant and the user's role in it, navigation, and notifications. */
export interface ShellContext {
  client: Client
  me: MeView
  /** The selected tenant; undefined only for a platform admin while no tenant exists. */
  tenantId: string | undefined
  tenantName: string | undefined
  /** The user's role in the selected tenant (from `/v1/me`). The UI hides what the role cannot do; panel-api enforces it. */
  role: PanelRole | undefined
  notify: (text: string) => void
  /** Opens a tab (and a Team setup section). */
  go: (tab: Tab, section?: SetupSection) => void
  /** Reloads `/v1/me` and `/v1/cells`, e.g. after a tenant or a repository was added. */
  refresh: () => Promise<void>
  /** Leaves the SPA for `url` (GitHub OAuth authorize). */
  navigate: (url: string) => void
  selectTenant: (tenantId: string) => void
}
const Shell = createContext<ShellContext | undefined>(undefined)
export const ShellProvider = Shell.Provider
export function useShell(): ShellContext {
  const value = useContext(Shell)
  if (!value) throw new Error('Panel page rendered outside the shell')
  return value
}

export interface PanelContext {
  client: Client
  cell: CellView
  /** Cells of the selected cell's tenant (chat bindings may point at any of them). */
  tenantCells: CellView[]
  notify: (text: string) => void
  openTicket: (ticketId: string) => void
  /** The user's role in the cell's tenant; `canEdit` = tenant admin or platform admin (members read and Stop/Retry only). */
  role: PanelRole
  canEdit: boolean
}
const Panel = createContext<PanelContext | undefined>(undefined)
export const PanelProvider = Panel.Provider
export function usePanel(): PanelContext {
  const value = useContext(Panel)
  if (!value) throw new Error('Panel page rendered outside the panel')
  return value
}

/** Wraps an async action with re-entrancy protection (a double click runs it once), a busy flag, and error reporting. */
export function useAction<A extends unknown[]>(action: (...args: A) => Promise<unknown>, { onError }: { onError?: (error: unknown) => void } = {}) {
  const shell = useContext(Shell), panel = useContext(Panel)
  const notify = shell?.notify ?? panel?.notify
  if (!notify) throw new Error('Panel page rendered outside the shell')
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const run = async (...args: A): Promise<boolean> => {
    if (running.current) return false
    running.current = true
    setBusy(true)
    try { await action(...args); return true }
    catch (failure) { if (onError) onError(failure); else notify(errorText(failure)); return false }
    finally { running.current = false; setBusy(false) }
  }
  return { run, busy }
}

export function ErrorState({ error }: { error: unknown }) {
  const kind = error instanceof ApiError ? error.kind : 'server'
  const title = kind === 'offline' ? 'Cell offline' : kind === 'forbidden' ? 'No access' : kind === 'unauthorized' ? 'Signed out'
    : kind === 'missing' ? 'Not found' : 'Something went wrong'
  return <div className={`notice notice-${kind}`} role="alert" data-kind={kind}>
    <strong>{title}</strong>
    <span>{errorText(error)}</span>
  </div>
}
export function LoadState({ error, loading }: { error?: unknown; loading: boolean }) {
  if (error) return <ErrorState error={error} />
  return loading ? <p className="hint" aria-busy="true">Loading…</p> : null
}

export function Section({ title, count, actions, children }: { title: string; count?: number; actions?: ReactNode; children: ReactNode }) {
  return <section className="section">
    <header className="section-head">
      <h2>{title}{count !== undefined && <span className="count">{count}</span>}</h2>
      {actions && <div className="section-actions">{actions}</div>}
    </header>
    {children}
  </section>
}

export function Modal({ title, message, onCancel, onConfirm, busy, confirmLabel = 'Confirm' }: {
  title: string; message: string; onCancel: () => void; onConfirm: () => void; busy: boolean; confirmLabel?: string
}) {
  const id = useId()
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => { cancel.current?.focus() }, [])
  return <div className="backdrop" onKeyDown={event => { if (event.key === 'Escape') onCancel() }}>
    <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-message`}>
      <h3 id={`${id}-title`}>{title}</h3>
      <p id={`${id}-message`}>{message}</p>
      <div className="dialog-actions">
        <button type="button" ref={cancel} onClick={onCancel}>Cancel</button>
        <button type="button" className="primary" disabled={busy} onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </div>
  </div>
}

/** A button that asks for confirmation; the confirmed action runs once however often Confirm is clicked while it runs. */
export function ConfirmButton({ label, title, message, onConfirm, danger }: {
  label: string; title: string; message: string; onConfirm: () => Promise<unknown>; danger?: boolean
}) {
  const [open, setOpen] = useState(false)
  const confirm = useAction(onConfirm)
  return <>
    <button type="button" className={danger ? 'danger' : undefined} onClick={() => setOpen(true)}>{label}</button>
    {open && <Modal title={title} message={message} busy={confirm.busy} onCancel={() => setOpen(false)}
      onConfirm={() => { void confirm.run().then(done => { if (done) setOpen(false) }) }} />}
  </>
}

/** Text from the API rendered as plain text (never as HTML), keeping line breaks. */
export const PlainText = ({ text, className }: { text: string | undefined; className?: string }) =>
  text ? <p className={`plain${className ? ` ${className}` : ''}`}>{text}</p> : null

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return <div className="stat"><span className="stat-label">{label}</span><span className="stat-value">{value}</span></div>
}

export function Toast({ text, onDone }: { text: string; onDone: () => void }) {
  const done = useRef(onDone)
  done.current = onDone
  useEffect(() => { const timer = setTimeout(() => done.current(), 5000); return () => clearTimeout(timer) }, [text])
  return <div className="toast" role="status">{text}</div>
}

/** Copies `text` to the clipboard (falls back to selecting nothing when the Clipboard API is unavailable). */
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch { setCopied(false) }
  }
  return <button type="button" aria-label={`${label}: ${text}`} onClick={() => { void copy() }}>{copied ? 'Copied' : label}</button>
}

/** A short read-only note for members, who may read everything but change only tickets (Stop/Retry). */
export const ReadOnlyNote = ({ what = 'these settings' }: { what?: string }) =>
  <p className="notice notice-readonly" role="note">Read-only: only a team admin can change {what}.</p>

/** System, Light or Dark; applied to <html> at once and remembered on this device. */
export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(storedTheme)
  const name = useId()
  const choose = (next: Theme) => { setTheme(next); applyTheme(next) }
  return <div className="theme-switch">
    <span className="theme-label" id={`${name}-label`}>Theme</span>
    <div className="theme-options" role="radiogroup" aria-labelledby={`${name}-label`}>
      {THEMES.map(item => <label key={item}>
        <input type="radio" name={name} value={item} checked={theme === item} onChange={() => choose(item)} />{THEME_LABELS[item]}
      </label>)}
    </div>
  </div>
}

/** The account menu in the top bar: who is signed in, the theme, and Log out. Closes on Escape or a click outside. */
export function AccountMenu({ email, onLogout }: { email: string | undefined; onLogout: () => void }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    const away = (event: MouseEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])
  return <div ref={box} className="account" onKeyDown={event => { if (event.key === 'Escape' && open) { setOpen(false); button.current?.focus() } }}>
    <button ref={button} type="button" className="account-button" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}>
      {email ? <><span className="visually-hidden">Account: </span><span className="email">{email}</span></> : 'Account'}
    </button>
    {open && <div id={id} className="account-menu" role="group" aria-label="Account">
      {email && <span className="account-email">Signed in as {email}</span>}
      <ThemeSwitch />
      <button type="button" onClick={onLogout}>Log out</button>
    </div>}
  </div>
}
