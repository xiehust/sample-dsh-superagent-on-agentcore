/**
 * Codex rollout lines the 0.166.0 probe (`codex-probe-rollout.jsonl`) does not contain, written in the probe's exact envelopes:
 * a second turn without `turn_context`, commentary, a failed tool call, an item type the renderer does not know, and bad lines.
 */
import type { TranscriptEntry } from '../../src/types.ts'

const at = (n: number) => `2026-11-03T11:20:${String(n).padStart(2, '0')}.000Z`
const turn = 'turn-2'
const item = (ordinal: number, value: Record<string, unknown>): TranscriptEntry =>
  ({ timestamp: at(ordinal), ordinal, type: 'event_msg', payload: { type: 'item_completed', thread_id: 'th', turn_id: turn, item: value } })

export const CODEX_EXTRA: TranscriptEntry[] = [
  { timestamp: at(30), ordinal: 30, type: 'event_msg', payload: { type: 'task_started', turn_id: turn, root_turn_id: turn } },
  item(31, { type: 'UserMessage', id: 'u2', content: [{ type: 'text', text: 'Now run the tests.', text_elements: [] }] }),
  item(32, { type: 'AgentMessage', id: 'm2', content: [{ type: 'Text', text: 'Running the unit tests first.' }], phase: 'commentary' }),
  item(33, { type: 'DynamicToolCall', id: 'call_x', tool: 'report', arguments: { status: 'ready' }, status: 'failed',
    content_items: [{ type: 'inputText', text: 'error: ticket is not running' }], success: false }),
  item(34, { type: 'CommandExecution', id: 'cmd1', command: 'pnpm test', exit_code: 0 }),
  { timestamp: at(35), ordinal: 35, type: 'event_msg', payload: null },
  { timestamp: at(36), ordinal: 36, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'raw' }] } },
  item(37, { type: 'AgentMessage', id: 'm3', content: [{ type: 'Text', text: 'All 12 tests pass.' }], phase: 'final_answer' }),
  { timestamp: at(38), ordinal: 38, type: 'event_msg', payload: { type: 'task_complete', turn_id: turn, duration_ms: 42_400 } },
]
