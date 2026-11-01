/**
 * Platform onboarding operations behind `dshsa-admin` (design §4.2). Each takes injected AWS clients so tests use fakes.
 * Every resource it names starts with `dshsa-` (parent design §3).
 */
import {
  CellId, CellRecord, CellsByTenantIndex, CognitoGroups, FeishuDomain, GithubOauthSecret, type PanelRole, RESERVED_TENANT_IDS, Secrets, TenantId,
  TenantRecord, cellId as makeCellId, cellQueueName, routeKey, StateKeys, Tables,
} from '@dshsa/contracts'
import {
  AdminAddUserToGroupCommand, AdminCreateUserCommand, AdminGetUserCommand, AdminRemoveUserFromGroupCommand, type CognitoIdentityProviderClient,
  CreateGroupCommand, ListUsersInGroupCommand, type UserType,
} from '@aws-sdk/client-cognito-identity-provider'
import {
  CreateSecretCommand, PutSecretValueCommand, type SecretsManagerClient, GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager'
import { CreateQueueCommand, GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs'
import {
  type DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, type QueryCommandInput, ScanCommand, type ScanCommandInput,
  TransactWriteCommand, UpdateCommand, DeleteCommand,
} from '@aws-sdk/lib-dynamodb'
import { GITHUB_API, appJwt } from '@dshsa/sources/apis'
import { PLATFORM_ADMIN_GROUP, tenantGroup } from '../authz.ts'

export interface AdminClients {
  db: DynamoDBDocumentClient
  sqs: SQSClient
  secrets: SecretsManagerClient
  cognito: CognitoIdentityProviderClient
  userPoolId: string
  now(): Date
  log(line: string): void
  /** HTTP client for GitHub (tests inject a fake); defaults to the global fetch. */
  fetch?: typeof fetch
}

export class AdminError extends Error {}
const assertDshsa = (name: string): string => {
  if (!name.startsWith('dshsa-') && !name.startsWith('dshsa/')) throw new AdminError(`refusing non-dshsa resource name ${name}`)
  return name
}
const isConditionFailure = (e: unknown) => (e as { name?: string }).name === 'ConditionalCheckFailedException'
/** Per-item reasons of a cancelled TransactWriteItems (`ConditionalCheckFailed`, `None`, ...), or undefined for other errors. */
const cancellationCodes = (e: unknown): (string | undefined)[] | undefined =>
  (e as { name?: string }).name === 'TransactionCanceledException'
    ? ((e as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? []).map(r => r.Code)
    : undefined

async function scanAll(c: AdminClients, input: ScanCommandInput): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []
  let ExclusiveStartKey: Record<string, unknown> | undefined
  do {
    const page = await c.db.send(new ScanCommand({ ...input, ExclusiveStartKey }))
    out.push(...(page.Items ?? []))
    ExclusiveStartKey = page.LastEvaluatedKey
  } while (ExclusiveStartKey)
  return out
}
async function queryAll(c: AdminClients, input: QueryCommandInput): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []
  let ExclusiveStartKey: Record<string, unknown> | undefined
  do {
    const page = await c.db.send(new QueryCommand({ ...input, ExclusiveStartKey }))
    out.push(...(page.Items ?? []))
    ExclusiveStartKey = page.LastEvaluatedKey
  } while (ExclusiveStartKey)
  return out
}

// ---- Tenants -----------------------------------------------------------------------------------------------------------

export async function tenantAdd(c: AdminClients, tenantId: string, name: string): Promise<TenantRecord> {
  TenantId.parse(tenantId)
  // cellId = `${tenantId}--gh${repoId}`: a tenant id containing `--` (or ending in `-`) would make cell ids ambiguous
  // (`a--gh1` + repo 2 = `a--gh1--gh2`), so such ids are refused at onboarding.
  if (tenantId.includes('--') || tenantId.endsWith('-')) throw new AdminError(`tenant id ${tenantId} must not contain "--" or end with "-"`)
  if (RESERVED_TENANT_IDS.includes(tenantId)) throw new AdminError(`tenant id ${tenantId} is reserved`)
  const group = assertDshsa(tenantGroup(tenantId))
  await ensureGroup(c, group, `dshsa tenant ${tenantId}`)
  await ensureGroup(c, assertDshsa(CognitoGroups.tenantAdmin(tenantId)), `dshsa tenant admins of ${tenantId}`)
  const record = TenantRecord.parse({ tenantId, name, cognitoGroup: group, status: 'active', createdAt: c.now().toISOString() })
  try {
    await c.db.send(new PutCommand({ TableName: Tables.tenants, Item: record, ConditionExpression: 'attribute_not_exists(tenantId)' }))
  } catch (e) {
    if (isConditionFailure(e)) throw new AdminError(`tenant ${tenantId} already exists`)
    throw e
  }
  c.log(`tenant ${tenantId} created (group ${group})`)
  return record
}

async function ensureGroup(c: AdminClients, group: string, description: string): Promise<void> {
  try {
    await c.cognito.send(new CreateGroupCommand({ UserPoolId: c.userPoolId, GroupName: group, Description: description }))
  } catch (e) {
    if ((e as { name?: string }).name !== 'GroupExistsException') throw e
  }
}

export async function tenantSetStatus(c: AdminClients, tenantId: string, status: 'active' | 'disabled'): Promise<void> {
  try {
    await c.db.send(new UpdateCommand({
      TableName: Tables.tenants, Key: { tenantId: TenantId.parse(tenantId) }, UpdateExpression: 'SET #s = :s',
      ConditionExpression: 'attribute_exists(tenantId)', ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':s': status },
    }))
  } catch (e) {
    if (isConditionFailure(e)) throw new AdminError(`no tenant ${tenantId}`)
    throw e
  }
  c.log(`tenant ${tenantId} ${status}`)
}

export async function tenantList(c: AdminClients): Promise<TenantRecord[]> {
  return (await scanAll(c, { TableName: Tables.tenants })).map(i => TenantRecord.parse(i))
}

export async function requireTenant(c: AdminClients, tenantId: string): Promise<TenantRecord> {
  const { Item } = await c.db.send(new GetCommand({ TableName: Tables.tenants, Key: { tenantId: TenantId.parse(tenantId) } }))
  if (!Item) throw new AdminError(`no tenant ${tenantId}; run: tenant add ${tenantId}`)
  return TenantRecord.parse(Item)
}

// ---- Cells -------------------------------------------------------------------------------------------------------------

export interface CellAddInput { tenantId: string; repo: string; repoId: number; installationId: number; defaultBranch?: string }

export async function cellAdd(c: AdminClients, input: CellAddInput): Promise<CellRecord> {
  await requireTenant(c, input.tenantId)
  const [owner, name, ...extra] = input.repo.split('/')
  if (!owner || !name || extra.length) throw new AdminError(`--repo must be owner/name (got ${input.repo})`)
  const id = makeCellId(input.tenantId, input.repoId)
  const queueName = assertDshsa(cellQueueName(id))
  const dlqName = assertDshsa(queueName.replace(/\.fifo$/, '-dlq.fifo'))
  const ghRoute = routeKey.github(input.installationId, input.repoId)
  // Route-steal guard, checked before anything is created so a refused add leaves no orphan queues behind.
  const { Item: bound } = await c.db.send(new GetCommand({ TableName: Tables.routes, Key: { routeKey: ghRoute }, ConsistentRead: true }))
  if (bound && bound.cellId !== id) throw new AdminError(`route ${ghRoute} is already bound to cell ${String(bound.cellId)}`)
  const fifo = { FifoQueue: 'true', SqsManagedSseEnabled: 'true', MessageRetentionPeriod: String(14 * 24 * 3600) }
  const dlq = await c.sqs.send(new CreateQueueCommand({ QueueName: dlqName, Attributes: fifo, tags: { project: 'dshsa' } }))
  const dlqArn = (await c.sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ['QueueArn'] }))).Attributes?.QueueArn
  if (!dlq.QueueUrl || !dlqArn) throw new AdminError(`could not resolve the ARN of ${dlqName}`)
  const queue = await c.sqs.send(new CreateQueueCommand({
    QueueName: queueName, tags: { project: 'dshsa', cellId: id },
    Attributes: {
      ...fifo, MessageRetentionPeriod: String(4 * 24 * 3600), VisibilityTimeout: '120', ContentBasedDeduplication: 'false',
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: 5 }),
    },
  }))
  const record = CellRecord.parse({
    cellId: id, tenantId: input.tenantId, status: 'active', stateBucketPrefix: StateKeys.litestream(id),
    queueUrl: queue.QueueUrl, createdAt: c.now().toISOString(),
    repo: { owner, name, id: input.repoId, installationId: input.installationId, defaultBranch: input.defaultBranch ?? 'main' },
  })
  // Cell and route are written in one transaction: either both exist or neither (no cell without its route).
  try {
    await c.db.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: Tables.cells, Item: record, ConditionExpression: 'attribute_not_exists(cellId)' } },
      { Put: {
        TableName: Tables.routes, Item: { routeKey: ghRoute, cellId: id, tenantId: input.tenantId, updatedAt: c.now().toISOString() },
        ConditionExpression: 'attribute_not_exists(routeKey) OR cellId = :c', ExpressionAttributeValues: { ':c': id },
      } },
    ] }))
  } catch (e) {
    const codes = cancellationCodes(e)
    if (codes?.[0] === 'ConditionalCheckFailed') throw new AdminError(`cell ${id} already exists`)
    if (codes?.[1] === 'ConditionalCheckFailed') throw new AdminError(`route ${ghRoute} is already bound to another cell`)
    throw e
  }
  c.log(`cell ${id} created (queue ${queueName})`)
  return record
}

async function putGithubRoute(c: AdminClients, installationId: number, repoId: number, cell: string, tenantId: string) {
  const key = routeKey.github(installationId, repoId)
  try {
    await c.db.send(new PutCommand({
      TableName: Tables.routes, Item: { routeKey: key, cellId: cell, tenantId, updatedAt: c.now().toISOString() },
      // A repo can belong to one cell only: refuse to steal a route bound to a different cell.
      ConditionExpression: 'attribute_not_exists(routeKey) OR cellId = :c', ExpressionAttributeValues: { ':c': cell },
    }))
  } catch (e) {
    if (isConditionFailure(e)) throw new AdminError(`route ${key} is already bound to another cell`)
    throw e
  }
}

export async function cellList(c: AdminClients, tenantId?: string): Promise<CellRecord[]> {
  const items = tenantId
    ? await queryAll(c, { TableName: Tables.cells, IndexName: CellsByTenantIndex, KeyConditionExpression: 'tenantId = :t',
      ExpressionAttributeValues: { ':t': TenantId.parse(tenantId) } })
    : await scanAll(c, { TableName: Tables.cells })
  return items.map(i => CellRecord.parse(i))
}

export async function cellSetStatus(c: AdminClients, id: string, status: 'active' | 'paused' | 'disabled'): Promise<void> {
  try {
    await c.db.send(new UpdateCommand({
      TableName: Tables.cells, Key: { cellId: CellId.parse(id) }, UpdateExpression: 'SET #s = :s',
      ConditionExpression: 'attribute_exists(cellId)', ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':s': status },
    }))
  } catch (e) {
    if (isConditionFailure(e)) throw new AdminError(`no cell ${id}`)
    throw e
  }
  c.log(`cell ${id} ${status}`)
}

/** Re-points every cell of a tenant at a new installation id (the App was re-installed) and rewrites their `gh#` routes. */
export async function githubInstallRegister(c: AdminClients, tenantId: string, installationId: number): Promise<string[]> {
  await requireTenant(c, tenantId)
  const changed: string[] = []
  for (const cell of await cellList(c, tenantId)) {
    if (cell.repo.installationId === installationId) continue
    await putGithubRoute(c, installationId, cell.repo.id, cell.cellId, tenantId)
    await c.db.send(new UpdateCommand({
      TableName: Tables.cells, Key: { cellId: cell.cellId }, UpdateExpression: 'SET repo.installationId = :i',
      ConditionExpression: 'attribute_exists(cellId)', ExpressionAttributeValues: { ':i': installationId },
    }))
    await c.db.send(new DeleteCommand({
      TableName: Tables.routes, Key: { routeKey: routeKey.github(cell.repo.installationId, cell.repo.id) },
      ConditionExpression: 'cellId = :c', ExpressionAttributeValues: { ':c': cell.cellId },
    })).catch((e: unknown) => { if (!isConditionFailure(e)) throw e })
    changed.push(cell.cellId)
  }
  c.log(`installation ${installationId} registered for ${changed.length} cell(s) of ${tenantId}`)
  return changed
}

// ---- Secrets -----------------------------------------------------------------------------------------------------------

export interface GithubAppInput { appId: string; slug?: string; privateKey: string; webhookSecret?: string }

/**
 * Asks GitHub who the App is (`GET /app` with an App JWT). This proves the private key belongs to `appId` and returns the
 * real slug, the name people mention (`@slug`), which is easy to confuse with the App's Client ID (`Iv…`).
 */
export async function githubAppIdentity(c: AdminClients, appId: string, privateKey: string): Promise<{ slug: string; name?: string }> {
  let jwt: string
  try { jwt = appJwt(appId, privateKey, c.now().getTime()) } catch (e) {
    throw new AdminError(`--private-key-file could not sign an App JWT: ${(e as Error).message}`)
  }
  const res = await (c.fetch ?? fetch)(`${GITHUB_API}/app`, { headers: githubHeaders(jwt) })
  const text = await res.text()
  if (!res.ok) {
    throw new AdminError(`GitHub rejected the App credentials (GET /app → HTTP ${res.status}): check that --app-id is the numeric App ID and the private key belongs to that App`)
  }
  const body = JSON.parse(text) as { id?: unknown; slug?: unknown; name?: unknown }
  if (typeof body.slug !== 'string' || !body.slug) throw new AdminError('GitHub GET /app returned no slug')
  if (String(body.id) !== appId) throw new AdminError(`GitHub says this key belongs to App ${String(body.id)}, not ${appId}`)
  return { slug: body.slug, name: typeof body.name === 'string' ? body.name : undefined }
}

export async function githubAppSet(c: AdminClients, input: GithubAppInput): Promise<{ slug: string }> {
  if (!/^\d+$/.test(input.appId)) throw new AdminError('--app-id must be numeric')
  if (!input.privateKey.includes('PRIVATE KEY')) throw new AdminError('--private-key-file does not look like a PEM private key')
  const given = input.slug?.replace(/^@/, '')
  const { slug } = await githubAppIdentity(c, input.appId, input.privateKey)
  if (given && given !== slug) {
    const hint = /^Iv\d/.test(given) ? ' (it looks like the Client ID)' : ''
    throw new AdminError(`the App's slug is ${slug}, not ${given}${hint}; drop --slug or pass --slug ${slug}`)
  }
  let webhookSecret = input.webhookSecret
  if (!webhookSecret) {
    // Keep the generated webhook secret unless one is given explicitly.
    const current = await c.secrets.send(new GetSecretValueCommand({ SecretId: Secrets.githubApp }))
    webhookSecret = (JSON.parse(current.SecretString ?? '{}') as { webhookSecret?: string }).webhookSecret
  }
  if (!webhookSecret) throw new AdminError('no webhook secret: pass --webhook-secret')
  await c.secrets.send(new PutSecretValueCommand({
    SecretId: Secrets.githubApp, SecretString: JSON.stringify({ appId: input.appId, slug, privateKey: input.privateKey, webhookSecret }),
  }))
  c.log(`${Secrets.githubApp} updated (app ${input.appId}, @${slug}, verified with GitHub)`)
  // Mirror the public App id + slug for panel-tenant (it never reads the App key). The App key is already stored, so a missing
  // `dshsa/github-oauth` (dshsa-shared older than v6) must not fail the CLI: say so and carry on.
  try {
    await mergeOauthSecret(c, { appId: input.appId, slug })
  } catch (e) {
    if ((e as { name?: string }).name !== 'ResourceNotFoundException') throw e
    c.log(`${Secrets.githubOauth} does not exist yet (deploy dshsa-shared v6); the panel install flow stays off until it does`)
  }
  c.log('Cells read the App slug and key only at start: restart the host (or wait for the next dshsa-host deploy) to pick this up.')
  return { slug }
}

/** `dshsa/github-oauth` as stored: the OAuth client plus the App's public id and slug (for install links and filtering). */
export interface OauthConfig { clientId: string; clientSecret: string; appId?: string; slug?: string }
async function readOauthSecret(c: AdminClients): Promise<Partial<OauthConfig>> {
  try {
    const raw = (await c.secrets.send(new GetSecretValueCommand({ SecretId: Secrets.githubOauth }))).SecretString
    const value = JSON.parse(raw ?? '{}') as Record<string, unknown>
    const str = (k: string) => typeof value[k] === 'string' && value[k] ? value[k] as string : undefined
    return { clientId: str('clientId'), clientSecret: str('clientSecret'), appId: str('appId'), slug: str('slug') }
  } catch (e) {
    if ((e as { name?: string }).name === 'ResourceNotFoundException') return {}
    throw e
  }
}
async function mergeOauthSecret(c: AdminClients, patch: Partial<OauthConfig>): Promise<void> {
  const next = { ...await readOauthSecret(c), ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) }
  await c.secrets.send(new PutSecretValueCommand({ SecretId: Secrets.githubOauth, SecretString: JSON.stringify(next) }))
}
/** The OAuth client when fully set, else undefined (the placeholder has empty values). */
export async function githubOauth(c: AdminClients): Promise<OauthConfig | undefined> {
  // Read through the contracts schema (v6.2): a malformed appId/slug (e.g. a Client ID pasted as slug) reads as not set.
  const parsed = GithubOauthSecret.safeParse(await readOauthSecret(c))
  return parsed.success ? parsed.data : undefined
}
/** Sets the App's OAuth client (GitHub App → Client ID + a generated client secret); omitted fields keep their value. */
export async function githubOauthSet(c: AdminClients, input: { clientId?: string; clientSecret?: string }): Promise<void> {
  if (input.clientId !== undefined && !/^(Iv|lv)[0-9A-Za-z.]{6,40}$/.test(input.clientId)) throw new AdminError('the OAuth client id looks like Iv23li…')
  if (input.clientSecret !== undefined && !/^[0-9a-f]{40}$/.test(input.clientSecret)) throw new AdminError('the OAuth client secret is 40 hex characters')
  await mergeOauthSecret(c, input)
  c.log(`${Secrets.githubOauth} updated`)
}

export interface GithubAppStatus {
  app: { set: boolean; appId?: string; slug?: string; keyValid?: boolean; installations?: number; error?: string }
  oauth: { set: boolean; clientId?: string }
}
/** Health of the platform GitHub App: whether the key signs for the App (`GET /app`) and how many installations it has. Never returns secrets. */
export async function githubAppStatus(c: AdminClients): Promise<GithubAppStatus> {
  const current = JSON.parse((await c.secrets.send(new GetSecretValueCommand({ SecretId: Secrets.githubApp }))).SecretString ?? '{}') as
    { appId?: string; slug?: string; privateKey?: string }
  const oauth = await readOauthSecret(c)
  const out: GithubAppStatus = { app: { set: !!(current.appId && current.privateKey) }, oauth: { set: !!(oauth.clientId && oauth.clientSecret), clientId: oauth.clientId } }
  if (!out.app.set) return out
  out.app.appId = String(current.appId)
  out.app.slug = current.slug
  try {
    const identity = await githubAppIdentity(c, String(current.appId), current.privateKey!)
    out.app.keyValid = true
    out.app.slug = identity.slug
    const res = await (c.fetch ?? fetch)(`${GITHUB_API}/app/installations?per_page=100`, { headers: githubHeaders(appJwt(String(current.appId), current.privateKey!, c.now().getTime())) })
    if (res.ok) out.app.installations = (JSON.parse(await res.text()) as unknown[]).length
  } catch (e) {
    out.app.keyValid = false
    out.app.error = e instanceof AdminError ? e.message : 'GitHub could not be reached'
  }
  return out
}
const githubHeaders = (jwt: string) =>
  ({ accept: 'application/vnd.github+json', authorization: `Bearer ${jwt}`, 'x-github-api-version': '2022-11-28', 'user-agent': 'dshsa-admin' })

export interface FeishuInput { tenantId: string; domain: string; appId: string; appSecret: string; encryptKey?: string }

export async function feishuSet(c: AdminClients, input: FeishuInput): Promise<string> {
  await requireTenant(c, input.tenantId)
  const domain = FeishuDomain.parse(input.domain)
  const name = assertDshsa(Secrets.feishuBot(input.tenantId))
  const value = JSON.stringify({ appId: input.appId, appSecret: input.appSecret, encryptKey: input.encryptKey })
  let arn: string | undefined
  try {
    arn = (await c.secrets.send(new CreateSecretCommand({
      Name: name, SecretString: value, Description: `dshsa Feishu/Lark bot of tenant ${input.tenantId}`, Tags: [{ Key: 'project', Value: 'dshsa' }],
    }))).ARN
  } catch (e) {
    if ((e as { name?: string }).name !== 'ResourceExistsException') throw e
    arn = (await c.secrets.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }))).ARN
  }
  if (!arn) throw new AdminError(`could not resolve ARN of ${name}`)
  await c.db.send(new UpdateCommand({
    TableName: Tables.tenants, Key: { tenantId: input.tenantId }, UpdateExpression: 'SET feishu = :f',
    // `revision` (contracts v6) tells running hosts to restart the tenant's Connector with the new secret.
    ConditionExpression: 'attribute_exists(tenantId)',
    ExpressionAttributeValues: { ':f': { domain, appId: input.appId, secretArn: arn, revision: c.now().toISOString() } },
  }))
  c.log(`feishu bot set for ${input.tenantId} (${domain}, ${input.appId})`)
  return arn
}

// ---- Chats -------------------------------------------------------------------------------------------------------------

export async function chatBind(c: AdminClients, tenantId: string, chatId: string, cell: string, chatName?: string): Promise<void> {
  await requireTenant(c, tenantId)
  if (!/^oc_[A-Za-z0-9]{1,64}$/.test(chatId)) throw new AdminError('chat id must look like oc_…')
  const { Item } = await c.db.send(new GetCommand({ TableName: Tables.cells, Key: { cellId: CellId.parse(cell) } }))
  if (!Item || Item.tenantId !== tenantId) throw new AdminError(`${cell} is not a cell of ${tenantId}`)
  await c.db.send(new PutCommand({
    TableName: Tables.routes,
    Item: { routeKey: routeKey.feishu(tenantId, chatId), cellId: cell, tenantId, chatName, updatedAt: c.now().toISOString(), updatedBy: 'dshsa-admin' },
    // Same guard as panel-api: never overwrite a route of another tenant (keys embed the tenant; defence in depth).
    ConditionExpression: 'attribute_not_exists(routeKey) OR tenantId = :t', ExpressionAttributeValues: { ':t': tenantId },
  }))
  c.log(`chat ${chatId} → ${cell}`)
}

export async function chatUnbind(c: AdminClients, tenantId: string, chatId: string): Promise<boolean> {
  try {
    await c.db.send(new DeleteCommand({
      TableName: Tables.routes, Key: { routeKey: routeKey.feishu(TenantId.parse(tenantId), chatId) },
      ConditionExpression: 'tenantId = :t', ExpressionAttributeValues: { ':t': tenantId },
    }))
  } catch (e) {
    if (isConditionFailure(e)) return false
    throw e
  }
  c.log(`chat ${chatId} unbound`)
  return true
}

// ---- Users -------------------------------------------------------------------------------------------------------------

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
/** Creates the user if absent (Cognito emails a temporary password), then adds it to `groups`. */
export async function userAdd(c: AdminClients, email: string, groups: string | string[], tempPassword?: string): Promise<void> {
  if (!EMAIL.test(email)) throw new AdminError(`invalid email ${email}`)
  const list = (Array.isArray(groups) ? groups : [groups]).map(assertDshsa)
  let exists = true
  try { await c.cognito.send(new AdminGetUserCommand({ UserPoolId: c.userPoolId, Username: email })) } catch (e) {
    if ((e as { name?: string }).name !== 'UserNotFoundException') throw e
    exists = false
  }
  if (!exists) {
    await c.cognito.send(new AdminCreateUserCommand({
      UserPoolId: c.userPoolId, Username: email, TemporaryPassword: tempPassword, DesiredDeliveryMediums: ['EMAIL'],
      UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }],
    }))
  }
  for (const group of list) await c.cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: c.userPoolId, Username: email, GroupName: group }))
  c.log(`${email} ${exists ? 'added to' : 'created in'} ${list.join(', ')}`)
}

/** Groups a tenant role holds: a tenant admin is always also a member (contracts v6). */
export const tenantRoleGroups = (tenant: TenantRecord, role: 'member' | 'tadmin'): string[] =>
  role === 'tadmin' ? [tenant.cognitoGroup, CognitoGroups.tenantAdmin(tenant.tenantId)] : [tenant.cognitoGroup]

/**
 * Invites `email` to a tenant as member or tenant admin. Inviting an existing tenant admin as `member` demotes it.
 * `ensureGroups` (platform only, it holds CreateGroup) creates the tenant-admin group of tenants made before v6.
 */
export async function userInvite(c: AdminClients, email: string, tenantId: string, role: 'member' | 'tadmin',
  opts: { tempPassword?: string; ensureGroups?: boolean } = {}): Promise<void> {
  const tenant = await requireTenant(c, tenantId)
  if (opts.ensureGroups && role === 'tadmin') await ensureGroup(c, assertDshsa(CognitoGroups.tenantAdmin(tenantId)), `dshsa tenant admins of ${tenantId}`)
  await userAdd(c, email, tenantRoleGroups(tenant, role), opts.tempPassword)
  if (role === 'member') await removeFromGroup(c, email, CognitoGroups.tenantAdmin(tenantId))
}

async function removeFromGroup(c: AdminClients, email: string, group: string): Promise<void> {
  try {
    await c.cognito.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: c.userPoolId, Username: email, GroupName: assertDshsa(group) }))
  } catch (e) {
    // Not a member / no such group / no such user: nothing to remove.
    if (!['UserNotFoundException', 'ResourceNotFoundException'].includes((e as { name?: string }).name ?? '')) throw e
  }
}

/** Removes `email` from the tenant (both its groups). The Cognito user itself stays (it may belong to other tenants). */
export async function userRemove(c: AdminClients, email: string, tenantId: string): Promise<void> {
  const tenant = await requireTenant(c, tenantId)
  for (const group of tenantRoleGroups(tenant, 'tadmin')) await removeFromGroup(c, email, group)
  c.log(`${email} removed from ${tenantId}`)
}
export async function adminRemove(c: AdminClients, email: string): Promise<void> {
  await removeFromGroup(c, email, PLATFORM_ADMIN_GROUP)
  c.log(`${email} removed from ${PLATFORM_ADMIN_GROUP}`)
}

export interface DirectoryUser { email: string; role: PanelRole; status?: string; enabled?: boolean; createdAt?: string }
async function groupUsers(c: AdminClients, group: string): Promise<UserType[]> {
  const out: UserType[] = []
  let NextToken: string | undefined
  do {
    try {
      const page = await c.cognito.send(new ListUsersInGroupCommand({ UserPoolId: c.userPoolId, GroupName: group, Limit: 60, NextToken }))
      out.push(...(page.Users ?? []))
      NextToken = page.NextToken
    } catch (e) {
      if ((e as { name?: string }).name === 'ResourceNotFoundException') return out
      throw e
    }
  } while (NextToken)
  return out
}
const directoryUser = (u: UserType, role: PanelRole): DirectoryUser => ({
  email: u.Attributes?.find(a => a.Name === 'email')?.Value ?? u.Username ?? '', role,
  status: u.UserStatus, enabled: u.Enabled, createdAt: u.UserCreateDate?.toISOString(),
})
/** Members and tenant admins of a tenant (one row per user, tenant admins win). Contains no sub, no attributes beyond email. */
export async function tenantUsers(c: AdminClients, tenantId: string): Promise<DirectoryUser[]> {
  const tenant = await requireTenant(c, tenantId)
  const admins = await groupUsers(c, CognitoGroups.tenantAdmin(tenantId))
  const members = await groupUsers(c, tenant.cognitoGroup)
  const byName = new Map<string, DirectoryUser>()
  for (const u of members) byName.set(u.Username ?? '', directoryUser(u, 'member'))
  for (const u of admins) if (byName.has(u.Username ?? '')) byName.set(u.Username ?? '', directoryUser(u, 'tadmin'))
  return [...byName.values()].sort((a, b) => a.email.localeCompare(b.email))
}
export async function platformAdmins(c: AdminClients): Promise<DirectoryUser[]> {
  return (await groupUsers(c, PLATFORM_ADMIN_GROUP)).map(u => directoryUser(u, 'admin')).sort((a, b) => a.email.localeCompare(b.email))
}

export const userAddToTenant = async (c: AdminClients, email: string, tenantId: string, tempPassword?: string) =>
  userInvite(c, email, tenantId, 'member', { tempPassword })
export const userAddAdmin = (c: AdminClients, email: string, tempPassword?: string) => userAdd(c, email, PLATFORM_ADMIN_GROUP, tempPassword)
