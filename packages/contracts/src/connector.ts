/** Tenant-level connectors hosted by packages/cell (design §4.8). */
import type { CellEnvelope } from './envelope.ts'
import type { TenantRecord } from './records.ts'

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
}

export interface ConnectorKv {
  get(key: string): Promise<string | undefined>
  put(key: string, value: string): Promise<void>
}

export interface FeishuSecrets { appId: string; appSecret: string; encryptKey?: string; verificationToken?: string }

export interface ConnectorContext {
  tenant: TenantRecord
  secrets: FeishuSecrets
  /** Resolve a chat to its bound cell via dshsa-routes; undefined = unbound (record, don't route). */
  route(chatId: string): Promise<string | undefined>
  /** Chats currently bound to any cell of this tenant (for backfill). */
  boundChats(): Promise<string[]>
  enqueue(cellId: string, envelope: CellEnvelope): Promise<void>
  kv: ConnectorKv
  log: Logger
  signal: AbortSignal
}

export interface Connector {
  /** `connector#<tenantId>` — the lease key. */
  readonly key: string
  start(ctx: ConnectorContext): Promise<void>
  stop(): Promise<void>
}

export type ConnectorFactory = (tenant: TenantRecord) => Connector
