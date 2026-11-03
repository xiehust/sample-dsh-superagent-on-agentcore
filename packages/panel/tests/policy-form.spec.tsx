import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { fieldProblems, groupIssues } from '../src/policy-form.tsx'
import type { RowsField } from '../src/types.ts'
import { api, settingsSources, text, useFakeApi } from './fake-api.ts'
import { openTab, renderPanel } from './render.tsx'

useFakeApi()

async function openForm() {
  openTab('settings')
  const panel = renderPanel()
  const form = await screen.findByRole('form', { name: 'Policy form' })
  return { ...panel, form }
}
const fieldset = (form: HTMLElement, title: string) => within(form).getByRole('group', { name: `${title} policy` })
const saveBar = () => screen.getByRole('region', { name: 'Policy form unsaved changes' })
const puts = () => api.find('PUT', '/v1/cells/acme--gh1/api/settings/policy')
const RULES = [{ id: 'r1', name: 'Bugs', enabled: true, instruction: 'Fix reported bugs.' }]

describe('policy form', () => {
  it('renders each Source from its policy.fields metadata', async () => {
    const { form } = await openForm()
    const github = fieldset(form, 'GitHub')
    expect(within(github).getByText('GitHub accounts that may originate work')).toBeTruthy()
    expect(within(github).getByText('Bots whose comments may become candidates')).toBeTruthy()
    expect(within(github).getByRole('combobox', { name: 'GitHub · New Issues: Not on the list, addressed' })).toBeTruthy()
    const feishu = fieldset(form, 'Feishu')
    expect(within(feishu).getByText('Feishu users who may originate work')).toBeTruthy()
    expect([...(within(feishu).getByLabelText('Sync chat') as HTMLSelectElement).options].map(option => option.textContent))
      .toEqual(['Do not sync', 'Team chat'])
    // Inapplicable admission cells have no control.
    expect(within(github).queryByRole('combobox', { name: 'GitHub · Default branch CI: On the list, not addressed' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Policy form unsaved changes' })).toBeNull()
  })

  it('round trip: pickers add rows, admission switches, save sends the policy body with the revision', async () => {
    const { user, form } = await openForm()
    const github = fieldset(form, 'GitHub')
    await user.click(within(github).getByRole('button', { name: 'Add from repo collaborators' }))
    const collaborators = await within(github).findByRole('group', { name: 'Repository collaborators' })
    await user.click(within(collaborators).getByRole('button', { name: 'Add bob' }))
    expect(within(collaborators).getByRole('button', { name: 'Add all (2)' })).toBeTruthy()
    await user.click(within(collaborators).getByRole('button', { name: 'Add all (2)' }))
    expect(within(collaborators).getAllByText('Listed')).toHaveLength(3)

    const feishu = fieldset(form, 'Feishu')
    await user.click(await within(feishu).findByRole('button', { name: 'Add all members of Team chat' }))
    await within(feishu).findByDisplayValue('ou_ben')
    expect(await screen.findByText('Added 2 people from Team chat.')).toBeTruthy()
    expect(api.find('GET', '/v1/cells/acme--gh1/api/sources/feishu/members')[0]!.query).toEqual({ chat: 'oc_team' })
    // Only chats bound to this repository are offered.
    expect(within(feishu).queryByRole('button', { name: /Ops room/ })).toBeNull()

    await user.selectOptions(within(github).getByRole('combobox', { name: 'GitHub · New Issues: Not on the list, addressed' }), 'inferred')
    await user.click(within(saveBar()).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]!.body).toEqual({ revision: 3, value: { rules: RULES, sources: {
      github: { allowed: [{ id: 'bob' }, { id: 'alice' }, { id: 'carol' }], admission: { issues: { unlistedAddressed: 'inferred' } } },
      feishu: { allowed: [{ id: 'ou_ann', name: 'Ann' }, { id: 'ou_ben', name: 'Ben' }] },
    } } })
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Policy form unsaved changes' })).toBeNull())
    expect(api.settings.policy.revision).toBe(4)
  })

  it('edits and removes rows by hand; an admission cell set back to its default is not stored', async () => {
    api.settings.policy.value = { rules: RULES, sources: { github: { allowed: [{ id: 'alice' }], admission: { issues: { unlistedAddressed: 'explicit' } } } } }
    const { user, form } = await openForm()
    const github = fieldset(form, 'GitHub')
    await within(github).findByDisplayValue('alice')
    await user.click(within(github).getByRole('button', { name: 'Add a row to GitHub accounts that may originate work' }))
    await user.type(within(github).getByRole('textbox', { name: 'GitHub accounts that may originate work row 2 Account' }), 'dave')
    await user.click(within(github).getByRole('button', { name: 'Remove alice from GitHub accounts that may originate work' }))
    await user.selectOptions(within(github).getByRole('combobox', { name: 'GitHub · New Issues: Not on the list, addressed' }), 'ignore')
    await user.click(within(saveBar()).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]!.body).toEqual({ revision: 3, value: { rules: RULES, sources: { github: { allowed: [{ id: 'dave' }] } } } })
  })

  it('checks patterns from the metadata before saving, naming the Source and field', async () => {
    const { user, form } = await openForm()
    const github = fieldset(form, 'GitHub')
    await user.click(within(github).getByRole('button', { name: 'Add a row to GitHub accounts that may originate work' }))
    await user.type(within(github).getByRole('textbox', { name: 'GitHub accounts that may originate work row 1 Account' }), '@alice')
    expect(within(github).getByText('GitHub · GitHub accounts that may originate work: Row 1 · Account: “@alice” is not valid')).toBeTruthy()
    expect((within(saveBar()).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    expect(puts()).toHaveLength(0)
  })

  it('shows the cell\'s 400 under the field its path names', async () => {
    api.policyIssues = [{ path: 'sources.feishu.allowed.0.id', message: 'Invalid string: must match pattern /^ou_[a-zA-Z0-9]+$/' },
      { path: 'rules', message: 'Duplicate rule IDs' }]
    const { user, form } = await openForm()
    const feishu = fieldset(form, 'Feishu')
    await user.click(await within(feishu).findByRole('button', { name: 'Add all members of Team chat' }))
    await within(feishu).findByDisplayValue('ou_ann')
    await user.click(within(saveBar()).getByRole('button', { name: 'Save' }))
    const errors = await within(feishu).findByRole('alert', { name: 'Feishu · Feishu users who may originate work errors' })
    expect(errors.textContent).toBe('Feishu · Feishu users who may originate work: Row 1 · open_id: Invalid string: must match pattern /^ou_[a-zA-Z0-9]+$/')
    expect(within(form).getByText('rules: Duplicate rule IDs')).toBeTruthy()
    // The draft is kept for fixing.
    expect(saveBar()).toBeTruthy()
  })

  it('reports a 409 as changed elsewhere and reloads on request', async () => {
    const { user, form } = await openForm()
    const github = fieldset(form, 'GitHub')
    await user.click(within(github).getByRole('button', { name: 'Add a row to GitHub accounts that may originate work' }))
    await user.type(within(github).getByRole('textbox', { name: 'GitHub accounts that may originate work row 1 Account' }), 'eve')
    api.settings.policy = { value: { rules: [], sources: { github: { allowed: [{ id: 'zed' }], admission: {} } } }, revision: 9 }
    await user.click(within(saveBar()).getByRole('button', { name: 'Save' }))
    const alert = await within(form).findByText(/Changed elsewhere/)
    await user.click(within(alert.closest('[role="alert"]') as HTMLElement).getByRole('button', { name: 'Reload' }))
    await within(github).findByDisplayValue('zed')
    expect(within(github).queryByDisplayValue('eve')).toBeNull()
  })

  it('saves the Eval mode to the eval block with its revision', async () => {
    const { user } = await openForm()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Eval mode' }), 'auto')
    expect(screen.getByText(/may start work it infers/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Save Eval settings' }))
    await waitFor(() => expect(api.find('PUT', '/v1/cells/acme--gh1/api/settings/eval')[0]?.body)
      .toEqual({ value: { mode: 'auto', timeoutSeconds: 120, model: null, replyOnIgnore: true, replyModel: null }, revision: 1 }))
  })

  it('turns the reply to ignored explicit requests off in the eval block', async () => {
    const { user } = await openForm()
    const toggle = screen.getByRole('checkbox', { name: 'Reply when an explicit request is ignored' }) as HTMLInputElement
    expect(toggle.checked).toBe(true)
    await user.click(toggle)
    await user.click(screen.getByRole('button', { name: 'Save Eval settings' }))
    await waitFor(() => expect(api.find('PUT', '/v1/cells/acme--gh1/api/settings/eval')[0]?.body)
      .toEqual({ value: { mode: 'observe', timeoutSeconds: 120, model: null, replyOnIgnore: false, replyModel: null }, revision: 1 }))
  })

  it('keeps the JSON editor as the Advanced tab', async () => {
    const { user } = await openForm()
    await user.click(within(screen.getByRole('group', { name: 'Policy editor' })).getByRole('button', { name: 'Advanced (JSON)' }))
    expect(await screen.findByRole('textbox', { name: 'Policy JSON' })).toBeTruthy()
    expect(screen.queryByRole('form', { name: 'Policy form' })).toBeNull()
  })

  it('picker errors from the cell are shown', async () => {
    api.bindings.set('acme', [{ chatId: 'oc_team', cellId: 'acme--gh1', chatName: 'Team chat' }])
    const { user, form } = await openForm()
    const button = await within(fieldset(form, 'Feishu')).findByRole('button', { name: 'Add all members of Team chat' })
    // The binding moved elsewhere after the page loaded: the cell refuses the chat.
    api.bindings.set('acme', [{ chatId: 'oc_team', cellId: 'acme--gh2', chatName: 'Team chat' }])
    await user.click(button)
    expect(await screen.findByText('This chat is not bound to this repository')).toBeTruthy()
  })
})

describe('policy form helpers', () => {
  const allowed = settingsSources()[1]!.policy!.fields[0] as RowsField
  it('fieldProblems checks required columns, patterns and duplicates', () => {
    expect(fieldProblems(allowed, [{ id: 'ou_a' }, { id: 'ou_a', name: 'A' }, { id: '' }, { id: 'x' }])).toEqual([
      'Row 3 · open_id: required', 'Row 4 · open_id: “x” is not valid', '“ou_a” is listed twice'])
    expect(fieldProblems({ key: 'syncChat', type: 'text', pattern: '(oc_[a-z]+)?', label: text('Sync chat') }, 'nope')).toEqual(['“nope” is not valid'])
  })
  it('groupIssues files prefixed paths by field and keeps unprefixed ones general', () => {
    const sources = settingsSources().filter(source => source.policy) as Parameters<typeof groupIssues>[1]
    const grouped = groupIssues([{ path: 'sources.github.allowed.1.id', message: 'bad' },
      { path: 'sources.github.admission.issues.unlistedAddressed', message: 'Invalid option' }, { path: 'allowed.0.id', message: 'bad' }], sources)
    expect(Object.fromEntries(grouped.fields)).toEqual({ 'github.allowed': ['Row 2 · Account: bad'],
      'github.admission': ['issues · unlistedAddressed: Invalid option'] })
    expect(grouped.general).toEqual(['allowed.0.id: bad'])
  })
})
