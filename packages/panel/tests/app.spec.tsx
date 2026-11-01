import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { api, ID_TOKEN, useFakeApi } from './fake-api.ts'
import { renderPanel } from './render.tsx'

useFakeApi()

describe('cell picker', () => {
  it('lists only the cells returned by /v1/cells, grouped by tenant', async () => {
    api.cells = api.cells.filter(cell => cell.cellId !== 'acme--gh2')
    renderPanel()
    const picker = await screen.findByRole('combobox', { name: 'Cell' }) as HTMLSelectElement
    expect([...picker.options].map(option => [option.value, option.textContent])).toEqual([
      ['acme--gh1', 'acme/widgets'], ['beta--gh3', 'beta/site']])
    expect([...picker.querySelectorAll('optgroup')].map(group => group.label)).toEqual(['Acme', 'Beta'])
  })

  it('switches the cell, remembers it in sessionStorage, and only calls the selected cell', async () => {
    const { user } = renderPanel()
    const picker = await screen.findByRole('combobox', { name: 'Cell' })
    await screen.findByText('Waiting for a person')
    await user.selectOptions(picker, 'beta--gh3')
    await waitFor(() => expect(api.count('GET overview', 'beta--gh3')).toBe(1))
    expect(sessionStorage.getItem('dshsa.panel.cell')).toBe('beta--gh3')
  })

  it('ignores a remembered cell the API no longer returns', async () => {
    sessionStorage.setItem('dshsa.panel.cell', 'gone--gh9')
    renderPanel()
    const picker = await screen.findByRole('combobox', { name: 'Cell' }) as HTMLSelectElement
    expect(picker.value).toBe('acme--gh1')
    await waitFor(() => expect(api.count('GET overview')).toBe(1))
    expect(api.requests.some(request => request.path.includes('gone--gh9'))).toBe(false)
  })

  it('shows the user and an empty state when there are no cells', async () => {
    api.cells = []
    renderPanel()
    expect(await screen.findByText('No cells')).toBeTruthy()
    expect(screen.getByText('op@example.com')).toBeTruthy()
  })
})

describe('error states', () => {
  it('shows the offline state for 503 cell_unavailable', async () => {
    api.offline.add('acme--gh1')
    renderPanel()
    const alert = await screen.findByRole('alert')
    expect(alert.dataset.kind).toBe('offline')
    expect(alert.textContent).toContain('Cell offline')
  })

  it('shows no-access for 403', async () => {
    api.forbidden.add('acme--gh1')
    renderPanel()
    const alert = await screen.findByRole('alert')
    expect(alert.dataset.kind).toBe('forbidden')
    expect(alert.textContent).toContain('No access')
  })

  it('starts a new login on 401 or a missing token', async () => {
    const { onUnauthorized } = renderPanel({ signedOut: true })
    await screen.findByRole('alert')
    expect(onUnauthorized).toHaveBeenCalled()
    expect(api.requests).toEqual([])
  })

  it('the fake API rejects a request without the ID-token bearer', async () => {
    await fetch('https://api.test/v1/me', { headers: { 'x-orchestrator-request': '1' } })
    await fetch('https://api.test/v1/cells/acme--gh1/api/search?q=x', { headers: { authorization: `Bearer ${ID_TOKEN}`,
      'x-orchestrator-request': '1' } })
    expect(api.misuse).toEqual(['missing or wrong bearer on GET /v1/me', 'unknown forwarded route GET search'])
    api.misuse.length = 0
  })
})

describe('overview', () => {
  it('shows person tickets, flow and executor load, and runs problem actions', async () => {
    api.paused = true
    const { user } = renderPanel()
    expect(await screen.findByText('Question about docs')).toBeTruthy()
    expect(screen.getByText('1 / 3')).toBeTruthy()
    const problems = screen.getByText('Problems').closest('section')!
    await user.click(within(problems).getByRole('button', { name: 'Resume' }))
    await waitFor(() => expect(api.find('POST', '/v1/cells/acme--gh1/api/executor/pause')[0]?.body).toEqual({ paused: false }))
    await user.click(within(problems).getByRole('button', { name: 'Evaluate again' }))
    await waitFor(() => expect(api.count('POST triggers/tr9/requeue')).toBe(1))
    await user.click(within(problems).getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(api.count('POST decisions/d9/dismiss')).toBe(1))
  })

  it('opens a person ticket in Execution', async () => {
    const { user } = renderPanel()
    await user.click(await screen.findByRole('button', { name: 'Question about docs' }))
    expect(await screen.findByText('Which branch should I target?')).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Execution' }).getAttribute('aria-selected')).toBe('true')
  })
})
