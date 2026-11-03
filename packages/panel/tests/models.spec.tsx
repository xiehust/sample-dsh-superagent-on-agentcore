import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { screen, waitFor, within } from '@testing-library/react'
import { DEFAULT_MODELS } from '@dshsa/contracts'
import { describe, expect, it } from 'vitest'
import { api, catalog, useFakeApi } from './fake-api.ts'
import { renderPanel } from './render.tsx'

useFakeApi()

const OPUS = 'global.anthropic.claude-opus-5-5'
const SONNET = 'global.anthropic.claude-sonnet-5-5'
const TERRA = 'global.openai.gpt-6.1-terra'

async function openModels() {
  sessionStorage.setItem('dshsa.panel.tab', 'settings')
  const panel = renderPanel()
  await screen.findByRole('combobox', { name: 'Worker model' })
  return panel
}
const select = (name: string) => screen.getByRole('combobox', { name }) as HTMLSelectElement
const options = (name: string) => [...select(name).options].map(option => option.textContent)
const radio = (name: string) => within(screen.getByRole('radiogroup', { name: 'Worker type' })).getByRole('radio', { name }) as HTMLInputElement
const puts = (block: string) => api.find('PUT', `/v1/cells/acme--gh1/api/settings/${block}`)

describe('Models form', () => {
  it('builds the pickers from GET models and disables an undeployed worker type', async () => {
    await openModels()
    expect(api.find('GET', '/v1/cells/acme--gh1/api/models')).toHaveLength(1)
    expect(radio('Claude Agent').checked).toBe(true)
    expect(radio('Codex').disabled).toBe(true)
    expect(screen.getByText('Codex: not deployed in this installation.')).toBeTruthy()
    // Claude worker surface only, in catalog order; the stored Opus choice is selected.
    expect(options('Worker model')).toEqual(['Default (Claude Opus 5.5)', 'Claude Opus 5.5', 'Claude Sonnet 5.5', 'Claude Haiku 5.5'])
    expect(select('Worker model').value).toBe(OPUS)
    expect(options('Worker effort')).toEqual(['Model default', 'Low', 'Medium', 'High', 'Extra high', 'Max'])
    // Converse surface for the Assessor; its default (GPT-6 Luna) has a catalog default effort.
    expect(options('Assessor model')).toEqual(['Default (GPT-6 Luna)', 'Claude Sonnet 5.5', 'Claude Haiku 5.5', 'GPT-6.1 Terra', 'GPT-6 Luna'])
    expect(options('Assessor effort')[0]).toBe('Default (Low)')
    expect(select('Assessor effort').disabled).toBe(true)
    expect((screen.getByRole('checkbox', { name: 'Same as Assessor' }) as HTMLInputElement).checked).toBe(true)
    expect(screen.queryByRole('combobox', { name: 'Replier model' })).toBeNull()
  })

  it('disables the effort under Default and saves null; a concrete model carries its effort', async () => {
    const { user } = await openModels()
    await user.selectOptions(select('Worker model'), '')
    expect(select('Worker effort').disabled).toBe(true)
    expect(within(select('Worker model').closest('li')!).getByText("Uses the default model's effort.")).toBeTruthy()
    await user.click(within(screen.getByRole('region', { name: 'Worker unsaved changes' })).getByRole('button', { name: 'Save worker' }))
    await waitFor(() => expect(puts('executor')).toHaveLength(1))
    expect(puts('executor')[0]!.body).toEqual({ revision: 2, value: { workerType: 'claude', model: null, maxWorkers: 3, directory: '', prepare: '',
      blockedCommands: [] } })
    await screen.findByText('Worker settings saved.')

    await user.selectOptions(select('Worker model'), SONNET)
    await user.selectOptions(select('Worker effort'), 'high')
    await user.click(screen.getByRole('button', { name: 'Save worker' }))
    await waitFor(() => expect(puts('executor')).toHaveLength(2))
    expect(puts('executor')[1]!.body).toMatchObject({ revision: 3, value: { model: { provider: 'bedrock', model: SONNET, reasoningEffort: 'high' } } })
  })

  it('switching the worker type resets a model of the other type and saves both together', async () => {
    api.models = catalog({ claude: true, codex: true })
    const { user } = await openModels()
    await user.click(radio('Codex'))
    expect(screen.getByRole('status').textContent).toBe('Model reset to the Codex default.')
    expect(select('Worker model').value).toBe('')
    expect(options('Worker model')).toEqual(['Default (GPT-6.1 Terra)', 'GPT-6 Astra', 'GPT-6.1 Sol', 'GPT-6.1 Terra'])
    expect(options('Worker effort')[0]).toBe('Default (High)')
    await user.click(screen.getByRole('button', { name: 'Save worker' }))
    await waitFor(() => expect(puts('executor')).toHaveLength(1))
    expect(puts('executor')[0]!.body).toEqual({ revision: 2, value: { workerType: 'codex', model: null, maxWorkers: 3, directory: '', prepare: '',
      blockedCommands: [] } })
  })

  it('warns while the stored worker type is not deployed, and still lets other changes save', async () => {
    api.settings.executor.value = { ...api.settings.executor.value, workerType: 'codex', model: { provider: 'bedrock', model: TERRA } }
    const { user } = await openModels()
    expect(radio('Codex').checked).toBe(true)
    expect(screen.getByText(/New Codex tickets fail until a Codex worker/)).toBeTruthy()
    await user.selectOptions(select('Worker effort'), 'medium')
    await user.click(screen.getByRole('button', { name: 'Save worker' }))
    await waitFor(() => expect(puts('executor')[0]?.body).toMatchObject({ value: { workerType: 'codex',
      model: { provider: 'bedrock', model: TERRA, reasoningEffort: 'medium' } } }))
  })

  it('Same as Assessor saves null; unchecking seeds the Replier from the resolved Assessor', async () => {
    const { user } = await openModels()
    await user.click(screen.getByRole('checkbox', { name: 'Same as Assessor' }))
    expect(select('Replier model').value).toBe(DEFAULT_MODELS.eval)
    await user.selectOptions(select('Replier effort'), 'medium')
    await user.click(screen.getByRole('button', { name: 'Save Assessor and Replier' }))
    await waitFor(() => expect(puts('eval')).toHaveLength(1))
    expect(puts('eval')[0]!.body).toEqual({ revision: 1, value: { mode: 'observe', timeoutSeconds: 120, model: null, replyOnIgnore: true,
      replyModel: { provider: 'bedrock', model: DEFAULT_MODELS.eval, reasoningEffort: 'medium' } } })
    await screen.findByText('Assessor and Replier saved.')
    await user.click(await screen.findByRole('checkbox', { name: 'Same as Assessor' }))
    await user.click(screen.getByRole('button', { name: 'Save Assessor and Replier' }))
    await waitFor(() => expect(puts('eval')).toHaveLength(2))
    expect(puts('eval')[1]!.body).toMatchObject({ revision: 2, value: { replyModel: null } })
  })

  it('reports a 409 as changed elsewhere', async () => {
    const { user } = await openModels()
    await user.selectOptions(select('Assessor model'), SONNET)
    api.settings.eval.revision = 7 // someone else saved meanwhile
    await user.click(screen.getByRole('button', { name: 'Save Assessor and Replier' }))
    const alert = await screen.findByText(/Changed elsewhere/)
    expect(within(alert.closest('[role="alert"]') as HTMLElement).getByRole('button', { name: 'Reload' })).toBeTruthy()
  })

  it('shows a modelUnavailable refusal on the row it names', async () => {
    const { user } = await openModels()
    await user.click(screen.getByRole('checkbox', { name: 'Same as Assessor' }))
    api.modelRefusal = { field: 'replyModel', reason: 'badEffort', error: 'effort max' }
    await user.click(screen.getByRole('button', { name: 'Save Assessor and Replier' }))
    const replier = (await screen.findByRole('combobox', { name: 'Replier model' })).closest('li')!
    expect((await within(replier).findByRole('alert')).textContent).toBe('The eval model is not available: effort max')
  })

  it('shows a workerUnavailable refusal on the worker type row', async () => {
    api.models = catalog({ claude: true, codex: true })
    const { user } = await openModels()
    api.modelRefusal = { field: 'workerType', reason: 'workerUnavailable', error: 'codex' }
    await user.click(radio('Codex'))
    await user.click(screen.getByRole('button', { name: 'Save worker' }))
    const typeRow = screen.getByRole('radiogroup', { name: 'Worker type' }).closest('li')!
    expect((await within(typeRow).findByRole('alert')).textContent).toBe('Codex worker is not deployed in this installation.')
  })

  it('shows an executor model refusal on the Worker model row, not the type row', async () => {
    const { user } = await openModels()
    await user.selectOptions(select('Worker model'), SONNET)
    api.modelRefusal = { field: 'model', reason: 'wrongSurface', error: 'sonnet' }
    await user.click(screen.getByRole('button', { name: 'Save worker' }))
    const modelRow = select('Worker model').closest('li')!
    expect((await within(modelRow).findByRole('alert')).textContent).toBe('The executor model is not available: sonnet')
    const typeRow = screen.getByRole('radiogroup', { name: 'Worker type' }).closest('li')!
    expect(within(typeRow).queryByRole('alert')).toBeNull()
  })

  it('keeps an untouched model the catalog no longer lists from blocking a save', async () => {
    api.settings.eval.value = { ...api.settings.eval.value, model: { provider: 'bedrock', model: 'global.example.retired-model' } }
    const { user } = await openModels()
    expect(options('Assessor model')).toContain('global.example.retired-model (not available)')
    expect(screen.getByText('Choose a model this installation offers.')).toBeTruthy()
    await user.click(screen.getByRole('checkbox', { name: 'Same as Assessor' }))
    const save = screen.getByRole('button', { name: 'Save Assessor and Replier' }) as HTMLButtonElement
    expect(save.disabled).toBe(false)
    await user.click(save)
    // The Replier is seeded from the default, not from the retired Assessor model; the untouched Assessor is sent as stored.
    await waitFor(() => expect(puts('eval')[0]?.body).toMatchObject({ value: { model: { model: 'global.example.retired-model' },
      replyModel: { provider: 'bedrock', model: DEFAULT_MODELS.eval } } }))
  })

  it('is read-only for members', async () => {
    api.me.tenants[0]!.role = 'member'
    await openModels()
    for (const name of ['Worker model', 'Worker effort', 'Assessor model']) expect(select(name).disabled).toBe(true)
    expect(radio('Claude Agent').disabled).toBe(true)
    expect((screen.getByRole('checkbox', { name: 'Same as Assessor' }) as HTMLInputElement).disabled).toBe(true)
  })

  it('shows stored values read-only for a host before the v7 catalog', async () => {
    api.models = { models: [{ id: OPUS, roles: ['executor'] }] }
    sessionStorage.setItem('dshsa.panel.tab', 'settings')
    renderPanel()
    expect(await screen.findByText(/Update the cell host to choose models here/)).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: 'Worker model' })).toBeNull()
  })

  it('keeps Advanced (JSON) usable when GET models fails', async () => {
    api.models = 'error'
    sessionStorage.setItem('dshsa.panel.tab', 'settings')
    const { user } = renderPanel()
    expect(await screen.findByText('Bedrock is unreachable')).toBeTruthy()
    await user.click(within(screen.getByRole('group', { name: 'Models editor' })).getByRole('button', { name: 'Advanced (JSON)' }))
    expect(await screen.findByRole('textbox', { name: 'Executor (model, workers) JSON' })).toBeTruthy()
  })
})

describe('panel source', () => {
  it('names no model id: every picker comes from GET models', () => {
    const root = join(import.meta.dirname, '../src')
    const offenders = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter(file => /\.tsx?$/.test(file))
      .filter(file => /global\.(anthropic|openai)\./.test(readFileSync(join(root, file), 'utf8')))
    expect(offenders).toEqual([])
  })
})
