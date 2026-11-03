/**
 * UI acceptance screenshots (task 11-03-panel-redesign): the real panel against the fake panel-api, in light and dark.
 * Run from packages/panel: `pnpm e2e` (starts vite on :5174 itself). Screenshots land in tests/e2e/screenshots/.
 */
import { defineConfig, devices } from '@playwright/test'

const PORT = 5174
export default defineConfig({
  testDir: '.',
  testMatch: '*.e2e.ts',
  outputDir: './results',
  fullyParallel: true,
  reporter: [['list']],
  use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${PORT}`, viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 },
  webServer: { command: `pnpm exec vite --port ${PORT} --strictPort`, cwd: '../..', url: `http://localhost:${PORT}/tests/e2e/harness.html`,
    reuseExistingServer: !process.env.CI, timeout: 60_000 },
})
