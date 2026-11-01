# GitHub App setup

dshsa uses one **platform-wide GitHub App**. Each team installs it on its repositories and links the installation in the panel, and each added repository becomes a cell (`<tenantId>--gh<repoId>`). People ask for work by mentioning the App, `@<app-slug> …`, in an Issue, a PR, or a comment. The agent's own comments, branches and PRs appear as `<app-slug>[bot]`.

Deliveries reach the cell along this path: GitHub webhook → API Gateway `dshsa-ingress` (`POST /github/webhook`) → Lambda `dshsa-ingress-github-webhook` (HMAC check, then a route lookup in `dshsa-routes` on `gh#<installationId>#<repoId>`) → SQS FIFO `dshsa-cell-<cellId>.fifo` → the cell's GitHub Source. The cell also runs a reconciliation poll every 60 s with an installation token, so a lost delivery is still picked up. A delivery and a poll that read the same comment produce the same Trigger id, and the Engine stores it once.

The step-by-step checklist is [e2e-setup.md](e2e-setup.md) steps 1, 3 and 5. This page explains the settings.

## 1. Create the App (platform admin, once)

GitHub → **Settings → Developer settings → GitHub Apps → New GitHub App**, or under an organization: **Organization settings → Developer settings → GitHub Apps**. `<PanelUrl>` is the `dshsa-panel` stack output `PanelUrl`.

| Field | Value |
|---|---|
| GitHub App name | The App's name. Its **slug** is what people mention, so keep it short, for example `acme-agent` |
| Homepage URL | Any URL, such as `<PanelUrl>` |
| Identifying and authorizing users | **Add redirect URI**: the **Redirect URI** (formerly Callback URL) is `<PanelUrl>/setup/github/callback`. Leave **Allow wildcard matching** and **Request user authorization (OAuth) during installation** unchecked, and **Enable Device Flow** off |
| Post installation → Setup URL | `<PanelUrl>/setup/github`, with **Redirect on update** on |
| Webhook → Active | On |
| Webhook URL | The `dshsa-ingress` stack output `GithubWebhookUrl` (`https://<api-id>.execute-api.ap-northeast-1.amazonaws.com/github/webhook`) |
| Webhook secret | The `webhookSecret` from Secrets Manager `dshsa/github-app` (see "Webhook secret" below). `dshsa-shared` generates it on first deploy |
| SSL verification | Enabled |
| Where can this App be installed | "Any account" if teams' repositories live in other accounts or organizations, otherwise "Only on this account" |

Why the two URLs:
- The **Redirect URI** is where GitHub returns after **Link installations** in the panel. The panel exchanges the one-time code for a user token, lists the installations of this App that the user can access (`GET /user/installations`), and discards the token. Wildcard matching must stay off, so GitHub returns only to this exact URL. "Request user authorization (OAuth) during installation" must stay off too: the panel starts the sign-in itself, with a single-use state tied to the team.
- The **Setup URL** brings people back to the panel after they install the App or, with **Redirect on update**, change its repositories. The panel ignores its `installation_id` query, which GitHub documents as spoofable; only the user-token check above links an installation.

### Repository permissions

| Permission | Access | Why |
|---|---|---|
| Issues | Read and write | Read requests; post acknowledgements and replies |
| Pull requests | Read and write | Read reviews and review comments; reply in review threads; workers open PRs |
| Contents | Read and write | Workers push `agent/<name>` branches. The cell's own token asks only for read |
| Checks | Read-only | CI state of the Tickets' PRs and the default branch |
| Commit statuses | Read-only | Same, for status-based CI |
| Actions | Read-only | `workflow_run` events |
| Metadata | Read-only | Mandatory |

### Organization permissions

**Members: Read-only.** When someone links an organization's installation, the panel checks with GitHub that they are an admin of that organization (`GET /user/memberships/orgs/{org}`). Without this permission GitHub doesn't say, and the link waits for platform approval (`membership_unavailable`). Leave every other organization and account permission at "No access".

### Subscribe to events

`Issue comment`, `Issues`, `Pull request`, `Pull request review`, `Pull request review comment`, `Check suite`, `Workflow run`, `Status`.

The webhook Lambda answers other events `202 {"ignored":"event"}` and `ping` with `200`.

## 2. Generate the credentials

On the App page:
- **Private keys → Generate a private key** downloads a `.pem`. Keep it out of the repository and out of chat.
- **Client secrets → Generate a new client secret**. GitHub shows it once. Note the **Client ID** (`Iv…`) next to it.

## 3. Store the App in the panel

Sign in to `<PanelUrl>` as a platform admin (the first one is created with `admin user add-admin <email>`, see [e2e-setup.md](e2e-setup.md) step 2). Open **Platform → GitHub App**. It shows the checklist **On GitHub (App settings → General)** with copy buttons for both URLs, then the form:

- **App ID**, and **Private key (.pem)** pasted or picked under **Upload private key**.
- **Client ID** and **Client secret**.
- **Webhook secret (optional)**: only to change it, and only together with the private key.

**Save GitHub App** checks the App ID and key with GitHub (`GET /app`) and stores the App's real slug, read from GitHub. The slug is the last part of the App page URL (`github.com/apps/<slug>`), **not** the Client ID. The section then shows the App ID and slug, **Private key: Valid**, the number of installations, and **OAuth client: Set**. Every secret field is write-only: a stored value is never shown back. Running hosts re-read the App every 5 minutes and restart a cell whose slug changed, so no restart is needed.

Where it is stored:
- `dshsa/github-app` holds `{appId, slug, privateKey, webhookSecret}`.
  - `dshsa-ingress-github-webhook` reads `webhookSecret` only. Until a real secret (≥ 20 characters) is stored, the Lambda refuses every delivery with `503`, so it fails closed.
  - The host task reads `appId` and `privateKey` to mint repo-scoped installation tokens (`issues`/`pull_requests` write, `contents`/`checks`/`statuses`/`actions` read).
  - worker-api mints the workers' ≤ 1 h tokens, scoped to the cell's repository with `contents:write, pull_requests:write, issues:write`.
- `dshsa/github-oauth` holds `{clientId, clientSecret}`, separately, so the panel's team-facing Lambda can sign users in without ever holding the App key.

### Webhook secret

Paste the generated `webhookSecret` into the App's **Webhook secret** field. **It is sensitive**: anyone holding it can sign deliveries that the ingress accepts. Don't print it. Copy it straight to the clipboard (macOS `pbcopy`; on Linux `wl-copy` or `xclip -selection clipboard`; over SSH, the OSC 52 form in [e2e-setup.md](e2e-setup.md) step 0), paste it, then clear the clipboard:

```sh
aws secretsmanager get-secret-value --region ap-northeast-1 --secret-id dshsa/github-app --query SecretString --output text | jq -r .webhookSecret | tr -d '\n' | pbcopy
```

To rotate it, enter the new value under **Webhook secret (optional)** with the private key and save, then change it on GitHub. The Lambda re-reads the secret once whenever a signature fails to match, so deliveries signed with either value are accepted during the switch.

## 4. Install the App and add repositories (team admin)

In **Team setup → Repositories**:

1. **Install / configure the GitHub App** opens GitHub's install page. Pick the account or organization and **Only select repositories**. GitHub returns to the Setup URL.
2. **Link installations** signs in to GitHub and links every installation of the App that this GitHub account can access:
   - **Active** right away when the installation is on the user's own account, or on an organization where the user is an **admin** (logins compare case-insensitively).
   - **Waiting for platform approval** otherwise, with the reason (`not_own_account`, `not_org_admin`, `membership_unavailable`). A platform admin approves or rejects it under **Platform → GitHub installations**. Its repositories can't be added before that.
   - **Belongs to another team** (`other_tenant`) when another team already linked it. A platform admin can release it.
3. Under **Linked installations**, **Add** a repository. This creates the cell, its FIFO queue and the route `gh#<installationId>#<repoId>`, with the ids taken from GitHub. A delivery from a repository without a route is answered `202 {"ignored":"unrouted"}` and logged as `webhook.unrouted`; nothing is queued.

**Unlink** (team admin) and **Release** (platform admin) remove a link, so another team can link the installation; the App stays installed on GitHub. Both are refused with `409 installation_in_use` while a repository of the team still uses the installation and isn't disabled. **Release anyway** releases it regardless and leaves those repositories running.

Then add the people who may ask for work: **Settings → Policy → Form → GitHub accounts that may originate work**, where **Add from repo collaborators** lists the repository's collaborators. Until that list has someone, no request becomes a Ticket.

## 5. Verify

- **Recent Deliveries** on the App page shows `202` for a test comment. `401` means the webhook secret differs; `503` means the Lambda cannot read a usable `webhookSecret` from `dshsa/github-app`.
- In CloudWatch Logs, `/dshsa/ingress-github-webhook` shows `webhook.enqueued` with the cell id.
- From an allowed account, comment `@<app-slug> <request>` on an Issue. Overview shows a Ticket within seconds. If not, `/dshsa/host` has `trigger not admitted` with the reason.

## CLI fallback

With platform-admin AWS credentials (`alias admin='pnpm --silent --filter @dshsa/control-api admin'`):

```sh
admin github app-set --app-id <APP_ID> --private-key-file ./app.private-key.pem
read -rs GITHUB_CLIENT_SECRET && echo
admin github oauth-set --client-id <Iv…> --client-secret "$GITHUB_CLIENT_SECRET"
unset GITHUB_CLIENT_SECRET
admin cell add <tenantId> --repo <owner>/<name> --repo-id <repoId> --installation-id <installationId>
```

- `app-set` keeps the existing `webhookSecret` unless you add `--webhook-secret <s>`. `--slug` is optional, and a wrong one is refused.
- `cell add` needs the installation id (the end of `https://github.com/settings/installations/<id>`, or `GET /app/installations` with the App JWT) and the repository's numeric id (`gh api repos/<owner>/<name> --jq .id`). It doesn't link the installation to the team in the panel.
- `admin github-install register <tenantId> <installationId>` points a team's cells at a new installation id after a reinstall.

## Behaviour notes (as in DSH)

- A mention added by editing an existing Issue body does not start work. Post a new comment instead. An edited comment produces a new Trigger.
- Comments that neither mention the App nor belong to a conversation the cell already knows are dropped before intake, unless one of the GitHub Source config's receive switches (`observeComments`, `observeIssues`, `observePulls`, `observeCi`) is on.
- The App's PR on the branch `…/<ticket short name>` binds to its Ticket, and its merge or close ends the Ticket.
- Payloads larger than 240 KiB go onto the queue as identifiers only, and the cell re-reads that Issue or PR.
