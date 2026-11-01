# Feishu / Lark bot setup (per tenant)

Each tenant brings **its own self-built app with a bot**, either on Feishu (`open.feishu.cn`) or on Lark (`open.larksuite.com`). The platform keeps **one long connection per tenant**. It runs as the tenant's Connector inside the host service, under the lease `connector#<tenantId>`. The app needs no public endpoint: the Connector dials out to Feishu.

Feishu delivers each event of an app to only one of its connections, so exactly one Connector per tenant must be running; the lease guarantees that. Every 60 s, and right after each reconnect, the Connector also reads the history of every bound chat and its active topics, so messages are recovered across disconnects. A message gets the same Trigger id on the live and the backfill path (`key('feishu', message_id)`), and the cell stores it once.

Messages are routed by chat. Each chat is bound to one cell (a repository) through the route `fs#<tenantId>#<chatId>`. Messages in unbound chats are **recorded but not acted on**: the Connector notes the chat, so it shows up as "not bound" for binding.

## 1. Create the app

On the Feishu developer console (https://open.feishu.cn/app) or the Lark one (https://open.larksuite.com/app): **Create custom app** (企业自建应用).

1. **Add features → Bot** (添加应用能力 → 机器人).
2. **Permissions & scopes** (权限管理). Grant the bot (tenant token) scopes:

   | Scope (console name) | Why |
   |---|---|
   | Receive group chat messages that @ the bot (接收群聊中@机器人消息事件) | Requests in groups |
   | Read direct messages sent to the bot (读取用户发给机器人的单聊消息) | Direct messages |
   | Obtain and send messages in direct and group chats (获取与发送单聊、群组消息) | Replies; history backfill (`GET /im/v1/messages`) |
   | Obtain group information (获取群组信息) | The chat list (`GET /im/v1/chats`) for names and binding |
   | Obtain group members (获取群成员信息) | Listing a chat's members with their open_ids, for the Policy's allowed list |
   | Read and upload images or files (获取与上传图片或文件资源) | Images in a request, read during assessment |
   | *Optional:* Read all messages in groups (获取群组中所有消息) | Only for chats set to **All** instead of **@ only** |

   The bot works only with the tenant token. No user token is ever requested or stored.
3. **Events & callbacks → Event configuration** (事件与回调 → 事件配置):
   - Subscription mode: **Receive events through persistent connection** (使用长连接接收事件). The console checks that a client is connected when you save. Store the credentials (step 2) first, wait until the host's Connector reports `Listening for bot events`, then save.
   - Add the event **Message received** `im.message.receive_v1` (接收消息).
   - An *Encrypt Key* is optional. If you set one, store it too (step 2).
4. **Version management & release** (版本管理与发布): create a version and publish it. A tenant admin approves it in the admin console.
5. Add the bot to each chat it should serve (chat settings → **Bots → Add bot**).

## 2. Store the credentials

These come from the app's **Credentials & basic info** page (凭证与基础信息). Run this with the platform admin's AWS credentials. `read -rs` waits for you to paste the App Secret and doesn't echo it, so it stays off the screen and out of shell history; press Enter after pasting. For a Lark tenant use `--domain lark`. If you set an Encrypt Key, add `--encrypt-key <Encrypt Key>`.

```sh
read -rs FEISHU_APP_SECRET && echo
pnpm --filter @dshsa/control-api admin feishu set <tenantId> --domain feishu --app-id cli_xxx --app-secret "$FEISHU_APP_SECRET"
unset FEISHU_APP_SECRET
```

This writes the Secrets Manager secret `dshsa/feishu/<tenantId>` (`{appId, appSecret, encryptKey?}`) and `feishu: {domain, appId, secretArn}` on the tenant record. Never put the App Secret in chat or tickets. The host's Connector picks the tenant up on its next lease round. Workers never receive Feishu credentials: they read Feishu through the control plane.

## 3. Bind chats to repositories

1. Find the chat id (`oc_…`). It appears in the panel's list of chats the Connector has seen, including unbound ones, after any message there. You can also read it from `GET /open-apis/im/v1/chats` with the bot.
2. Bind it to a cell:

   ```sh
   pnpm --filter @dshsa/control-api admin chat bind <tenantId> <oc_chatId> <cellId> --name "<chat name>"
   ```

3. Within about 60 s the host adds the chat to that cell's Feishu Source config under `chats` as **@ only** (`listen: mentions`). It syncs that list from the bindings, so the binding table is the only place to bind or unbind; **Settings → Feishu chat bindings** in the panel shows the table and can add or remove bindings. As in DSH, that config decides what the cell listens to in a bound chat. Direct messages follow its `directMessages` switch, and the direct chat must be bound too. The panel has no editor for the Source config, so a chat stays **@ only**.
4. In the panel, under **Settings → Configuration → Policy** (a JSON editor), add the people who may ask for work to `sources.feishu.allowed` as `{ "id": "ou_…", "name": "…" }`. `name` is optional, and the id is the person's open_id for this bot. [e2e-setup.md](e2e-setup.md) step 3 shows how to list a chat's members with their open_ids. The panel has no **Sync now** button.

## 4. Verify

- Mention the bot in a bound chat. The thread gets an acknowledgement, and Overview shows the Ticket.
- In a chat that isn't bound, a mention produces no reply. The host log shows `feishu.unrouted` with the chat id, and the chat appears as not bound.
- If the bot is missing from a chat, replies fail with `The Feishu bot is not a member of the chat`. Add the bot, and the next retry succeeds.

## Notes

- **Feishu vs Lark**: the domain is per tenant and must match the console where the app was created. Lark apps don't work with `open.feishu.cn`, and the reverse.
- **Cross-border latency**: the host runs in ap-northeast-1 (Tokyo). The long connection to `open.feishu.cn` still crosses borders, though it is shorter than from the US. Disconnects are expected; the SDK reconnects, the Connector restarts the client with backoff (1 s up to 60 s), and the backfill after each reconnect fills the gap. Spike S3 measures this.
- **Topics** (话题) are scanned for 14 days after their last message, as in DSH.
