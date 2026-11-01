import { describe, expect, it } from 'vitest'
import { key } from '@dshsa/core'
import { feishuTrigger, historyAsEvent, historyEvent, HistoricalMessageSchema, HistoryPageSchema, receiveTrigger, sdkEvent } from '../src/index.ts'
import { fixture } from './fakes.ts'

const raw = fixture('feishu/receive.group-mention.json')
const item = HistoricalMessageSchema.parse(fixture('feishu/history.item.json'))

describe('Feishu event → Trigger (ids as the DSH prototype derives them)', () => {
  it('turns a raw SDK receive_v1 event into the DSH Trigger', () => {
    expect(receiveTrigger(raw, 'ou_bot', 'cli_app')).toEqual({
      id: key('feishu', 'om_5ce6d572455d361153b7cb51da133945'), source: 'feishu', threads: [{ source: 'feishu', id: 'oc_team:om_root1' }],
      actor: { source: 'feishu', id: 'ou_alice' }, human: true, addressed: 'mention', at: '2025-11-01T12:26:40.000Z',
      text: '@Agent please fix the header',
      channel: { source: 'feishu', thread: 'feishu:oc_team', address: { chatId: 'oc_team', messageId: 'om_5ce6d572455d361153b7cb51da133945' } },
      meta: { chatId: 'oc_team', messageId: 'om_5ce6d572455d361153b7cb51da133945', direct: false, mentioned: true, rootId: 'om_root1',
        parentId: 'om_root1', threadId: 'omt_topic1' },
    })
  })
  it('gives the same Trigger as DSH\'s history path and as the Connector\'s backfill path', () => {
    const live = receiveTrigger(raw, 'ou_bot', 'cli_app')
    const dshHistory = feishuTrigger(historyEvent(item, 'oc_team', false), 'ou_bot', 'cli_app')
    const backfill = receiveTrigger(historyAsEvent(item, false), 'ou_bot', 'cli_app')
    expect(backfill).toEqual(live)
    expect(dshHistory).toEqual(live)
  })
  it('marks a direct message, drops the bot\'s own messages and keeps a root message on its own thread', () => {
    const direct = structuredClone(raw) as { message: Record<string, unknown> }
    direct.message.chat_type = 'p2p'; delete direct.message.mentions; delete direct.message.root_id; delete direct.message.parent_id
    expect(receiveTrigger(direct, 'ou_bot', 'cli_app')).toMatchObject({ addressed: 'direct', threads: [{ id: 'oc_team:om_5ce6d572455d361153b7cb51da133945' }],
      channel: { address: { direct: 'true' } } })
    const mine = structuredClone(raw) as { sender: { sender_id: { open_id: string } } }
    mine.sender.sender_id.open_id = 'ou_bot'
    expect(receiveTrigger(mine, 'ou_bot', 'cli_app')).toBeUndefined()
    expect(receiveTrigger(historyAsEvent({ ...item, sender: { id: 'cli_app', sender_type: 'app' } }, false), 'ou_bot', 'cli_app')).toBeUndefined()
  })
  it('reads an event whose withheld fields are null (no user-ID scope), as Feishu sends them', () => {
    const nulls = structuredClone(raw) as { sender: { sender_id: Record<string, unknown> }; message: Record<string, unknown> & { mentions?: { id: Record<string, unknown> }[] } }
    Object.assign(nulls.sender.sender_id, { user_id: null, union_id: null })
    Object.assign(nulls.message, { root_id: null, parent_id: null, thread_id: null, message_app_link: null })
    for (const mention of nulls.message.mentions ?? []) Object.assign(mention.id, { user_id: null, union_id: null })
    expect(sdkEvent(nulls)).toMatchObject({ sender_type: 'user', content: '@_user_1 please fix the header', mentions: [{ id: 'ou_bot', key: '@_user_1', name: 'Agent' }] })
    expect(sdkEvent(nulls)).not.toHaveProperty('root_id', null)
    expect(receiveTrigger(nulls, 'ou_bot', 'cli_app')).toBeDefined()
  })
  it('reads history items and pages whose absent fields are null, giving the same Trigger', () => {
    const live = receiveTrigger(raw, 'ou_bot', 'cli_app')
    const nulls = { ...fixture('feishu/history.item.json') as object, msg_type: null, message_app_link: null, updated: null,
      sender: { id: 'ou_alice', id_type: null, sender_type: 'user', tenant_key: null },
      mentions: [{ key: '@_user_1', id: 'ou_bot', id_type: null, name: 'Agent', tenant_key: null }, { key: '@_user_2', id: null, name: null }] }
    const parsed = HistoricalMessageSchema.parse(nulls)
    expect(receiveTrigger(historyAsEvent(parsed, false), 'ou_bot', 'cli_app')).toEqual(live)
    expect(feishuTrigger(historyEvent(parsed, 'oc_team', false), 'ou_bot', 'cli_app')).toEqual(live)
    const root = HistoricalMessageSchema.parse({ ...nulls, root_id: null, parent_id: null, thread_id: null, deleted: null, mentions: null })
    expect(receiveTrigger(historyAsEvent(root, false), 'ou_bot', 'cli_app')).toMatchObject({ threads: [{ id: 'oc_team:om_5ce6d572455d361153b7cb51da133945' }] })
    const gone = HistoricalMessageSchema.parse({ ...nulls, deleted: true, body: null, sender: { id: null, sender_type: 'user' } })
    expect([gone.body, gone.sender.id]).toEqual([undefined, ''])
    expect(HistoryPageSchema.parse({ items: null, has_more: null, page_token: null })).toEqual({ items: [], has_more: false })
    expect(HistoricalMessageSchema.safeParse({ ...nulls, message_id: null }).success).toBe(false)
  })
  it('flattens to the lark-cli shape with plain text content and open_id mentions', () => {
    expect(sdkEvent(raw)).toMatchObject({ sender_type: 'user', content: '@_user_1 please fix the header', mentions: [{ id: 'ou_bot', key: '@_user_1', name: 'Agent' }] })
  })
})

describe('syncBoundChats', () => {
  it('adds bound chats as @ only, keeps a person\'s listen mode and name, and drops unbound ones', async () => {
    const { feishuKind, syncBoundChats } = await import('../src/index.ts')
    const config = feishuKind.schema.parse({ chats: [{ chatId: 'oc_a', name: 'Team A', listen: 'all' }, { chatId: 'oc_gone', listen: 'mentions' }] })
    const synced = syncBoundChats(config, [{ chatId: 'oc_a', chatName: 'renamed' }, { chatId: 'oc_b', chatName: 'Team B' }])
    expect(synced.chats).toEqual([{ chatId: 'oc_a', name: 'Team A', listen: 'all' }, { chatId: 'oc_b', name: 'Team B', listen: 'mentions' }])
    expect(feishuKind.schema.parse(synced)).toEqual(synced)
    expect(syncBoundChats(synced, [{ chatId: 'oc_a' }, { chatId: 'oc_b' }])).toBe(synced)
  })
})
