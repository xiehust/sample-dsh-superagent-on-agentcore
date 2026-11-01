#!/usr/bin/env -S pnpm exec tsx
/** `dshsa-admin`: platform onboarding CLI (design §4.2). Uses the operator's AWS credentials in the platform region (`REGION` from @dshsa/contracts). */
import { readFileSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { REGION } from '@dshsa/contracts'
import { CognitoIdentityProviderClient, ListUserPoolsCommand } from '@aws-sdk/client-cognito-identity-provider'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { SQSClient } from '@aws-sdk/client-sqs'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import * as ops from './ops.ts'

const USAGE = `dshsa-admin <command>
  tenant add <tenantId> --name <name>        tenant disable|enable <tenantId>        tenant list
  cell add <tenantId> --repo owner/name --repo-id <n> --installation-id <n> [--default-branch main]
  cell list [--tenant <id>]                  cell pause|disable|enable <cellId>
  github app-set --app-id <n> --private-key-file <pem> [--slug <slug>] [--webhook-secret <s>]   (slug is read from GitHub)
  github-install register <tenantId> <installationId>
  feishu set <tenantId> --domain feishu|lark --app-id <id> --app-secret <s> [--encrypt-key <k>]
  chat bind <tenantId> <chatId> <cellId> [--name <chat name>]      chat unbind <tenantId> <chatId>
  github oauth-set [--client-id <Iv…>] [--client-secret <hex>]      (the App's OAuth client, for the panel install flow)
  user add <email> --tenant <tenantId> [--role member|tadmin] [--temp-password <p>]       user add-admin <email> [--temp-password <p>]
  user remove <email> --tenant <tenantId>    user list --tenant <tenantId>
Env: AWS_PROFILE / credentials; DSHSA_USER_POOL_ID (else the pool named dshsa-users is looked up).`

const OPTIONS = {
  name: { type: 'string' }, repo: { type: 'string' }, 'repo-id': { type: 'string' }, 'installation-id': { type: 'string' },
  'default-branch': { type: 'string' }, tenant: { type: 'string' }, 'app-id': { type: 'string' }, slug: { type: 'string' },
  'private-key-file': { type: 'string' }, 'webhook-secret': { type: 'string' }, domain: { type: 'string' },
  'app-secret': { type: 'string' }, 'encrypt-key': { type: 'string' }, 'temp-password': { type: 'string' }, role: { type: 'string' },
  'client-id': { type: 'string' }, 'client-secret': { type: 'string' }, help: { type: 'boolean', short: 'h' },
} as const

const need = (value: string | undefined, flag: string): string => {
  if (!value) throw new ops.AdminError(`missing ${flag}`)
  return value
}
const int = (value: string | undefined, flag: string): number => {
  const n = Number(need(value, flag))
  if (!Number.isSafeInteger(n) || n <= 0) throw new ops.AdminError(`${flag} must be a positive integer`)
  return n
}

async function userPoolId(cognito: CognitoIdentityProviderClient): Promise<string> {
  if (process.env.DSHSA_USER_POOL_ID) return process.env.DSHSA_USER_POOL_ID
  let NextToken: string | undefined
  do {
    const page = await cognito.send(new ListUserPoolsCommand({ MaxResults: 60, NextToken }))
    const pool = page.UserPools?.find(p => p.Name === 'dshsa-users')
    if (pool?.Id) return pool.Id
    NextToken = page.NextToken
  } while (NextToken)
  throw new ops.AdminError('user pool dshsa-users not found; deploy dshsa-shared or set DSHSA_USER_POOL_ID')
}

export async function main(argv: string[]): Promise<void> {
  const { values: v, positionals: p } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true })
  if (v.help || p.length === 0) { console.log(USAGE); return }
  const cognito = new CognitoIdentityProviderClient({ region: REGION })
  const lazyPool = { id: '' }
  const c: ops.AdminClients = {
    db: DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), { marshallOptions: { removeUndefinedValues: true } }),
    sqs: new SQSClient({ region: REGION }), secrets: new SecretsManagerClient({ region: REGION }), cognito,
    get userPoolId() { return lazyPool.id },
    now: () => new Date(), log: line => console.log(line),
  }
  const withPool = async () => { lazyPool.id = await userPoolId(cognito) }
  const [group, cmd, ...args] = p
  const print = (x: unknown) => console.log(JSON.stringify(x, null, 2))

  switch (`${group} ${cmd ?? ''}`.trim()) {
    case 'tenant add': await withPool(); await ops.tenantAdd(c, need(args[0], '<tenantId>'), need(v.name, '--name')); break
    case 'tenant disable': await ops.tenantSetStatus(c, need(args[0], '<tenantId>'), 'disabled'); break
    case 'tenant enable': await ops.tenantSetStatus(c, need(args[0], '<tenantId>'), 'active'); break
    case 'tenant list': print(await ops.tenantList(c)); break
    case 'cell add': print(await ops.cellAdd(c, {
      tenantId: need(args[0], '<tenantId>'), repo: need(v.repo, '--repo'), repoId: int(v['repo-id'], '--repo-id'),
      installationId: int(v['installation-id'], '--installation-id'), defaultBranch: v['default-branch'],
    })); break
    case 'cell list': print(await ops.cellList(c, v.tenant)); break
    case 'cell pause': await ops.cellSetStatus(c, need(args[0], '<cellId>'), 'paused'); break
    case 'cell disable': await ops.cellSetStatus(c, need(args[0], '<cellId>'), 'disabled'); break
    case 'cell enable': await ops.cellSetStatus(c, need(args[0], '<cellId>'), 'active'); break
    case 'github app-set': await ops.githubAppSet(c, {
      appId: need(v['app-id'], '--app-id'), slug: v.slug,
      privateKey: readFileSync(need(v['private-key-file'], '--private-key-file'), 'utf8'), webhookSecret: v['webhook-secret'],
    }); break
    case 'github-install register': print(await ops.githubInstallRegister(c, need(args[0], '<tenantId>'), int(args[1], '<installationId>'))); break
    case 'feishu set': await ops.feishuSet(c, {
      tenantId: need(args[0], '<tenantId>'), domain: need(v.domain, '--domain'), appId: need(v['app-id'], '--app-id'),
      appSecret: need(v['app-secret'], '--app-secret'), encryptKey: v['encrypt-key'],
    }); break
    case 'chat bind': await ops.chatBind(c, need(args[0], '<tenantId>'), need(args[1], '<chatId>'), need(args[2], '<cellId>'), v.name); break
    case 'chat unbind': await ops.chatUnbind(c, need(args[0], '<tenantId>'), need(args[1], '<chatId>')); break
    case 'github oauth-set': await ops.githubOauthSet(c, { clientId: v['client-id'], clientSecret: v['client-secret'] }); break
    case 'user add': {
      const role = v.role ?? 'member'
      if (role !== 'member' && role !== 'tadmin') throw new ops.AdminError('--role must be member or tadmin')
      await withPool(); await ops.userInvite(c, need(args[0], '<email>'), need(v.tenant, '--tenant'), role, { tempPassword: v['temp-password'], ensureGroups: true }); break
    }
    case 'user remove': await withPool(); await ops.userRemove(c, need(args[0], '<email>'), need(v.tenant, '--tenant')); break
    case 'user list': await withPool(); print(await ops.tenantUsers(c, need(v.tenant, '--tenant'))); break
    case 'user add-admin': await withPool(); await ops.userAddAdmin(c, need(args[0], '<email>'), v['temp-password']); break
    default: throw new ops.AdminError(`unknown command: ${p.join(' ')}\n\n${USAGE}`)
  }
}

/** True when this file is the process entry (also through a symlinked `bin` or a relative path). */
const isEntry = (): boolean => {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href } catch { return false }
}
if (isEntry()) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof ops.AdminError ? `error: ${e.message}` : e)
    process.exit(1)
  })
}
