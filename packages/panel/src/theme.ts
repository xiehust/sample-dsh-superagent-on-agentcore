/**
 * Colour theme: System follows the OS (`prefers-color-scheme`); Light or Dark sets `data-theme` on <html>, which the stylesheet's
 * `light-dark()` tokens follow through `color-scheme`. The choice is kept in localStorage (it is a device preference, not a session one).
 */
export const THEMES = ['system', 'light', 'dark'] as const
export type Theme = typeof THEMES[number]
export const THEME_LABELS: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' }
const THEME_KEY = 'dshsa.panel.theme'

export function storedTheme(): Theme {
  try {
    const value = localStorage.getItem(THEME_KEY)
    return (THEMES as readonly string[]).includes(value ?? '') ? value as Theme : 'system'
  } catch { return 'system' }
}

/** Applies `theme` to the document and remembers it. */
export function applyTheme(theme: Theme, remember = true): void {
  const root = document.documentElement
  if (theme === 'system') delete root.dataset.theme; else root.dataset.theme = theme
  if (!remember) return
  try { if (theme === 'system') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, theme) } catch { /* storage unavailable */ }
}
