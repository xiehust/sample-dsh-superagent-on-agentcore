import { screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { storedTheme } from '../src/theme.ts'
import { useFakeApi } from './fake-api.ts'
import { renderPanel } from './render.tsx'

useFakeApi()
afterEach(() => { localStorage.clear(); delete document.documentElement.dataset.theme })

describe('account menu and theme', () => {
  it('opens the account menu, switches to Dark, remembers it, and closes on Escape', async () => {
    const { user, onLogout } = renderPanel()
    await user.click(await screen.findByRole('button', { name: /^Account/ }))
    const menu = screen.getByRole('group', { name: 'Account' })
    expect(within(menu).getByText('Signed in as op@example.com')).toBeTruthy()
    const themes = within(menu).getByRole('radiogroup', { name: 'Theme' })
    expect((within(themes).getByRole('radio', { name: 'System' }) as HTMLInputElement).checked).toBe(true)
    await user.click(within(themes).getByRole('radio', { name: 'Dark' }))
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(storedTheme()).toBe('dark')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('group', { name: 'Account' })).toBeNull()
    await user.click(screen.getByRole('button', { name: /^Account/ }))
    expect((screen.getByRole('radio', { name: 'Dark' }) as HTMLInputElement).checked).toBe(true)
    await user.click(screen.getByRole('radio', { name: 'System' }))
    expect(document.documentElement.dataset.theme).toBeUndefined()
    expect(storedTheme()).toBe('system')
    await user.click(screen.getByRole('button', { name: 'Log out' }))
    expect(onLogout).toHaveBeenCalledOnce()
  })
})
