# GitHub App setup

dshsa uses one **platform-wide GitHub App**. Each tenant installs it on its repositories, and each installed repository becomes a cell (`<tenantId>--gh<repoId>`). People ask for work by mentioning the App, `@<app-slug> …`, in an Issue, a PR, or a comment. The agent's own comments, branches and PRs appear as `<app-slug>[bot]`.

Deliveries reach the cell along this path: GitHub webhook → API Gateway `dshsa-ingress` (`POST /github/webhook`) → Lambda `dshsa-ingress-github-webhook` (HMAC check, then a route lookup in `dshsa-routes` on `gh#<installationId>#<repoId>`) → SQS FIFO `dshsa-cell-<cellId>.fifo` → the cell's GitHub Source. The cell also runs a reconciliation poll every 60 s with an installation token, so a lost delivery is still picked up. A delivery and a poll that read the same comment produce the same Trigger id, and the Engine stores it once.

## 1. Create the App

GitHub → **Settings → Developer settings → GitHub Apps → New GitHub App**, or under an organization: **Organization settings → GitHub Apps**.

| Field | Value |
|---|---|
| GitHub App name | The App's name. Its **slug** is what people mention, so keep it short, for example `acme-agent` |
| Homepage URL | Any URL, such as the panel URL |
| Identifying and authorizing users | **Add redirect URI**: the **Redirect URI** (formerly Callback URL) is `<PanelUrl>/setup/github/callback`. Leave **Allow wildcard matching**, **Request user authorization (OAuth) during installation** and **Enable Device Flow** unchecked |
| Post installation → Setup URL | Optional: `<PanelUrl>/setup/github`, with **Redirect on update** on |
| Webhook → Active | On |
| Webhook URL | The `dshsa-ingress` stack output `GithubWebhookUrl` (`https://<api-id>.execute-api.ap-northeast-1.amazonaws.com/github/webhook`) |
| Webhook secret | The `webhookSecret` from Secrets Manager `dshsa/github-app` (see step 3). `dshsa-shared` generates it on first deploy |
| SSL verification | Enabled |
| Where can this App be installed | "Any account" if tenants live in other orgs, otherwise "Only on this account" |

`<PanelUrl>` is the `dshsa-panel` stack output `PanelUrl`. The panel's **Platform → GitHub App** checklist shows the same values with copy buttons. The Redirect URI and Setup URL serve the panel's "Link installations" flow; the CLI steps below don't use them. For that flow, also **Generate a new client secret** under **Client secrets** and enter it with the Client ID in the panel.

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

Under **Organization permissions**, grant **Members: Read-only**: the panel uses it to check that whoever links an organization's installation is an admin of that organization. Leave every other organization and account permission at "No access".

### Subscribe to events

`Issue comment`, `Issues`, `Pull request`, `Pull request review`, `Pull request review comment`, `Check suite`, `Workflow run`, `Status`.

The webhook Lambda answers other events `202 {"ignored":"event"}` and `ping` with `200`.

## 2. Generate a private key

On the App page, **Private keys → Generate a private key** downloads a `.pem`. Keep it out of the repository and out of chat.

## 3. Store the App identity

Run this with the platform admin's AWS credentials. It keeps the `webhookSecret` that `dshsa-shared` generated; add `--webhook-secret <s>` to set your own. It checks the App ID and key with GitHub (`GET /app`) and stores the App's real slug. The slug is the last part of the App page URL (`github.com/apps/<slug>`), **not** the Client ID (`Iv…`). `--slug <app-slug>` is optional, and a wrong one is refused. Cells read the slug and key only at start, so restart the host afterwards (or wait for the next `dshsa-host` deploy).

```sh
pnpm --filter @dshsa/control-api admin github app-set --app-id <numeric app id> --private-key-file ./app.private-key.pem
```

Then paste the webhook secret into the App's **Webhook secret** field. **It is sensitive**: anyone holding it can sign deliveries that the ingress accepts. Don't print it. Copy it straight to the clipboard (macOS `pbcopy`; on Linux `wl-copy` or `xclip -selection clipboard`; over SSH, the OSC 52 form in [e2e-setup.md](e2e-setup.md) step 0), paste it, then clear the clipboard:

```sh
aws secretsmanager get-secret-value --region ap-northeast-1 --secret-id dshsa/github-app --query SecretString --output text | jq -r .webhookSecret | tr -d '\n' | pbcopy
```

The secret `dshsa/github-app` holds `{appId, slug, privateKey, webhookSecret}`. Who reads it:
- `dshsa-ingress-github-webhook` reads `webhookSecret` only. Until a real secret (≥ 20 characters) is stored, the Lambda refuses every delivery with `503`, so it fails closed.
- The host task reads `appId` and `privateKey` to mint repo-scoped installation tokens (`issues`/`pull_requests` write, `contents`/`checks`/`statuses`/`actions` read).
- worker-api mints the workers' ≤ 1 h tokens, scoped to the cell's repository with `contents:write, pull_requests:write, issues:write`.

To rotate the webhook secret, write the new value with `app-set --webhook-secret`, then change it on GitHub. The Lambda re-reads the secret once whenever a signature fails to match, so deliveries signed with either value are accepted during the switch.

## 4. Install the App and create cells

1. The tenant installs the App on its repositories (**Install App → Only select repositories**).
2. Find the installation id (the URL `https://github.com/settings/installations/<id>`, or `GET /app/installations` with the App JWT) and each repository's numeric id (`gh api repos/<owner>/<name> --jq .id`).
3. Register them:

   ```sh
   dshsa-admin cell add <tenantId> --repo <owner>/<name> --repo-id <repoId> --installation-id <installationId>
   ```

   This creates the cell, its FIFO queue and the route `gh#<installationId>#<repoId>`. A delivery from a repository without a route is answered `202` and logged as `webhook.unrouted`; nothing is queued.
4. In the panel, add the people who may ask for work to `sources.github.allowed` under **Settings → Configuration → Policy** (a JSON editor; entries are `{ "id": "<github-login>" }`). Until that list has someone, no request becomes a Ticket.

## 5. Verify

- **Recent Deliveries** on the App page shows `202` for a test comment. `401` means the webhook secret differs; `503` means the Lambda cannot read a usable `webhookSecret` from `dshsa/github-app`.
- In CloudWatch Logs, `/dshsa/ingress-github-webhook` shows `webhook.enqueued` with the cell id.
- From an allowed account, comment `@<app-slug> <request>` on an Issue. Overview shows a Ticket within seconds.

## Behaviour notes (as in DSH)

- A mention added by editing an existing Issue body does not start work. Post a new comment instead. An edited comment produces a new Trigger.
- Comments that neither mention the App nor belong to a conversation the cell already knows are dropped before intake, unless an **observe** switch on the GitHub Source card is on.
- The App's PR on the branch `…/<ticket short name>` binds to its Ticket, and its merge or close ends the Ticket.
- Payloads larger than 240 KiB go onto the queue as identifiers only, and the cell re-reads that Issue or PR.
