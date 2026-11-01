/**
 * Lambda `dshsa-ingress-github-webhook` (API Gateway HTTP API, payload v2): verify, route, enqueue.
 * Env: SECRET_ID (dshsa/github-app), ROUTES_TABLE (dshsa-routes), CELLS_TABLE (dshsa-cells).
 */
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb'
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs'
import { dedupId, handleWebhook, type HttpEvent, type HttpResult, type Route, type WebhookDeps } from './core.ts'

const SECRET_TTL_MS = 5 * 60_000
const ROUTE_TTL_MS = 60_000

/** Builds the dependencies from AWS clients; `env` is read once per cold start. */
export function awsDeps(env: Record<string, string | undefined> = process.env, clients = {
  secrets: new SecretsManagerClient({}), dynamo: new DynamoDBClient({}), sqs: new SQSClient({}),
}): WebhookDeps {
  const secretId = env.SECRET_ID, routesTable = env.ROUTES_TABLE, cellsTable = env.CELLS_TABLE
  let secret: { value: string; at: number } | undefined
  const routes = new Map<string, { value: Route | undefined; at: number }>()
  return {
    async secret(fresh = false) {
      if (!secretId) throw new Error('SECRET_ID is not set')
      if (!fresh && secret && Date.now() - secret.at < SECRET_TTL_MS) return secret.value
      const result = await clients.secrets.send(new GetSecretValueCommand({ SecretId: secretId }))
      const value = (JSON.parse(result.SecretString ?? '{}') as { webhookSecret?: unknown }).webhookSecret
      // A placeholder or missing secret verifies nothing: every request is refused until the platform admin sets it.
      if (typeof value !== 'string' || value.length < 20) throw new Error('The webhook secret is not set')
      secret = { value, at: Date.now() }
      return value
    },
    async route(key) {
      const cached = routes.get(key)
      if (cached && Date.now() - cached.at < ROUTE_TTL_MS) return cached.value
      if (!routesTable || !cellsTable) throw new Error('ROUTES_TABLE / CELLS_TABLE are not set')
      const bound = await clients.dynamo.send(new GetItemCommand({ TableName: routesTable, Key: { routeKey: { S: key } }, ProjectionExpression: 'cellId' }))
      const cellId = bound.Item?.cellId?.S
      let value: Route | undefined
      if (cellId) {
        const cell = await clients.dynamo.send(new GetItemCommand({ TableName: cellsTable, Key: { cellId: { S: cellId } },
          ProjectionExpression: 'queueUrl, #s', ExpressionAttributeNames: { '#s': 'status' } }))
        const queueUrl = cell.Item?.queueUrl?.S
        if (queueUrl) value = { cellId, queueUrl, status: cell.Item?.status?.S ?? 'active' }
      }
      routes.set(key, { value, at: Date.now() })
      return value
    },
    async send(queueUrl, envelope) {
      await clients.sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(envelope),
        MessageGroupId: envelope.cellId, MessageDeduplicationId: dedupId(envelope) }))
    },
    log(message, data) { console.log(JSON.stringify({ level: message.includes('failed') || message.includes('unavailable') ? 'error' : 'info', msg: message, ...data })) },
  }
}
let deps: WebhookDeps | undefined
export async function handler(event: HttpEvent): Promise<HttpResult> {
  deps ??= awsDeps()
  return handleWebhook(event, deps)
}
