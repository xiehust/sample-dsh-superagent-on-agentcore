/**
 * Team setup (onboarding design §1, §3, §4) for tenant admins and platform admins: the onboarding checklist, Repositories
 * (GitHub App install, installation linking, adding repos as cells), the Feishu/Lark bot, chat bindings, and the team's users.
 * Every value the user picks comes from the API (installations, repos, chats); nothing is typed as a numeric or `oc_` id.
 * Secrets are write-only: the forms never show a stored secret, and clear what was typed once it is saved.
 */
import { useState, type FormEvent } from 'react'
import { errorText, usePoll } from './api.ts'
import { githubAuthorizeUrl, githubInstallUrl, rememberLink } from './routes.ts'
import { claimReasonText, when } from './text.ts'
import type { FeishuDomain, InstallationClaim, SetupCell, SetupChecklist, SetupStatusView } from './types.ts'
import { InviteForm, UserTable } from './users.tsx'
import { ConfirmButton, LoadState, Section, SETUP_SECTIONS, useAction, useShell, type SetupSection } from './widgets.tsx'

const SECTION_LABELS: Record<SetupSection, string> = { repositories: 'Repositories', feishu: 'Feishu / Lark', chats: 'Chats', users: 'Users' }
const STATUS_POLL_MS = 15_000
/** Repos come from GitHub through the host: loaded on open and after a change, not polled often. */
const REPOS_POLL_MS = 300_000

export function SetupPage({ section, onSection }: { section: SetupSection; onSection: (section: SetupSection) => void }) {
  const { client, tenantId, tenantName } = useShell()
  const tenant = tenantId!
  const status = usePoll(() => client.setup.status(tenant), [tenant], STATUS_POLL_MS)
  return <>
    <header className="page-head"><h2>Team setup · {tenantName}</h2></header>
    <LoadState error={status.error} loading={!status.data} />
    {status.data && <Checklist checklist={status.data.checklist} onSection={onSection} />}
    <div className="filters" role="group" aria-label="Setup section">
      {SETUP_SECTIONS.map(item => <button key={item} type="button" className="pill" aria-pressed={section === item}
        onClick={() => onSection(item)}>{SECTION_LABELS[item]}</button>)}
    </div>
    {section === 'repositories' ? status.data && <Repositories status={status.data} reload={status.reload} />
      : section === 'feishu' ? <Feishu reloadStatus={status.reload} />
      : section === 'chats' ? <Chats reloadStatus={status.reload} />
      : <Users />}
  </>
}

function Checklist({ checklist, onSection }: { checklist: SetupChecklist; onSection: (section: SetupSection) => void }) {
  const { go } = useShell()
  // `waiting`: nothing is linked yet, but a claim waits for platform approval (v6.2).
  const items: { label: string; done?: boolean; waiting?: boolean; action: string; open: () => void }[] = [
    { label: 'GitHub App installed and linked to this team', done: checklist.appLinked, waiting: !checklist.appLinked && !!checklist.approvalPending,
      action: 'Repositories', open: () => onSection('repositories') },
    { label: 'A repository added', done: checklist.repoAdded, action: 'Repositories', open: () => onSection('repositories') },
    { label: 'Feishu / Lark bot connected', done: checklist.botConnected, action: 'Feishu / Lark', open: () => onSection('feishu') },
    { label: 'A chat bound to a repository', done: checklist.chatBound, action: 'Chats', open: () => onSection('chats') },
    { label: 'People allowed to start work', action: 'Open the Policy form', open: () => go('settings') },
  ]
  return <Section title="Onboarding checklist">
    <ol className="checklist">{items.map(item => <li key={item.label}
      data-done={item.waiting ? 'waiting' : item.done === undefined ? 'unknown' : String(item.done)}>
      <span className="check" aria-hidden="true">{item.done ? '✓' : item.waiting ? '…' : item.done === false ? '○' : '·'}</span>
      <span className="checklist-label">{item.label}</span>
      <span className="hint">{item.done ? 'Done' : item.waiting ? 'Waiting for approval' : item.done === false ? 'To do' : 'Per repository'}</span>
      <button type="button" className="link" onClick={item.open}>{item.action}</button>
    </li>)}</ol>
  </Section>
}

// ---- Repositories ----------------------------------------------------------------------------------------------------

function Repositories({ status, reload }: { status: SetupStatusView; reload: () => Promise<void> }) {
  const { client, tenantId, navigate, refresh, notify } = useShell()
  const tenant = tenantId!
  const installations = usePoll(() => client.setup.installations(tenant), [tenant], STATUS_POLL_MS)
  // Only a github.com/apps/<slug> link is offered; anything else from the API renders the disabled button.
  const installUrl = githubInstallUrl(status.github.installUrl)
  const link = useAction(async () => {
    // Only GitHub's own OAuth authorize page is ever followed; any other URL from the API is refused.
    const start = githubAuthorizeUrl((await client.setup.linkStart(tenant)).url)
    if (!start) throw new Error('panel-api returned an unexpected GitHub sign-in URL, so the panel did not follow it.')
    // GitHub returns to this tab; the callback finds the team by the single-use `state`.
    rememberLink(start.state, tenant)
    navigate(start.url)
  })
  const changed = async () => { await Promise.all([reload(), installations.reload(), refresh()]) }
  return <>
    <Section title="GitHub App">
      {!status.github.configured && <div className="notice notice-conflict" role="alert"><strong>GitHub App not set up</strong>
        <span>A platform admin must finish Platform → GitHub App before repositories can be added.</span></div>}
      <ol className="steps">
        <li>Install the App on the account or organization that owns the repositories, and pick the repositories it may access.
          {' '}{installUrl ? <a className="button" href={installUrl} target="_blank" rel="noopener noreferrer">Install / configure the GitHub App</a>
            : <button type="button" disabled>Install / configure the GitHub App</button>}</li>
        <li>Link the installation to this team. GitHub asks you to sign in, so the panel can check which installations your account can
          access. {' '}<button type="button" disabled={link.busy || !status.github.configured} onClick={() => { void link.run() }}>Link installations</button></li>
      </ol>
    </Section>
    <Section title="Linked installations" count={installations.data?.installations.length}>
      <LoadState error={installations.error} loading={!installations.data} />
      {installations.data && (installations.data.installations.length
        // Only an `active` claim lists repositories; anything else waits for a platform admin and its repos are never requested.
        ? installations.data.installations.map(claim => claim.status === 'active'
          ? <InstallationRepos key={claim.installationId} claim={claim} onUnlinked={changed} onAdded={async name => {
            notify(`Added ${name}. Its cell starts within a minute.`); await changed()
          }} />
          : <PendingInstallation key={claim.installationId} claim={claim} onUnlinked={changed} />)
        : <p className="hint">No installation is linked yet. Install the App, then press Link installations.</p>)}
    </Section>
    <Section title="Repositories of this team" count={status.cells.length}>
      {status.cells.length ? <table className="table">
        <thead><tr><th>Repository</th><th>Status</th><th /></tr></thead>
        <tbody>{status.cells.map(cell => <CellRow key={cell.cellId} cell={cell} onChange={changed} />)}</tbody>
      </table> : <p className="hint">No repository is added yet. Add one from a linked installation above.</p>}
    </Section>
  </>
}

/**
 * Unlinks the team's claim so the installation can be linked to another team (it stays installed on GitHub). panel-api
 * refuses with 409 `installation_in_use`, naming the repositories, while any of them is not disabled; that message is shown.
 */
function UnlinkButton({ claim, onUnlinked }: { claim: InstallationClaim; onUnlinked: () => Promise<void> }) {
  const { client, tenantId, notify, tenantName } = useShell()
  return <ConfirmButton danger label="Unlink" title={`Unlink ${claim.account} from ${tenantName ?? tenantId}?`}
    message={`This team can no longer add repositories from ${claim.account}, and another team can link it. The App stays installed on GitHub. Disable this team's repositories on it first.`}
    onConfirm={async () => {
      await client.setup.unlink(tenantId!, claim.installationId)
      notify(`Unlinked ${claim.account}.`)
      await onUnlinked()
    }} />
}

function InstallationRepos({ claim, onAdded, onUnlinked }: { claim: InstallationClaim; onAdded: (name: string) => Promise<void>; onUnlinked: () => Promise<void> }) {
  const { client, tenantId } = useShell()
  const tenant = tenantId!
  const repos = usePoll(() => client.setup.repositories(tenant, claim.installationId), [tenant, claim.installationId], REPOS_POLL_MS)
  const add = useAction(async (repoId: number, name: string) => {
    await client.setup.addCell(tenant, { installationId: claim.installationId, repoId })
    await repos.reload()
    await onAdded(name)
  })
  const title = claim.account ?? 'Installation'
  return <div className="subsection" role="group" aria-label={`Installation ${title}`}>
    <h3>{title} <span className="hint">linked {when(claim.claimedAt)} by {claim.claimedBy}</span></h3>
    <div className="section-actions"><UnlinkButton claim={claim} onUnlinked={onUnlinked} /></div>
    <LoadState error={repos.error} loading={!repos.data} />
    {repos.data && (repos.data.repositories.length ? <ul className="list">{repos.data.repositories.map(repo => <li key={repo.id} className="row">
      <div className="row-main"><div className="row-title">{repo.fullName}</div>
        <div className="row-meta">{repo.private && <span className="tag">private</span>}{repo.archived && <span className="tag">archived</span>}
          <span>default branch {repo.defaultBranch}</span></div></div>
      <div className="row-actions">{repo.cell ? <span className="tag" data-state={repo.cell.status}>Added · {repo.cell.status}</span>
        : <button type="button" disabled={add.busy || repo.archived} aria-label={`Add ${repo.fullName}`}
          onClick={() => { void add.run(repo.id, repo.fullName) }}>Add</button>}</div>
    </li>)}</ul> : <p className="hint">This installation has no repositories. Configure the App to give it access to some.</p>)}
    {repos.data?.truncated && <p className="hint">Showing the first repositories only.</p>}
  </div>
}

function PendingInstallation({ claim, onUnlinked }: { claim: InstallationClaim; onUnlinked: () => Promise<void> }) {
  return <div className="subsection" role="group" aria-label={`Installation ${claim.account}`}>
    <h3>{claim.account} <span className="hint">linked {when(claim.claimedAt)} by {claim.claimedBy}</span></h3>
    <p><span className="tag" data-state="warn">Waiting for platform approval</span>{' '}
      <span className="hint">{claimReasonText(claim.pendingReason, claim.account)}</span></p>
    <p className="hint">Its repositories appear here once a platform admin approves it. Someone who controls {claim.account} on GitHub (its owner,
      or an organization admin) can also link it themselves.</p>
    <div className="section-actions"><UnlinkButton claim={claim} onUnlinked={onUnlinked} /></div>
  </div>
}

function CellRow({ cell, onChange }: { cell: SetupCell; onChange: () => Promise<void> }) {
  const { client, tenantId } = useShell()
  const name = `${cell.repo.owner}/${cell.repo.name}`
  const act = useAction(async (action: 'pause' | 'enable') => { await client.setup.cellStatus(tenantId!, cell.cellId, action); await onChange() })
  return <tr>
    <td>{name}</td><td><span className="tag" data-state={cell.status}>{cell.status}</span></td>
    <td className="row-actions">
      {cell.status === 'active' && <button type="button" disabled={act.busy} aria-label={`Pause ${name}`}
        onClick={() => { void act.run('pause') }}>Pause</button>}
      {cell.status !== 'active' && <button type="button" disabled={act.busy} aria-label={`Enable ${name}`}
        onClick={() => { void act.run('enable') }}>Enable</button>}
      {cell.status !== 'disabled' && <ConfirmButton danger label="Disable" title={`Disable ${name}?`}
        message="The cell stops and ignores new GitHub and Feishu messages until it is enabled again. Its tickets and settings are kept."
        onConfirm={async () => { await client.setup.cellStatus(tenantId!, cell.cellId, 'disable'); await onChange() }} />}
    </td>
  </tr>
}

// ---- Feishu / Lark ---------------------------------------------------------------------------------------------------

const APP_ID = /^cli_[A-Za-z0-9]{1,64}$/
const HEALTH_LABELS = { starting: 'Starting', ready: 'Connected', error: 'Error' } as const

function Feishu({ reloadStatus }: { reloadStatus: () => Promise<void> }) {
  const { client, tenantId, notify } = useShell()
  const tenant = tenantId!
  const { data, error, reload } = usePoll(() => client.setup.feishu(tenant), [tenant], STATUS_POLL_MS)
  const [domain, setDomain] = useState<FeishuDomain>()
  const [appId, setAppId] = useState('')
  // Secrets live only in these fields until saved; they are never read back from the API.
  const [appSecret, setAppSecret] = useState('')
  const [encryptKey, setEncryptKey] = useState('')
  const [touched, setTouched] = useState(false)
  const [failure, setFailure] = useState<string>()
  const id = appId.trim() || data?.appId || ''
  const problems = [!APP_ID.test(id) && 'The App ID looks like cli_ followed by letters and digits.',
    appSecret.length < 8 && 'Enter the App Secret (at least 8 characters). It is needed on every save.'].filter(Boolean) as string[]
  const save = useAction(async () => {
    setFailure(undefined)
    await client.setup.feishuSet(tenant, { domain: domain ?? data?.domain ?? 'feishu', appId: id, appSecret,
      ...encryptKey ? { encryptKey } : {} })
    setAppSecret(''); setEncryptKey(''); setAppId(''); setTouched(false)
    notify('Saved. The Connector reconnects with the new credentials within a minute.')
    await Promise.all([reload(), reloadStatus()])
  }, { onError: failed => setFailure(errorText(failed)) })
  const submit = (event: FormEvent) => { event.preventDefault(); setTouched(true); if (!problems.length) void save.run() }
  return <>
    <Section title="Feishu / Lark bot">
      <LoadState error={error} loading={!data} />
      {data && <div className="row-meta">
        {data.set ? <><span className="tag" data-state="ok">Credentials set</span><span>{data.domain === 'lark' ? 'Lark' : 'Feishu'}</span>
          <span>App ID <code>{data.appId}</code></span>{data.revision && <span>updated {when(data.revision)}</span>}</>
          : <span className="tag">Not configured</span>}
        {data.health ? <><span className="tag" data-state={data.health.state}>{HEALTH_LABELS[data.health.state]}</span>
          <span>{data.health.detail}</span>{data.health.at && <span className="hint">{when(data.health.at)}</span>}</>
          : data.set && <span className="hint">The Connector has not reported yet.</span>}
      </div>}
      <form className="stack-form" onSubmit={submit} aria-label="Feishu bot credentials">
        <label>Platform<select value={domain ?? data?.domain ?? 'feishu'} onChange={event => setDomain(event.target.value as FeishuDomain)}>
          <option value="feishu">Feishu (open.feishu.cn)</option><option value="lark">Lark (open.larksuite.com)</option>
        </select></label>
        <label>App ID<input value={appId} placeholder={data?.appId ?? 'cli_…'} spellCheck={false} autoComplete="off"
          aria-invalid={touched && !APP_ID.test(id)} onChange={event => setAppId(event.target.value.trim())} /></label>
        <label>App Secret<input type="password" value={appSecret} autoComplete="new-password" spellCheck={false}
          placeholder={data?.set ? 'Set. Enter it again to save changes' : ''} aria-invalid={touched && appSecret.length < 8}
          onChange={event => setAppSecret(event.target.value)} /></label>
        <label>Encrypt Key (optional)<input type="password" value={encryptKey} autoComplete="new-password" spellCheck={false}
          placeholder="Only if set under Events & callbacks" onChange={event => setEncryptKey(event.target.value)} /></label>
        {touched && problems.map(problem => <p key={problem} className="error" role="alert">{problem}</p>)}
        {failure && <p className="error" role="alert">{failure}</p>}
        <div><button type="submit" className="primary" disabled={save.busy}>Save bot</button></div>
      </form>
    </Section>
    <Section title="Feishu / Lark console checklist">
      <p className="hint">In the developer console (Feishu open.feishu.cn/app, Lark open.larksuite.com/app), on your self-built app:</p>
      <ol className="steps">
        <li><strong>Add features → Bot</strong> (添加应用能力 → 机器人).</li>
        <li><strong>Permissions &amp; scopes</strong> (权限管理): receive group messages that @ the bot; read direct messages to the bot; obtain and send
          messages in direct and group chats; obtain group information; obtain group members; read and upload images or files. Optional:
          read all messages in groups, only for chats set to “All”.</li>
        <li><strong>Credentials &amp; basic info</strong>: copy the App ID (cli_…) and App Secret into the form above, then <strong>Save bot</strong>
          {' '}before the next step.</li>
        <li><strong>Events &amp; callbacks → Event configuration</strong>: choose <em>Receive events through persistent connection</em> (使用长连接接收事件)
          and save. The console accepts it only while the Connector is connected (“Connected” above). Add the event
          {' '}<code>im.message.receive_v1</code> (接收消息).</li>
        <li><strong>Version management &amp; release</strong>: create a version and publish it (an admin may need to approve it).</li>
        <li>Add the bot to a group and @ it once. The group then appears under <strong>Chats</strong>.</li>
      </ol>
    </Section>
  </>
}

// ---- Chats -----------------------------------------------------------------------------------------------------------

function Chats({ reloadStatus }: { reloadStatus: () => Promise<void> }) {
  const { client, tenantId } = useShell()
  const tenant = tenantId!
  const { data, error, reload } = usePoll(() => client.setup.chats(tenant), [tenant], STATUS_POLL_MS)
  const after = async () => { await Promise.all([reload(), reloadStatus()]) }
  const bind = useAction(async (chatId: string, cellId: string) => { await client.setup.bind(tenant, chatId, cellId); await after() })
  const repo = (cellId: string | undefined) => data?.cells.find(item => item.cellId === cellId)?.repo ?? cellId
  return <Section title="Chats" count={data?.chats.length}>
    <p className="hint">Groups the bot has seen. Messages in a bound chat go to its repository; binding syncs to the cell within a minute.</p>
    <LoadState error={error} loading={!data} />
    {data && (data.chats.length ? <table className="table">
      <thead><tr><th>Chat</th><th>Last activity</th><th>Repository</th><th /></tr></thead>
      <tbody>{data.chats.map(chat => {
        const name = chat.name || (chat.direct ? 'Direct message' : 'Unnamed chat')
        return <tr key={chat.chatId}>
          <td><div>{name}{chat.direct && <span className="tag">direct</span>}</div>
            {!chat.seen && <div className="hint">The bot has not seen this chat.</div>}
            {!chat.cellId && !!chat.unrouted && <div className="hint">{chat.unrouted} message{chat.unrouted === 1 ? '' : 's'} waiting for a binding</div>}</td>
          <td>{when(chat.lastAt) || '—'}</td>
          <td><select aria-label={`Repository for ${name}`} value={chat.cellId ?? ''} disabled={bind.busy || !data.cells.length}
            onChange={event => { if (event.target.value) void bind.run(chat.chatId, event.target.value) }}>
            {!chat.cellId && <option value="">Choose a repository…</option>}
            {chat.cellId && !data.cells.some(item => item.cellId === chat.cellId) && <option value={chat.cellId}>{repo(chat.cellId)}</option>}
            {data.cells.map(item => <option key={item.cellId} value={item.cellId}>{item.repo}</option>)}
          </select></td>
          <td>{chat.cellId && <ConfirmButton danger label="Unbind" title={`Unbind ${name}?`}
            message={`Messages in ${name} will no longer reach ${repo(chat.cellId)}.`}
            onConfirm={async () => { await client.setup.unbind(tenant, chat.chatId); await after() }} />}</td>
        </tr>
      })}</tbody>
    </table> : <div className="notice" role="status"><strong>No chats yet</strong>
      <span>Add the bot to a group and @ it once. The chat shows up here within a minute.</span></div>)}
    {data && !data.cells.length && data.chats.length > 0 && <p className="hint">Add a repository first, then bind chats to it.</p>}
  </Section>
}

// ---- Users -----------------------------------------------------------------------------------------------------------

const TEAM_ROLES = ['member', 'tadmin'] as const

function Users() {
  const { client, tenantId, tenantName, notify } = useShell()
  const tenant = tenantId!
  const { data, error, reload } = usePoll(() => client.setup.users(tenant), [tenant], 30_000)
  return <Section title="Users" count={data?.users.length}>
    <p className="hint">Members read everything and may Stop or Retry tickets. Team admins also change settings, repositories, the bot and
      chats.</p>
    <LoadState error={error} loading={!data} />
    {data && <UserTable users={data.users} removeMessage={email => `${email} loses access to ${tenantName}.`}
      onRemove={async email => { await client.setup.removeUser(tenant, email); await reload() }} />}
    <InviteForm roles={TEAM_ROLES} onInvite={async (email, role) => {
      await client.setup.invite(tenant, { email, role })
      notify(`Invited ${email}. Cognito emails a temporary password to new users.`)
      await reload()
    }} />
  </Section>
}
