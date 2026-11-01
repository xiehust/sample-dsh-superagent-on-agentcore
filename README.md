# dshsa: a multi-tenant super agent on AWS

**English** | [简体中文](README.zh-CN.md)

dshsa turns GitHub and Feishu/Lark messages into **Tickets** that coding agents work on. An agent acknowledges each request, opens a pull request, and replies when the work is ready. Workers are [Claude Agent SDK](https://docs.claude.com/en/docs/agent-sdk/overview) agents that run on **Amazon Bedrock AgentCore Runtime**, one microVM session per Ticket. Each Ticket's workspace sits on its own **S3 Files access point**.

It is a port of DeepSeek's **dsh-superagent** prototype (`dsh-superagent-prototype/`, MIT, © 2026 DeepSeek Harness Team) from a single-repository process to a multi-tenant AWS platform. `packages/core` is a near-verbatim copy of its Engine, model and Policy. The per-ticket storage isolation follows the `agentcore-s3files-per-user-isolation` sample.

For depth, see:
- [`docs/design.md`](docs/design.md): architecture, the cross-module contracts (§4) and the security model. This is the source of truth.
- [`research/00-synthesis.md`](research/00-synthesis.md): what was learned from the prototype and the isolation sample, in Chinese.

## Architecture

[![dshsa architecture: GitHub and Feishu/Lark ingress, the host with tenant cells, Bedrock, the AgentCore worker microVM, and per-ticket S3 Files access points](docs/images/architecture.svg)](docs/images/architecture.svg)

The dashed boxes are trust boundaries: a **tenant cell** (one Engine per tenant and repository), a **worker microVM** (one per Ticket), and **AP isolation** (each Ticket's storage is reachable only through its own access point). A [PNG](docs/images/architecture.png) is also available.

<details>
<summary>Text version of the diagram</summary>

```
 GitHub App ──webhook──► API GW dshsa-ingress ─► Lambda github-webhook ─┐
                                                                        ▼
 Feishu/Lark ◄──long connection── Feishu Connector ──────────► SQS FIFO dshsa-cell-<cellId>.fifo
                                  (1 per tenant)                        │
            ┌─ ECS Fargate dshsa-host ──────────────────────────────────▼───────────┐
            │  LeaseManager ─► cell runtime ×k: DSH Engine + SQLite ─► Litestream → S3 │
            │                  Assessor / Replier ─► Bedrock Converse                │
            │                  Executor ─► InvokeAgentRuntime   Outbox ─► GitHub/Feishu│
            └──────────▲───────────────────────────────┬────────────────────────────┘
                       │ internal HTTP :8080            │ ticket token (ES256, KMS)
 Panel SPA (CloudFront)│                                ▼
   ─Cognito JWT─► panel-api ──┘        AgentCore Runtime dshsa-worker (1 session per Ticket)
                                         gateway (root) ─► broker Lambda ─► STS + session policy
                                         agent (uid 1000, Claude Agent SDK)  ─► /mnt/work = ticket AP
                                         gateway proxy ─► worker-api (private API GW) ─► cell queue
```

</details>

**Ingress (`dshsa-ingress`).** An HTTP API exposes a single route, `POST /github/webhook`, with stage throttling. Its Lambda verifies GitHub's HMAC signature and looks up the cell in `dshsa-routes` by installation and repository. It then enqueues a `source.event` envelope on that cell's SQS FIFO queue. Feishu/Lark needs no public endpoint: the host dials out over a long connection.

**Host (`dshsa-host`).** An ECS Fargate service (arm64). Each task acquires DynamoDB leases with fencing, so exactly one Engine writes each cell.
- A **cell** is one (tenant, repository) pair: one DSH Engine plus one SQLite file, replicated to the state bucket with Litestream.
- The same lease mechanism runs one **Feishu Connector** per tenant (`connector#<tenantId>`): a WebSocket client plus history backfill.
- Every write to a cell enters through its FIFO queue or its internal HTTP endpoint, both served by the lease owner.

**Bedrock eval and reply (`packages/assess`).** The Assessor decides whether a request becomes a Ticket under the cell's Policy, and the Replier composes the replies. Both make Bedrock Converse tool calls with prompt caching. The defaults are `global.anthropic.claude-sonnet-5-5` for eval and reply and `global.anthropic.claude-opus-5-5` for the worker, and both can be overridden per cell.

**Worker (`dshsa-worker`).** An AgentCore Runtime container (Amazon Linux 2023, arm64). AgentCore runs each session in its own microVM, and one Ticket keeps one `runtimeSessionId`.
- The **gateway** runs as root. It holds the ticket token, mounts the Ticket's S3 Files access point at `/mnt/work` using credentials from the broker, and proxies the agent's control-plane calls.
- The **agent** runs as uid 1000 with NoNewPrivs. It drives the Claude Agent SDK.
- The git working copy lives on local disk, because git on S3 Files measured 17–384× slower. At the end of each turn the agent checkpoints to `/mnt/work/repo.bundle`, and the SDK transcript is kept under `/mnt/work/.claude`. A new microVM on the same session restores both (design §4.10).

**worker-api, provisioner and broker** are Lambdas in `worker/src/dshsa_worker`.
- The **provisioner** creates the per-Ticket access point.
- The **broker** checks the ticket token and returns STS credentials whose session policy allows only that access point.
- **worker-api** is a private API Gateway (AWS_IAM plus a VPC endpoint condition) that also requires the ticket token. It turns worker events (ack, report, handback, …) into cell queue messages and serves GitHub and Feishu reads and short-lived, repository-scoped GitHub credentials.

**Panel (`dshsa-panel`).** A React SPA on CloudFront (OAC) with Cognito sign-in (hosted UI). panel-api is an HTTP API with a JWT authorizer plus a Lambda. It checks the user's tenant group and forwards to the lease owner's internal HTTP endpoint.

## Domain model

| Term | Meaning |
|---|---|
| **Trigger** | One normalized message or event (a comment, a Feishu message, a CI result), with a deterministic id |
| **Thread** | The conversation a Trigger belongs to (`github:<n>`, `feishu:<chat>:<root>`) |
| **Eval** | One Assessor run over the admissible Triggers of a Thread, under the current Policy |
| **Decision** | The Eval's outcome: `accept`, `ignore`, `reopen`, `stop` or `unavailable` |
| **Ticket** | A unit of accepted work, with a title and scope |
| **Assignment** | One worker run of a Ticket (an AgentCore session) |
| **Report** | The worker's state: `progress`, `waiting`, `ready`, `blocked`, `failed` or `dropped`. The Replier turns it into a reply in the original Thread |

## Repository layout

| Path | Content |
|---|---|
| `packages/contracts` | Shared names, zod schemas and types for every cross-module contract, plus a Python mirror (`python/dshsa_contracts.py`) for the worker |
| `packages/core` | The DSH domain core (Engine, model, Policy), ported from the prototype |
| `packages/cell` | The host process: LeaseManager, cell runtime, SQLite + Litestream store, AgentCore Executor, Outbox, internal HTTP API |
| `packages/sources` | The GitHub and Feishu/Lark Sources, the Feishu Connector, and the GitHub webhook Lambda |
| `packages/assess` | The stateless Bedrock model layer for the Assessor and Replier |
| `packages/control-api` | The panel-api Lambda, the `dshsa-admin` CLI for onboarding, and the e2e harness |
| `packages/panel` | The panel SPA (React + Vite) |
| `worker/` | The AgentCore container (`container/`: gateway, agent, Dockerfile) and the broker, provisioner and worker-api Lambdas (`src/dshsa_worker`), in Python |
| `infra/` | The CDK app: `dshsa-shared`, `dshsa-worker`, `dshsa-host`, `dshsa-ingress`, `dshsa-panel` |
| `scripts/` | `deploy.sh`, `destroy.sh`, `e2e/run.sh` |
| `docs/` | The design (`design.md`, `onboarding-design.md`) and operator guides: the e2e setup checklist, GitHub App, Feishu bot |
| `spikes/` | Risk spikes with reports: S1 git on S3 Files, S2 SDK resume, S3 Feishu WebSocket |
| `research/` | Analysis of the prototype and the isolation sample, in Chinese |
| `dsh-superagent-prototype/` | The upstream prototype, kept read-only as the porting reference |

## Security model

- **Teams and roles are Cognito groups.** A team (tenant) has a member group and a team-admin group; platform admins have their own group. panel-api serves a cell only when the user's `cognito:groups` contains that cell's team group, and only team admins and platform admins may change settings, repositories, the bot or chats. Members read, and may Stop or Retry tickets.
- **Installations are linked by proof, not by id.** A team admin links a GitHub installation by signing in to GitHub in the panel; the panel lists the installations that GitHub says the user can access. It is active only for the user's own account or an organization they are an admin of. Anything else waits for a platform admin's approval.
- **Per-Ticket storage.** Each Ticket has its own S3 Files access point. The broker issues STS credentials with a session policy pinned to that access point's ARN. The file-system policy denies access that does not go through an access point. The AgentCore **execution role has no S3 or S3 Files permissions**.
- **The ticket token is the worker's only authority.** It is an ES256 JWS signed with a KMS key (`alias/dshsa-ticket-token`), lasts at most 2 h, and is scoped to tenant, cell, Ticket and assignment. Only the cell issues it. It stays in the root gateway process, and the agent reaches the control plane through the gateway's local proxy. Only the host role may call `InvokeAgentRuntime`, and nobody may call `InvokeAgentRuntimeCommand`.
- **Internal calls prove the caller's IAM identity.** panel-api and worker-api call the host's internal HTTP endpoint with a presigned `sts:GetCallerIdentity` URL that also signs the target cell. The host executes the URL and checks the returned role ARN. Security groups are a second layer.
- **Webhook HMAC.** Every GitHub delivery is verified against `X-Hub-Signature-256` before anything is parsed, and the check fails closed. The deploy script verifies that unsigned and forged requests are refused.

## Prerequisites

- Node.js ≥ 22.19 (developed on Node 24) and pnpm 10 (`packageManager` is `pnpm@10.27.0`).
- [uv](https://docs.astral.sh/uv/) for the Python worker (Python ≥ 3.12).
- Docker able to build `linux/arm64` images: CDK builds the host and worker images.
- The AWS CLI with admin credentials for the target account. `curl` and `jq` are used by the scripts and docs.
- The target account id in `DSHSA_ACCOUNT`: export it, or put `DSHSA_ACCOUNT=<12-digit account id>` in `scripts/local.env` (gitignored; `scripts/lib.sh` sources it). The scripts refuse to run without it.
- CDK bootstrapped in the target account and region: `cd infra && pnpm exec cdk bootstrap aws://<account-id>/ap-northeast-1`.
- Bedrock model access to the Claude models above, through their `global.` inference profiles.

## Deploy and destroy

The region is **ap-northeast-1**. It is a constant, not an option: `REGION` in `packages/contracts/src/names.ts` (and its Python mirror), and `AWS_REGION` in `scripts/lib.sh`. Moving regions means changing those, and passing AZ names that map to AgentCore-supported AZ IDs (`DSHSA_AZS`).

The CDK app and the scripts deploy only to the account in `DSHSA_ACCOUNT` (from the environment or `scripts/local.env`), and refuse credentials for any other account. The repository holds no account id: `ACCOUNT` in `infra/lib/compose.ts` is a placeholder for tests and local synth. Set `DSHSA_ALLOW_ANY_ACCOUNT=true` to skip the check.

```sh
pnpm install
scripts/deploy.sh
```

`deploy.sh` runs these steps:
1. Installs dependencies and builds the panel.
2. Deploys `dshsa-shared`, `dshsa-worker`, `dshsa-host`, `dshsa-ingress` and `dshsa-panel` (or only the stacks you name, e.g. `scripts/deploy.sh dshsa-host`). It refuses any stack name without the `dshsa-` prefix.
3. Writes the outputs to `infra/cdk-outputs.json`.
4. Verifies denial: anonymous panel-api calls must get the authorizer's 401, and `pnpm --filter @dshsa/sources check:ingress` must see unsigned and forged webhooks refused.

The optional environment variables are:
- `DSHSA_VPC_ID`: import an existing VPC instead of creating `dshsa-vpc`.
- `DSHSA_AZS`: a comma-separated list of AZ names.
- `DSHSA_RETAIN=true`: retain data on destroy.
- `DSHSA_DEV_CALLBACK=true`: add a local-dev Cognito callback.

The stack outputs you will need are `GithubWebhookUrl`, `PanelUrl`, `PanelApiUrl`, `HostedUiDomain`, `UserPoolClientId` and `DshsaFileSystemId`.

```sh
scripts/destroy.sh
```

`destroy.sh` asks you to type the account id to confirm, or takes `--yes`. It deletes only what is named `dshsa-*`:
1. The per-cell queues.
2. The per-Ticket access points.
3. The five stacks.
4. The `dshsa/feishu/*` secrets.
5. The `dshsa` log groups.

It then lists anything still tagged `project=dshsa`.

## Onboarding a team

Onboarding is self-service in the panel (`PanelUrl`). The step-by-step checklist, including the GitHub and Feishu console steps, is [docs/e2e-setup.md](docs/e2e-setup.md). The details are in [docs/github-app.md](docs/github-app.md) and [docs/feishu-bot.md](docs/feishu-bot.md).

1. **GitHub App** (platform, once): create it with the Redirect URI `<PanelUrl>/setup/github/callback`, the Setup URL `<PanelUrl>/setup/github`, **Organization permissions → Members: Read-only**, and a client secret.
2. **First platform admin** (the one CLI step): `pnpm --filter @dshsa/control-api admin user add-admin <email>`. Cognito emails a temporary password.
3. **Platform** tab: under **GitHub App**, enter the App ID, private key, Client ID and client secret; the slug is read from GitHub. Under **Teams**, create the team; under **Users**, invite its team admin.
4. **Team setup** tab (team admin), guided by its **Onboarding checklist**:
   - **Repositories**: **Install / configure the GitHub App**, then **Link installations**, then **Add** each repository. An installation on your own account, or on an organization you are an admin of, is linked right away; any other installation waits for a platform admin under **Platform → GitHub installations**.
   - **Feishu / Lark**: the bot's App ID and App Secret, then the console's event configuration once the bot shows **Connected**. Each team uses its own app.
   - **Chats**: add the bot to a group, @-mention it once, then pick the group's repository.
   - **Users**: invite members and other team admins.
5. **Settings → Policy** (per repository): the form lists who may originate work, with **Add from repo collaborators** and **Add all members of <chat>**, and sets the **Eval mode**. **Advanced (JSON)** edits the whole block.

**Eval mode** (`Off`, `Observe` or `Auto`; the default is `Observe`) only affects **inferred** messages, the ones that don't @-mention the agent and aren't direct messages. With `Observe`, they are evaluated and recorded as "would accept", and nothing else happens. With `Auto`, they can become Tickets. With `Off`, they are not evaluated. An explicit @-mention or direct message from someone on the list is evaluated in every mode.

Every step also has a `dshsa-admin` command; see "Appendix: CLI fallback" in [docs/e2e-setup.md](docs/e2e-setup.md).

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm check
pnpm --filter @dshsa/sources test
pnpm --filter @dshsa/infra test
pnpm --filter @dshsa/infra synth
pnpm --filter @dshsa/panel dev
```

`pnpm check` runs both typecheck and test across the workspace. Every package (`contracts`, `core`, `cell`, `sources`, `assess`, `control-api`, `panel`, `infra`) has `typecheck` and `test` scripts, run with `pnpm --filter @dshsa/<name> <script>`.

The worker uses Python with uv:

```sh
cd worker
uv run pytest -q
uv run ruff check .
uv run python tests/smoke/local_smoke.py
uv run python tests/isolation_test.py --region ap-northeast-1
```

- `local_smoke.py` runs the worker image in Docker: two containers share one work volume, and only Bedrock is called. The second container must resume the SDK session.
- `isolation_test.py` is the deployed A3/A4 isolation and resume test. It needs admin credentials and uses tenant `isotest`. It deletes the tickets' access points at the end unless `--keep` is given.

The e2e harness runs against the deployed platform. It creates `e2e<run>`-prefixed tenants, cells and users and removes them afterwards unless `--keep` is given:

```sh
scripts/e2e/run.sh
scripts/e2e/run.sh --only panel
scripts/e2e/run.sh --strict --wait 60
```

## Status (verified live on 2026-11-01)

- **A2, GitHub**: an Issue mention → acknowledgement → PR from the App's bot → ready reply.
- **A2, Feishu**: a bound-chat mention → Ticket → PR.
- **A3/A4 isolation and resume**: 19/19 (`worker/tests/isolation_test.py`).
- **A5 panel tenant isolation**: a tenant sees and acts on only its own cells (`scripts/e2e/run.sh`).
- **Ingress gate**: unsigned and forged webhooks are refused (`check:ingress`).

Known gaps:
- A6 (an unauthorized or unaddressed message produces no Ticket) and A7 (destroy leaves nothing behind) are not yet automated end to end. `run.sh` has an A6 step; the live A2–A5 steps there are placeholders.
- **Rotate the GitHub webhook secret before production.** Enter a new value under **Platform → GitHub App → Webhook secret (optional)** (with the private key), or run `admin github app-set … --webhook-secret <new>`, and set the same value in the App.

## Troubleshooting

Host logs are in the CloudWatch log group `/dshsa/host`. The webhook Lambda logs to `/dshsa/ingress-github-webhook`, panel-api to `/dshsa/panel-api`, and the panel's setup actions are audited in `/dshsa/panel-admin`.

| Log message | Meaning |
|---|---|
| `feishu.health` | Connector state per tenant: `starting`, `ready` (detail `Listening for bot events`) or `error` with the cause |
| `trigger not admitted` | The cell didn't admit a message. `reason` says why, for example `not_a_member` (the sender isn't on the Policy's list), `no_mention` (not addressed to the agent) or `not_human` (a bot not on the bot list); `at` is `intake` or `gate` |
| `feishu.unrouted` | A message arrived from a chat that isn't bound. Bind it under **Team setup → Chats** (its `chatId` is what `admin chat bind` needs) |
| `poison envelope dropped` | A cell-queue message was not a valid envelope and was deleted so it doesn't block the cell's FIFO group; the parse error is in the entry |
| `worker event refused` | The domain refused a worker event (for example, a report on an ended Ticket). It is recorded and not retried |

- **The slug is not the Client ID.** The App slug is the last part of `github.com/apps/<slug>`, the name people @-mention. The Client ID (`Iv…`) is something else. The panel and `admin github app-set` read the slug from GitHub.
- **An installation waits for platform approval**: the reason is `not_own_account` (a user installation on someone else's account), `not_org_admin` (the user isn't an admin of the organization) or `membership_unavailable` (GitHub didn't confirm the org role, usually because the App lacks **Members: Read-only**). A platform admin approves it under **Platform → GitHub installations**.
- **Belongs to another team** (`other_tenant`): another team linked the installation; a platform admin can release it. **Unlink** and **Release** answer `409 installation_in_use` while a repository still uses the installation: disable those repositories first.
- **Webhook 401 / 503**, and more: see the troubleshooting table in [docs/e2e-setup.md](docs/e2e-setup.md).
- **Feishu console won't save long-connection mode**: save the bot in **Team setup → Feishu / Lark** first, then wait for **Connected** (`feishu.health` `ready`).
