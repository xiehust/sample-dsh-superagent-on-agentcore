/**
 * Panel shell: header with team and cell pickers and the user, role-gated tabs, per-cell pages, Team setup, Platform, and the
 * GitHub setup routes (`/setup/github`, `/setup/github/callback`).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Client } from './api.ts'
import { ExecutionPage } from './execution.tsx'
import { GithubCallback, GithubInstalled } from './github-link.tsx'
import { OverviewPage } from './overview.tsx'
import { PlatformPage } from './platform.tsx'
import type { Route } from './routes.ts'
import { SettingsPage } from './settings.tsx'
import { SetupPage } from './setup.tsx'
import { atLeast, ROLE_LABELS, type CellView, type MeView, type PanelRole } from './types.ts'
import { AccountMenu, ErrorState, PanelProvider, SETUP_SECTIONS, ShellProvider, TABS, Toast, type SetupSection, type ShellContext, type Tab }
  from './widgets.tsx'

export { TABS, type Tab }
const TAB_LABELS: Record<Tab, string> = { overview: 'Overview', execution: 'Execution', settings: 'Settings', setup: 'Team setup',
  platform: 'Platform' }
/** Which scope a tab belongs to; the rail groups tabs under these captions. */
const TAB_SCOPES: Record<Tab, string> = { overview: 'This repository', execution: 'This repository', settings: 'This repository',
  setup: 'This team', platform: 'Platform' }
const CELL_KEY = 'dshsa.panel.cell'
const TAB_KEY = 'dshsa.panel.tab'
const TENANT_KEY = 'dshsa.panel.tenant'
const SECTION_KEY = 'dshsa.panel.setup'

const remembered = (key: string) => { try { return sessionStorage.getItem(key) ?? undefined } catch { return undefined } }
const remember = (key: string, value: string) => { try { sessionStorage.setItem(key, value) } catch { /* storage unavailable */ } }
export const cellLabel = (cell: CellView) => cell.repo?.owner && cell.repo.name ? `${cell.repo.owner}/${cell.repo.name}` : cell.cellId

function CellPicker({ cells, me, value, onChange }: { cells: CellView[]; me: MeView | undefined; value: string; onChange: (id: string) => void }) {
  const tenants = [...new Set(cells.map(cell => cell.tenantId))]
  const tenantName = (id: string) => me?.tenants.find(tenant => tenant.tenantId === id)?.name
    ?? cells.find(cell => cell.tenantId === id)?.tenantName ?? id
  return <label className="picker">
    <span>Cell</span>
    <select aria-label="Cell" value={value} onChange={event => onChange(event.target.value)}>
      {!cells.some(cell => cell.cellId === value) && <option value="">No repository</option>}
      {tenants.map(tenant => <optgroup key={tenant} label={tenantName(tenant)}>
        {cells.filter(cell => cell.tenantId === tenant).map(cell => <option key={cell.cellId} value={cell.cellId}>{cellLabel(cell)}</option>)}
      </optgroup>)}
    </select>
  </label>
}

function TabButton({ item, caption, selected, onClick }: { item: Tab; caption: boolean; selected: boolean; onClick: () => void }) {
  return <>
    {caption && <span className="rail-group" aria-hidden="true">{TAB_SCOPES[item]}</span>}
    <button type="button" role="tab" aria-selected={selected} onClick={onClick}>{TAB_LABELS[item]}</button>
  </>
}

/** Tabs the role may open: cell pages for any role, Team setup for tenant admins, Platform for platform admins. */
export function visibleTabs(role: PanelRole | undefined, platformAdmin: boolean, hasTenant: boolean): Tab[] {
  return TABS.filter(tab => tab === 'platform' ? platformAdmin : !hasTenant ? false : tab === 'setup' ? atLeast(role, 'tadmin') : true)
}

const initialTab = (): Tab => (TABS as readonly string[]).includes(remembered(TAB_KEY) ?? '') ? remembered(TAB_KEY) as Tab : 'overview'
const initialSection = (): SetupSection =>
  (SETUP_SECTIONS as readonly string[]).includes(remembered(SECTION_KEY) ?? '') ? remembered(SECTION_KEY) as SetupSection : 'repositories'

export function App({ client, email, onLogout, route: initialRoute = { kind: 'panel' }, navigate = url => window.location.assign(url) }: {
  client: Client; email?: string | undefined; onLogout: () => void; route?: Route; navigate?: (url: string) => void
}) {
  const [me, setMe] = useState<MeView>()
  const [cells, setCells] = useState<CellView[]>()
  const [loadError, setLoadError] = useState<unknown>()
  const [cellId, setCellId] = useState(() => remembered(CELL_KEY) ?? '')
  const [tenantChoice, setTenantChoice] = useState(() => remembered(TENANT_KEY) ?? '')
  const [tab, setTab] = useState<Tab>(initialTab)
  const [section, setSection] = useState<SetupSection>(initialSection)
  const [route, setRoute] = useState<Route>(initialRoute)
  const [ticketId, setTicketId] = useState<string>()
  const [toast, setToast] = useState<{ text: string; id: number }>()

  const load = useCallback(async () => {
    setLoadError(undefined)
    try {
      const [profile, list] = await Promise.all([client.me(), client.cells()])
      setMe(profile); setCells(list)
    } catch (error) { setLoadError(error) }
  }, [client])
  useEffect(() => { void load() }, [load])

  const tenants = me?.tenants ?? []
  // Keep remembered choices only while the API still returns them.
  const rememberedCell = cells?.find(item => item.cellId === cellId)
  const tenantId = tenants.find(item => item.tenantId === tenantChoice)?.tenantId ?? rememberedCell?.tenantId ?? tenants[0]?.tenantId
    ?? cells?.[0]?.tenantId
  const tenantCells = useMemo(() => (cells ?? []).filter(item => item.tenantId === tenantId), [cells, tenantId])
  const cell = tenantCells.find(item => item.cellId === cellId) ?? tenantCells[0]
  const tenant = tenants.find(item => item.tenantId === tenantId)
  // A tenant listed without a role is treated as the least privileged one; panel-api decides in any case.
  const role: PanelRole | undefined = tenantId ? tenant?.role ?? (me?.platformAdmin ? 'admin' : 'member') : undefined
  const tabs = visibleTabs(role, !!me?.platformAdmin, !!tenantId)
  const shown: Tab | undefined = tabs.includes(tab) ? tab : tabs[0]

  const selectCell = (id: string) => {
    setCellId(id); setTicketId(undefined); remember(CELL_KEY, id)
    const owner = cells?.find(item => item.cellId === id)?.tenantId
    if (owner) { setTenantChoice(owner); remember(TENANT_KEY, owner) }
  }
  const selectTenant = useCallback((id: string) => {
    setTenantChoice(id); remember(TENANT_KEY, id); setTicketId(undefined)
    const first = cells?.find(item => item.tenantId === id)?.cellId ?? ''
    setCellId(first); remember(CELL_KEY, first)
  }, [cells])
  const go = useCallback((next: Tab, part?: SetupSection) => {
    setRoute({ kind: 'panel' })
    setTab(next); remember(TAB_KEY, next); if (next !== 'execution') setTicketId(undefined)
    if (part) { setSection(part); remember(SECTION_KEY, part) }
  }, [])
  const notify = useCallback((text: string) => setToast({ text, id: Date.now() }), [])
  const openTicket = useCallback((id: string) => { go('execution'); setTicketId(id) }, [go])
  const shell = useMemo<ShellContext | undefined>(() => me && { client, me, tenantId, tenantName: tenant?.name ?? tenantId, role, notify, go,
    refresh: load, navigate, selectTenant }, [client, me, tenantId, tenant, role, notify, go, load, navigate, selectTenant])
  const context = useMemo(() => cell && role && { client, cell, tenantCells, notify, openTicket, role, canEdit: atLeast(role, 'tadmin') },
    [client, cell, tenantCells, notify, openTicket, role])

  const page = () => {
    if (route.kind === 'github-installed') return <GithubInstalled />
    if (route.kind === 'github-callback' || route.kind === 'github-callback-error') return <GithubCallback route={route} />
    if (shown === 'platform') return <PlatformPage />
    if (shown === 'setup') return <SetupPage section={section} onSection={part => go('setup', part)} />
    if (!context) {
      return <div className="notice" role="alert"><strong>No cells</strong>
        <span>{tenantId ? 'This team has no repositories yet.' : 'Your account has no cells yet. Ask a platform admin to add you to a tenant.'}</span>
        {tenantId && atLeast(role, 'tadmin') && <button type="button" onClick={() => go('setup', 'repositories')}>Add a repository</button>}
      </div>
    }
    return <PanelProvider value={context}>
      {shown === 'overview' ? <OverviewPage /> : shown === 'execution' ? <ExecutionPage ticketId={ticketId} onSelect={setTicketId} />
        : <SettingsPage />}
    </PanelProvider>
  }

  const cellPage = route.kind === 'panel' && !!context && (shown === 'overview' || shown === 'execution' || shown === 'settings')
  const heading = cellPage && cell ? <div className="context">
    <span className="context-title">{cell.repo?.owner && cell.repo.name
      ? <><span className="owner">{cell.repo.owner} / </span>{cell.repo.name}</> : cell.cellId}</span>
    <span className="context-sub">{tenant?.name ?? cell.tenantName ?? cell.tenantId}
      {cell.status && <span className="tag" data-state={cell.status}>{cell.status === 'active' ? 'Active' : cell.status}</span>}</span>
  </div> : <div className="context">
    {/* Team setup and Platform name themselves in their page heading; the bar only says which team is selected. */}
    {route.kind === 'panel' && shown !== 'platform' && tenant?.name && <>
      <span className="context-title">{tenant.name}</span><span className="context-sub">Team</span></>}
  </div>

  return <div className="app">
    <aside className="rail">
      <div className="brand"><span className="brand-mark" aria-hidden="true"><span /><span /><span /></span><h1>DSH Superagent</h1></div>
      <div className="pickers">
        {tenants.length > 1 && tenantId && <label className="picker">
          <span>Team</span>
          <select aria-label="Team" value={tenantId} onChange={event => selectTenant(event.target.value)}>
            {tenants.map(item => <option key={item.tenantId} value={item.tenantId}>{item.name ?? item.tenantId}</option>)}
          </select>
        </label>}
        {cells && cells.length > 0 && <CellPicker cells={cells} me={me} value={cell?.cellId ?? ''} onChange={selectCell} />}
      </div>
      {shell && cells && route.kind === 'panel' && tabs.length > 0 && <nav className="tabs" role="tablist" aria-label="Pages" aria-orientation="vertical">
        {tabs.map((item, index) => <TabButton key={item} item={item} caption={index === 0 || TAB_SCOPES[tabs[index - 1]!] !== TAB_SCOPES[item]}
          selected={shown === item} onClick={() => go(item)} />)}
      </nav>}
    </aside>
    <div className="stage">
      <header className="topbar">
        {heading}
        <div className="user">
          {role && <span className="tag" data-role={role}>{ROLE_LABELS[role]}</span>}
          <AccountMenu email={me?.email ?? email} onLogout={onLogout} />
        </div>
      </header>
      {loadError ? <main><ErrorState error={loadError} /><button type="button" onClick={() => { void load() }}>Try again</button></main>
        : !cells || !shell ? <main><p className="hint">Loading…</p></main>
        : <ShellProvider value={shell}>
          {/* The GitHub routes keep one key, so a tenant or cell change never remounts the callback (its code is single use). */}
          <main key={route.kind === 'panel' ? `${tenantId ?? ''}/${cell?.cellId ?? ''}` : 'github-setup'} role="tabpanel"
            aria-label={route.kind === 'panel' ? TAB_LABELS[shown ?? 'overview'] : 'GitHub setup'}>
            {page()}
          </main>
        </ShellProvider>}
    </div>
    {toast && <Toast key={toast.id} text={toast.text} onDone={() => setToast(undefined)} />}
  </div>
}
