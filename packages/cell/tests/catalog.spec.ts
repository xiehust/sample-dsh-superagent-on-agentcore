import type { AttributeValue, DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { expect, it } from 'vitest'
import { Tables, type Logger } from '@dshsa/contracts'
import { DynamoCatalog } from '../src/aws/catalog.ts'

const S = (value: string): AttributeValue => ({ S: value })
const N = (value: number): AttributeValue => ({ N: String(value) })
const cell = (cellId: string, status: string): Record<string, AttributeValue> => ({ cellId: S(cellId), tenantId: S('acme'), status: S(status),
  repo: { M: { owner: S('acme'), name: S('widgets'), id: N(812345), installationId: N(77), defaultBranch: S('main') } },
  queueUrl: S('https://sqs.ap-northeast-1.amazonaws.com/123456789012/dshsa-cell-x.fifo'), stateBucketPrefix: S(''), createdAt: S('2026-11-01T00:00:00Z') })
const tenant = (tenantId: string): Record<string, AttributeValue> => ({ tenantId: S(tenantId), name: S('Acme'), cognitoGroup: S('acme'), status: S('active'),
  feishu: { M: { domain: S('feishu'), appId: S('cli_x'), secretArn: S('arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:dshsa/feishu/acme') } },
  createdAt: S('2026-11-01T00:00:00Z') })

function catalog(tables: Record<string, Record<string, AttributeValue>[]>) {
  const warnings: [string, Record<string, unknown> | undefined][] = []
  const log: Logger = { debug() {}, info() {}, error() {}, warn: (message, data) => { warnings.push([message, data]) } }
  const client = { send: async (command: { input: { TableName: string } }) => ({ Items: tables[command.input.TableName] ?? [] }) } as unknown as DynamoDBClient
  return { catalog: new DynamoCatalog(client, log), warnings }
}

it('skips a cell record that fails its schema and warns with its id and first issue only, never the body', async () => {
  const broken = { ...cell('acme--gh2', 'active'), queueUrl: S('not a url'), secretish: S('do-not-log') }
  const { catalog: c, warnings } = catalog({ [Tables.cells]: [cell('acme--gh1', 'active'), broken, cell('acme--gh3', 'paused')] })
  expect((await c.activeCells()).map(record => record.cellId)).toEqual(['acme--gh1'])
  expect(warnings).toHaveLength(1)
  expect(warnings[0]![1]).toMatchObject({ table: Tables.cells, id: 'acme--gh2', path: 'queueUrl' })
  expect(JSON.stringify(warnings)).not.toContain('do-not-log')
  expect(JSON.stringify(warnings)).not.toContain('not a url')
})

it('skips a tenant record that fails its schema and warns with its id', async () => {
  const broken = { ...tenant('beta'), status: S('weird') }
  const { catalog: c, warnings } = catalog({ [Tables.tenants]: [tenant('acme'), broken] })
  expect((await c.feishuTenants()).map(record => record.tenantId)).toEqual(['acme'])
  expect(warnings).toEqual([['catalog record failed to parse; skipped', expect.objectContaining({ table: Tables.tenants, id: 'beta', path: 'status' })]])
})
