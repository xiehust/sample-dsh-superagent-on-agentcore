import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { codexMessages, type Shown } from '../src/transcript.tsx'
import type { TranscriptEntry } from '../src/types.ts'
import { api, useFakeApi } from './fake-api.ts'
import { CODEX_EXTRA } from './fixtures/codex-extra.ts'
import L1 from './fixtures/codex-l1-lines.json'
import probe from './fixtures/codex-probe-rollout.jsonl?raw'
import { renderPanel } from './render.tsx'

const PROBE = probe.split('\n').filter(Boolean).map(line => JSON.parse(line) as TranscriptEntry)

/** A compact, comparable form of what the renderer produced. */
const outline = (items: Shown[]) => items.map(item => item.kind === 'turn' ? `[${item.label}${item.detail ? ` | ${item.detail}` : ''}]`
  : `${item.role}: ${item.parts.map(part => part.kind === 'text' ? `${part.tone ? `(${part.tone}) ` : ''}${part.text}`
    : part.kind === 'tool' ? `tool ${part.name} ${part.detail.replace(/\s+/g, '')}` : part.kind === 'result' ? `result${part.error ? '!' : ''} ${part.detail}`
      : part.kind === 'command' ? `command ${part.command} exit ${part.exitCode} ${JSON.stringify(part.detail)}`
      : part.kind === 'files' ? `files ${part.files.map(file => `${file.change} ${file.path}`).join(', ')}${part.error ? '!' : ''} ${JSON.stringify(part.detail)}`
      : part.kind === 'note' ? `note ${part.text} ${JSON.stringify(part.detail)}`
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
      'tool: tool McpToolCall {"type":"McpToolCall","id":"mcp1","server":"docs","tool":"search"}',
      'assistant: All 12 tests pass.',
      '[Turn 2 finished in 42 s]',
    ])
    expect(() => codexMessages([{ type: 'event_msg' }, { type: 'turn_context', payload: 'x' } as never, {} as never, null as never, 7 as never])).not.toThrow()
  })

  it('renders the L1 live shapes: shell command, file edit, and the operator instructions note; skips raw tool calls', () => {
    expect(outline(codexMessages(L1 as TranscriptEntry[]))).toEqual([
      'tool: command ls -a exit 0 ".\\n..\\n.agents\\n.git\\nREADME.md\\n"',
      'tool: files add NOTES.md "Added NOTES.md\\n+hello"',
      'system: note The operator updated the instructions for this ticket. "You are the dshsa probe worker, second edition."',
    ])
  })

  it('shows a failing command, an update diff, a rename, and deleted text marked as deleted', () => {
    const line = (item: Record<string, unknown>): TranscriptEntry => ({ type: 'event_msg', ordinal: 1, payload: { type: 'item_completed', item } })
    const [command, files] = codexMessages([
      line({ type: 'CommandExecution', command: ['/bin/bash', '-c', 'pnpm test'], aggregated_output: 'FAIL', exit_code: 1 }),
      line({ type: 'FileChange', changes: { '/mnt/work/repo/src/a.ts': { type: 'update', unified_diff: '@@ -1 +1 @@\n-a\n+b', move_path: null },
        '/mnt/work/repo/src/b.ts': { type: 'update', unified_diff: '', move_path: '/mnt/work/repo/src/c.ts' },
        '/mnt/work/repo/old.md': { type: 'delete', content: 'gone\nfor good\n' } }, status: 'failed', stderr: 'conflict' }),
    ])
    expect(outline([command!, files!])).toEqual([
      'tool: command pnpm test exit 1 "FAIL"',
      'tool: files update src/a.ts, update src/b.ts → src/c.ts, delete old.md! "Updated src/a.ts\\n@@ -1 +1 @@\\n-a\\n+b\\n\\n'
        + 'Updated src/b.ts → src/c.ts\\n\\nDeleted old.md\\n-gone\\n-for good\\n\\nstderr:\\nconflict"',
    ])
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
