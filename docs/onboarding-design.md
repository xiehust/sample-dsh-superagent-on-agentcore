# Design: panel self-service onboarding

Parent contracts: [`design.md`](design.md). This task adds contract **v6** (§4.11 below); existing v1–v5
are unchanged. 

## 1. Roles and authorization (D1)

| Cognito group | Meaning |
|---|---|
| `dshsa-platform-admin` | everything |
| `dshsa-tadmin-<tenantId>` (new) | tenant admin of one tenant; always also in `dshsa-tenant-<tenantId>` |
| `dshsa-tenant-<tenantId>` | tenant member (today) |

The new prefix is `dshsa-tadmin-`, not `dshsa-tenant-…-admin`, because `candidateTenantIds` strips `dshsa-tenant-` and
tenant ids may contain `-`. `TenantId` additionally refuses the reserved ids `admin`, `tadmin`.

Authorization matrix (enforced in panel-api handlers, fail closed, 403 without revealing existence):

| Operation | member | tenant admin (own) | platform admin |
|---|---|---|---|
| read cells, tickets, transcript; Stop/Retry | ✓ | ✓ | ✓ |
| PUT settings (Policy/Eval/Executor/prompts) | ✗ (**new restriction**) | ✓ | ✓ |
| repos: link installation, add/pause/disable cell | ✗ | ✓ | ✓ |
| Feishu bot secret set; chats list; bind/unbind | ✗ | ✓ | ✓ |
| tenant users: invite member/tenant admin, remove | ✗ | ✓ (own tenant only) | ✓ |
| tenants create/disable; platform admins; GitHub App | ✗ | ✗ | ✓ |

The cell host already receives `x-dshsa-actor`; panel-api adds `x-dshsa-role` (`member|tadmin|admin`, from the
verified claims) and the cell refuses `PUT settings/*` and `POST policy-sync/*` for `member` as a second check.

## 2. Components

```
Panel (SPA)  ──JWT──▶ API GW (same authorizer)
                       ├─ /v1/cells/**, /v1/me ............ dshsa-panel-api      (today; read + cell forward)
                       ├─ /v1/tenants/{t}/setup/** ........ dshsa-panel-tenant   (new; tenant admin + platform admin)
                       └─ /v1/admin/** .................... dshsa-panel-platform (new; platform admin only)
```

Two new Lambdas instead of widening `dshsa-panel-api`, so each role holds only what its routes need:

| Lambda | IAM (all `dshsa-*` scoped) | Never gets |
|---|---|---|
| panel-tenant | DDB write `dshsa-cells`, `dshsa-routes`, `dshsa-onboarding`, `dshsa-tenants` (feishu attr via UpdateItem); SQS `CreateQueue/GetQueueAttributes/SetQueueAttributes/TagQueue` on `dshsa-cell-*`; Secrets `CreateSecret/PutSecretValue/TagResource` on `dshsa/feishu/*` (no Get); `GetSecretValue` on `dshsa/github-oauth`; Cognito `AdminCreateUser/AdminAddUserToGroup/AdminRemoveUserFromGroup/AdminGetUser/ListUsersInGroup` on the pool; S3 `GetObject` on state bucket `connectors/*/kv.json`; installation repo lists via a host route (§7 Q1) | the GitHub App private key, KMS token key, data bucket, other secrets |
| panel-platform | DDB write `dshsa-tenants`; Cognito `CreateGroup` + the user actions; Secrets `Get/PutSecretValue` on `dshsa/github-app`, `dshsa/github-oauth` | everything else |

Secrets are **write-only** through every API: responses carry `{set: true, updatedAt}` only. All three Lambdas reuse
`packages/control-api/src/admin/ops.ts` (the CLI stays the same code path).

Audit: every mutation logs one JSON line to `/dshsa/panel-admin`:
`{actor:{sub,email}, role, op, tenantId, target, ok, error?}`; no secret values, no message text.

## 3. GitHub repo claim (D2) — never trust `installation_id`

GitHub documents that the Setup URL's `installation_id` can be spoofed; the safe check is a **user access token** and
`GET /user/installations`. Flow:

1. Tenant admin → **Repositories → Install / configure App**: panel opens
   `https://github.com/apps/<slug>/installations/new` (new tab). The App's **Setup URL** = `<panel>/setup/github`
   just brings the user back; its query is ignored.
2. **Link installations**: panel-tenant creates a single-use nonce item in the new table `dshsa-onboarding`
   `{key: "ghstate#<nonce>", tenantId, sub, ttl: now+10min}` and returns
   `https://github.com/login/oauth/authorize?client_id=<id>&redirect_uri=<panel>/setup/github/callback&state=<nonce>`.
3. GitHub → callback with `code`, `state`. Panel posts both to `POST /v1/tenants/{t}/setup/github/link`.
   panel-tenant: conditional-delete the nonce (must exist, unexpired, same tenant and same `sub`) → exchange `code`
   with the client secret → `GET /user/installations` (filtered to our App id) → user token discarded.
4. For each such installation: claim `dshsa-onboarding {key: "ghinst#<installationId>", tenantId, claimedBy, at}` with
   condition `attribute_not_exists OR tenantId = :t`. Claimed by another tenant → shown as "belongs to another team"
   (platform admin can reassign).
4a. **Who may claim (user decision 2026-11-01, v6.2)**: with the user token, `GET /user` gives the login. A
   `User` installation is `active` only if `account.login == login`; an `Organization` installation is `active` only if
   `GET /user/memberships/orgs/{org}` returns `state: active, role: admin`. Anything else is written as `pending`
   (`pendingReason`), shown to the tenant as "waiting for platform approval", and listed for platform admins (approve →
   `active`, reject → delete). The App needs **Organization permissions → Members: read** for the membership call.
   The host lists repositories only for `status: active` claims of the asking tenant (fail closed).
5. **Repos list**: for installations claimed by this tenant only, panel-tenant asks the host (internal API, v3
   caller proof, new tenant-level route `GET /tenants/{t}/github/installations/{id}/repositories`), which uses the App
   installation token it already holds (`GET /installation/repositories`).
   **Add** → `ops.cellAdd` with ids from GitHub (no typing). `cellAdd`'s existing route-steal guard stays.

Needs from the platform admin (one time, Platform → GitHub App page shows the checklist): App **Callback URL** =
`<panel>/setup/github/callback`, **Setup URL** = `<panel>/setup/github`, "Redirect on update" on, generate a **client
secret**; stored in new secret `dshsa/github-oauth` `{clientId, clientSecret}`, separate from the private key so
panel-tenant can read the OAuth creds without ever holding the App key.

## 4. Feishu / Lark

- **Bot**: form `domain, appId, appSecret, encryptKey?` → `ops.feishuSet` (write-only). `TenantRecord.feishu` gains
  `revision` (ISO time of last set). Health: panel-tenant reads Connector state `connectors/<t>/kv.json`
  (`health`, `chats`) from the state bucket.
- **Chats** page: from the same Connector state: every chat the bot has seen (`name`, `lastAt`, `routed`, `cellId`,
  `unrouted` count) + bindings from `dshsa-routes`. Bind = dropdown of the tenant's cells → `ops.chatBind`.
  Bot not in any chat yet → show "add the bot to a group and @ it once".
- **Host propagation**: the Connector holder compares `tenant.feishu.revision` each lease tick and restarts the
  Connector on change; same for a cell's Feishu API client.

## 5. Policy form (D3)

Cell API already exposes each SourceKind's `policy.fields` (rows/columns metadata, as DSH's panel used). The panel
renders those as a form; pickers call two new cell routes (added to `CELL_ROUTES`, member-readable):

- `GET sources/feishu/members?chat=<oc_>` — members of a chat **bound to this cell** (refused otherwise), via the
  cell's FeishuClient (`/im/v1/chats/:id/members?member_id_type=open_id`); returns `{id: ou_…, name}`.
- `GET sources/github/collaborators` — repo collaborators via the installation token; returns `{id: login}`.

Save = existing `PUT settings/policy` (optimistic revision). Errors are shown per field, with the Source prefix fixed
in the cell's 400 (`sources.github.allowed.0`). JSON tab = today's editor.

## 6. GitHub App changes reaching hosts (R8)

Host re-reads `dshsa/github-app` (version id) every 5 min; on a new version it drops the cached App and restarts
cells whose slug changed (slug is baked into CellInfo at start).

## 4.11 Contract v6

- `CognitoGroups.tenantAdmin(t) = "dshsa-tadmin-" + t`; `RESERVED_TENANT_IDS` (`admin`, `tadmin`, `platform`) refused
  by `tenantAdd` only (the `TenantId` schema is unchanged so stored records keep parsing).
- New table `dshsa-onboarding` (pk `key`, TTL attribute `ttl`, GSI `byTenant`), **not** `dshsa-routes`: route GSI
  queries feed the host's chat sync and must only ever see `gh#`/`fs#` routes. Keys `onboardingKey.githubInstall(id)
  = "ghinst#" + id`, `onboardingKey.githubState(nonce) = "ghstate#" + nonce`; records `InstallationClaim`,
  `SetupState` (see records.ts). Shared stack adds the table.
- `TenantRecord.feishu.revision?: string`.
- `Secrets.githubOauth = "dshsa/github-oauth"`; `GithubOauthSecret {clientId, clientSecret}`.
- Header `x-dshsa-role`; `PanelRole = 'member'|'tadmin'|'admin'`.
- `AuditEntry` shape (§2).
- Python mirror: group/route helpers only.

## 7. Review decisions (user approved 2026-11-01: Q1 host route, Q2 tighten now, Q3 code-enforced + audited)

- Q1 panel-tenant needs the GitHub App private key to list an installation's repos (step 5). Alternative: list via
  the host (it already holds the key) through a tenant-level host route — keeps the key off panel Lambdas but adds a
  host dependency for onboarding. Proposed: host route (key stays in host + worker-api only).
- Q2 Members currently may edit settings; D1 removes that. OK to tighten now?
- Q3 Tenant admins may invite users of their own tenant (R1/D1). Cognito IAM cannot scope `AdminAddUserToGroup` by
  group, so that limit is enforced in code only (audited). Acceptable?

## 8. Security review (builder-security)

No new listener or public origin: same CloudFront + API GW + Cognito JWT authorizer; new routes are authorized per
§1 before any side effect; anonymous → 401 at the authorizer (verified by e2e before UI rollout). OAuth `state`
is single-use, bound to tenant+sub, 10-min TTL; `installation_id` from GitHub redirects is never trusted. Secrets are
write-only; GitHub user tokens are used once in memory and never stored or logged. IAM is per-Lambda, `dshsa-*`
scoped (§2). Rollback: remove the two Lambdas' routes; CLI keeps working throughout.
