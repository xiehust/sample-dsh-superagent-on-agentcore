/** DynamoDB access for panel-api (design §4.2). Kept behind an interface so the handler tests use an in-memory fake. */
import { CellRecord, CellsByTenantIndex, LeaseRecord, TenantRecord, routeKey, type Tables } from '@dshsa/contracts'
import { DeleteCommand, type DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb'

export interface ChatBinding { tenantId: string; chatId: string; cellId: string; chatName?: string; updatedAt: string; updatedBy?: string }

export interface Repo {
  getTenant(tenantId: string): Promise<TenantRecord | undefined>
  listTenants(): Promise<TenantRecord[]>
  getCell(cellId: string): Promise<CellRecord | undefined>
  listCellsByTenant(tenantId: string): Promise<CellRecord[]>
  getLease(leaseKey: string): Promise<LeaseRecord | undefined>
  listChatBindings(tenantId: string): Promise<ChatBinding[]>
  putChatBinding(binding: ChatBinding): Promise<void>
  /** Deletes only if the route belongs to `tenantId`; resolves false when there was nothing to delete. */
  deleteChatBinding(tenantId: string, chatId: string): Promise<boolean>
}

/** v6 `onboarding` is optional here: panel-api (read path) does not use it; the setup Lambdas pass it. */
type TableNames = Record<Exclude<keyof typeof Tables, 'onboarding'>, string> & { onboarding?: string }

/** Records that fail their schema are dropped rather than trusted (an admin typo must not widen access). */
const parsed = <T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, item: unknown): T | undefined => {
  const r = schema.safeParse(item)
  return r.success ? r.data : undefined
}

export class DynamoRepo implements Repo {
  constructor(private readonly db: DynamoDBDocumentClient, private readonly tables: TableNames) {}

  async getTenant(tenantId: string) {
    const { Item } = await this.db.send(new GetCommand({ TableName: this.tables.tenants, Key: { tenantId } }))
    return Item ? parsed(TenantRecord, Item) : undefined
  }
  async listTenants() {
    const out: TenantRecord[] = []
    let ExclusiveStartKey: Record<string, unknown> | undefined
    do {
      const page = await this.db.send(new ScanCommand({ TableName: this.tables.tenants, ExclusiveStartKey }))
      for (const item of page.Items ?? []) { const t = parsed(TenantRecord, item); if (t) out.push(t) }
      ExclusiveStartKey = page.LastEvaluatedKey
    } while (ExclusiveStartKey)
    return out
  }
  async getCell(cellId: string) {
    const { Item } = await this.db.send(new GetCommand({ TableName: this.tables.cells, Key: { cellId } }))
    return Item ? parsed(CellRecord, Item) : undefined
  }
  async listCellsByTenant(tenantId: string) {
    const items = await this.query(this.tables.cells, tenantId)
    return items.map(i => parsed(CellRecord, i)).filter((c): c is CellRecord => !!c && c.tenantId === tenantId)
  }
  async getLease(leaseKey: string) {
    const { Item } = await this.db.send(new GetCommand({ TableName: this.tables.leases, Key: { leaseKey }, ConsistentRead: true }))
    return Item ? parsed(LeaseRecord, Item) : undefined
  }
  async listChatBindings(tenantId: string) {
    const items = await this.query(this.tables.routes, tenantId)
    const prefix = routeKey.feishu(tenantId, '')
    return items.filter(i => typeof i.routeKey === 'string' && i.routeKey.startsWith(prefix) && i.tenantId === tenantId)
      .map(i => ({
        tenantId, chatId: String(i.routeKey).slice(prefix.length), cellId: String(i.cellId),
        chatName: typeof i.chatName === 'string' ? i.chatName : undefined,
        updatedAt: String(i.updatedAt ?? ''), updatedBy: typeof i.updatedBy === 'string' ? i.updatedBy : undefined,
      }))
  }
  async putChatBinding(b: ChatBinding) {
    const key = routeKey.feishu(b.tenantId, b.chatId)
    await this.db.send(new PutCommand({
      TableName: this.tables.routes,
      Item: { routeKey: key, cellId: b.cellId, tenantId: b.tenantId, chatName: b.chatName, updatedAt: b.updatedAt, updatedBy: b.updatedBy },
      // Never overwrite a route that belongs to another tenant (keys embed the tenant, so this is defence in depth).
      ConditionExpression: 'attribute_not_exists(routeKey) OR tenantId = :t', ExpressionAttributeValues: { ':t': b.tenantId },
    }))
  }
  async deleteChatBinding(tenantId: string, chatId: string) {
    try {
      await this.db.send(new DeleteCommand({
        TableName: this.tables.routes, Key: { routeKey: routeKey.feishu(tenantId, chatId) },
        ConditionExpression: 'tenantId = :t', ExpressionAttributeValues: { ':t': tenantId },
      }))
      return true
    } catch (error) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return false
      throw error
    }
  }

  private async query(table: string, tenantId: string): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = []
    let ExclusiveStartKey: Record<string, unknown> | undefined
    do {
      const page = await this.db.send(new QueryCommand({
        TableName: table, IndexName: CellsByTenantIndex, KeyConditionExpression: 'tenantId = :t',
        ExpressionAttributeValues: { ':t': tenantId }, ExclusiveStartKey,
      }))
      out.push(...(page.Items ?? []))
      ExclusiveStartKey = page.LastEvaluatedKey
    } while (ExclusiveStartKey)
    return out
  }
}
