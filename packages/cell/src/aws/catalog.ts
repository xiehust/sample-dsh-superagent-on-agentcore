/** Read-only access to the platform tables the host needs: active cells and tenants (lease candidates) and chat routes (connectors). */
import { DynamoDBClient, GetItemCommand, QueryCommand, ScanCommand, type AttributeValue } from '@aws-sdk/client-dynamodb'
import { CellRecord, TenantRecord, Tables, onboardingKey, routeKey, type Logger } from '@dshsa/contracts'
import type { ZodError } from 'zod'

/** Converts a DynamoDB item to plain JSON (S, N, BOOL, M, L, NULL). */
export function plain(value: AttributeValue | undefined): unknown {
  if (!value) return undefined
  if (value.S !== undefined) return value.S
  if (value.N !== undefined) return Number(value.N)
  if (value.BOOL !== undefined) return value.BOOL
  if (value.NULL) return null
  if (value.L) return value.L.map(plain)
  if (value.M) return Object.fromEntries(Object.entries(value.M).map(([key, item]) => [key, plain(item)]))
  return undefined
}
const item = (raw: Record<string, AttributeValue>) => plain({ M: raw })

export interface Catalog {
  activeCells(): Promise<CellRecord[]>
  cell(cellId: string): Promise<CellRecord | undefined>
  feishuTenants(): Promise<TenantRecord[]>
  tenant(tenantId: string): Promise<TenantRecord | undefined>
  route(tenantId: string, chatId: string): Promise<string | undefined>
  boundChats(tenantId: string): Promise<string[]>
  /** The Feishu chats routed to one cell, with the name the binding recorded. */
  cellChats(tenantId: string, cellId: string): Promise<{ chatId: string; name?: string }[]>
}
/** Logs a stored record that fails its schema (only its id and the first issue, never the body): the host skips it, so its lease is dropped. */
export function warnUnparsable(log: Logger | undefined, table: string, id: unknown, error: ZodError): void {
  const issue = error.issues[0]
  log?.warn('catalog record failed to parse; skipped', { table, id: typeof id === 'string' ? id : String(id),
    ...issue ? { path: issue.path.join('.'), issue: issue.message } : {} })
}
const idOf = (raw: unknown, field: string): unknown => (raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[field] : undefined)

export class DynamoCatalog implements Catalog {
  constructor(private readonly client: DynamoDBClient = new DynamoDBClient({}), private readonly log?: Logger) {}
  private async scan(table: string): Promise<unknown[]> {
    const items: unknown[] = []
    let start: Record<string, AttributeValue> | undefined
    do {
      const page = await this.client.send(new ScanCommand({ TableName: table, ExclusiveStartKey: start }))
      items.push(...(page.Items ?? []).map(item))
      start = page.LastEvaluatedKey
    } while (start)
    return items
  }
  async activeCells(): Promise<CellRecord[]> {
    return (await this.scan(Tables.cells)).flatMap(raw => {
      const parsed = CellRecord.safeParse(raw)
      if (!parsed.success) { warnUnparsable(this.log, Tables.cells, idOf(raw, 'cellId'), parsed.error); return [] }
      return parsed.data.status === 'active' ? [parsed.data] : []
    })
  }
  async cell(cellId: string): Promise<CellRecord | undefined> {
    const result = await this.client.send(new GetItemCommand({ TableName: Tables.cells, Key: { cellId: { S: cellId } }, ConsistentRead: true }))
    return result.Item ? CellRecord.parse(item(result.Item)) : undefined
  }
  async feishuTenants(): Promise<TenantRecord[]> {
    return (await this.scan(Tables.tenants)).flatMap(raw => {
      const parsed = TenantRecord.safeParse(raw)
      if (!parsed.success) { warnUnparsable(this.log, Tables.tenants, idOf(raw, 'tenantId'), parsed.error); return [] }
      return parsed.data.status === 'active' && parsed.data.feishu ? [parsed.data] : []
    })
  }
  async tenant(tenantId: string): Promise<TenantRecord | undefined> {
    const result = await this.client.send(new GetItemCommand({ TableName: Tables.tenants, Key: { tenantId: { S: tenantId } } }))
    return result.Item ? TenantRecord.parse(item(result.Item)) : undefined
  }
  async route(tenantId: string, chatId: string): Promise<string | undefined> {
    const result = await this.client.send(new GetItemCommand({ TableName: Tables.routes, Key: { routeKey: { S: routeKey.feishu(tenantId, chatId) } } }))
    const cellId = result.Item ? plain(result.Item.cellId) : undefined
    return typeof cellId === 'string' ? cellId : undefined
  }
  private async feishuRoutes(tenantId: string): Promise<{ chatId: string; cellId: string; name?: string }[]> {
    const prefix = routeKey.feishu(tenantId, '')
    const routes: { chatId: string; cellId: string; name?: string }[] = []
    let start: Record<string, AttributeValue> | undefined
    do {
      const page = await this.client.send(new QueryCommand({ TableName: Tables.routes, IndexName: 'byTenant', KeyConditionExpression: 'tenantId = :t',
        ExpressionAttributeValues: { ':t': { S: tenantId } }, ExclusiveStartKey: start }))
      for (const raw of page.Items ?? []) {
        const key = String(plain(raw.routeKey)), cellId = plain(raw.cellId), name = plain(raw.chatName)
        if (key.startsWith(prefix) && typeof cellId === 'string') routes.push({ chatId: key.slice(prefix.length), cellId, ...typeof name === 'string' && name ? { name } : {} })
      }
      start = page.LastEvaluatedKey
    } while (start)
    return routes
  }
  /** v6: the `dshsa-onboarding` claim of a GitHub App installation (strongly consistent; parsed by the caller), or undefined. */
  async installationClaim(installationId: number): Promise<unknown> {
    const result = await this.client.send(new GetItemCommand({ TableName: Tables.onboarding, Key: { key: { S: onboardingKey.githubInstall(installationId) } },
      ConsistentRead: true }))
    return result.Item ? item(result.Item) : undefined
  }
  async boundChats(tenantId: string): Promise<string[]> { return (await this.feishuRoutes(tenantId)).map(route => route.chatId) }
  async cellChats(tenantId: string, cellId: string): Promise<{ chatId: string; name?: string }[]> {
    return (await this.feishuRoutes(tenantId)).filter(route => route.cellId === cellId).map(({ chatId, name }) => ({ chatId, ...name ? { name } : {} }))
  }
}
