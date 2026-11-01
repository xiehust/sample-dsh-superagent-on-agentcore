/** `LeaseStore` on DynamoDB `dshsa-leases` (parent design §4.2), with conditional writes. */
import { ConditionalCheckFailedException, DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { Tables } from '@dshsa/contracts'
import type { LeaseGrant, LeaseStore } from '../lease.ts'

const failed = (error: unknown): boolean => error instanceof ConditionalCheckFailedException
  || (error instanceof Error && error.name === 'ConditionalCheckFailedException')

export class DynamoLeaseStore implements LeaseStore {
  constructor(private readonly client: DynamoDBClient = new DynamoDBClient({}), private readonly table: string = Tables.leases) {}
  async acquire(leaseKey: string, owner: string, endpoint: string | undefined, now: number, ttlMs: number): Promise<LeaseGrant | undefined> {
    try {
      const result = await this.client.send(new UpdateItemCommand({
        TableName: this.table, Key: { leaseKey: { S: leaseKey } },
        ConditionExpression: 'attribute_not_exists(leaseKey) OR expiresAt < :now',
        UpdateExpression: `SET #owner = :owner, expiresAt = :exp, fence = if_not_exists(fence, :zero) + :one${endpoint ? ', endpoint = :endpoint' : ' REMOVE endpoint'}`,
        ExpressionAttributeNames: { '#owner': 'owner' },
        ExpressionAttributeValues: { ':now': { N: String(now) }, ':owner': { S: owner }, ':exp': { N: String(now + ttlMs) }, ':zero': { N: '0' },
          ':one': { N: '1' }, ...endpoint ? { ':endpoint': { S: endpoint } } : {} },
        ReturnValues: 'ALL_NEW',
      }))
      return { leaseKey, owner, fence: Number(result.Attributes?.fence?.N), expiresAt: Number(result.Attributes?.expiresAt?.N) }
    } catch (error) { if (failed(error)) return undefined; throw error }
  }
  async renew(leaseKey: string, owner: string, fence: number, now: number, ttlMs: number): Promise<boolean> {
    try {
      await this.client.send(new UpdateItemCommand({
        TableName: this.table, Key: { leaseKey: { S: leaseKey } },
        ConditionExpression: '#owner = :owner AND fence = :fence', UpdateExpression: 'SET expiresAt = :exp',
        ExpressionAttributeNames: { '#owner': 'owner' },
        ExpressionAttributeValues: { ':owner': { S: owner }, ':fence': { N: String(fence) }, ':exp': { N: String(now + ttlMs) } },
      }))
      return true
    } catch (error) { if (failed(error)) return false; throw error }
  }
  /** Expire the lease in place rather than delete it, so the fence counter keeps growing across owners. */
  async release(leaseKey: string, owner: string, fence: number): Promise<void> {
    try {
      await this.client.send(new UpdateItemCommand({
        TableName: this.table, Key: { leaseKey: { S: leaseKey } },
        ConditionExpression: '#owner = :owner AND fence = :fence', UpdateExpression: 'SET expiresAt = :zero REMOVE endpoint',
        ExpressionAttributeNames: { '#owner': 'owner' },
        ExpressionAttributeValues: { ':owner': { S: owner }, ':fence': { N: String(fence) }, ':zero': { N: '0' } },
      }))
    } catch (error) { if (!failed(error)) throw error }
  }
}
