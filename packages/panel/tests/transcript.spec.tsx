import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { codexMessages, type Shown } from '../src/transcript.tsx'
import type { TranscriptEntry } from '../src/types.ts'
import { api, useFakeApi } from './fake-api.ts'
import { CODEX_EXTRA } from './fixtures/codex-extra.ts'
import probe from './fixtures/codex-probe-rollout.jsonl?raw'
import { renderPanel } from './render.tsx'

const PROBE = probe.split('\n').filter(Boolean).map(line => JSON.parse(line) as TranscriptEntry)

/** A compact, comparable form of what the renderer produced. */
const outline = (items: Shown[]) => items.map(item => item.kind === 'turn' ? `[${item.label}${item.detail ? ` | ${item.detail}` : ''}]`
  : `${item.role}: ${item.parts.map(part => part.kind === 'text' ? `${part.tone ? `(${part.tone}) ` : ''}${part.text}`
    : part.kind === 'tool' ? `tool ${part.name} ${part.detail.replace(/\s+/g, '')}` : part.kind === 'result' ? `result${part.error ? '!' : ''} ${part.detail}`
      : part.kind).join(' + ')}`)

describe('Codex transcript', () => {
  it('renders the 0.166.0 probe rollout: turn header joined by turn_id, user, tool call, answer, end', () => {
    expect(PROBE).toHaveLength(21)
    expect(outline(codexMessages(PROBE))).toEqual([
      '[Turn 1 | Model global.openai.gpt-6.1-terra, effort low]',
      "user: What's the weather in Tokyo? Use the tool, then answer in one short sentence.",
      'tool: tool get_weather {"city":"Tokyo"} + result weather is sunny, 23C',
      'assistant: Tokyo is sunny and 23°C.',
      '[Turn 1 finished in 3.85 s]',
    ])
  })

  it('renders commentary, a failed tool, unknown items generically, and skips raw and malformed lines', () => {
    expect(outline(codexMessages([...PROBE, ...CODEX_EXTRA])).slice(5)).toEqual([
      '[Turn 2]',
      'user: Now run the tests.',
      'assistant: (commentary) Running the unit tests first.',
      'tool: tool report {"status":"ready"} + result! error: ticket is not running',
      'tool: tool CommandExecution {"type":"CommandExecution","id":"cmd1","command":"pnpmtest","exit_code":0}',
      'assistant: All 12 tests pass.',
      '[Turn 2 finished in 42 s]',
    ])
    expect(() => codexMessages([{ type: 'event_msg' }, { type: 'turn_context', payload: 'x' } as never, {} as never, null as never, 7 as never])).not.toThrow()
  })

  describe('on the ticket page', () => {
    useFakeApi()
    it('uses the Codex renderer when the transcript says agent: codex', async () => {
      api.transcript = PROBE
      api.transcriptAgent = 'codex'
      sessionStorage.setItem('dshsa.panel.tab', 'execution')
      const { user } = renderPanel()
      await user.click(await screen.findByRole('button', { name: 'Fix login regression' }))
      await user.click(await screen.findByRole('button', { name: 'Show transcript' }))
      const start = await screen.findByRole('separator', { name: 'Turn 1' })
      expect(start.textContent).toContain('Model global.openai.gpt-6.1-terra, effort low')
      expect(screen.getByRole('separator', { name: 'Turn 1 finished in 3.85 s' })).toBeTruthy()
      expect(screen.getByText('Tool call: get_weather')).toBeTruthy()
      const answer = screen.getByText('Tokyo is sunny and 23°C.').closest('li')!
      expect(within(answer).getByText('assistant')).toBeTruthy()
      expect(screen.queryByText(/redacted/)).toBeNull()
    })
  })
})
