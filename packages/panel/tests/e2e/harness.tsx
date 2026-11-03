/**
 * Browser harness for the Playwright screenshots: the real `App` against the in-memory fake panel-api (`../fake-api-core.ts`),
 * with richer fixture data. Served by `vite` (see `playwright.config.ts`); never part of the production build.
 * * Query: `tab` (overview | execution | settings | setup | platform), `theme` (light | dark), `section` (Team setup section),
 * `platform=1` (platform admin), `codex=1` (a Codex worker is deployed), `retired=1` (the stored Assessor model left the catalog),
 * `transcript=codex` (the ticket transcript is the codex 0.166.0 probe rollout).
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createClient } from '../../src/api.ts'
import { App } from '../../src/app.tsx'
import { applyTheme } from '../../src/theme.ts'
import type { TranscriptEntry } from '../../src/types.ts'
import { API, catalog, createFakeApi, ID_TOKEN, ignored, text, thread, ticket } from '../fake-api-core.ts'
import { CODEX_EXTRA } from '../fixtures/codex-extra.ts'
import probe from '../fixtures/codex-probe-rollout.jsonl?raw'
import '@fontsource-variable/atkinson-hyperlegible-next'
import '@fontsource/atkinson-hyperlegible-mono/latin-400.css'
import '../../src/styles.css'

const params = new URL(window.location.href).searchParams
const theme = params.get('theme')
applyTheme(theme === 'dark' || theme === 'light' ? theme : 'system', false)
sessionStorage.setItem('dshsa.panel.tab', params.get('tab') ?? 'overview')
sessionStorage.setItem('dshsa.panel.setup', params.get('section') ?? 'repositories')

const api = createFakeApi()
if (params.get('platform') === '1') api.me.platformAdmin = true
if (params.get('codex') === '1') api.models = catalog({ claude: true, codex: true })
if (params.get('retired') === '1') api.settings.eval.value = { ...api.settings.eval.value, model: { provider: 'bedrock', model: 'global.example.retired-model' } }
if (params.get('transcript') === 'codex') {
  api.transcript = [...probe.split('\n').filter(Boolean).map(line => JSON.parse(line) as TranscriptEntry), ...CODEX_EXTRA]
  api.transcriptAgent = 'codex'
}
api.tickets.push(
  ticket('t3', { stage: 'person', action: 'review' }, { title: 'Bump zod to v4 across packages',
    threads: [thread('github:51', '#51 Bump zod to v4')] }),
  ticket('t4', { stage: 'person', action: 'blocked' }, { title: 'Migrate the queue consumer to SQS FIFO', summary: 'Needs AWS credentials for the staging account.',
    threads: [thread('feishu:oc_ops', 'Ops chat')] }),
  ticket('t5', { stage: 'working', action: 'queued' }, { title: 'Add retries to the webhook relay' }),
  ticket('t6', { stage: 'idle' }, { title: 'Document the onboarding checklist' }),
)
api.ignored.push(ignored('d-e2e-1', [{ code: 'not_a_member' }], { preview: 'can someone look at the flaky e2e run?', source: 'github',
  sender: { source: 'github', id: 'mallory', name: text('mallory') } }))
api.overview.flow = { ...api.overview.flow, received: 48, filtered: 9, judged: 31, accepted: 7 }

const client = createClient({ apiUrl: API, token: async () => ID_TOKEN, onUnauthorized: () => {}, fetch: api.fetch })
function Harness() {
  return <App client={client} email="op@example.com" onLogout={() => {}} />
}
createRoot(document.getElementById('root')!).render(<StrictMode><Harness /></StrictMode>)
// Opening a ticket goes through the UI, as a person would: the spec clicks it.
Object.assign(window, { fakeApi: api })
