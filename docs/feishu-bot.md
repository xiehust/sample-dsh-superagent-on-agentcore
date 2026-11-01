# Feishu / Lark bot setup (per team)

Each team brings **its own self-built app with a bot**, either on Feishu (`open.feishu.cn`) or on Lark (`open.larksuite.com`). The platform keeps **one long connection per team**. It runs as the team's Connector inside the host service, under the lease `connector#<tenantId>`. The app needs no public endpoint: the Connector dials out to Feishu.

Feishu delivers each event of an app to only one of its connections, so exactly one Connector per app must be running; the lease guarantees that. This is also why each team needs its own app: two teams sharing one app would share one connection. Every 60 s, and right after each reconnect, the Connector also reads the history of every bound chat and its active topics, so messages are recovered across disconnects. A message gets the same Trigger id on the live and the backfill path (`key('feishu', message_id)`), and the cell stores it once.

Messages are routed by chat. Each chat is bound to one cell (a repository) through the route `fs#<tenantId>#<chatId>`. Messages in unbound chats are **recorded but not acted on**: the Connector notes the chat, so it shows up in the panel, waiting for a binding.

Everything below is done by a team admin in the panel's **Team setup**. The step-by-step checklist is [e2e-setup.md](e2e-setup.md) steps 6 and 7.

## 1. Create the app

On the Feishu developer console (https://open.feishu.cn/app) or the Lark one (https://open.larksuite.com/app): **Create custom app** (企业自建应用). **Team setup → Feishu / Lark** shows the same steps as the **Feishu / Lark console checklist**.

1. **Add features → Bot** (添加应用能力 → 机器人).
2. **Permissions & scopes** (权限管理). Grant the bot (tenant token) scopes:

   | Scope (console name) | Why |
   |---|---|
   | Receive group chat messages that @ the bot (接收群聊中@机器人消息事件) | Requests in groups |
   | Read direct messages sent to the bot (读取用户发给机器人的单聊消息) | Direct messages |
   | Obtain and send messages in direct and group chats (获取与发送单聊、群组消息) | Replies; history backfill (`GET /im/v1/messages`) |
   | Obtain group information (获取群组信息) | The chat list (`GET /im/v1/chats`) for names and binding |
   | Obtain group members (获取群成员信息) | The Policy form's **Add all members of …** and **Pick from …** |
   | Read and upload images or files (获取与上传图片或文件资源) | Images in a request, read during assessment |
   | *Optional:* Read all messages in groups (获取群组中所有消息) | Only for chats set to **All** instead of **@ only** |

   The bot works only with the tenant token. No user token is ever requested or stored.
3. Store the credentials (step 2) **before** the event configuration.
4. **Events & callbacks → Event configuration** (事件与回调 → 事件配置):
   - Subscription mode: **Receive events through persistent connection** (使用长连接接收事件). The console checks that a client is connected when you save, so wait until the panel shows **Connected**, then save.
   - Add the event **Message received** `im.message.receive_v1` (接收消息).
   - An *Encrypt Key* is optional. If you set one, store it too (step 2).
5. **Version management & release** (版本管理与发布): create a version and publish it. A Feishu tenant admin approves it in the admin console.
6. Add the bot to each chat it should serve (chat settings → **Bots → Add bot**), and @-mention it there once.

## 2. Store the credentials

In **Team setup → Feishu / Lark → Feishu / Lark bot**, copy the values from the app's **Credentials & basic info** page (凭证与基础信息):

- **Platform**: Feishu (open.feishu.cn) or Lark (open.larksuite.com). It must match the console where the app was created.
- **App ID** (`cli_…`) and **App Secret**. The App Secret is needed on every save.
- **Encrypt Key (optional)**: only if set under Events & callbacks.

**Save bot** writes the Secrets Manager secret `dshsa/feishu/<tenantId>` (`{appId, appSecret, encryptKey?}`) and `feishu: {domain, appId, secretArn, revision}` on the team record. The form never shows a stored secret. The Connector reconnects with the new credentials within a minute, and the section shows its health: **Starting**, **Connected** (`Listening for bot events`) or **Error** with the cause. Never put the App Secret in chat or tickets. Workers never receive Feishu credentials: they read Feishu through the control plane.

## 3. Bind chats to repositories

1. Once the bot is in a group and someone has @-mentioned it there, **Team setup → Chats** lists the group, with its last activity and the number of messages waiting for a binding. A chat the bot isn't in never appears.
2. In the chat's **Repository** column, pick a repository from **Choose a repository…**. **Unbind** removes the binding. A repository must be added first (**Team setup → Repositories**).
3. Within about 60 s the host adds the chat to that cell's Feishu Source config under `chats` as **@ only** (`listen: mentions`). It syncs that list from the bindings, so the binding table is the only place to bind or unbind; **Settings → Feishu chat bindings** shows the table per repository, and **Manage chats** opens Team setup. As in DSH, that config decides what the cell listens to in a bound chat. Direct messages follow its `directMessages` switch, and the direct chat must be bound too.
4. Add the people who may ask for work in **Settings → Policy → Form → Feishu users who may originate work**: **Add all members of <chat>** adds everyone in a chat bound to this repository, and **Pick from <chat>** adds chosen people. Each row holds the person's `open_id` for this bot (open_ids differ per app) and their name. Optionally, choose a **Sync chat**: the list then follows that chat's members, at startup and on **Sync now**.

## 4. Verify

- Mention the bot in a bound chat. The thread gets an acknowledgement, and Overview shows the Ticket.
- In a chat that isn't bound, a mention produces no reply. The host log shows `feishu.unrouted` with the chat id, and **Team setup → Chats** shows the chat waiting for a binding.
- A mention from someone not on the list produces no reply either; `/dshsa/host` logs `trigger not admitted` with `reason: not_a_member`.
- If the bot is missing from a chat, replies fail with `The Feishu bot is not a member of the chat`. Add the bot, and the next retry succeeds.

## CLI fallback

With platform-admin AWS credentials (`alias admin='pnpm --silent --filter @dshsa/control-api admin'`). `read -rs` waits for you to paste the App Secret and doesn't echo it, so it stays off the screen and out of shell history; press Enter after pasting. For a Lark team use `--domain lark`. If you set an Encrypt Key, add `--encrypt-key <Encrypt Key>`.

```sh
read -rs FEISHU_APP_SECRET && echo
admin feishu set <tenantId> --domain feishu --app-id <cli_APP_ID> --app-secret "$FEISHU_APP_SECRET"
unset FEISHU_APP_SECRET
admin chat bind <tenantId> <oc_CHAT_ID> <cellId> --name "<chat name>"
```

The chat id (`oc_…`) of an unbound chat is in the `feishu.unrouted` entries of `/dshsa/host`. [e2e-setup.md](e2e-setup.md) (Appendix: CLI fallback) shows how to list a chat's members with their open_ids for the Policy's **Advanced (JSON)** tab.

## Notes

- **Feishu vs Lark**: the domain is per team and must match the console where the app was created. Lark apps don't work with `open.feishu.cn`, and the reverse.
- **Cross-border latency**: the host runs in ap-northeast-1 (Tokyo). The long connection to `open.feishu.cn` still crosses borders, though it is shorter than from the US. Disconnects are expected; the SDK reconnects, the Connector restarts the client with backoff (1 s up to 60 s), and the backfill after each reconnect fills the gap. Spike S3 measures this.
- **Topics** (话题) are scanned for 14 days after their last message, as in DSH.
