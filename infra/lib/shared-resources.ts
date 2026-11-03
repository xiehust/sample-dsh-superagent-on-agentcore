/**
 * What `dshsa-shared` hands to every module construct (worker.ts, host.ts, ingress.ts) and to `dshsa-panel`.
 * Owner: dd. Changing this interface: message dd (and the coordinator if it touches parent design §4).
 *
 * Cross-stack rules (to keep the stack graph acyclic: shared → worker → host; shared → ingress; shared → panel):
 * - Grant through the consumer's role (`table.grantReadData(role)`, `key.grant(role, 'kms:Sign')`): CDK writes identity
 *   policies in the consumer's stack. Never call anything that edits a resource policy of a shared resource
 *   (bucket policies, key policies, secret resource policies) from another stack; ask dd instead.
 * - Name every resource `dshsa-*` (parent design §3). Roles too: `dshsa-<module>-<purpose>`.
 */
import type { aws_cognito as cognito, aws_dynamodb as dynamodb, aws_ec2 as ec2, aws_iam as iam, aws_kms as kms, aws_lambda as lambda,
  aws_s3 as s3, aws_secretsmanager as secretsmanager } from 'aws-cdk-lib'

export interface SharedTables {
  /** `dshsa-tenants`, PK `tenantId`. */
  tenants: dynamodb.ITable
  /** `dshsa-cells`, PK `cellId`, GSI `byTenant` (PK `tenantId`). */
  cells: dynamodb.ITable
  /** `dshsa-routes`, PK `routeKey` (`gh#<installationId>#<repoId>` | `fs#<tenantId>#<chatId>`), GSI `byTenant`. */
  routes: dynamodb.ITable
  /** `dshsa-leases`, PK `leaseKey` (`cell#<cellId>` | `connector#<tenantId>` | `host#<taskId>` presence). */
  leases: dynamodb.ITable
  /** `dshsa-ticket-storage`, PK `ticketKey`. Written only by the provisioner, read (GetItem) by the broker / worker-api. */
  ticketStorage: dynamodb.ITable
  /**
   * v6 `dshsa-onboarding`, PK `key` (`ghinst#<installationId>` claim | `ghstate#<nonce>` OAuth state), TTL `ttl`, GSI `byTenant`.
   * Written only by the panel setup Lambdas; the host reads claims (GetItem) for its tenant repo-list route.
   */
  onboarding: dynamodb.ITable
}

export interface SharedSecrets {
  /**
   * `dshsa/github-app`: JSON `{ appId, slug, privateKey, webhookSecret, clientId? }`. Placeholder values until the
   * platform admin runs `dshsa-admin github app-set`. Readers: ingress (webhookSecret), host (privateKey), worker-api.
   */
  githubApp: secretsmanager.ISecret
  /** v6 `dshsa/github-oauth`: `{ clientId, clientSecret, appId?, slug? }` of the App's OAuth client. Readers: panel setup Lambdas only. */
  githubOauth: secretsmanager.ISecret
  /** ARN pattern of per-tenant Feishu secrets `dshsa/feishu/<tenantId>` (created by the admin CLI, not by CDK). */
  feishuSecretArnPattern: string
}

export interface SharedNetwork {
  vpc: ec2.IVpc
  /**
   * Private subnets with NAT egress, in AgentCore-supported AZ IDs (apne1-az4 / apne1-az1, i.e. ap-northeast-1a / 1c in this account). Use for the AgentCore runtime,
   * S3 Files mount targets, the host Fargate tasks and every in-VPC Lambda.
   */
  privateSubnets: ec2.SubnetSelection
  /** Interface endpoint for `execute-api`; the private worker-api (a8) restricts its resource policy to this endpoint. */
  executeApiEndpoint: ec2.IInterfaceVpcEndpoint
  /**
   * Whether private DNS is on for `executeApiEndpoint`. It is off when the VPC is imported (other teams share it), so call the
   * private API through `https://{apiId}-{vpceId}.execute-api.<region>.amazonaws.com/{stage}` in that case.
   */
  executeApiPrivateDns: boolean
  /** SG of the panel-api Lambda. host.ts must allow TCP 8080 from it on the host task SG (design §4.7). */
  panelApiSg: ec2.ISecurityGroup
}

export interface SharedResources {
  account: string
  region: string
  network: SharedNetwork
  tables: SharedTables
  /** KMS `alias/dshsa-ticket-token`, ECC_NIST_P256, SIGN_VERIFY (design §4.3). Host: kms:Sign; broker/worker-api: kms:GetPublicKey (+ kms:Verify). */
  ticketTokenKey: kms.IKey
  buckets: {
    /** `dshsa-data-<acct>`: S3 Files data bucket. Only `dataBucketS3FilesRole` is granted access. */
    data: s3.IBucket
    /** `dshsa-state-<acct>`: Litestream replicas `cells/<cellId>/`, connector KV `connectors/<tenantId>/kv.json`. Host only. */
    state: s3.IBucket
    /** `dshsa-logs-<acct>`: S3 server access logs and CloudFront standard logs (ACLs enabled, BucketOwnerPreferred). */
    logs: s3.IBucket
  }
  /** `dshsa-s3files`: service role S3 Files assumes to sync the FS with the data bucket (pass as `RoleArn` of the FS). */
  dataBucketS3FilesRole: iam.IRole
  secrets: SharedSecrets
  /** `dshsa-users`: Cognito user pool. Tenant groups are `dshsa-tenant-<tenantId>`, tenant admins `dshsa-tadmin-<tenantId>`; platform admins `dshsa-platform-admin`. */
  userPool: cognito.IUserPool
  /** ARN pattern of the per-cell FIFO queues `dshsa-cell-<cellId>.fifo` (created by the admin CLI, design §4.1). */
  cellQueueArnPattern: string
  /** Model ids (design §3), overridable per cell. */
  models: { eval: string; worker: string }
}

/** Props every module construct receives. Add your own module-specific props by extending this. */
export interface ModuleProps {
  shared: SharedResources
}

/**
 * Module construct shape that app.ts instantiates. Each owner exports exactly this class name from their file:
 *   infra/lib/constructs/worker.ts  → `export class WorkerModule extends Construct implements WorkerOutputs` (a8)
 *   infra/lib/constructs/host.ts    → `export class HostModule extends Construct` (5c), props `HostModuleProps`
 *   infra/lib/constructs/ingress.ts → `export class IngressModule extends Construct` (95), props `ModuleProps`
 * app.ts creates one Stack per module (`dshsa-worker`, `dshsa-host`, `dshsa-ingress`) and does
 * `new WorkerModule(stack, 'Worker', { shared })`, etc. Put no Stack inside your construct.
 */
export interface WorkerOutputs {
  /** AgentCore runtime ARN (`dshsa_worker`); host gets bedrock-agentcore:InvokeAgentRuntime on it (and its endpoints). */
  readonly runtimeArn: string
  /** `dshsa-provisioner` Lambda; host gets lambda:InvokeFunction. */
  readonly provisionerFunction: lambda.IFunction
  /** S3 Files file system id (the destroy script deletes leftover access points on it). */
  readonly fileSystemId: string
  /** SG of the worker-api Lambda; host.ts allows TCP 8080 from it (token refresh, design §4.3). */
  readonly workerApiSg: ec2.ISecurityGroup
  /** v7: the Codex runtime (`dshsa_worker_codex`), absent when disabled; host gets invoke/stop on it and `RUNTIME_ARN_CODEX`. */
  readonly codexRuntimeArn?: string | undefined
}

export interface HostModuleProps extends ModuleProps {
  worker: WorkerOutputs
}
