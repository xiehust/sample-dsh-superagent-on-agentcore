import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { api, text, useFakeApi } from './fake-api.ts'
import { renderPanel } from './render.tsx'

useFakeApi()

async function openTicket(title: string) {
  sessionStorage.setItem('dshsa.panel.tab', 'execution')
  const panel = renderPanel()
  await panel.user.click(await screen.findByRole('button', { name: title }))
  await screen.findByRole('heading', { name: title })
  return panel
}

describe('execution', () => {
  it('filters the ticket list by stage', async () => {
    sessionStorage.setItem('dshsa.panel.tab', 'execution')
    const { user } = renderPanel()
    expect(await screen.findByRole('button', { name: 'Fix login regression' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Waiting for a person' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Fix login regression' })).toBeNull())
    expect(screen.getByRole('button', { name: 'Question about docs' })).toBeTruthy()
    expect(api.find('GET', '/v1/cells/acme--gh1/api/tickets').map(request => request.query.state)).toEqual(['open', 'person'])
  })

  it('shows stage, mandate, assignments and undelivered inputs', async () => {
    await openTicket('Fix login regression')
    expect(screen.getByText('Working')).toBeTruthy()
    expect(screen.getByText('Fix the login regression')).toBeTruthy()
    expect(screen.getByText('Also update the docs')).toBeTruthy()
    expect(screen.getByRole('table')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'PR #42' }).getAttribute('href')).toBe('https://github.com/acme/widgets/pull/42')
  })

  it('asks for confirmation before Stop, and a double click on Confirm sends one request', async () => {
    const { user } = await openTicket('Fix login regression')
    await user.click(screen.getByRole('button', { name: 'Stop' }))
    let dialog = screen.getByRole('dialog', { name: 'Stop this ticket?' })
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(api.count('POST tickets/t1/stop')).toBe(0)

    await user.click(screen.getByRole('button', { name: 'Stop' }))
    dialog = screen.getByRole('dialog', { name: 'Stop this ticket?' })
    await user.dblClick(within(dialog).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.count('POST tickets/t1/stop')).toBe(1)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull())
  })

  it('renders the transcript as text with tool calls collapsed', async () => {
    const { user } = await openTicket('Fix login regression')
    await user.click(screen.getByRole('button', { name: 'Show transcript' }))
    expect(await screen.findByText('Looking at the auth module.')).toBeTruthy()
    const tool = screen.getByText('Tool call: Bash').closest('details')!
    expect(tool.open).toBe(false)
    expect(tool.textContent).toContain('git status')
    expect(screen.getByText('Tool result').closest('details')!.open).toBe(false)
    expect(screen.queryByText('not a message')).toBeNull()
    expect(api.find('GET', '/v1/cells/acme--gh1/tickets/t1/transcript')).toHaveLength(1)
  })

  it('renders API text as plain text, never as HTML', async () => {
    api.tickets[0]!.attention = { id: 'q', question: '<img src=x onerror=alert(1)>Pick one' }
    await openTicket('Fix login regression')
    expect(screen.getByText('<img src=x onerror=alert(1)>Pick one')).toBeTruthy()
    expect(document.querySelector('img')).toBeNull()
  })

  it('drops non-http links from API content', async () => {
    api.tickets[0]!.channels = [{ source: 'github', url: 'javascript:alert(1)', label: text('Bad link') }]
    await openTicket('Fix login regression')
    expect(screen.getByText('Bad link').closest('a')).toBeNull()
  })
})
