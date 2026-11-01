/**
 * The `dshsa-host` container entrypoint: AWS wiring of HostProcess. Configuration comes from the task definition's environment
 * (`infra/lib/constructs/host.ts`); the region comes from AWS_REGION, never from code.
 */
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs'
import { InternalApiPort, type CellEnvelope, type CellRecord, type FeishuSecrets, type Logger, type TenantRecord } from '@dshsa/contracts'
import { StateKeys } from '@dshsa/contracts'
import type { CellInfo, SourceKind } from '@dshsa/core/host'
import { claimPull, feishuKind, feishuRead, feishuRef, githubKind, pullEndNotices, readPull, syncBoundChats, type FeishuConfig } from '@dshsa/sources'
import { FeishuClient, GithubApp, GithubAppSecret, GithubClient, feishuBotInfo } from '@dshsa/sources/apis'
import { createFeishuConnector } from '@dshsa/sources/connector'
import { DynamoLeaseStore } from './aws/dynamo-leases.ts'
import { DynamoCatalog } from './aws/catalog.ts'
import { SecretCache } from './aws/secrets.ts'
import { S3JsonKv } from './aws/s3-kv.ts'
import { AgentCoreRuntime } from './aws/agentcore.ts'
import { SsmWorkerVersion } from './aws/worker-version.ts'
import { LambdaProvisioner } from './aws/provisioner.ts'
import { HostProcess, type CellSources } from './host.ts'
import { LitestreamReplicator } from './litestream.ts'
import { SqsCellQueue } from './queue.ts'
import { BedrockModelClient } from '@dshsa/assess'
import { KmsDerSigner, TicketTokens } from './token.ts'
import { internalServer, type TenantRoutes } from './server.ts'
import { installationRepositories } from './installations.ts'
import { createHash } from 'node:crypto'
import { CallerVerifier } from './caller.ts'

const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback
  if (value === undefined || value === '') throw new Error(`${name} is not set`)
  return value
}
/** JSON lines for CloudWatch Logs. */
export const jsonLog: Logger = Object.fromEntries((['debug', 'info', 'warn', 'error'] as const).map(level => [level,
  (msg: string, data?: Record<string, unknown>) => { if (level !== 'debug' || process.env.DEBUG) console.log(JSON.stringify({ level, msg, ...data, at: new Date().toISOString() })) }])) as unknown as Logger

/** The task's ARN and private IP from the ECS task metadata endpoint (v4). */
async function taskIdentity(): Promise<{ owner: string; ip: string }> {
  const uri = process.env.ECS_CONTAINER_METADATA_URI_V4
  if (!uri) return { owner: env('TASK_ID', `local-${process.pid}`), ip: env('TASK_IP', '127.0.0.1') }
  const task = await (await fetch(`${uri}/task`)).json() as { TaskARN: string; Containers?: { Networks?: { IPv4Addresses?: string[] }[] }[] }
  const ip = task.Containers?.flatMap(container => container.Networks ?? []).flatMap(network => network.IPv4Addresses ?? [])[0]
  if (!ip) throw new Error('No task IP in the ECS metadata')
  return { owner: task.TaskARN, ip }
}

export async function main(): Promise<void> {
  const log = jsonLog
  const { owner, ip } = await taskIdentity()
  const secrets = new SecretCache()
  const githubSecretId = env('GITHUB_APP_SECRET')
  const stateBucket = env('STATE_BUCKET')
  const sqs = new SQSClient({})
  const apps = new Map<string, GithubApp>()
  const botUsers = new Map<string, number>()
  /**
   * The platform GitHub App; `app` is undefined while `dshsa/github-app` still holds placeholders (`dshsa-admin github app-set`).
   * Keyed by App id and private key, so a rotated key (a new secret version, design onboarding §6) mints with the new key.
   */
  let unconfigured = false
  const appFor = async (): Promise<{ app?: GithubApp; slug: string; secret?: GithubAppSecret }> => {
    const parsed = GithubAppSecret.safeParse(await secrets.json(githubSecretId).catch(() => ({})))
    if (!parsed.success) {
      if (!unconfigured) log.warn('GitHub App secret is not configured; cells run without GitHub access', { secret: githubSecretId })
      unconfigured = true
      return { slug: 'dshsa-unconfigured' }
    }
    unconfigured = false
    const id = createHash('sha256').update(`${parsed.data.appId}\n${parsed.data.privateKey}`).digest('hex')
    let app = apps.get(id)
    if (!app) { apps.clear(); apps.set(id, app = new GithubApp(parsed.data)) }
    return { app, slug: parsed.data.slug, secret: parsed.data }
  }
  const botUserId = async (login: string): Promise<number> => {
    const cached = botUsers.get(login)
    if (cached) return cached
    const response = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'dshsa' } })
    const id = response.ok ? Number(((await response.json()) as { id?: number }).id ?? 0) : 0
    if (id) botUsers.set(login, id)
    return id
  }
  // A new `feishu.revision` means `feishu set` wrote a new secret version: read it past the cache (design onboarding §4).
  const feishuRevisions = new Map<string, string>()
  const feishuSecrets = async (tenant: TenantRecord): Promise<FeishuSecrets> => {
    const { secretArn, revision = '' } = tenant.feishu!
    if (feishuRevisions.has(secretArn) && feishuRevisions.get(secretArn) !== revision) secrets.forget(secretArn)
    feishuRevisions.set(secretArn, revision)
    return secrets.json<FeishuSecrets>(secretArn)
  }

  const sourcesFor = async (record: CellRecord, tenant: TenantRecord | undefined): Promise<CellSources> => {
    const { app, slug } = await appFor()
    const repository = `${record.repo.owner}/${record.repo.name}`
    const login = `${slug}[bot]`
    const userId = app ? await botUserId(login) : 0
    // Without an App the cell still runs (lease, SQLite, Litestream, panel); GitHub calls fail and their effects retry.
    // The App is resolved on every token, so a rotated private key applies without a restart (a changed slug restarts the cell).
    const github = new GithubClient(repository, async () => {
      const current = (await appFor()).app
      if (!current) throw new Error('The GitHub App is not configured (dshsa-admin github app-set)')
      return (await current.token(record.repo.installationId, [record.repo.id])).token
    })
    let feishu: CellInfo['feishu']
    let feishuApi: FeishuClient | undefined
    if (tenant?.feishu) {
      const bot = await feishuSecrets(tenant)
      feishuApi = new FeishuClient({ domain: tenant.feishu.domain, appId: bot.appId, appSecret: bot.appSecret })
      const info = await feishuBotInfo(feishuApi)
      feishu = { domain: tenant.feishu.domain, appId: bot.appId, botId: info.openId, name: info.name }
    }
    const cell: CellInfo = { tenantId: record.tenantId, cellId: record.cellId, repository, repoId: record.repo.id, installationId: record.repo.installationId,
      defaultBranch: record.repo.defaultBranch, app: { slug, login, userId, noreply: `${userId}+${login}@users.noreply.github.com` }, ...feishu ? { feishu } : {} }
    const kinds = [githubKind, ...feishu ? [feishuKind] : []] as SourceKind[]
    return { cell, apis: { github, ...feishuApi ? { feishu: feishuApi } : {} }, kinds,
      claimPull: async (runtime, ticketId, prNumber) => {
        const ctx = runtime.context(githubKind)
        const pull = await readPull(ctx, prNumber)
        return runtime.store.atomic(() => claimPull(ctx, ticketId, pull))
      },
      // DSH Runtime: notify the ticket's conversations whenever it ends via a pull request.
      onEvent: (event, parts) => {
        if (event.type !== 'ticket.ended') return
        const ended = parts.store.tickets.get(event.data.ticketId)
        if (!ended) return
        const request = parts.store.triggers.get(ended.origin.triggerId)?.text ?? ''
        for (const message of pullEndNotices(ended, request, repository)) parts.notify(message)
      },
      readResource: async (runtime, trigger, resource) => {
        if (!feishuApi) throw new Error('This tenant has no Feishu bot')
        const ref = feishuRef(trigger)
        if (!ref) throw new Error('Not a Feishu trigger')
        const pageSize = Number((runtime.sources.instance('feishu')?.config as { readPageSize?: number } | undefined)?.readPageSize ?? 20)
        return { content: JSON.stringify(await feishuRead(feishuApi, ref, resource, pageSize)), mediaType: 'application/json' }
      },
      syncChats: (config, chats) => {
        const current = config as unknown as FeishuConfig
        const next = syncBoundChats(current, chats.map(chat => ({ chatId: chat.chatId, chatName: chat.name })))
        return next === current ? undefined : next as unknown as Record<string, unknown>
      } }
  }
  const workerVersion = new SsmWorkerVersion(log)
  const catalog = new DynamoCatalog(undefined, log)
  const host = new HostProcess({ owner, endpoint: `http://${ip}:${InternalApiPort}`, dataDir: env('DATA_DIR', '/data'), stateBucket,
    maxCells: Number(env('MAX_CELLS', '20')), maxConnectors: Number(env('MAX_CONNECTORS', '5')), log,
    leases: new DynamoLeaseStore(), catalog, replicator: new LitestreamReplicator(log),
    queueFor: record => new SqsCellQueue(record.queueUrl, sqs),
    sourcesFor, runtime: new AgentCoreRuntime(env('RUNTIME_ARN')), provisioner: new LambdaProvisioner(env('PROVISIONER_FUNCTION')),
    workerVersion: () => workerVersion.current(),
    tokens: new TicketTokens(new KmsDerSigner(env('TOKEN_KEY_ID'))), model: new BedrockModelClient(),
    connectors: { factory: tenant => createFeishuConnector(tenant), secrets: feishuSecrets,
      kv: tenantId => new S3JsonKv(stateBucket, StateKeys.connectorKv(tenantId)),
      enqueue: async (queueUrl: string, envelope: CellEnvelope) => {
        await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(envelope), MessageGroupId: envelope.cellId, MessageDeduplicationId: envelope.id }))
      } } })
  // Internal HTTP callers prove their IAM role with a presigned sts:GetCallerIdentity URL (parent design §4.7, contracts v3).
  const verifier = new CallerVerifier({ region: env('AWS_REGION'), ...process.env.ACCOUNT_ID ? { account: process.env.ACCOUNT_ID } : {},
    roles: { api: env('PANEL_API_ROLE_NAME'), worker: env('WORKER_API_ROLE_NAME'), tenant: env('PANEL_TENANT_ROLE_NAME', 'dshsa-panel-tenant') } })
  const tenants: TenantRoutes = {
    installationRepositories: (tenantId, installationId) => installationRepositories({ claim: id => catalog.installationClaim(id),
      app: async () => { const { secret } = await appFor(); return secret ? { appId: secret.appId, privateKey: secret.privateKey } : undefined } },
    tenantId, installationId, AbortSignal.timeout(20_000)),
  }
  const server = internalServer({ verify: (presigned, target, area) => verifier.verify(presigned, target, area), cells: host, log, tenants })
  server.listen(InternalApiPort, '0.0.0.0')
  const stop = new AbortController()
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { log.info('stopping', { signal }); stop.abort() })
  log.info('host started', { owner, endpoint: `http://${ip}:${InternalApiPort}` })
  const watching = watchGithubApp({ version: () => secrets.version(githubSecretId), slug: async () => (await appFor()).slug, host, log,
    everyMs: 5 * 60_000, signal: stop.signal })
  await host.run(stop.signal)
  await watching
  server.close()
  log.info('host stopped', {})
}

/**
 * Design onboarding §6: re-reads `dshsa/github-app`'s version every `everyMs`; on a new version (set from the Platform page or
 * `dshsa-admin github app-set`), restarts each running cell whose App slug changed (the slug is part of its CellInfo). A key
 * rotation alone needs no restart: cells resolve the App on every token.
 */
export async function watchGithubApp(options: { version(): Promise<string | undefined>; slug(): Promise<string>;
  host: Pick<HostProcess, 'cellSlugs' | 'restartCell'>; log: Logger; everyMs: number; signal: AbortSignal }): Promise<void> {
  let last = await options.version().catch(() => undefined)
  while (!options.signal.aborted) {
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, options.everyMs)
      options.signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
    })
    if (options.signal.aborted) return
    try {
      const version = await options.version()
      if (!version || version === last) continue
      const known = last !== undefined
      last = version
      if (!known) continue
      const slug = await options.slug()
      options.log.info('GitHub App secret changed', { version, slug })
      for (const [cellId, started] of options.host.cellSlugs()) if (started !== slug) await options.host.restartCell(cellId, 'GitHub App slug changed')
    } catch (error) { options.log.warn('GitHub App watch failed', { error: String(error) }) }
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.env.DSHSA_MAIN === '1') {
  main().catch((error: unknown) => { console.error(error); process.exit(1) })
}
