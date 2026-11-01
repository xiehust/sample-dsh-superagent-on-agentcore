/** The tenant Connector's saved state in the state bucket (`connectors/<t>/kv.json`, key `state`; 95's ConnectorState). Read-only. */
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import { StateKeys } from '@dshsa/contracts'

export interface SeenChat { direct: boolean; name?: string; lastAt?: string; routed?: boolean; unrouted?: number; cellId?: string }
export interface ConnectorView { chats: Record<string, SeenChat>; health?: { state: 'starting' | 'ready' | 'error'; detail: string; at: string } }
export interface ConnectorStateReader { read(tenantId: string): Promise<ConnectorView | undefined> }

/** Only `chats` and `health` are kept; history cursors and topics never leave this module. */
export function parseConnectorKv(text: string): ConnectorView | undefined {
  try {
    const kv = JSON.parse(text) as { state?: unknown }
    if (typeof kv.state !== 'string') return undefined
    const state = JSON.parse(kv.state) as Partial<ConnectorView>
    const chats: Record<string, SeenChat> = {}
    for (const [id, c] of Object.entries(state.chats ?? {})) {
      if (!/^oc_[A-Za-z0-9]{1,64}$/.test(id) || typeof c !== 'object' || !c) continue
      chats[id] = { direct: !!c.direct, name: typeof c.name === 'string' ? c.name.slice(0, 200) : undefined, lastAt: typeof c.lastAt === 'string' ? c.lastAt : undefined,
        routed: typeof c.routed === 'boolean' ? c.routed : undefined, unrouted: typeof c.unrouted === 'number' ? c.unrouted : undefined,
        cellId: typeof c.cellId === 'string' ? c.cellId : undefined }
    }
    const h = state.health
    const health = h && typeof h.state === 'string' && ['starting', 'ready', 'error'].includes(h.state)
      ? { state: h.state, detail: String(h.detail ?? '').slice(0, 500), at: String(h.at ?? '') } : undefined
    return { chats, health }
  } catch { return undefined }
}

export class S3ConnectorState implements ConnectorStateReader {
  constructor(private readonly s3: S3Client, private readonly bucket: string) {}
  async read(tenantId: string) {
    try {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: StateKeys.connectorKv(tenantId) }))
      return parseConnectorKv(await res.Body!.transformToString())
    } catch (e) {
      if (['NoSuchKey', 'AccessDenied'].includes((e as { name?: string }).name ?? '')) return undefined
      throw e
    }
  }
}
