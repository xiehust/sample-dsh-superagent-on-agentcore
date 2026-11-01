# AGENTS.md

Guidance for AI coding agents (Claude Code, Codex, Kiro, …) working in this repository. Humans: start with
[README.md](README.md).

## What this is

A multi-tenant "super agent" platform on AWS, ported from DeepSeek's dsh-superagent (MIT). GitHub and Feishu/Lark
messages become Triggers; the DSH domain (Trigger → Thread/Eval → Decision → Ticket → Assignment → Report) runs in a
per-(tenant, repo) **cell** on the ECS host; work runs in **AgentCore Runtime** microVMs with a Claude Agent SDK
worker and a per-ticket **S3 Files access point**. Read [docs/design.md](docs/design.md) (§4 contracts, §5 security)
before changing anything that crosses a package boundary; panel onboarding is in
[docs/onboarding-design.md](docs/onboarding-design.md).

## Layout

| Path | What |
|---|---|
| `packages/contracts` | Cross-module contracts (zod + TS) and `python/dshsa_contracts.py` mirror; `tests/vectors.json` is the shared oracle |
| `packages/core` | DSH domain port (keep behaviour byte-identical to DSH; domain tests) |
| `packages/cell` | Host process: leases, cells (Engine + SQLite + Litestream), AgentCore executor, internal HTTP API |
| `packages/sources` | GitHub (webhook ingress, App tokens, OAuth helpers) and Feishu/Lark (connector, API) source kinds |
| `packages/assess` | Stateless Bedrock assessor / replier |
| `packages/control-api` | panel-api, panel-tenant, panel-platform Lambdas; `dshsa-admin` CLI (`src/admin`) |
| `packages/panel` | React + Vite SPA |
| `worker/` | Python: AgentCore container (gateway, agent, repo checkpoint), broker, provisioner, worker-api Lambdas |
| `infra/` | CDK app: stacks `dshsa-shared`, `dshsa-ingress`, `dshsa-worker`, `dshsa-host`, `dshsa-panel` |
| `scripts/` | `deploy.sh`, `destroy.sh`, `e2e/run.sh`, shared `lib.sh` |
| `docs/`, `research/`, `spikes/` | Design and setup docs; DSH study notes; risk-spike reports |

## Commands

```sh
pnpm install
pnpm check
pnpm --filter @dshsa/cell test
pnpm --filter @dshsa/infra test
cd worker && uv run pytest -q tests/unit && uv run ruff check .
```

`pnpm check` runs every package's typecheck and tests. Deploys need AWS credentials and the target account pinned:
`export DSHSA_ACCOUNT=<12-digit id>` (or put it in the untracked `scripts/local.env`), then
`scripts/deploy.sh [stack ...]`. Run CDK deploys **one at a time** (they share `infra/cdk.out`). Never deploy or
call AWS unless the user asked for it.

## Rules

- **Contracts first.** A shape that crosses packages (DynamoDB items, queue envelopes, invocation/worker-api bodies,
  headers, names) lives in `packages/contracts`; change it there, mirror it in Python, add a vector or test, and
  record it in docs/design.md §8. Keep stored records parseable (additive, optional fields).
- **Names**: every AWS resource is `dshsa-` prefixed; code must refuse non-`dshsa` names it would create or delete.
- **Security** (docs/design.md §5): fail closed; authorize before any side effect; secrets are write-only through
  APIs and never logged; internal HTTP uses the presigned `sts:GetCallerIdentity` caller proof; the worker execution
  role has no S3 permissions; per-Lambda least-privilege IAM, asserted in `infra/test`. No public listeners or
  buckets; the panel API stays behind the Cognito JWT authorizer (deploy.sh checks the anonymous 401).
- **Tests**: add a test that fails without your change (mutation-check it). Live failures this project hit were all
  "green tests, silent prod" — see the gotchas below.
- No commits or pushes unless the user asks.

## Gotchas learned in production

- Bedrock Claude 5.5 rejects forced `toolChoice`; use auto + a "must call" instruction + one retry (`packages/assess`).
- S3 Files access-point root paths allow at most 4 components: `/tenants/<t>/<cell>/<ticketKey>`.
- Feishu/Lark sends `null`, not an absent field, for withheld values; parse with the nullish helpers in
  `packages/sources/src/feishu/wire.ts`.
- The host bundle is ESM: the esbuild banner must define `require`, `__filename`, `__dirname`
  (`packages/cell/build.mjs`, guarded by `tests/bundle.spec.ts`).
- Worker → cell envelopes are `{event, verified}`; worker prompts must name the domain **trigger id**
  (`WorkerInput.meta.triggerId`), never the ticket input id. Both are pinned by golden vectors.
- An AgentCore Runtime deploy does not update live sessions; the cell stops idle sessions whose `workerVersion`
  differs from SSM `/dshsa-worker/version`. To force one by hand, `StopRuntimeSession` for that ticket.
- The GitHub App **slug** is the last part of `github.com/apps/<slug>`, not the Client ID (`Iv…`); `app-set` reads
  it from `GET /app`. Hosts read it at cell start.
- Never trust a GitHub `installation_id` from a redirect; verify with the user token (`GET /user/installations`).
- Policy rejections are logged as `trigger not admitted` with a reason in `/dshsa/host`; check it first when a
  message "does nothing".

## Local workflow (optional)

The block below is managed by the Trellis workflow tool and applies only to checkouts that have a local `.trellis/`
directory (it is not published in this repository).

<!-- TRELLIS:START -->
# Trellis Instructions

These instructions are for AI assistants working in this project.

This project is managed by Trellis. The working knowledge you need lives under `.trellis/`:

- `.trellis/workflow.md` — development phases, when to create tasks, skill routing
- `.trellis/spec/` — package- and layer-scoped coding guidelines (read before writing code in a given layer)
- `.trellis/workspace/` — per-developer journals and session traces
- `.trellis/tasks/` — active and archived tasks (PRDs, research, jsonl context)

If a Trellis command is available on your platform (e.g. `/trellis:finish-work`, `/trellis:continue`), prefer it over manual steps. Not every platform exposes every command.

If you're using Codex or another agent-capable tool, additional project-scoped helpers may live in:
- `.agents/skills/` — reusable Trellis skills
- `.codex/agents/` — optional custom subagents

Managed by Trellis. Edits outside this block are preserved; edits inside may be overwritten by a future `trellis update`.

<!-- TRELLIS:END -->
