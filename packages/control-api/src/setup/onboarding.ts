/** `dshsa-onboarding` (contracts v6): single-use OAuth state nonces and GitHub installation claims (onboarding design §3). */
import { InstallationClaim, OnboardingByTenantIndex, SetupState, onboardingKey } from '@dshsa/contracts'
import { DeleteCommand, type DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'

/** `active`/`pending`: the claim's status after the write (an existing active claim of the tenant is never downgraded). */
export type ClaimResult = 'active' | 'pending' | 'other_tenant'

export interface OnboardingStore {
  createState(state: SetupState): Promise<void>
  /** Deletes the nonce if it exists, is unexpired and was issued to the same tenant and `sub`; false otherwise (single use). */
  consumeState(nonce: string, tenantId: string, sub: string, nowSec: number): Promise<boolean>
  /**
   * Binds an installation to `tenantId` unless another tenant holds it (contracts v6.2). An `active` claim replaces a pending
   * one of the same tenant; a `pending` claim never replaces an `active` one (re-linking without proof keeps the approval).
   */
  claim(claim: InstallationClaim): Promise<ClaimResult>
  getClaim(installationId: number): Promise<InstallationClaim | undefined>
  listClaims(tenantId: string): Promise<InstallationClaim[]>
  /**
   * Releases (unlinks or rejects) a claim so another tenant can link the installation. With `tenantId` the delete is
   * conditional on the claim belonging to that tenant (the panel-tenant IAM grant cannot express the tenant); false when
   * there is no such claim.
   */
  releaseClaim(installationId: number, tenantId?: string): Promise<boolean>
  /** Platform only: every pending claim, oldest first. */
  listPending(): Promise<InstallationClaim[]>
  /** Platform only: every claim (active and pending), oldest first. */
  listAllClaims(): Promise<InstallationClaim[]>
  /** Platform only: pending → active; false when there is no pending claim. */
  approveClaim(installationId: number, approvedBy: string, approvedAt: string): Promise<boolean>
}

const failed = (e: unknown) => (e as { name?: string }).name === 'ConditionalCheckFailedException'

export class DynamoOnboarding implements OnboardingStore {
  constructor(private readonly db: DynamoDBDocumentClient, private readonly table: string) {}

  async createState(state: SetupState) {
    await this.db.send(new PutCommand({ TableName: this.table, Item: SetupState.parse(state), ConditionExpression: 'attribute_not_exists(#k)',
      ExpressionAttributeNames: { '#k': 'key' } }))
  }
  async consumeState(nonce: string, tenantId: string, sub: string, nowSec: number) {
    try {
      await this.db.send(new DeleteCommand({
        TableName: this.table, Key: { key: onboardingKey.githubState(nonce) },
        // DynamoDB TTL deletes lazily, so expiry is checked here too.
        ConditionExpression: 'attribute_exists(#k) AND tenantId = :t AND #s = :s AND #ttl > :now',
        ExpressionAttributeNames: { '#k': 'key', '#s': 'sub', '#ttl': 'ttl' }, ExpressionAttributeValues: { ':t': tenantId, ':s': sub, ':now': nowSec },
      }))
      return true
    } catch (e) {
      if (failed(e)) return false
      throw e
    }
  }
  async claim(claim: InstallationClaim) {
    const item = InstallationClaim.parse(claim)
    const active = item.status === 'active'
    try {
      await this.db.send(new PutCommand({
        TableName: this.table, Item: item,
        ConditionExpression: active ? 'attribute_not_exists(#k) OR tenantId = :t' : 'attribute_not_exists(#k) OR (tenantId = :t AND #st = :pending)',
        ExpressionAttributeNames: { '#k': 'key', ...(active ? {} : { '#st': 'status' }) },
        ExpressionAttributeValues: { ':t': item.tenantId, ...(active ? {} : { ':pending': 'pending' }) },
      }))
      return item.status
    } catch (e) {
      if (!failed(e)) throw e
      // Refused: either another tenant holds it, or this tenant's claim is already active (kept as is).
      const held = await this.getClaim(item.installationId)
      return held?.tenantId === item.tenantId && held.status === 'active' ? 'active' : 'other_tenant'
    }
  }
  listPending() { return this.scanClaims('pending') }
  listAllClaims() { return this.scanClaims() }
  /** Scans claims only: the filter keeps `ghstate#` nonces out of the response. */
  private async scanClaims(status?: 'pending') {
    const out: InstallationClaim[] = []
    let ExclusiveStartKey: Record<string, unknown> | undefined
    do {
      const page = await this.db.send(new ScanCommand({
        TableName: this.table, ExclusiveStartKey,
        FilterExpression: status ? 'begins_with(#k, :p) AND #st = :st' : 'begins_with(#k, :p)',
        ExpressionAttributeNames: { '#k': 'key', ...(status ? { '#st': 'status' } : {}) },
        ExpressionAttributeValues: { ':p': 'ghinst#', ...(status ? { ':st': status } : {}) },
      }))
      for (const item of page.Items ?? []) {
        const parsed = InstallationClaim.safeParse(item)
        if (parsed.success && (!status || parsed.data.status === status)) out.push(parsed.data)
      }
      ExclusiveStartKey = page.LastEvaluatedKey
    } while (ExclusiveStartKey)
    return out.sort((a, b) => a.claimedAt.localeCompare(b.claimedAt))
  }
  async approveClaim(installationId: number, approvedBy: string, approvedAt: string) {
    try {
      await this.db.send(new UpdateCommand({
        TableName: this.table, Key: { key: onboardingKey.githubInstall(installationId) },
        UpdateExpression: 'SET #st = :active, approvedBy = :by, approvedAt = :at REMOVE pendingReason',
        ConditionExpression: 'attribute_exists(#k) AND #st = :pending',
        ExpressionAttributeNames: { '#k': 'key', '#st': 'status' },
        ExpressionAttributeValues: { ':active': 'active', ':pending': 'pending', ':by': approvedBy, ':at': approvedAt },
      }))
      return true
    } catch (e) {
      if (failed(e)) return false
      throw e
    }
  }
  async getClaim(installationId: number) {
    const { Item } = await this.db.send(new GetCommand({ TableName: this.table, Key: { key: onboardingKey.githubInstall(installationId) }, ConsistentRead: true }))
    const parsed = InstallationClaim.safeParse(Item)
    return parsed.success ? parsed.data : undefined
  }
  async listClaims(tenantId: string) {
    const out: InstallationClaim[] = []
    let ExclusiveStartKey: Record<string, unknown> | undefined
    do {
      const page = await this.db.send(new QueryCommand({
        TableName: this.table, IndexName: OnboardingByTenantIndex, KeyConditionExpression: 'tenantId = :t', ExpressionAttributeValues: { ':t': tenantId }, ExclusiveStartKey,
      }))
      for (const item of page.Items ?? []) {
        const parsed = InstallationClaim.safeParse(item)
        if (parsed.success && parsed.data.tenantId === tenantId) out.push(parsed.data)
      }
      ExclusiveStartKey = page.LastEvaluatedKey
    } while (ExclusiveStartKey)
    return out.sort((a, b) => a.installationId - b.installationId)
  }
  async releaseClaim(installationId: number, tenantId?: string) {
    try {
      await this.db.send(new DeleteCommand({
        TableName: this.table, Key: { key: onboardingKey.githubInstall(installationId) },
        ConditionExpression: tenantId ? 'attribute_exists(#k) AND tenantId = :t' : 'attribute_exists(#k)',
        ExpressionAttributeNames: { '#k': 'key' }, ...(tenantId ? { ExpressionAttributeValues: { ':t': tenantId } } : {}),
      }))
      return true
    } catch (e) {
      if (failed(e)) return false
      throw e
    }
  }
}
