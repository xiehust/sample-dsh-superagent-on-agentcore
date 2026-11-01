import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { api, useFakeApi } from './fake-api.ts'
import { openTab, renderPanel } from './render.tsx'

useFakeApi()

const tabNames = () => screen.getAllByRole('tab').map(tab => tab.textContent)
const asMember = () => { api.me.tenants[0]!.role = 'member' }

describe('role-gated tabs', () => {
  it('a member sees the cell pages only', async () => {
    asMember()
    renderPanel()
    await screen.findByText('Waiting for a person')
    expect(tabNames()).toEqual(['Overview', 'Execution', 'Settings'])
    expect(screen.getByText('Member')).toBeTruthy()
  })

  it('a tenant admin also sees Team setup, not Platform', async () => {
    renderPanel()
    await screen.findByText('Waiting for a person')
    expect(tabNames()).toEqual(['Overview', 'Execution', 'Settings', 'Team setup'])
    expect(screen.getByText('Team admin')).toBeTruthy()
  })

  it('a platform admin sees Team setup and Platform', async () => {
    api.me.platformAdmin = true
    renderPanel()
    await screen.findByText('Waiting for a person')
    expect(tabNames()).toEqual(['Overview', 'Execution', 'Settings', 'Team setup', 'Platform'])
    expect(screen.getByText('Platform admin')).toBeTruthy()
  })

  it('the role follows the selected team', async () => {
    const { user } = renderPanel()
    await screen.findByText('Waiting for a person')
    expect(tabNames()).toContain('Team setup')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Team' }), 'beta')
    await waitFor(() => expect(tabNames()).not.toContain('Team setup'))
    expect((screen.getByRole('combobox', { name: 'Cell' }) as HTMLSelectElement).value).toBe('beta--gh3')
  })

  it('a remembered tab the role may not open falls back to Overview', async () => {
    asMember()
    openTab('setup')
    renderPanel()
    await screen.findByText('Waiting for a person')
    expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true')
    expect(api.requests.some(request => request.path.includes('/setup'))).toBe(false)
  })

  it('a platform admin without any team gets the Platform page', async () => {
    api.me.platformAdmin = true
    api.me.tenants = []
    api.tenants = []
    api.cells = []
    renderPanel()
    expect(await screen.findByRole('heading', { name: 'Platform' })).toBeTruthy()
    expect(tabNames()).toEqual(['Platform'])
  })

  it('a team admin of a team without repositories is pointed to Team setup', async () => {
    api.cells = api.cells.filter(cell => cell.tenantId !== 'acme')
    const { user } = renderPanel()
    expect(await screen.findByText('This team has no repositories yet.')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Add a repository' }))
    expect(await screen.findByRole('heading', { name: /^Linked installations/ })).toBeTruthy()
  })
})

describe('members: read plus Stop/Retry', () => {
  it('shows settings read-only: no pause, no save path, no pickers', async () => {
    asMember()
    openTab('settings')
    renderPanel()
    expect(await screen.findByRole('note')).toBeTruthy()
    expect(screen.getByRole('note').textContent).toContain('Read-only')
    await screen.findByText('Running')
    expect(screen.queryByRole('button', { name: /processing/ })).toBeNull()
    const evalJson = await screen.findByRole('textbox', { name: 'Eval JSON' }) as HTMLTextAreaElement
    expect(evalJson.readOnly).toBe(true)
    expect((screen.getByRole('textbox', { name: 'Prompt config JSON' }) as HTMLTextAreaElement).readOnly).toBe(true)
    // The Policy form renders disabled, without pickers, add or remove buttons.
    const form = await screen.findByRole('form', { name: 'Policy form' })
    expect(within(form).queryByRole('button', { name: /Add|Remove|Sync/ })).toBeNull()
    expect((screen.getByRole('combobox', { name: 'Eval mode' }) as HTMLSelectElement).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: 'Manage chats' })).toBeNull()
  })

  it('hides problem actions on the Overview', async () => {
    asMember()
    api.paused = true
    renderPanel()
    const problems = (await screen.findByText('Problems')).closest('section')!
    expect(within(problems).getByText('Processing is paused')).toBeTruthy()
    expect(within(problems).queryByRole('button')).toBeNull()
  })

  it('sees the recently ignored list', async () => {
    asMember()
    renderPanel()
    const section = (await screen.findByRole('heading', { name: /Recently ignored/ })).closest('section')!
    expect(await within(section).findByText('@bot hi')).toBeTruthy()
    expect(within(section).queryByRole('button')).toBeNull()
  })

  it('may still stop a ticket', async () => {
    asMember()
    openTab('execution')
    const { user } = renderPanel()
    await user.click(await screen.findByRole('button', { name: 'Fix login regression' }))
    await user.click(await screen.findByRole('button', { name: 'Stop' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(api.count('POST tickets/t1/stop')).toBe(1))
  })

  it('the fake API refuses a member mutation like panel-api (403)', async () => {
    asMember()
    const { client } = renderPanel()
    await screen.findByText('Waiting for a person')
    await expect(client.call('acme--gh1', 'POST executor/pause', { body: { paused: true } })).rejects.toMatchObject({ status: 403 })
    await expect(client.setup.status('acme')).rejects.toMatchObject({ status: 403 })
    await expect(client.admin.tenants()).rejects.toMatchObject({ status: 403 })
    expect(api.paused).toBe(false)
  })
})
