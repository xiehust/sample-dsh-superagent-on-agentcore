/**
 * Platform (onboarding design §1–§3), platform admins only: tenants, users of every role, and the GitHub App. The App's
 * private key, webhook secret and OAuth client secret are write-only: the form starts empty, never shows a stored value, and
 * clears what was typed once it is saved.
 */
import { useState, type FormEvent } from 'react'
import { ApiError, errorText, usePoll } from './api.ts'
import { claimReasonText, when } from './text.ts'
import type { GithubAppInput, GithubAppView, InstallationClaim } from './types.ts'
import { InviteForm, UserTable } from './users.tsx'
import { ConfirmButton, CopyButton, LoadState, Modal, Section, useAction, useShell } from './widgets.tsx'

export const TENANT_ID = /^[a-z][a-z0-9-]{2,30}$/
/** Reserved by contracts v6 (`RESERVED_TENANT_IDS`); `tenantAdd` refuses them. */
export const RESERVED_TENANT_IDS = ['admin', 'tadmin', 'platform']

export function PlatformPage() {
  return <>
    <header className="page-head"><h2>Platform</h2></header>
    <Tenants />
    <PlatformUsers />
    <GithubApp />
    <Installations />
  </>
}

function Tenants() {
  const { client, refresh, notify } = useShell()
  const { data, error, reload } = usePoll(() => client.admin.tenants(), [], 30_000)
  const [form, setForm] = useState({ tenantId: '', name: '' })
  const [touched, setTouched] = useState(false)
  const idProblem = !TENANT_ID.test(form.tenantId) ? 'A team id is 3–31 lowercase letters, digits or hyphens, starting with a letter.'
    : RESERVED_TENANT_IDS.includes(form.tenantId) ? `“${form.tenantId}” is reserved.`
    : data?.tenants.some(item => item.tenantId === form.tenantId) ? 'A team with this id exists.' : undefined
  const nameProblem = form.name.trim() ? undefined : 'Enter a display name.'
  const add = useAction(async () => {
    await client.admin.addTenant({ tenantId: form.tenantId, name: form.name.trim() })
    notify(`Created ${form.name.trim()}. Invite its first team admin under Users.`)
    setForm({ tenantId: '', name: '' }); setTouched(false)
    await Promise.all([reload(), refresh()])
  })
  const submit = (event: FormEvent) => { event.preventDefault(); setTouched(true); if (!idProblem && !nameProblem) void add.run() }
  const status = async (tenantId: string, action: 'disable' | 'enable') => {
    await client.admin.tenantStatus(tenantId, action); await Promise.all([reload(), refresh()])
  }
  return <Section title="Teams" count={data?.tenants.length}>
    <LoadState error={error} loading={!data} />
    {data && (data.tenants.length ? <table className="table">
      <thead><tr><th>Team</th><th>Id</th><th>Status</th><th>Feishu / Lark</th><th>Created</th><th /></tr></thead>
      <tbody>{data.tenants.map(tenant => <tr key={tenant.tenantId}>
        <td>{tenant.name}</td><td><code>{tenant.tenantId}</code></td>
        <td><span className="tag" data-state={tenant.status}>{tenant.status}</span></td>
        <td>{tenant.feishu ? `${tenant.feishu.domain} · ${tenant.feishu.appId}` : '—'}</td><td>{when(tenant.createdAt)}</td>
        <td>{tenant.status === 'active'
          ? <ConfirmButton danger label="Disable" title={`Disable ${tenant.name}?`}
            message="Its users lose access in the panel and its cells stop taking new work until the team is enabled again."
            onConfirm={() => status(tenant.tenantId, 'disable')} />
          : <button type="button" aria-label={`Enable ${tenant.name}`} onClick={() => { void status(tenant.tenantId, 'enable') }}>Enable</button>}</td>
      </tr>)}</tbody>
    </table> : <p className="hint">No teams yet.</p>)}
    <form className="inline-form" onSubmit={submit} aria-label="Create team">
      <label>Team id<input value={form.tenantId} placeholder="acme" spellCheck={false} autoComplete="off" aria-invalid={touched && !!idProblem}
        onChange={event => setForm({ ...form, tenantId: event.target.value.trim().toLowerCase() })} /></label>
      <label>Name<input value={form.name} placeholder="Acme" aria-invalid={touched && !!nameProblem}
        onChange={event => setForm({ ...form, name: event.target.value })} /></label>
      <button type="submit" disabled={add.busy}>Create team</button>
    </form>
    {touched && [idProblem, nameProblem].filter(Boolean).map(problem => <p key={problem} className="error" role="alert">{problem}</p>)}
  </Section>
}

const ADMINS = ''
function PlatformUsers() {
  const { client, notify } = useShell()
  const tenants = usePoll(() => client.admin.tenants(), [], 60_000)
  const [scope, setScope] = useState(ADMINS)
  const users = usePoll(() => client.admin.users(scope || undefined), [scope], 30_000)
  const name = scope ? tenants.data?.tenants.find(item => item.tenantId === scope)?.name ?? scope : 'the platform'
  return <Section title="Users" count={users.data?.users.length} actions={<label className="picker">
    <span className="visually-hidden">Users of</span>
    <select aria-label="Users of" value={scope} onChange={event => setScope(event.target.value)}>
      <option value={ADMINS}>Platform admins</option>
      {(tenants.data?.tenants ?? []).map(item => <option key={item.tenantId} value={item.tenantId}>{item.name}</option>)}
    </select>
  </label>}>
    <LoadState error={users.error} loading={!users.data} />
    {users.data && <UserTable users={users.data.users}
      removeMessage={email => scope ? `${email} loses access to ${name}.` : `${email} is no longer a platform admin.`}
      onRemove={async email => { await client.admin.removeUser(email, scope || undefined); await users.reload() }} />}
    {scope
      ? <InviteForm key={scope} roles={['member', 'tadmin'] as const} label={`Invite user to ${name}`} onInvite={async (email, role) => {
        await client.admin.invite({ email, role, tenantId: scope }); notify(`Invited ${email} to ${name}.`); await users.reload()
      }} />
      : <InviteForm key="admins" roles={['admin'] as const} label="Invite platform admin" onInvite={async email => {
        await client.admin.invite({ email, role: 'admin' }); notify(`${email} is now a platform admin.`); await users.reload()
      }} />}
  </Section>
}

// ---- GitHub App ------------------------------------------------------------------------------------------------------

/** Reads a picked file in the browser only (the key goes from the file to the PUT body, nowhere else). */
function readText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'))
    reader.readAsText(file)
  })
}

const EMPTY = { appId: '', privateKey: '', webhookSecret: '', clientId: '', clientSecret: '' }
type AppForm = typeof EMPTY
/** Client-side checks mirroring panel-platform's body schema and ops (the server checks again). */
export function appProblems(form: AppForm, current: GithubAppView | undefined): string[] {
  const out: string[] = []
  const appId = form.appId.trim() || current?.app.appId || ''
  if (form.appId.trim() && !/^\d+$/.test(form.appId.trim())) out.push('The App ID is a number.')
  if (form.privateKey && !form.privateKey.includes('PRIVATE KEY')) out.push('The private key is the .pem file GitHub generated (it contains “PRIVATE KEY”).')
  if (form.privateKey && !appId) out.push('Enter the App ID with the private key.')
  if (form.webhookSecret && !form.privateKey) out.push('Changing the webhook secret needs the private key too.')
  if (form.webhookSecret && form.webhookSecret.length < 20) out.push('The webhook secret is at least 20 characters.')
  if (form.clientId.trim() && !/^(Iv|lv)[0-9A-Za-z.]{6,40}$/.test(form.clientId.trim())) out.push('The Client ID looks like Iv23li…')
  if (form.clientSecret && !/^[0-9a-f]{40}$/.test(form.clientSecret.trim())) out.push('The client secret is 40 hex characters.')
  if (!form.privateKey && !form.clientId.trim() && !form.clientSecret && !form.webhookSecret) out.push('Nothing to change.')
  return out
}

function GithubApp() {
  const { client, notify } = useShell()
  const status = usePoll(() => client.admin.githubApp(), [], 60_000)
  const [view, setView] = useState<GithubAppView>()
  const current = view ?? status.data
  // Every field is write-only and starts empty; stored values are never shown back.
  const [typed, setForm] = useState<AppForm>(EMPTY)
  // An uploaded key stays in memory only (never in storage) and is not echoed into the page; it wins over a pasted one.
  const [keyFile, setKeyFile] = useState<{ name: string; text: string }>()
  const [touched, setTouched] = useState(false)
  const [failure, setFailure] = useState<string>()
  const form: AppForm = keyFile ? { ...typed, privateKey: keyFile.text } : typed
  const problems = appProblems(form, current)
  const save = useAction(async () => {
    setFailure(undefined)
    const appId = form.appId.trim() || (form.privateKey ? current?.app.appId : undefined)
    const body: GithubAppInput = Object.fromEntries(Object.entries({ appId: form.privateKey ? appId : form.appId.trim() || undefined,
      privateKey: form.privateKey || undefined, webhookSecret: form.webhookSecret || undefined, clientId: form.clientId.trim() || undefined,
      clientSecret: form.clientSecret.trim() || undefined }).filter(([, value]) => value !== undefined))
    const next = await client.admin.setGithubApp(body)
    setForm(EMPTY); setKeyFile(undefined); setTouched(false); setView(next)
    notify('GitHub App saved. Running hosts pick up a new key within 5 minutes.')
    await status.reload()
  }, { onError: failed => setFailure(errorText(failed)) })
  const submit = (event: FormEvent) => { event.preventDefault(); setTouched(true); if (!problems.length) void save.run() }
  const set = (key: keyof AppForm) => (value: string) => setForm(previous => ({ ...previous, [key]: value }))
  const readKey = async (file: File | undefined) => {
    if (!file) return
    let text: string
    try { text = await readText(file) } catch { setFailure('Could not read the key file.'); return }
    set('privateKey')(''); setKeyFile({ name: file.name, text })
  }
  return <Section title="GitHub App">
    <LoadState error={status.error} loading={!current} />
    {current && <dl className="kv">
      <div><dt>App</dt><dd>{current.app.set ? <>App ID <code>{current.app.appId}</code>{current.app.slug && <> · slug <code>{current.app.slug}</code></>}</>
        : <span className="tag">Not set</span>}</dd></div>
      {current.app.set && <div><dt>Private key</dt><dd>{current.app.keyValid
        ? <span className="tag" data-state="ok">Valid</span>
        : <><span className="tag" data-state="error">Not valid</span> {current.app.error}</>}</dd></div>}
      {current.app.installations !== undefined && <div><dt>Installations</dt><dd>{current.app.installations}</dd></div>}
      <div><dt>OAuth client</dt><dd>{current.oauth.set ? <>Set · Client ID <code>{current.oauth.clientId}</code></>
        : <span className="tag">Not set</span>}</dd></div>
    </dl>}
    {current && <div className="subsection">
      <h3>On GitHub (App settings → General)</h3>
      <ol className="steps">
        <li>Under Identifying and authorizing users, <strong>Add redirect URI</strong>. Redirect URI (formerly Callback URL):
          {' '}<code>{current.checklist.callbackUrl}</code> <CopyButton text={current.checklist.callbackUrl} /></li>
        <li>Leave <strong>Allow wildcard matching</strong> and <strong>Request user authorization (OAuth) during installation</strong> unchecked.</li>
        <li>Setup URL (optional): <code>{current.checklist.setupUrl}</code> <CopyButton text={current.checklist.setupUrl} /></li>
        <li>Turn on <strong>Redirect on update</strong>, so changing an installation's repositories also returns to the panel.</li>
        {(current.checklist.permissions ?? []).map(permission => <li key={permission}>Under Permissions, grant <strong>{permission}</strong>
          {' '}(the panel checks who may link an organization's installation with it).</li>)}
        <li>Under Client secrets, <strong>Generate a new client secret</strong> and paste it below with the Client ID.</li>
        <li>To change the key, <strong>Generate a private key</strong> and upload the .pem below.</li>
      </ol>
    </div>}
    <form className="stack-form" onSubmit={submit} aria-label="GitHub App settings">
      <label>App ID<input value={typed.appId} inputMode="numeric" autoComplete="off" placeholder={current?.app.appId ?? '123456'}
        onChange={event => set('appId')(event.target.value)} /></label>
      <label>Private key (.pem)<textarea className="code" rows={4} value={typed.privateKey} spellCheck={false} autoComplete="off"
        disabled={!!keyFile}
        placeholder={keyFile ? `Using the uploaded file ${keyFile.name}` : current?.app.set ? 'Set. Paste or upload a new key to replace it'
          : '-----BEGIN RSA PRIVATE KEY-----'}
        onChange={event => set('privateKey')(event.target.value)} /></label>
      <label>Upload private key<input type="file" accept=".pem,application/x-pem-file,text/plain" autoComplete="off"
        onChange={event => { void readKey(event.target.files?.[0]); event.target.value = '' }} /></label>
      {keyFile && <p className="hint">Key loaded from <code>{keyFile.name}</code> (kept in this page only until you save).
        {' '}<button type="button" className="link" onClick={() => setKeyFile(undefined)}>Remove</button></p>}
      <label>Client ID<input value={typed.clientId} autoComplete="off" spellCheck={false} placeholder={current?.oauth.clientId ?? 'Iv23li…'}
        onChange={event => set('clientId')(event.target.value)} /></label>
      <label>Client secret<input type="password" value={typed.clientSecret} autoComplete="new-password" spellCheck={false}
        placeholder={current?.oauth.set ? 'Set. Enter a new one to replace it' : ''} onChange={event => set('clientSecret')(event.target.value)} /></label>
      <label>Webhook secret (optional)<input type="password" value={typed.webhookSecret} autoComplete="new-password" spellCheck={false}
        placeholder="Only to change it; needs the private key too" onChange={event => set('webhookSecret')(event.target.value)} /></label>
      {touched && problems.map(problem => <p key={problem} className="error" role="alert">{problem}</p>)}
      {failure && <p className="error" role="alert">{failure}</p>}
      <div><button type="submit" className="primary" disabled={save.busy}>Save GitHub App</button></div>
    </form>
  </Section>
}

// ---- GitHub installations (contracts v6.2) ----------------------------------------------------------------------------

/**
 * Every installation claim, active and pending. A pending claim (the team admin did not prove control on GitHub) can be
 * approved or rejected; an active one released, e.g. when it was linked to the wrong team. A release is refused while the
 * team's repositories still use the installation; "Release anyway" then releases it and names those repositories, which are
 * left as they are (never disabled or removed here).
 */
function Installations() {
  const { client, notify } = useShell()
  const { data, error, reload } = usePoll(() => client.admin.installations(), [], 30_000)
  const [inUse, setInUse] = useState<{ claim: InstallationClaim; message: string }>()
  const force = useAction(async (claim: InstallationClaim) => {
    try {
      const result = await client.admin.releaseInstallation(claim.installationId, true)
      setInUse(undefined)
      notify(`Released ${claim.account}. Still on it: ${result.affectedCells.map(cell => cell.repo).join(', ') || 'no repository'}; disable those in the team's setup.`)
    } finally { await reload() }
  })
  const label = (claim: InstallationClaim & { tenantName?: string }) => claim.tenantName ?? claim.tenantId
  const approve = async (claim: InstallationClaim & { tenantName?: string }) => {
    try { await client.admin.approveInstallation(claim.installationId); notify(`Approved ${claim.account} for ${label(claim)}.`) }
    finally { await reload() }
  }
  const release = async (claim: InstallationClaim) => {
    try {
      await client.admin.releaseInstallation(claim.installationId)
      notify(claim.status === 'pending' ? `Rejected ${claim.account}. It can be linked again.` : `Released ${claim.account}. It can be linked again.`)
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === 'installation_in_use') { setInUse({ claim, message: failure.message }); return }
      throw failure
    } finally { await reload() }
  }
  const rows = data?.installations ?? []
  return <Section title="GitHub installations" count={data?.installations.length}>
    <LoadState error={error} loading={!data} />
    {data && (rows.length ? <table className="table">
      <thead><tr><th>Team</th><th>Account</th><th>Status</th><th>GitHub login</th><th>Claimed</th><th /></tr></thead>
      <tbody>{rows.map(claim => <tr key={claim.installationId} aria-label={`Claim of ${claim.account}`}>
        <td>{claim.tenantName && <span>{claim.tenantName} </span>}<code>{claim.tenantId}</code></td>
        <td><span>{claim.account}</span> <span className="tag">{claim.accountType === 'Organization' ? 'organization' : 'user'}</span>
          <div className="hint">installation {claim.installationId}</div></td>
        <td>{claim.status === 'pending'
          ? <><span className="tag" data-state="warn">pending</span><div className="hint">{claimReasonText(claim.pendingReason, claim.account, claim.githubLogin)}</div></>
          : <><span className="tag" data-state="ok">active</span>{claim.approvedBy && <div className="hint">approved by {claim.approvedBy}</div>}</>}</td>
        <td><code>{claim.githubLogin}</code></td>
        <td><span>{claim.claimedBy}</span><div className="hint">{when(claim.claimedAt)}</div></td>
        <td className="row-actions">{claim.status === 'pending' ? <>
          <ConfirmButton label="Approve" title={`Approve ${claim.account} for ${label(claim)}?`}
            message={`${label(claim)} can then add any repository the installation on ${claim.account} can access. Approve only if this team should act for ${claim.account}.`}
            onConfirm={() => approve(claim)} />
          <ConfirmButton danger label="Reject" title={`Reject ${claim.account} for ${label(claim)}?`}
            message="The claim is removed. The installation stays on GitHub and can be linked again by someone who controls the account."
            onConfirm={() => release(claim)} />
        </> : <ConfirmButton danger label="Release" title={`Release ${claim.account} from ${label(claim)}?`}
          message={`${label(claim)} can no longer add repositories from ${claim.account}, and another team can link it. The App stays installed on GitHub.`}
          onConfirm={() => release(claim)} />}</td>
      </tr>)}</tbody>
    </table> : <p className="hint">No installation is linked to any team.</p>)}
    {inUse && <Modal title={`${inUse.claim.account} is still in use`} confirmLabel="Release anyway" busy={force.busy}
      message={`${inUse.message}. Release anyway leaves those repositories as they are: they keep running on this installation until a team admin disables them.`}
      onCancel={() => setInUse(undefined)} onConfirm={() => { void force.run(inUse.claim) }} />}
  </Section>
}
