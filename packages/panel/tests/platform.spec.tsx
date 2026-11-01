import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { appProblems } from '../src/platform.tsx'
import { api, claim, ID_TOKEN, useFakeApi } from './fake-api.ts'
import { openTab, renderPanel } from './render.tsx'

useFakeApi()
beforeEach(() => { api.me.platformAdmin = true })

const sectionOf = async (name: string) => (await screen.findByRole('heading', { name: new RegExp(`^${name}`) })).closest('section')!
async function openPlatform() {
  openTab('platform')
  const panel = renderPanel()
  await screen.findByRole('heading', { name: 'Platform' })
  return panel
}

describe('teams', () => {
  it('creates a team and it becomes selectable in the header', async () => {
    const { user } = await openPlatform()
    const section = await sectionOf('Teams')
    await within(section).findByText('Beta')
    const form = within(section).getByRole('form', { name: 'Create team' })
    await user.type(within(form).getByLabelText('Team id'), 'gamma')
    await user.type(within(form).getByLabelText('Name'), 'Gamma Corp')
    await user.click(within(form).getByRole('button', { name: 'Create team' }))
    await waitFor(() => expect(api.find('POST', '/v1/admin/tenants')[0]?.body).toEqual({ tenantId: 'gamma', name: 'Gamma Corp' }))
    await within(section).findByText('Gamma Corp')
    const teams = screen.getByRole('combobox', { name: 'Team' }) as HTMLSelectElement
    await waitFor(() => expect([...teams.options].map(option => option.value)).toContain('gamma'))
  })

  it('refuses reserved and malformed ids without calling the API', async () => {
    const { user } = await openPlatform()
    const form = await screen.findByRole('form', { name: 'Create team' })
    await user.type(within(form).getByLabelText('Team id'), 'admin')
    await user.type(within(form).getByLabelText('Name'), 'Nope')
    await user.click(within(form).getByRole('button', { name: 'Create team' }))
    expect(screen.getByText('“admin” is reserved.')).toBeTruthy()
    await user.clear(within(form).getByLabelText('Team id'))
    await user.type(within(form).getByLabelText('Team id'), '9x')
    expect(screen.getByText(/A team id is 3–31 lowercase letters/)).toBeTruthy()
    expect(api.find('POST', '/v1/admin/tenants')).toHaveLength(0)
  })

  it('disables a team after confirmation and enables it again', async () => {
    const { user } = await openPlatform()
    const section = await sectionOf('Teams')
    const row = (await within(section).findByText('Beta')).closest('tr')!
    await user.click(within(row).getByRole('button', { name: 'Disable' }))
    await user.click(within(screen.getByRole('dialog', { name: 'Disable Beta?' })).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(api.find('POST', '/v1/admin/tenants/beta/disable')).toHaveLength(1))
    await user.click(await within(row).findByRole('button', { name: 'Enable Beta' }))
    await waitFor(() => expect(api.find('POST', '/v1/admin/tenants/beta/enable')).toHaveLength(1))
  })
})

describe('users', () => {
  it('invites platform admins and team users, and removes one from a team', async () => {
    const { user } = await openPlatform()
    const section = await sectionOf('Users')
    await within(section).findByText('root@example.com')
    let form = within(section).getByRole('form', { name: 'Invite platform admin' })
    expect(within(form).queryByLabelText('Role')).toBeNull()
    await user.type(within(form).getByLabelText('Email'), 'ops@example.com')
    await user.click(within(form).getByRole('button', { name: 'Invite' }))
    await waitFor(() => expect(api.find('POST', '/v1/admin/users')[0]?.body).toEqual({ email: 'ops@example.com', role: 'admin' }))

    await user.selectOptions(within(section).getByRole('combobox', { name: 'Users of' }), 'beta')
    await within(section).findByText('b@example.com')
    expect(api.find('GET', '/v1/admin/users').map(request => request.query.tenant)).toContain('beta')
    form = within(section).getByRole('form', { name: 'Invite user to Beta' })
    await user.type(within(form).getByLabelText('Email'), 'dev@beta.test')
    await user.selectOptions(within(form).getByLabelText('Role'), 'tadmin')
    await user.click(within(form).getByRole('button', { name: 'Invite' }))
    await waitFor(() => expect(api.find('POST', '/v1/admin/users')[1]?.body).toEqual({ email: 'dev@beta.test', role: 'tadmin', tenantId: 'beta' }))
    const row = (await within(section).findByText('b@example.com')).closest('tr')!
    await user.click(within(row).getByRole('button', { name: 'Remove' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(api.find('DELETE', '/v1/admin/users/b%40example.com')[0]?.query).toEqual({ tenant: 'beta' }))
  })
})

describe('GitHub App', () => {
  it('shows the App status and the Setup/Redirect URIs with copy buttons', async () => {
    const { user } = await openPlatform()
    const section = await sectionOf('GitHub App')
    await within(section).findByText('dshsa-agent')
    expect(within(section).getByText('Valid')).toBeTruthy()
    expect(within(section).getByText('Iv23liAbcdef')).toBeTruthy()
    expect(within(section).getByText('https://panel.test/setup/github/callback')).toBeTruthy()
    expect(within(section).getByText('https://panel.test/setup/github/callback').closest('li')!.textContent).toMatch(/Redirect URI \(formerly Callback URL\)/)
    expect(within(section).getByText('Allow wildcard matching').closest('li')!.textContent)
      .toBe('Leave Allow wildcard matching and Request user authorization (OAuth) during installation unchecked.')
    expect(within(section).getByText(/Redirect on update/)).toBeTruthy()
    // v6.2: the App permission the claim check needs is part of the checklist.
    expect(within(section).getByText('Organization permissions → Members: Read-only').closest('li')!.textContent).toMatch(/^Under Permissions, grant/)
    await user.click(within(section).getByRole('button', { name: 'Copy: https://panel.test/setup/github/callback' }))
    expect(await navigator.clipboard.readText()).toBe('https://panel.test/setup/github/callback')
    await within(section).findByRole('button', { name: 'Copy: https://panel.test/setup/github/callback' })
  })

  it('saves only the fields entered, reads the key from a file, and never shows a secret back', async () => {
    const { user } = await openPlatform()
    const form = await screen.findByRole('form', { name: 'GitHub App settings' })
    for (const input of within(form).getAllByRole('textbox')) expect((input as HTMLInputElement).value).toBe('')
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEsecretkeymaterial\n-----END RSA PRIVATE KEY-----\n'
    await user.upload(within(form).getByLabelText('Upload private key'), new File([pem], 'app.pem', { type: 'application/x-pem-file' }))
    // The uploaded key is kept in memory for the PUT only: never echoed into the page.
    await within(form).findByText('app.pem')
    expect((within(form).getByLabelText('Private key (.pem)') as HTMLTextAreaElement).value).toBe('')
    expect(document.body.innerHTML).not.toContain('MIIEsecretkeymaterial')
    const clientSecret = 'abcdef0123456789abcdef0123456789abcdef01'
    fireEvent.change(within(form).getByLabelText('Client secret'), { target: { value: clientSecret } })
    await user.click(within(form).getByRole('button', { name: 'Save GitHub App' }))
    // The App ID is the current one (not a secret); untouched fields are not sent.
    await waitFor(() => expect(api.find('PUT', '/v1/admin/github-app')[0]?.body).toEqual({ appId: '123456', privateKey: pem, clientSecret }))
    await waitFor(() => expect((within(form).getByLabelText('Private key (.pem)') as HTMLTextAreaElement).value).toBe(''))
    expect((within(form).getByLabelText('Client secret') as HTMLInputElement).value).toBe('')
    expect(within(form).queryByText('app.pem')).toBeNull()
    for (const name of ['Client secret', 'Webhook secret (optional)']) {
      const input = within(form).getByLabelText(name) as HTMLInputElement
      expect(input.type).toBe('password')
      expect(input.autocomplete).toBe('new-password')
    }
    expect(JSON.stringify({ ...sessionStorage })).not.toContain('MIIEsecretkeymaterial')
    for (const value of api.secrets) expect(document.body.innerHTML).not.toContain(value.trim())
  })

  it('checks the form before saving', async () => {
    const { user } = await openPlatform()
    const form = await screen.findByRole('form', { name: 'GitHub App settings' })
    await user.click(within(form).getByRole('button', { name: 'Save GitHub App' }))
    expect(within(form).getByText('Nothing to change.')).toBeTruthy()
    fireEvent.change(within(form).getByLabelText('Webhook secret (optional)'), { target: { value: 'w'.repeat(24) } })
    await user.click(within(form).getByRole('button', { name: 'Save GitHub App' }))
    expect(within(form).getByText('Changing the webhook secret needs the private key too.')).toBeTruthy()
    expect(api.find('PUT', '/v1/admin/github-app')).toHaveLength(0)
    expect(appProblems({ appId: '', privateKey: 'x PRIVATE KEY', webhookSecret: '', clientId: '', clientSecret: '' },
      { app: { set: false }, oauth: { set: false }, checklist: { setupUrl: '', callbackUrl: '', redirectOnUpdate: true } }))
      .toEqual(['Enter the App ID with the private key.'])
    expect(appProblems({ appId: '', privateKey: '', webhookSecret: '', clientId: 'nope', clientSecret: 'short' }, undefined))
      .toEqual(['The Client ID looks like Iv23li…', 'The client secret is 40 hex characters.'])
  })
})

describe('GitHub installations', () => {
  beforeEach(() => {
    api.claims.set(99, claim(99, 'acme', 'big-org', { status: 'pending', pendingReason: 'not_org_admin', githubLogin: 'dev-gh',
      claimedBy: 'dev@example.com', claimedAt: '2026-10-31T08:00:00Z' }))
    api.claims.set(100, claim(100, 'beta', 'someone', { status: 'pending', pendingReason: 'not_own_account', accountType: 'User',
      githubLogin: 'b-gh', claimedBy: 'b@example.com', claimedAt: '2026-10-31T09:00:00Z' }))
  })
  const rowOf = async (account: string) => (await within(await sectionOf('GitHub installations')).findByRole('row', { name: `Claim of ${account}` }))

  it('lists each pending claim with team, account type, GitHub login, claimer and reason', async () => {
    await openPlatform()
    const section = await sectionOf('GitHub installations')
    const org = within(await rowOf('big-org'))
    for (const value of ['Acme', 'acme', 'organization', 'dev-gh', 'dev@example.com', 'dev-gh is not an admin of big-org']) expect(org.getByText(value)).toBeTruthy()
    const user = within(await rowOf('someone'))
    for (const value of ['Beta', 'user', 'b-gh', 'b@example.com', "installed on another person's account, not b-gh's own"]) expect(user.getByText(value)).toBeTruthy()
    expect(org.getByText('pending')).toBeTruthy()
    // Active claims (77, 88) are listed too, with their team and a Release action instead of Approve/Reject.
    const active = within(within(section).getByRole('row', { name: 'Claim of acme-org' }))
    for (const value of ['Acme', 'active', 'installation 77']) expect(active.getByText(value)).toBeTruthy()
    expect(active.getByRole('button', { name: 'Release' })).toBeTruthy()
    expect(active.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(api.find('GET', '/v1/admin/installations')[0]?.query).toEqual({ status: 'all' })
  })

  it('approves after confirming, then refreshes', async () => {
    const { user } = await openPlatform()
    await user.click(within(await rowOf('big-org')).getByRole('button', { name: 'Approve' }))
    const dialog = screen.getByRole('dialog', { name: 'Approve big-org for Acme?' })
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(api.find('POST', '/v1/admin/installations/99/approve')).toHaveLength(0)
    await user.click(within(await rowOf('big-org')).getByRole('button', { name: 'Approve' }))
    await user.click(within(screen.getByRole('dialog', { name: 'Approve big-org for Acme?' })).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(api.find('POST', '/v1/admin/installations/99/approve')).toHaveLength(1))
    expect(api.find('POST', '/v1/admin/installations/99/approve')[0]!.body).toEqual({})
    const section = await sectionOf('GitHub installations')
    await waitFor(() => expect(within(within(section).getByRole('row', { name: 'Claim of big-org' })).queryByRole('button', { name: 'Approve' })).toBeNull())
    expect(api.claims.get(99)).toMatchObject({ status: 'active', approvedBy: 'op@example.com' })
    expect(api.claims.get(99)?.pendingReason).toBeUndefined()
    expect(within(section).getByRole('row', { name: 'Claim of someone' })).toBeTruthy()
  })

  it('rejects (releases) after confirming, then refreshes; with none left it says so', async () => {
    for (const id of [77, 88, 99]) api.claims.delete(id)
    const { user } = await openPlatform()
    await user.click(within(await rowOf('someone')).getByRole('button', { name: 'Reject' }))
    await user.click(within(screen.getByRole('dialog', { name: 'Reject someone for Beta?' })).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(api.find('DELETE', '/v1/admin/installations/100')).toHaveLength(1))
    const section = await sectionOf('GitHub installations')
    expect(await within(section).findByText('No installation is linked to any team.')).toBeTruthy()
    expect(api.claims.has(100)).toBe(false)
    expect(api.find('GET', '/v1/admin/installations').length).toBeGreaterThan(1)
  })

  it('shows the error and refreshes when a claim was already handled elsewhere', async () => {
    const { user } = await openPlatform()
    await rowOf('big-org')
    api.claims.set(99, { ...api.claims.get(99)!, status: 'active' })
    await user.click(within(await rowOf('big-org')).getByRole('button', { name: 'Approve' }))
    await user.click(within(screen.getByRole('dialog', { name: 'Approve big-org for Acme?' })).getByRole('button', { name: 'Confirm' }))
    expect(await screen.findByText('No pending claim for this installation')).toBeTruthy()
    const section = await sectionOf('GitHub installations')
    await waitFor(() => expect(within(within(section).getByRole('row', { name: 'Claim of big-org' })).queryByRole('button', { name: 'Approve' })).toBeNull())
  })

  it('releases an active claim no repository uses', async () => {
    api.cellRecords.splice(0, api.cellRecords.length, ...api.cellRecords.filter(cell => cell.tenantId !== 'beta'))
    const { user } = await openPlatform()
    await user.click(within(await rowOf('other-org')).getByRole('button', { name: 'Release' }))
    await user.click(within(screen.getByRole('dialog', { name: 'Release other-org from Beta?' })).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(api.claims.has(88)).toBe(false))
    expect(api.find('DELETE', '/v1/admin/installations/88')[0]?.query).toEqual({})
    expect(await screen.findByText('Released other-org. It can be linked again.')).toBeTruthy()
  })

  it('a release refused for repositories in use names them; Release anyway forces it and reports them, changing no cell', async () => {
    const { user } = await openPlatform()
    await user.click(within(await rowOf('acme-org')).getByRole('button', { name: 'Release' }))
    await user.click(within(screen.getByRole('dialog', { name: 'Release acme-org from Acme?' })).getByRole('button', { name: 'Confirm' }))
    const dialog = await screen.findByRole('dialog', { name: 'acme-org is still in use' })
    expect(dialog.textContent).toMatch(/acme\/widgets, acme\/gadgets/)
    expect(api.claims.has(77)).toBe(true)
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(api.find('DELETE', '/v1/admin/installations/77')).toHaveLength(1)
    await user.click(within(await rowOf('acme-org')).getByRole('button', { name: 'Release' }))
    await user.click(within(screen.getByRole('dialog', { name: 'Release acme-org from Acme?' })).getByRole('button', { name: 'Confirm' }))
    await user.click(within(await screen.findByRole('dialog', { name: 'acme-org is still in use' })).getByRole('button', { name: 'Release anyway' }))
    await waitFor(() => expect(api.claims.has(77)).toBe(false))
    expect(api.find('DELETE', '/v1/admin/installations/77').map(request => request.query)).toEqual([{}, {}, { force: 'true' }])
    expect(await screen.findByText(/Released acme-org\. Still on it: acme\/widgets, acme\/gadgets/)).toBeTruthy()
    expect(api.cellRecords.filter(cell => cell.tenantId === 'acme').map(cell => cell.status)).toEqual(['active', 'paused'])
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('authorization', () => {
  it('a tenant admin never calls /v1/admin', async () => {
    api.me.platformAdmin = false
    api.claims.set(99, claim(99, 'acme', 'big-org', { status: 'pending', pendingReason: 'not_org_admin' }))
    openTab('platform')
    renderPanel()
    await screen.findByText('Waiting for a person')
    expect(screen.queryByRole('tab', { name: 'Platform' })).toBeNull()
    expect(screen.queryByRole('heading', { name: /^GitHub installations/ })).toBeNull()
    expect(api.requests.some(request => request.path.startsWith('/v1/admin'))).toBe(false)
  })

  it('the platform-only routes refuse anyone else', async () => {
    api.me.platformAdmin = false
    const call = (method: string, path: string, body?: unknown) => api.fetch(`https://api.test${path}`, { method,
      headers: { authorization: `Bearer ${ID_TOKEN}`, 'x-orchestrator-request': '1', ...body === undefined ? {} : { 'content-type': 'application/json' } },
      ...body === undefined ? {} : { body: JSON.stringify(body) } })
    for (const [method, path, body] of [['GET', '/v1/admin/installations?status=pending'], ['POST', '/v1/admin/installations/99/approve', {}],
      ['DELETE', '/v1/admin/installations/99']] as const) {
      const response = await call(method, path, body)
      expect(response.status, `${method} ${path}`).toBe(403)
    }
  })
})
