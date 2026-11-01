/**
 * dshsa E2E harness (A5, A6 skeleton; A2–A4 steps are placeholders the module owners fill in). Runs against the deployed
 * platform in DSHSA_ACCOUNT/ap-northeast-1 with the operator's credentials. It creates only `e2e<run>`-prefixed tenants, cells and
 * users, and removes them at the end unless `--keep`.
 * Usage: scripts/e2e/run.sh [--keep] [--only panel] [--strict [--wait <seconds, default 30>]]
 */
import { randomBytes } from 'node:crypto'
import { parseArgs } from 'node:util'
import { REGION, Secrets, Tables, cellQueueName, routeKey } from '@dshsa/contracts'
import { a6NoTicket } from '@dshsa/sources/e2e'
import {
  AdminDeleteUserCommand, AdminInitiateAuthCommand, ListUserPoolsCommand, AdminSetUserPasswordCommand, CognitoIdentityProviderClient, DeleteGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider'
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { DeleteQueueCommand, GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs'
import { DeleteCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import * as ops from '../src/admin/ops.ts'

const { values } = parseArgs({ options: {
  keep: { type: 'boolean' }, only: { type: 'string' },
  /** Require 200 from tenant A's own cell (proves panel-api → host v3 caller auth), waiting up to --wait seconds for its lease. */
  strict: { type: 'boolean' }, wait: { type: 'string', default: '30' },
} })
const run = randomBytes(3).toString('hex')
/** Unique fake repo ids per run, so routes of parallel runs never collide. */
const repoId = (i: number): number => 900_000_000 + parseInt(run, 16) * 2 + i
const cfn = new CloudFormationClient({ region: REGION })
const cognito = new CognitoIdentityProviderClient({ region: REGION })
const sqs = new SQSClient({ region: REGION })
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), { marshallOptions: { removeUndefinedValues: true } })

async function outputs(stack: string): Promise<Record<string, string>> {
  const { Stacks } = await cfn.send(new DescribeStacksCommand({ StackName: stack }))
  return Object.fromEntries((Stacks?.[0]?.Outputs ?? []).map(o => [o.OutputKey!, o.OutputValue!]))
}

let failures = 0
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`✓ ${name}`) } catch (e) { failures++; console.log(`✗ ${name}: ${(e as Error).message}`) }
}
function expectStatus(actual: number, expected: number | number[], what: string) {
  const ok = Array.isArray(expected) ? expected.includes(actual) : actual === expected
  if (!ok) throw new Error(`${what}: got ${actual}, want ${String(expected)}`)
}

async function main() {
  const panel = await outputs('dshsa-panel')
  const api = panel.PanelApiUrl!, clientId = panel.UserPoolClientId!
  // The account is shared: page through every pool rather than trusting the first 60.
  let userPoolId: string | undefined
  let NextToken: string | undefined
  do {
    const page = await cognito.send(new ListUserPoolsCommand({ MaxResults: 60, NextToken }))
    userPoolId = page.UserPools?.find(p => p.Name === 'dshsa-users')?.Id
    NextToken = page.NextToken
  } while (!userPoolId && NextToken)
  if (!api || !clientId || !userPoolId) throw new Error('dshsa-panel / dshsa-shared are not deployed')
  const c: ops.AdminClients = { db, sqs, secrets: new SecretsManagerClient({ region: REGION }), cognito, userPoolId, now: () => new Date(), log: () => {} }

  const tenants = [`e2e${run}a`, `e2e${run}b`]
  const users: { email: string; token?: string }[] = tenants.map(t => ({ email: `${t}@example.com` }))
  const cells: string[] = []
  const password = `E2e!${randomBytes(12).toString('base64url')}9a`
  const call = (path: string, token?: string, init: RequestInit = {}) =>
    fetch(`${api}${path}`, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', ...init.headers } })

  try {
    await step('onboard two tenants with one cell and one user each', async () => {
      for (const [i, t] of tenants.entries()) {
        await ops.tenantAdd(c, t, `E2E ${t}`)
        cells.push((await ops.cellAdd(c, { tenantId: t, repo: `e2e/${t}`, repoId: repoId(i), installationId: 1 })).cellId)
        await ops.userAddToTenant(c, users[i]!.email, t, password)
        await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: userPoolId, Username: users[i]!.email, Password: password, Permanent: true }))
        const auth = await cognito.send(new AdminInitiateAuthCommand({
          UserPoolId: userPoolId, ClientId: clientId, AuthFlow: 'ADMIN_USER_PASSWORD_AUTH', AuthParameters: { USERNAME: users[i]!.email, PASSWORD: password },
        }))
        users[i]!.token = auth.AuthenticationResult?.IdToken
        if (!users[i]!.token) throw new Error(`no id token for ${users[i]!.email}`)
      }
    })
    const [a, b] = users
    await step('anonymous call is refused by the authorizer (401)', async () => expectStatus((await call('/v1/cells')).status, 401, 'anonymous'))
    await step('A5: tenant B lists only its own cells', async () => {
      const res = await call('/v1/cells', b!.token)
      expectStatus(res.status, 200, 'B /v1/cells')
      const ids = ((await res.json()) as { cells: { cellId: string }[] }).cells.map(x => x.cellId)
      if (ids.includes(cells[0]!) || !ids.includes(cells[1]!)) throw new Error(`B sees ${ids.join(',')}`)
    })
    await step('A5: tenant B cannot read or act on tenant A cells (403)', async () => {
      expectStatus((await call(`/v1/cells/${cells[0]}/api/state`, b!.token)).status, 403, 'B → A state')
      expectStatus((await call(`/v1/cells/${cells[0]}/api/tickets/x/stop`, b!.token, { method: 'POST', body: '{}' })).status, 403, 'B → A stop')
      expectStatus((await call(`/v1/tenants/${tenants[0]}/chat-bindings`, b!.token)).status, 403, 'B → A chat bindings')
    })
    await step(`tenant A reaches its cell (${values.strict ? 'strict: 200 required' : '200, or 503 cell_unavailable without a lease'})`, async () => {
      // A 200 here proves the whole path: JWT authorizer → panel-api tenant authz → lease → host caller auth (presigned STS).
      // A host refusal of the caller proof surfaces as 503 "did not accept the request"; no lease as 503 "not running".
      const deadline = Date.now() + Number(values.wait) * 1000
      for (let attempt = 1; ; attempt++) {
        const res = await call(`/v1/cells/${cells[0]}/api/state`, a!.token)
        const text = await res.text()
        console.log(`  A → A state #${attempt}: ${res.status} ${text.slice(0, 300)}`)
        if (res.status === 200) return
        if (!values.strict) return expectStatus(res.status, 503, 'A → A state')
        if (res.status !== 503 || Date.now() > deadline) throw new Error(`A → A state: got ${res.status} after ${attempt} attempt(s), want 200`)
        await new Promise(resolve => setTimeout(resolve, 3000))
      }
    })
    if (values.only !== 'panel') {
      // Placeholders owned by other modules (fill in, keep the step names): see parent prd.md acceptance criteria.
      await step('A2 GitHub mention → ack → PR → ready (owner: 95/5c/a8) [TODO]', async () => {})
      await step('A2 Feishu bound chat flow (owner: 95/5c) [TODO]', async () => {})
      await step('A3 isolation probes from inside a worker microVM (owner: a8) [TODO]', async () => {})
      await step('A4 resume after microVM loss (owner: a8/5c) [TODO]', async () => {})
      await step('A5 Stop/Retry through the panel API on a live ticket (owner: dd, needs host) [TODO]', async () => {})
      await step('A6 unauthorized requester / unaddressed message → no ticket', async () => {
        const ingress = await outputs('dshsa-ingress')
        const app = JSON.parse((await c.secrets.send(new GetSecretValueCommand({ SecretId: Secrets.githubApp }))).SecretString ?? '{}') as
          { webhookSecret?: string; slug?: string }
        if (!ingress.GithubWebhookUrl || !app.webhookSecret || !app.slug) throw new Error('dshsa-ingress or the GitHub App secret is not set up')
        await a6NoTicket({
          webhookUrl: ingress.GithubWebhookUrl, webhookSecret: app.webhookSecret, slug: app.slug, cellId: cells[0]!, installationId: 1,
          repoId: repoId(0), repoFullName: `e2e/${tenants[0]}`, log: console.log,
          cellApi: (p, init) => call(`/v1/cells/${cells[0]}/api/${p}`, a!.token, init),
        })
      })
    }
  } finally {
    if (!values.keep) await cleanup(c, tenants, cells, users.map(u => u.email))
  }
  console.log(failures ? `\n${failures} step(s) failed` : '\nall steps passed')
  process.exit(failures ? 1 : 0)
}

/** Removes only what this run created (names carry the run id). */
async function cleanup(c: ops.AdminClients, tenants: string[], cells: string[], emails: string[]) {
  const quiet = async (p: Promise<unknown>) => { try { await p } catch { /* already gone */ } }
  for (const [i, cell] of cells.entries()) {
    for (const name of [cellQueueName(cell), cellQueueName(cell).replace(/\.fifo$/, '-dlq.fifo')]) {
      await quiet(sqs.send(new GetQueueUrlCommand({ QueueName: name })).then(q => sqs.send(new DeleteQueueCommand({ QueueUrl: q.QueueUrl }))))
    }
    await quiet(db.send(new DeleteCommand({ TableName: Tables.cells, Key: { cellId: cell } })))
    await quiet(db.send(new DeleteCommand({ TableName: Tables.routes, Key: { routeKey: routeKey.github(1, repoId(i)) } })))
  }
  for (const t of tenants) {
    await quiet(db.send(new DeleteCommand({ TableName: Tables.tenants, Key: { tenantId: t } })))
    await quiet(cognito.send(new DeleteGroupCommand({ UserPoolId: c.userPoolId, GroupName: `dshsa-tenant-${t}` })))
    await quiet(cognito.send(new DeleteGroupCommand({ UserPoolId: c.userPoolId, GroupName: `dshsa-tadmin-${t}` })))
  }
  for (const e of emails) await quiet(cognito.send(new AdminDeleteUserCommand({ UserPoolId: c.userPoolId, Username: e })))
  console.log(`cleaned up run ${run}`)
}

main().catch((e: unknown) => { console.error(e); process.exit(1) })
