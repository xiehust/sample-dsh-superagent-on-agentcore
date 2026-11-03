import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { api, useFakeApi } from './fake-api.ts'
import { renderPanel } from './render.tsx'

useFakeApi()

/** Opens Settings with Models → Advanced (JSON), where the Eval and Executor JSON editors live. */
async function openSettings() {
  sessionStorage.setItem('dshsa.panel.tab', 'settings')
  const panel = renderPanel()
  await panel.user.click(within(await screen.findByRole('group', { name: 'Models editor' })).getByRole('button', { name: 'Advanced (JSON)' }))
  await screen.findByRole('textbox', { name: 'Eval JSON' })
  return panel
}
async function openPolicyJson() {
  const panel = await openSettings()
  await panel.user.click(within(screen.getByRole('group', { name: 'Policy editor' })).getByRole('button', { name: 'Advanced (JSON)' }))
  await screen.findByRole('textbox', { name: 'Policy JSON' })
  return panel
}
const edit = (name: string, value: unknown) =>
  fireEvent.change(screen.getByRole('textbox', { name }), { target: { value: JSON.stringify(value, null, 2) } })

describe('settings blocks', () => {
  it('shows the save bar only when dirty and saves with the revision the edit started from', async () => {
    await openPolicyJson()
    expect(screen.queryByRole('region', { name: 'Policy unsaved changes' })).toBeNull()
    edit('Policy JSON', { rules: [] })
    const bar = screen.getByRole('region', { name: 'Policy unsaved changes' })
    fireEvent.click(within(bar).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.find('PUT', '/v1/cells/acme--gh1/api/settings/policy')).toHaveLength(1))
    expect(api.find('PUT', '/v1/cells/acme--gh1/api/settings/policy')[0]!.body).toEqual({ value: { rules: [] }, revision: 3 })
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Policy unsaved changes' })).toBeNull())
    expect(api.settings.policy.revision).toBe(4)
  })

  it('reports a 409 as changed elsewhere and reloads on request', async () => {
    await openSettings()
    edit('Eval JSON', { mode: 'auto' })
    api.settings.eval = { value: { mode: 'off', timeoutSeconds: 120, model: null, replyOnIgnore: true, replyModel: null }, revision: 2 } // someone else saved meanwhile
    fireEvent.click(within(screen.getByRole('region', { name: 'Eval unsaved changes' })).getByRole('button', { name: 'Save' }))
    const alert = await screen.findByText(/Changed elsewhere/)
    expect(api.find('PUT', '/v1/cells/acme--gh1/api/settings/eval')[0]!.body).toEqual({ value: { mode: 'auto' }, revision: 1 })
    expect(api.settings.eval.value).toEqual({ mode: 'off', timeoutSeconds: 120, model: null, replyOnIgnore: true, replyModel: null })
    fireEvent.click(within(alert.closest('[role="alert"]') as HTMLElement).getByRole('button', { name: 'Reload' }))
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Eval JSON' }) as HTMLTextAreaElement).value)
      .toBe(JSON.stringify({ mode: 'off', timeoutSeconds: 120, model: null, replyOnIgnore: true, replyModel: null }, null, 2)))
    expect(screen.queryByRole('region', { name: 'Eval unsaved changes' })).toBeNull()
  })

  it('does not save invalid JSON', async () => {
    await openSettings()
    fireEvent.change(screen.getByRole('textbox', { name: 'Executor (model, workers) JSON' }), { target: { value: '{ "model": ' } })
    expect(screen.getByText(/Not valid JSON/)).toBeTruthy()
    const save = within(screen.getByRole('region', { name: 'Executor (model, workers) unsaved changes' }))
      .getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(api.find('PUT', '/v1/cells/acme--gh1/api/settings/executor')).toHaveLength(0)
  })

  it('saves prompts with baseRevision', async () => {
    await openSettings()
    await screen.findByRole('textbox', { name: 'Prompt config JSON' })
    edit('Prompt config JSON', { communication: 'Be thorough.', scope: '', delivery: '', skills: {} })
    fireEvent.click(within(screen.getByRole('region', { name: 'Prompt config unsaved changes' })).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.prompts.revision).toBe(5))
    expect(api.find('PUT', '/v1/cells/acme--gh1/api/prompts')[0]!.body).toEqual({ config: { communication: 'Be thorough.', scope: '', delivery: '', skills: {} },
      baseRevision: 4 })
  })

  it('pauses and resumes processing', async () => {
    const { user } = await openSettings()
    await user.click(await screen.findByRole('button', { name: 'Pause processing' }))
    await screen.findByRole('button', { name: 'Resume processing' })
    expect(api.paused).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Resume processing' }))
    await screen.findByRole('button', { name: 'Pause processing' })
    expect(api.find('POST', '/v1/cells/acme--gh1/api/executor/pause').map(request => request.body)).toEqual([{ paused: true },
      { paused: false }])
  })
})

describe('chat bindings', () => {
  it('lists the tenant\'s bindings read-only and sends tenant admins to Team setup → Chats', async () => {
    const { user } = await openSettings()
    const section = (await screen.findByRole('heading', { name: /^Feishu chat bindings/ })).closest('section')!
    expect(await within(section).findByText('Team chat')).toBeTruthy()
    expect(within(section).getByText('acme/widgets')).toBeTruthy()
    expect(within(section).queryByRole('textbox')).toBeNull()
    await user.click(within(section).getByRole('button', { name: 'Manage chats' }))
    expect(await screen.findByRole('heading', { name: /^Chats/ })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Team setup' }).getAttribute('aria-selected')).toBe('true')
    expect(within(screen.getByRole('group', { name: 'Setup section' })).getByRole('button', { name: 'Chats' }).getAttribute('aria-pressed')).toBe('true')
  })
})
