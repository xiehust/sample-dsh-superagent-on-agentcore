/** Screenshots of every top-level page, the Models section and a Codex transcript, in light and dark; plus 360 px views. */
import { expect, test, type Page } from '@playwright/test'

const THEMES = ['light', 'dark'] as const
const shot = (page: Page, name: string) => page.screenshot({ path: `tests/e2e/screenshots/${name}.png`, fullPage: true })
const open = async (page: Page, query: string) => {
  await page.goto(`/tests/e2e/harness.html?${query}`)
  await page.evaluate(() => document.fonts.ready)
  // Captures only: a sticky top bar would cover element screenshots and repeat in full-page ones.
  await page.addStyleTag({ content: '.topbar { position: static !important; }' })
}

for (const theme of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme: theme })

    test('overview', async ({ page }) => {
      await open(page, `tab=overview&theme=${theme}`)
      await expect(page.getByRole('heading', { name: /Waiting for a person/ })).toBeVisible()
      await expect(page.getByRole('heading', { name: /Recently ignored/ })).toBeVisible()
      await shot(page, `overview-${theme}`)
    })

    test('execution list and ticket', async ({ page }) => {
      await open(page, `tab=execution&theme=${theme}`)
      await expect(page.getByRole('button', { name: 'Fix login regression' })).toBeVisible()
      await shot(page, `execution-${theme}`)
      await page.getByRole('button', { name: 'Question about docs' }).click()
      await expect(page.getByRole('heading', { name: 'Mandate' })).toBeVisible()
      await page.getByRole('button', { name: 'Show transcript' }).click()
      await expect(page.getByText('Looking at the auth module.')).toBeVisible()
      await shot(page, `ticket-${theme}`)
    })

    test('settings', async ({ page }) => {
      await open(page, `tab=settings&theme=${theme}`)
      await expect(page.getByRole('heading', { name: 'Policy' })).toBeVisible()
      await shot(page, `settings-${theme}`)
    })

    test('team setup', async ({ page }) => {
      await open(page, `tab=setup&theme=${theme}`)
      await expect(page.getByRole('heading', { name: 'Onboarding checklist' })).toBeVisible()
      await shot(page, `setup-${theme}`)
    })

    test('platform', async ({ page }) => {
      await open(page, `tab=platform&platform=1&theme=${theme}`)
      await expect(page.getByRole('heading', { name: 'Platform' })).toBeVisible()
      await shot(page, `platform-${theme}`)
    })

    test('models', async ({ page }) => {
      await open(page, `tab=settings&theme=${theme}`)
      const models = page.getByRole('heading', { name: 'Models' }).locator('xpath=ancestor::section')
      await expect(page.getByRole('combobox', { name: 'Worker model' })).toBeVisible()
      await models.screenshot({ path: `tests/e2e/screenshots/models-${theme}.png` })
      // A change: switch the Replier off "Same as Assessor" and pick an effort, so the save bar shows.
      await page.getByRole('checkbox', { name: 'Same as Assessor' }).uncheck()
      await page.getByRole('combobox', { name: 'Replier effort' }).selectOption('medium')
      await expect(page.getByRole('region', { name: 'Assessor and Replier unsaved changes' })).toBeVisible()
      await models.screenshot({ path: `tests/e2e/screenshots/models-editing-${theme}.png` })
    })

    test('models with Codex deployed and a retired model', async ({ page }) => {
      await open(page, `tab=settings&codex=1&retired=1&theme=${theme}`)
      await page.getByRole('radio', { name: 'Codex' }).check()
      await expect(page.getByText('Model reset to the Codex default.')).toBeVisible()
      await expect(page.getByText('Choose a model this installation offers.')).toBeVisible()
      await page.getByRole('heading', { name: 'Models' }).locator('xpath=ancestor::section')
        .screenshot({ path: `tests/e2e/screenshots/models-codex-${theme}.png` })
    })

    test('codex transcript', async ({ page }) => {
      await open(page, `tab=execution&transcript=codex&theme=${theme}`)
      await page.getByRole('button', { name: 'Fix login regression' }).click()
      await page.getByRole('button', { name: 'Show transcript' }).click()
      await expect(page.getByRole('separator', { name: 'Turn 1', exact: true })).toBeVisible()
      await page.getByText('Tool call: get_weather').click()
      await page.getByRole('heading', { name: 'Transcript' }).locator('xpath=ancestor::section')
        .screenshot({ path: `tests/e2e/screenshots/transcript-codex-${theme}.png` })
    })

    test('account menu', async ({ page }) => {
      await open(page, `tab=overview&theme=${theme}`)
      await page.getByRole('button', { name: /^Account/ }).click()
      await expect(page.getByRole('radiogroup', { name: 'Theme' })).toBeVisible()
      await page.screenshot({ path: `tests/e2e/screenshots/account-menu-${theme}.png` })
    })
  })
}

test('overview at 360 px', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 })
  await open(page, 'tab=overview&theme=light')
  await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible()
  await shot(page, 'overview-narrow-light')
})

test('models at 360 px', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 })
  await open(page, 'tab=settings&theme=dark')
  await expect(page.getByRole('combobox', { name: 'Worker model' })).toBeVisible()
  await page.getByRole('heading', { name: 'Models' }).locator('xpath=ancestor::section')
    .screenshot({ path: 'tests/e2e/screenshots/models-narrow-dark.png' })
})
