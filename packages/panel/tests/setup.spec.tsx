import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { api, claim, useFakeApi } from './fake-api.ts'
import { openTab, renderPanel } from './render.tsx'

useFakeApi()

const heading = (name: string) => screen.findByRole('heading', { name: new RegExp(`^${name}`) })
const sectionOf = async (name: string) => (await heading(name)).closest('section')!
async function openSetup(section = 'repositories') {
  openTab('setup', section)
  const panel = renderPanel()
  await screen.findByRole('heading', { name: 'Team setup · Acme' })
  return panel
}

describe('onboarding checklist', () => {
  it('shows each step from GET setup and opens the matching section', async () => {
    api.feishu.delete('acme')
    const { user } = await openSetup()
    const list = (await sectionOf('Onboarding checklist')).querySelector('ol')!
    await waitFor(() => expect(list.querySelectorAll('li')).toHaveLength(5))
    const state = [...list.querySelectorAll('li')].map(item => [item.querySelector('.checklist-label')!.textContent, item.dataset.done])
    expect(state).toEqual([['GitHub App installed and linked to this team', 'true'], ['A repository added', 'true'],
      ['Feishu / Lark bot connected', 'false'], ['A chat bound to a repository', 'true'], ['People allowed to start work', 'unknown']])
    await user.click(within(list).getByRole('button', { name: 'Feishu / Lark' }))
    expect(await heading('Feishu / Lark bot')).toBeTruthy()
    await user.click(within(list).getByRole('button', { name: 'Open the Policy form' }))
    expect(await screen.findByRole('form', { name: 'Policy form' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Settings' }).getAttribute('aria-selected')).toBe('true')
  })

  it('says the App step is waiting for approval when the only claim is pending', async () => {
    api.claims.set(77, claim(77, 'acme', 'acme-org', { status: 'pending', pendingReason: 'not_org_admin' }))
    await openSetup()
    const list = (await sectionOf('Onboarding checklist')).querySelector('ol')!
    await waitFor(() => expect(list.querySelector('li')!.dataset.done).toBe('waiting'))
    expect(within(list.querySelector('li')!).getByText('Waiting for approval')).toBeTruthy()
  })

  it('a pending claim next to an active one does not change a done App step', async () => {
    api.claims.set(99, claim(99, 'acme', 'big-org', { status: 'pending', pendingReason: 'not_org_admin' }))
    await openSetup()
    const list = (await sectionOf('Onboarding checklist')).querySelector('ol')!
    await waitFor(() => expect(list.querySelector('li')!.dataset.done).toBe('true'))
    expect(within(list.querySelector('li')!).getByText('Done')).toBeTruthy()
  })
})

describe('repositories', () => {
  it('opens the App install page in a new tab without an opener', async () => {
    await openSetup()
    const link = await screen.findByRole('link', { name: 'Install / configure the GitHub App' })
    expect(link.getAttribute('href')).toBe('https://github.com/apps/dshsa-agent/installations/new')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
  })

  it('Link installations remembers the team under the state, then leaves for GitHub', async () => {
    const { user, navigate } = await openSetup()
    await user.click(await screen.findByRole('button', { name: 'Link installations' }))
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1))
    const url = new URL(navigate.mock.calls[0]![0])
    expect(`${url.origin}${url.pathname}`).toBe('https://github.com/login/oauth/authorize')
    const state = url.searchParams.get('state')!
    expect(sessionStorage.getItem(`dshsa.panel.ghlink.${state}`)).toBe('acme')
    expect(api.find('POST', '/v1/tenants/acme/setup/github/link-start')).toHaveLength(1)
  })

  it('refuses to follow a link-start URL that is not the GitHub OAuth authorize page', async () => {
    const real = api.fetch
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => String(input).endsWith('/github/link-start')
      ? new Response(JSON.stringify({ url: `https://evil.example/login/oauth/authorize?client_id=I&state=${'s'.repeat(40)}`, expiresInSec: 600 }),
        { status: 200, headers: { 'content-type': 'application/json' } })
      : real(input, init)) as typeof fetch)
    const { user, navigate } = await openSetup()
    await user.click(await screen.findByRole('button', { name: 'Link installations' }))
    expect(await screen.findByText(/unexpected GitHub sign-in URL/)).toBeTruthy()
    expect(navigate).not.toHaveBeenCalled()
    expect(Object.keys(sessionStorage).some(key => key.startsWith('dshsa.panel.ghlink.'))).toBe(false)
  })

  it('does not offer an install link that is not github.com/apps/…', async () => {
    const real = api.fetch
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await real(input, init)
      if (!new URL(String(input)).pathname.endsWith('/setup')) return response
      const value = await response.json() as { github: { installUrl?: string } }
      value.github.installUrl = 'https://evil.example/apps/dshsa-agent/installations/new'
      return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch)
    await openSetup()
    expect(await screen.findByRole('button', { name: 'Install / configure the GitHub App' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Install / configure the GitHub App' })).toBeNull()
  })

  it('without a platform GitHub App, explains it and disables linking', async () => {
    api.oauthConfigured = false
    await openSetup()
    expect(await screen.findByText('GitHub App not set up')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Link installations' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('link', { name: 'Install / configure the GitHub App' })).toBeNull()
  })

  it('lists the repositories of each linked installation and adds one by its GitHub ids', async () => {
    const { user } = await openSetup()
    const install = await screen.findByRole('group', { name: 'Installation acme-org' })
    // Only this team's claims are listed (88 belongs to beta).
    expect(screen.queryByRole('group', { name: 'Installation other-org' })).toBeNull()
    await within(install).findByText('acme/tools')
    expect(within(install).getAllByText(/^Added · /)).toHaveLength(2)
    expect((within(install).getByRole('button', { name: 'Add acme/legacy' }) as HTMLButtonElement).disabled).toBe(true)
    // No id is typed anywhere on the page.
    expect(screen.queryAllByRole('spinbutton')).toEqual([])
    await user.click(within(install).getByRole('button', { name: 'Add acme/tools' }))
    await waitFor(() => expect(api.find('POST', '/v1/tenants/acme/setup/cells')[0]?.body).toEqual({ installationId: 77, repoId: 5 }))
    const row = within(install).getByText('acme/tools').closest('li')!
    await within(row).findByText('Added · active')
    expect(within(install).queryByRole('button', { name: 'Add acme/tools' })).toBeNull()
    // The new cell reaches the picker without a reload.
    const picker = screen.getByRole('combobox', { name: 'Cell' }) as HTMLSelectElement
    await waitFor(() => expect([...picker.options].map(option => option.value)).toContain('acme--gh5'))
    expect(await screen.findByText(/Added acme\/tools/)).toBeTruthy()
  })

  it('shows pending installations as waiting for approval, with the reason, and never asks for their repositories', async () => {
    api.claims.set(99, claim(99, 'acme', 'big-org', { status: 'pending', pendingReason: 'not_org_admin', claimedAt: '2026-10-31T10:00:00Z' }))
    api.claims.set(100, claim(100, 'acme', 'someone', { status: 'pending', pendingReason: 'not_own_account', accountType: 'User' }))
    api.claims.set(101, claim(101, 'acme', 'quiet-org', { status: 'pending', pendingReason: 'membership_unavailable' }))
    api.repos.set(99, [{ id: 9, name: 'secret', owner: 'big-org', fullName: 'big-org/secret', private: true, archived: false, defaultBranch: 'main' }])
    await openSetup()
    const section = await sectionOf('Linked installations')
    // The active installation still lists its repositories.
    await within(await within(section).findByRole('group', { name: 'Installation acme-org' })).findByText('acme/tools')
    const pending = {
      'big-org': 'you are not an admin of big-org',
      someone: "installed on another person's account",
      'quiet-org': 'GitHub did not confirm your org role (the App may lack Organization → Members: read)',
    }
    for (const [account, reason] of Object.entries(pending)) {
      const group = within(section).getByRole('group', { name: `Installation ${account}` })
      expect(within(group).getByText('Waiting for platform approval')).toBeTruthy()
      expect(within(group).getByText(reason)).toBeTruthy()
      // Its only action is Unlink (withdraw the claim).
      expect(within(group).getAllByRole('button').map(button => button.textContent)).toEqual(['Unlink'])
      expect(within(group).queryByRole('list')).toBeNull()
    }
    expect(screen.queryByText('big-org/secret')).toBeNull()
    for (const id of [99, 100, 101]) expect(api.find('GET', `/v1/tenants/acme/setup/github/installations/${id}/repositories`)).toEqual([])
    expect(api.find('GET', '/v1/tenants/acme/setup/github/installations/77/repositories').length).toBeGreaterThan(0)
  })

  it('unlink is refused while repositories use the installation, naming them; then unlinks after they are disabled', async () => {
    const { user } = await openSetup()
    const install = await screen.findByRole('group', { name: 'Installation acme-org' })
    await user.click(within(install).getByRole('button', { name: 'Unlink' }))
    await user.click(within(screen.getByRole('dialog', { name: 'Unlink acme-org from Acme?' })).getByRole('button', { name: 'Confirm' }))
    expect(await screen.findByText('Repositories still use this installation (acme/widgets, acme/gadgets); disable them first')).toBeTruthy()
    expect(api.claims.has(77)).toBe(true)
    for (const cell of api.cellRecords) if (cell.tenantId === 'acme') cell.status = 'disabled'
    await user.click(within(install).getByRole('button', { name: 'Unlink' }))
    await user.click(within(screen.getByRole('dialog', { name: 'Unlink acme-org from Acme?' })).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(api.claims.has(77)).toBe(false))
    expect(api.find('DELETE', '/v1/tenants/acme/setup/github/installations/77')).toHaveLength(2)
    expect(await screen.findByText('Unlinked acme-org.')).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Installation acme-org' })).toBeNull())
    // Another team's claim is never touched.
    expect(api.claims.has(88)).toBe(true)
  })

  it('pauses, enables and (after confirming) disables a repository', async () => {
    const { user } = await openSetup()
    const table = (await sectionOf('Repositories of this team')).querySelector('table')!
    await user.click(within(table).getByRole('button', { name: 'Pause acme/widgets' }))
    await waitFor(() => expect(api.find('POST', '/v1/tenants/acme/setup/cells/acme--gh1/pause')).toHaveLength(1))
    await user.click(await within(table).findByRole('button', { name: 'Enable acme/gadgets' }))
    await waitFor(() => expect(api.find('POST', '/v1/tenants/acme/setup/cells/acme--gh2/enable')).toHaveLength(1))
    const row = within(table).getByText('acme/gadgets').closest('tr')!
    await waitFor(() => expect(within(row).getByText('active')).toBeTruthy())
    await user.click(within(row).getByRole('button', { name: 'Disable' }))
    await user.click(within(screen.getByRole('dialog', { name: 'Disable acme/gadgets?' })).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(api.find('POST', '/v1/tenants/acme/setup/cells/acme--gh2/disable')).toHaveLength(1))
    await waitFor(() => expect(within(row).getByText('disabled')).toBeTruthy())
  })
})

describe('feishu / lark', () => {
  it('shows status and health, never a secret, and saves the bot write-only', async () => {
    const { user } = await openSetup('feishu')
    const section = await sectionOf('Feishu / Lark bot')
    await within(section).findByText('Connected')
    expect(within(section).getByText('Listening for bot events')).toBeTruthy()
    expect(within(section).getByText('cli_acme1')).toBeTruthy()
    const form = within(section).getByRole('form', { name: 'Feishu bot credentials' })
    const secret = within(form).getByLabelText('App Secret') as HTMLInputElement
    expect(secret.type).toBe('password')
    expect(secret.value).toBe('')
    expect(secret.placeholder).toMatch(/^Set\./)
    await user.selectOptions(within(form).getByLabelText('Platform'), 'lark')
    await user.type(within(form).getByLabelText('App ID'), 'cli_new42')
    await user.type(secret, 'super-secret-value')
    await user.type(within(form).getByLabelText('Encrypt Key (optional)'), 'enc-key-value')
    await user.click(within(form).getByRole('button', { name: 'Save bot' }))
    await waitFor(() => expect(api.find('PUT', '/v1/tenants/acme/setup/feishu')[0]?.body).toEqual({ domain: 'lark', appId: 'cli_new42',
      appSecret: 'super-secret-value', encryptKey: 'enc-key-value' }))
    await within(section).findByText('Starting')
    expect(secret.value).toBe('')
    expect((within(form).getByLabelText('Encrypt Key (optional)') as HTMLInputElement).value).toBe('')
    for (const value of api.secrets) expect(document.body.innerHTML).not.toContain(value)
  })

  it('keeps the current App ID, but requires the secret on every save', async () => {
    const { user } = await openSetup('feishu')
    const form = await screen.findByRole('form', { name: 'Feishu bot credentials' })
    await user.click(within(form).getByRole('button', { name: 'Save bot' }))
    expect(await within(form).findByText(/Enter the App Secret/)).toBeTruthy()
    expect(api.find('PUT', '/v1/tenants/acme/setup/feishu')).toHaveLength(0)
    await user.type(within(form).getByLabelText('App Secret'), 'another-secret')
    await user.click(within(form).getByRole('button', { name: 'Save bot' }))
    await waitFor(() => expect(api.find('PUT', '/v1/tenants/acme/setup/feishu')[0]?.body).toEqual({ domain: 'feishu', appId: 'cli_acme1',
      appSecret: 'another-secret' }))
  })

  it('includes the Feishu console checklist', async () => {
    await openSetup('feishu')
    const checklist = await sectionOf('Feishu / Lark console checklist')
    expect(checklist.textContent).toContain('im.message.receive_v1')
    expect(checklist.textContent).toContain('persistent connection')
    expect(checklist.textContent).toContain('obtain group members')
    expect(checklist.textContent).toContain('publish')
  })
})

describe('chats', () => {
  it('lists seen chats with their repository and binds one from a dropdown', async () => {
    const { user } = await openSetup('chats')
    const section = await sectionOf('Chats')
    await within(section).findByText('Ops room')
    expect(within(section).getByText('2 messages waiting for a binding')).toBeTruthy()
    const select = within(section).getByRole('combobox', { name: 'Repository for Ops room' }) as HTMLSelectElement
    expect([...select.options].map(option => option.textContent)).toEqual(['Choose a repository…', 'acme/widgets', 'acme/gadgets'])
    await user.selectOptions(select, 'acme--gh2')
    await waitFor(() => expect(api.find('PUT', '/v1/tenants/acme/setup/chats/oc_ops')[0]?.body).toEqual({ cellId: 'acme--gh2' }))
    await waitFor(() => expect(select.value).toBe('acme--gh2'))
    // No chat id is typed.
    expect(within(section).queryAllByRole('textbox')).toEqual([])
  })

  it('unbinds after confirmation', async () => {
    const { user } = await openSetup('chats')
    const row = (await screen.findByText('Team chat')).closest('tr')!
    await user.click(within(row).getByRole('button', { name: 'Unbind' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(api.find('DELETE', '/v1/tenants/acme/setup/chats/oc_team')).toHaveLength(1))
    await waitFor(() => expect(within(row).queryByRole('button', { name: 'Unbind' })).toBeNull())
  })

  it('tells the user how to make a chat appear', async () => {
    api.chats.set('acme', [])
    api.bindings.set('acme', [])
    await openSetup('chats')
    expect(await screen.findByText('No chats yet')).toBeTruthy()
    expect(screen.getByText(/Add the bot to a group and @ it once/)).toBeTruthy()
  })
})

describe('users', () => {
  it('lists, invites and removes team users', async () => {
    const { user } = await openSetup('users')
    const section = await sectionOf('Users')
    await within(section).findByText('dev@example.com')
    // You cannot remove yourself.
    expect(within(within(section).getByText('op@example.com').closest('tr')!).queryByRole('button')).toBeNull()
    const form = within(section).getByRole('form', { name: 'Invite user' })
    await user.type(within(form).getByLabelText('Email'), 'new@example.com')
    await user.selectOptions(within(form).getByLabelText('Role'), 'tadmin')
    await user.click(within(form).getByRole('button', { name: 'Invite' }))
    await waitFor(() => expect(api.find('POST', '/v1/tenants/acme/setup/users')[0]?.body).toEqual({ email: 'new@example.com', role: 'tadmin' }))
    await within(section).findByText('new@example.com')
    const row = within(section).getByText('dev@example.com').closest('tr')!
    await user.click(within(row).getByRole('button', { name: 'Remove' }))
    await user.click(within(screen.getByRole('dialog', { name: 'Remove dev@example.com?' })).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(api.find('DELETE', '/v1/tenants/acme/setup/users/dev%40example.com')).toHaveLength(1))
  })

  it('checks the email before inviting', async () => {
    const { user } = await openSetup('users')
    const form = await screen.findByRole('form', { name: 'Invite user' })
    await user.type(within(form).getByLabelText('Email'), 'not-an-email')
    await user.click(within(form).getByRole('button', { name: 'Invite' }))
    expect(within(form).getByText('Enter an email address.')).toBeTruthy()
    expect(api.find('POST', '/v1/tenants/acme/setup/users')).toHaveLength(0)
  })
})
