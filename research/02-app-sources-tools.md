# 02 — dsh-superagent：App / Sources / Tools 层分析

> 范围：`dsh-superagent-prototype/` 下 `src/app/*`（含 tools/、views/）、`src/sources/*`、`src/infra/*`、`src/index.ts`、`src/setup.ts`、`src/deployment.ts`、`src/navigation.ts`、`cordis.patch.yml`、`prompts/`、`skills/`、`docs/004-prompts.md`、`docs/008-cookbook.md`。
> 为说明 worker 目录模型，少量引用了 `src/executor/dsh.ts` 和 `src/policy.ts`（不在原始范围内）。
> 下文路径均相对 `dsh-superagent-prototype/`。只读研究，代码没有改动。

---

## 0. 一句话总览

dsh-superagent 是一个 **DSH（DeepSeek Harness）bundle 插件**：一个单进程的 `Runtime`（Cordis Service，名为 `orchestrator`）独占一个 `stateDir`（目录锁 + SQLite）。Source 插件（GitHub / Feishu）**靠轮询和长连接子进程**把外部消息归一成 `Trigger` 交给 `Engine`。**主 Session**（router/orchestrator，一个 LLM 会话）负责评估和路由；每个被接受的 Ticket 有**一个持久的 Executor Session**（worker），在**每个 ticket 独立的目录**里干活（通常是 operator 的 prepare 命令建出的 `git worktree`）。所有副作用（启动 worker、投递消息、对外回复）都先写进 SQLite 的 `effect` 表，提交后再由耐久队列执行：语义是**至少一次，外加每个 sink 端的幂等键**。

---

## 1. Source 抽象（GitHub、Feishu）

### 1.1 插件契约

- Source 插件只通过 Cordis 上下文里的 `orchestrator` 服务（`SourceHost`）和应用交互：`src/app/runtime.ts:50-51`，`src/sources/host.ts:23-27`。
- 插件入口模式都一样：`inject = ['orchestrator']`，第一个 effect 调 `sources.register(kind)`，第二个 effect 用 `AbortController` 跑轮询循环（`src/sources/github.ts:110-122`，`src/sources/feishu.ts:130-139`，`docs/008-cookbook.md:252-270`）。
- `SourceKind` 描述符（`src/sources/kind.ts:85-113`）包含：`schema`/`fields`（配置与面板表单）、`health`（自己独占的健康条目）、`scope()`（监听规则 → `listened/observed/row`）、`channel`（出站 `send`/`link`/`allowed`）、`threadContext`（给评估用的有界上下文读取器）、`find`、`repliesTo`、`policy`（允许的发送者、admission 表行、可选的名单同步）、`environment`（注入 worker 的环境变量）。
- `SourceContext`（`src/sources/host.ts:31-66`，由 `src/app/source-context.ts:33-72` 实现）给 Source 的能力：`receive(trigger)`、`atomic()`、带类型的 KV `state`（游标）、threads describe/patch、tickets bindThread/threadClosed、`notify(OutboundMessage)`（经 Outbox 发出），以及 `report(health)`。
- `SourceRegistry` 实现 Engine 的 `SourceScope` 端口：`src/sources/registry.ts:13`。`scope()` 在 `:124-132`：插件未安装 → `source_not_installed`，插件被禁用 → `source_disabled`。

### 1.2 轮询还是 webhook：**没有 webhook**

| Source | 入站机制 | 证据 |
|---|---|---|
| GitHub | 纯轮询。`watch()` 循环，间隔 `max(GitHub 返回的 X-Poll-Interval, pollSeconds)`，默认 60 秒，最小 60 秒。每轮依次是：账号 notifications → 仓库级事件流（issues/pulls/comments/ci，各有开关）→ open ticket 的 PR 和 CI → 已订阅 Thread。 | `src/sources/github.ts:25-27,127-145,280-296` |
| GitHub 游标 | 全局 `github-since`、每个 Issue/PR 的 `github-cursor:<n>`、每个事件流的 `{since, etag}`（`If-None-Match` 条件请求）。游标回退 5 秒（`cursorAt`），重叠部分靠确定性 Trigger ID 去重。读取失败记进 retry map，24 小时后放弃。 | `src/sources/poll.ts:16`；`src/sources/github.ts:156,203-248,298-342`；`src/kv.ts:46-50` |
| Feishu 实时 | **长期运行的子进程** `lark-cli event consume im.message.receive_v1 --as bot`，逐行读 stdout 的 JSON（单行上限 1 MiB）。45 秒内没 ready 就重启；崩溃后指数退避，从 1 秒到 60 秒。 | `src/sources/feishu-loops.ts:43-71,78-95` |
| Feishu 补收 | 每 60 秒一个 `backfillLoop`：每个群一个历史游标（`feishu-history:<chat>`）补收消息和活跃话题，再 `pollThreads` 补漏实时流错过的回复。另有群名刷新循环。 | `src/sources/feishu-loops.ts:117-160,218-259` |
| 订阅 Thread 的轮询窗口 | Thread 有 live ticket，或最近一次活动在 14 天内，才继续轮询。 | `src/sources/poll.ts:6-14` |

`docs/008-cookbook.md:7-15` 里的示例 Source 名叫 "webhook"，实际也是 `hookq pull --after <n>` 这种拉取式的 CLI。

### 1.3 Trigger 归一化

- 统一形状（`src/sources/github-trigger.ts:65-108`，`src/sources/feishu-trigger.ts:31-44`）：
  `{ id, source, threads:[{source,id}], actor:{source,id}, human, addressed?: 'mention'|'direct', at, text, channel: ChannelRef, url?, meta }`。
- **ID 是确定的**：GitHub 评论是 `key('github-comment', html_url, comment.id, updated_at)`（编辑后产生新 Trigger）；Issue/PR 正文是 `key('github-issue', number)`；CI 是 `key('github-ci', number|branch, revision)`；Feishu 是 `key('feishu', message_id)`。实时流、历史补收、话题翻页三条路径对同一消息得到同一个 ID（`src/sources/feishu-trigger.ts:16-18`）。
- Thread key：GitHub 是 `github:<number>` 或 `github:ci:<branch>`；Feishu 是 `feishu:<chat>:<root|msg>`（`src/sources/feishu-trigger.ts:16`）。
- `human`：GitHub 上 `[bot]` 后缀或非 `User` 类型、以及 agent 自己，都记为非人类（`src/sources/github-trigger.ts:46-47,62-63`）。Feishu 按 `sender_type`，机器人自己发的消息直接丢弃（`src/sources/feishu-trigger.ts:33`）。
- 接收入口：`ctx.receive` → `Passes.receive` → `Engine.receive`，在一个 SQLite 事务里执行，返回 `'stored' | 'duplicate' | 'filtered'`（`src/core/intake.ts:8`，`src/core/engine.ts:48`）。`stored` 会立即触发一次 pass（`src/app/passes.ts:34-39`）。Source 必须先 await `receive` 再推进游标（`src/sources/host.ts:41`）。

### 1.4 Channel / 回复投递，outbox / effects 的语义

链路：`Engine/SourceContext.notify` → `Outbox.send()`，把 receipt 写入和 `effect('reply')` 入队放在**同一个事务**里，重复的 message id 直接忽略（`src/app/outbox.ts:27-32`）。

- 投递处理器（`src/app/outbox.ts:24,39-51`）：并发 1；paused 时并发为 0；退避 5 秒到 300 秒。Source 关闭时抛 `Later`（重排，不计失败次数）。**同一 ticket、同一会话内保持顺序**：前一条 pending 没成功前，后面的等着，直到前一条失败次数达到 `FAILURES_BEFORE_ERROR=3`（`:45`；索引列见 `src/app/store.ts:41-43`）。`channelAllowed` 为假时结算为 `channelIgnored`；目标被删、撤回或锁定时结算为 `channelGone`，不再重试。
- **sink 端幂等**：
  - GitHub：评论正文末尾嵌入 `<!-- dsh-superagent:${message.id} -->`。POST 前先翻页读已有评论，找到同账号、同标记的就视为已发（`src/sources/github-channel.ts:18-45`）。
  - Feishu：`im +messages-reply ... --idempotency-key <message.id>`（`src/sources/feishu-channel.ts:19-30`）。
- **Effects 耐久队列**（`src/app/effects.ts`）：
  - 6 种 kind：`assessment | launch | delivery | relay | notice | reply`（`:11-24`）。
  - `enqueue` 在调用方事务里做 upsert，同 `(kind,key)` 合并，`generation+1`（`:61-66`）。
  - 提交后用微任务 dispatch；成功才 DELETE；失败按 `retry[0]*2^attempts` 退避，封顶 `retry[1]`。按 `seq+generation` 匹配行，避免覆盖运行中被替换的新载荷（`:130-146`）。
  - ordered kind（relay、notice）一次只跑一条，队首阻塞后面的；shutdown 时运行中的行保持原样，下次启动重试（`:137`）。
- **投递给 LLM Session 时去重**：`AgentDelivery` 把 requestId 映射为固定的 `MessageId('dsh-superagent:'+requestId)`，扫描 session 持久化历史和 inbox，已有就跳过；投递后 `sessionPersistence.flush()` 才算确认（`src/app/delivery.ts:16,40-86`）。notice 按 `name + payload hash` 去重（`src/app/sessions.ts:180-186`）。
- **结论**：整体是 **at-least-once + 处处幂等键 ≈ effectively-once**。入站靠确定性 Trigger ID，出站靠消息标记或 idempotency-key，Session 投递靠 MessageId，状态写入和副作用入队是同一个本地事务（transactional outbox）。

---

## 2. 暴露给 Session 的工具与执行模型

### 2.1 主 Session（router / orchestrator）

自定义工具（`src/app/tools/main.ts:155-301`，通过 `Sessions.registerTool` 注册，见 `src/app/sessions.ts:206-216`）：

| 工具 | 作用 |
|---|---|
| `orchestrator_read` | 分页读资源：tickets、ticket/<id>/…、trigger/<id>、settings、prompts、prompt-preview（语法见 `src/app/resources.ts:25-57`）。 |
| `orchestrator_route` | 一次批量处理 1–20 条 accept/attach/ignore/stop，每条各自是一个 Engine 命令，失败互不影响（`main.ts:125-153`）。 |
| `orchestrator_ticket_retry` / `_request_status` / `_note` | 重开一个 assignment；向空闲 worker 要状态；给 worker 补充事实（≤100 词，不授予权限）。 |
| `orchestrator_trigger_requeue` | 重新评估一个 trigger（已归 worker 的 follow-up 拒绝 requeue）。 |
| `orchestrator_eval` / `_eval_read` / `_eval_decide` | 对 proactive 候选做有界评估：加载上下文窗口 → 读消息/图片/文件 → 记录决定（`main.ts:203-221`）。 |
| `orchestrator_reply` | 对外回复，purpose 是 `answer | result | attention`，由 gate 校验目的（`main.ts:224-239`）。 |
| `orchestrator_thread_unsubscribe` | 删除一个 thread 上的全部订阅。 |
| `orchestrator_settings_save` / `_policy_sync` / `_prompts_save` | 只在人明确要求时改配置或 prompt；执行环境和账号字段被 origin guard 挡住（见 2.4）。 |

DSH 内置工具被**限制**为 `skill, bash, read, read_image, job_output, job_list, job_kill`，外加 `noWait` guard：拒绝 `sleep`、超过 30 秒的 shell 超时、超过 5 秒的 job wait（`src/app/sessions.ts:61-86,262-264`）。router preset 里 fs 没有 write/edit，也没有 subagent/web/todo（`cordis.patch.yml:125-193`）。主 Session 的 cwd 是 `stateDir`（`src/app/runtime.ts:210`）。

### 2.2 Executor Session（worker）

自定义工具（`src/app/tools/executor.ts:23-105`）：

| 工具 | 作用 |
|---|---|
| `orchestrator_read` | 只能读本 ticket 的资源，以及 `github/…`、`feishu/<trigger>/…` 原文（`tool.ts:22-35`，`resources.ts` 中 `executor:true` 的项）。 |
| `orchestrator_ack` | 开始实质工作前，在原消息下回一条短确认，按 source trigger 去重。 |
| `orchestrator_thread_unrelated` / `_thread_follow` | 退订无关 thread；为获取上下文 follow 一个相关 thread。 |
| `orchestrator_trigger_handback` | 把超出本 ticket 范围的消息交还，重新评估。 |
| `orchestrator_report` | 报告 `progress/ready/blocked/failed/dropped`，可带 `human_action`、`pr_number`。在一个事务里认领 PR、写入报告、入队 relay（`executor.ts:75-103`）。 |

DSH 内置工具只留 `WORK_TOOLS`：read/write/edit/read_image/glob/grep/bash/pwsh/job_*/web_search/web_fetch/skill/todo_write/subagent/list_subagent_models/send_message/list_agents/interrupt_agent（`src/app/sessions.ts:61-62,289-297`）。另有 guard：ticket 结束后**拒绝所有工具调用**（`:293-296`）。worker spawn 的 subagent 跑在 `standard` preset 下，同样被限制成 work tools（`:303-312`）。worker preset（`cordis.patch.yml:20-120`）的特点：bash 前台 5 秒后转后台；web 只开 search，不开 fetch；不含问人、present、plan mode、plugin manager、调度等工具。

### 2.3 Sandbox / workspace / 目录模型：**每个 ticket 一个持久 Session + 一个独立目录**

- 目录 = `executionRoot/<name>`。`executionRoot` 取 `settings.executor.directory`，留空时是 `<stateDir>/work`（`src/app/execution-environment.ts:18`）。`name` = 路由时给的 `worktree_name` 加 12 位 ticket-id 后缀（`src/executor/dsh.ts:56,97-110`）。
- 首次 launch 时如果目录不存在，就在**父目录**执行 operator 配置的 `executor.prepare`（`sh -c`，10 分钟超时，带 ticket 环境变量）；之后 `mkdir`，并用 `verifyDirectory` 检查仓库本地 git config 里没有 `credential.*` 或 `http.*extraheader`（`src/executor/dsh.ts:247-261,432-441`；`src/infra/environment.ts:149-157`）。目录已存在就视为准备好了；prepare 失败的 ticket 直接标 failed，不自动重试。
- **官方推荐的 prepare 命令**是从 operator 本地的**一个共享 clone** fetch PR head 或 HEAD，然后 `git worktree add -b agent/$DSH_SUPERAGENT_NAME "$DSH_SUPERAGENT_DIR"`（`docs/006-deployment.md:149-154`，`docs/003-execution.md:51-53`）。所以模型是：**共享一个 object store，每个 ticket 一个 worktree 和分支**，不是每个 ticket 单独 clone。没配 prepare 时 worker 从空目录开始。
- Session 创建：`sessionController.create({ sessionId: workerSessionId(ticket), workspaceId: workspaceRegistry.create(dir).id, agentPreset })`（`src/app/sessions.ts:138-155`）。并发槽 `maxWorkers` 默认 3（`src/policy.ts:93`；`src/executor/dsh.ts:229-232`）。
- 注入的环境变量（不含凭据）：`DSH_SUPERAGENT_DIR/NAME/TICKET/BLOCKED_COMMANDS`，以及 Source 提供的 `..._GITHUB_REPOSITORY/ACCOUNT/COMMIT_EMAIL/NUMBER/PR_HEAD` 和 `..._FEISHU_BOT/CHAT`（`src/app/execution-environment.ts:10-15,27-43`；`src/sources/github.ts:93-103`；`src/sources/feishu.ts:118-124`）。这些变量同时渲染进 worker 的系统提示。

### 2.4 权限模型

- 两类 Session 都设成 `permissionPresets.set(session, 'danger-full-access')`（`src/app/sessions.ts:152`），也就是 **DSH 层不做逐命令审批**。
- 实际约束靠以下几层：
  1. 工具 allowlist 和 guard（上文）。
  2. **CLI shim**：`stateDir/worker-bin/{gh,lark-cli,<blocked>}` 被插到 PATH 最前面。`gh` 和 `lark-cli` 转发到 agent 账号或 bot 的包装脚本；blocked 命令一律 exit 1（`src/infra/environment.ts:79-104,119-125`）。
  3. **隔离的 git 配置** `worker-gitconfig`：`useConfigOnly`，github.com 的 credential helper 指向 `gh auth git-credential`，SSH 改写成 HTTPS（`:106-115`）。
  4. 剥掉环境变量：GH_TOKEN/GITHUB_TOKEN、GIT_DIR 等定位变量、身份变量、askpass（`:45-58`）。DSH 的 subprocess 还会剥掉形似凭据的变量（`:127-135`）。
  5. 编排侧调用的 `Commands.api` 只允许 `repos/<configured repo>/…` 路径（`src/infra/commands.ts:94-98`）。
  6. Feishu CLI 必须是 strict-mode `bot`，否则拒绝启动，防止 worker 用人的身份行事（`src/deployment.ts:110-131`）。
  7. 执行环境和账号字段只能从面板修改，tool 发起的保存会被拒（`src/app/settings.ts:45,51,143`）。
- 代码自己写明：**这不是 OS 级安全边界，worker 以 operator 的 OS 用户运行**（`src/infra/environment.ts:2-4`）。

---

## 3. Prompt 组装与每个角色的模型

### 3.1 组装流程

- 所有 Session 都挂一个系统提示 section：`name:'dsh-superagent-policy', order:9999, interpolate:false`。主 Session 额外设 `complete:true`，也就是**完全替换 DSH 的其他系统提示**（`src/app/sessions.ts:244-249`）。`text` 是回调，**每次模型请求都重新计算**，开头带 `[dsh-superagent prompt revision N]`，worker 末尾再拼 `mandateInstructions`。
- worker 的完整系统提示由三部分组成：DSH preset 自带的 persona（`"You are a coding agent powered by the {{model}} model."`）+ `dsh-agent-instructions`（读仓库的 `AGENTS.md`，上限 64 KiB）+ time-context（`cordis.patch.yml:28-37`），再加上本 section。主 Session 不读 AGENTS.md，没有 persona（`docs/004-prompts.md` "Assembly and precedence"）。
- 顺序由 `promptParts` 决定（`src/app/prompts.ts:102-116`）：
  1. `runtime/shared` + `runtime/<role>`
  2. 三个 team section：Communication / Ticket scope / Delivery requirements（`prompts/team/*.md`）
  3. `runtime/subscriptions` + `runtime/replies` + `runtime/dispatch`（主）或 `runtime/work`（worker）
  4. `runtime/admission`（仅主 Session）
  5. `runtime/handoff/<role>`
  6. `runtime/environment`（生成部分，`{variables}`）
  7. `runtime/policy`（仅主 Session，生成部分，`{version}{mode}{rules}`，**永远放最后**，所以 policy 变化不影响前缀）
- 文本来源：`prompts/<name>.md` 每行一句，加载时把段内各行拼成一行（`src/app/skill-files.ts:29-32`；`src/app/context.ts:7-24`）。全部 15 个内置 part 都可以被团队 override（`src/app/prompts.ts:24-26,55-70`），override 记录 `base` 哈希，用来提示 "Default updated"。
- **版本化**：`Versions` 保存不可变快照和指针（`src/app/versions.ts`）。保存时带 `baseRevision` 做乐观并发（`src/app/prompts.ts:202-216`）。每个 Session 记录自己用过的 revision（`KV session-prompts:`），worker 只能读这些 revision（`src/app/sessions.ts:196-204,329-339`）。总长度上限 `promptMaxChars`，默认 100k（`src/deployment.ts:17-18`）。
- **Skills**：按 prompt revision 注册到 agent 的 skill scope，名称加 `dsh-superagent-` 前缀：`github` 总是注册，`feishu` 只在配置了 bot 时注册，再加团队自定义 skills（`src/app/prompts.ts:146-148`；`src/app/sessions.ts:314-327`）。内置 skill 带 `resourceBase` 目录（`skills/dsh-superagent-*/`），正文附上 `prompts/cli.md` 作为 "CLI usage"（`src/app/prompts.ts:68-69`）。skill 内容主要讲 `orchestrator_read` 的 `github/…`、`feishu/…` 资源语法，以及 gh/lark-cli 用法。
- 优先级从强到弱：工具和 host 强制的事实 > 内置/生成 section > 匹配规则的流程（仅限该 ticket）> team sections/skills > 外部文本（`docs/004-prompts.md` "From strongest to weakest"）。

### 3.2 各角色用的模型

- `settings.eval.model` 给主 Session（router 和评估都在主 Session 里做；`MasterAssessor` 把候选卡片用 `steer` 送进主 Session，没有单独的 LLM 调用：`src/app/runtime.ts:131-133`）。`settings.executor.model` 给 worker（`src/app/sessions.ts:150`；`src/policy.ts:70,86,92`）。
- `RoleModel = {provider, model, reasoningEffort?}`。值为 `null` 时用 DSH 全局默认。通过 `ctx.llm.resolveCallConfig` 解析（`src/app/role-models.ts:8-12`）。
- **只给新建的 Session 播种一次**：append 一个 `model/selection` 事件，再挂钩 `system-prompt/assemble` 和 `agent/request` 注入模型选择，不改 DSH 的全局默认（`src/app/role-models.ts:15-44`）。之后人手动换模型会保留。
- worker 的 subagent 可以自选或自己发现模型（`cordis.patch.yml:107-111`）。

---

## 4. App 接线：bundle 怎样挂进 DSH host

- `package.json` 的 `dsh.bundle.patch = ./cordis.patch.yml`。patch **插入三个插件**：`dsh-superagent`（主插件）、`dsh-superagent/github-watch`、`dsh-superagent/feishu-watch`（默认禁用）。另外**定义两个 agent preset**：`dsh-superagent-worker`、`dsh-superagent-router`（`cordis.patch.yml:4-125`）。`stateDir` 由 profile 提供，没有就拒绝启动（`:1-3`；`src/deployment.ts:15`）。
- 主插件 `inject = ['agents','sessionController','sessionPersistence','workspaceRegistry','permissionPresets','tools','systemPrompt','skills','webServer','llm','subprocess']`（`src/index.ts:8`）。可选注入 `settings`（关掉自动生成的设置页：`src/index.ts:13`）、`agentPresets`、`sessionProjections`（`src/app/sessions.ts:124-132,274-282`）。
- `Runtime` 是组合根（`src/app/runtime.ts:54-172`）：锁 stateDir → 打开 Store → 依次构造 Setup、Prompts、Commands、Effects、SourceRegistry、Sessions、Settings、DshExecutor、MasterAssessor、Outbox、Engine、Passes（每 2 秒一次 pass：`src/app/passes.ts:28`）。`initialize()` 先注册 HTTP，再跑 setup 校验账号；setup 不过就 paused（`:201-218`）。
- 管理面板：`webServer.register({kind:'prefix', path:'/orchestrator'})`，**要求 webServer 绑定 127.0.0.1**，并检查同源（`src/app/http.ts:231-240`）。约 25 个 REST 路由：state/overview/search/sources/settings/threads/tickets/decisions/prompts/models，以及 retry/stop/pause/requeue/policy-sync/setup-check 等。`views/*` 是只读投影：overview、tickets、threads、sources、settings、records。前端在 `src/client`（React，用 dsh-client-ui-*）。

### 4.1 `@deepseek-ai/*` 依赖与提供的能力（AWS 上要替换的清单）

| 包 / 服务 | 提供的能力 | 用在哪里 |
|---|---|---|
| `cordis` | 插件宿主、DI（`ctx.inject`/`Service`）、effect 生命周期、`fiber.restart()`、logger、`Volatile` 配置、事件总线（`ctx.on('session/event'…)`） | 全局 |
| `schemastery` | 插件配置 schema | `src/deployment.ts:15` |
| `dsh-settings` | DSH 设置服务（`configure({auto:false})`、`describe()`） | `src/index.ts:13-19` |
| `dsh-agent`（`agents`）| `Agent`：inbox 的 `steer`/`followup`/`inject`、`cancel`、`whenIdle`、`agent.ctx.on('system-prompt/assemble' / 'agent/request')` | sessions、delivery、role-models、runtime |
| `dsh-session` | Session 事件流、`append`、`header`（parentSession、agentPreset）、`snapshotEvents` | sessions、role-models |
| `dsh-session-persistence` | 会话持久化：`flush()`、`open(id,'read').read()` | `src/app/delivery.ts:45-58`，`src/app/runtime.ts:243` |
| `dsh-api-session-controller` | `resolveAgent/create/rename/modelCatalog`（会话目录与生命周期） | sessions、http、navigation |
| `dsh-workspace`（`workspaceRegistry`）| 目录 → workspace（Session 的 cwd） | `src/app/sessions.ts:142` |
| `dsh-permission-presets` | 权限预设（这里用 `danger-full-access`） | `src/app/sessions.ts:152` |
| `dsh-system-prompt` | 系统提示 section 注册 | `src/app/sessions.ts:244` |
| `dsh-tools` | 工具 `register/restrict/guard/get` | sessions |
| `dsh-skill`（`skills`）| 运行时注册 skill | `src/app/sessions.ts:323` |
| `dsh-scope` | `scopeParentOf`，读取 preset 继承来的工具 | `src/app/sessions.ts:291` |
| `dsh-llm`（`llm`）| 模型路由 `resolveCallConfig`、`MessageId`、`freezeMessage`、`ReasoningEffortId` | role-models、delivery |
| `dsh-subprocess` | 子进程运行时（剥掉凭据类环境变量、限制输出大小） | `src/infra/environment.ts:128-135`，setup 探测，prepare |
| `dsh-host-webserver`（`webServer`）| 回环 HTTP server、前缀路由 | `src/app/http.ts` |
| `dsh-attachment` | 图片附件引用（Feishu 图片读成模型可看的图像） | `src/sources/feishu-image.ts:5` |
| `dsh-agent-preset` 及 preset 内插件 | persona、agent-instructions（AGENTS.md）、time-context、bash/pwsh-sandbox、tool-bash/fs/fs-search/jobs、skill-filesystem/tool-skill、compaction-basic/command-compact/tool-result-pruner、tool-subagent(-control)、tool-todo、tool-web | `cordis.patch.yml` |
| `dsh-client-*` | Web 面板 UI 外壳（locale/settings/renderer/layout/sidebar/workspace/slots/plugin-manager） | `src/client` |

一句话：**DSH 提供 agent loop、会话持久化、工具/沙箱 shell、skill、系统提示、LLM 路由、本地 web server 和 UI 外壳**。dsh-superagent 自己实现的是领域引擎、Source、耐久 effect 队列和 prompt 版本管理。

---

## 5. Store / settings / migration / versions：磁盘布局

```
<stateDir>/                      0700，被 proper-lockfile 锁住（stale 30s，锁失效就中止）  runtime.ts:91-94
├── orchestrator.sqlite          0600，WAL，synchronous=FULL                            store.ts:63-64
├── worker-bin/                  gh、lark-cli 和 blocked 命令的 shim（带 marker，每次启动重写）  environment.ts:79-105
├── worker-gitconfig             隔离的 git 配置                                         environment.ts:106-115
└── work/<name-xxxxxxxxxxxx>/    默认的 ticket 目录（可用 executor.directory 换根）       execution-environment.ts:18
```
DSH Session 的 transcript 和事件不在 stateDir，由 DSH 的 `sessionPersistence` 管理。

SQLite 表（`src/app/store.ts:71-87`），value 一律存 JSON 文本：
- `kv(key,value)`：配置、版本和游标都在这里（命名空间见 `src/kv.ts:21-58`）：`schema`；`settings-revision`、`settings-block-revision:*`、`settings-version:<n>`；`prompt-revision`、`prompt-version:<n>`、`prompt-built-in:<hash>`；`master-id`；`session-prompts:<sid>`；`source-labels:*`；`github-since/retry/cursor:<n>/stream:<id>/branch-ci/ci:<n>`；`feishu-chats/history:<chat>/history-threads:<chat>`；`thread-seen:*`、`thread-initialized:*`。
- 领域表：`trigger(id,value,at)`、`disposition`、`thread(key)`、`ticket(id)`、`decision(id,thread)`、`outbox(id)`（receipt）、`trigger_thread(thread,id,at,human)`。
- `effect(kind,key,value,seq,generation,attempts,error,due,since)`，主键 `(kind,key)`，索引 `effect_due`。
- JSON 生成列加部分索引表示"活跃工作集"，例如 `ticket.open/active`、`thread.active/subscribed`、`outbox.pending/dropped`（`store.ts:28-45`）。

Settings：一个 `SettingsSchema` 对象（`src/policy.ts:103-104`），按块保存：`policy | eval | executor | pause | source:<id>`，每块有自己的 revision，保存是乐观并发，冲突返回 409（`SettingsConflict`）。每次保存产生一个完整快照 `SettingsVersion`，包括 policyVersion 和受影响的 ticket 通知（`store.ts:21-25`）。Policy 版本 = 哈希(rules, mode, sources)（`src/policy.ts:117`）。`machine` 级配置（stateDir、promptMaxChars 等 volatile 项）放在 DSH profile 里（`src/deployment.ts:15-23`）。

Migration：`SCHEMA_VERSION=11`，`OLDEST_SCHEMA=10`。只支持 10→11，在单个事务里迁移，失败时数据库保持原样；更老的版本直接拒绝，要求换新的 stateDir（`src/app/migration.ts:20-26`；`store.ts:65-67,88-93`）。

---

## 6. 移植说明：DSH 能力 → AWS 对应

> 前提：worker 跑在 **Bedrock AgentCore Runtime**，用每用户一个的 **S3 Files** 挂载。下面给出建议和要注意的点。

| DSH 能力 | 当前实现 | AWS 建议 | 说明 / 风险 |
|---|---|---|---|
| 进程宿主 + 单写者 | Cordis 插件；stateDir 文件锁；单进程 | **Control plane**：ECS Fargate 单任务（或 2 个任务，用 DynamoDB 条件写租约选主），运行 Engine、Passes、Effects dispatcher | Engine 大量依赖同步的 `store.atomic()`，跨 trigger/ticket/effect/outbox 都在一个事务里。保持**单写者**能省掉大量重写。 |
| SQLite Store | 9 张 JSON 表 + 生成列索引 | 首选 **Aurora PostgreSQL Serverless v2 / Aurora DSQL**：保留 SQL、多行事务和 JSONB 表达式索引，改动最小。备选 **DynamoDB** 单表（`TransactWriteItems` 上限 100 项，生成列要改成 GSI 加稀疏属性） | 选 DynamoDB 就要改写 `Repositories`，把活跃工作集换成 sparse GSI。 |
| Effects 耐久队列 | 事务内写 effect 行，提交后 dispatch | 保留 **transactional outbox**：effect 行入库后，用 CDC（DynamoDB Streams）或 dispatcher 投到 **SQS**。`relay`/`notice` 用 FIFO 队列（MessageGroupId=主 Session）；`reply` 用 FIFO（GroupId=`ticket+thread`）；`launch` 用标准队列，并发=maxWorkers | `Later` 对应 `ChangeMessageVisibility`；超过阈值的进 DLQ 并报健康；`due` 定时可用 EventBridge Scheduler 单次调度。 |
| Passes（每 2 秒）/ evaluateDue | setInterval | control plane 内循环；Eval 到期用 **EventBridge Scheduler** 单次调度唤醒 | EventBridge 最小粒度是分钟，2 秒心跳要留在常驻进程里。 |
| GitHub 入站 | 轮询 notifications、事件流、PR、CI | 改成 **GitHub App webhook → API Gateway HTTP API → Lambda**（校验 `X-Hub-Signature-256`）→ 归一化为 Trigger → 条件写 `attribute_not_exists(id)` → SQS。另保留 **EventBridge Scheduler + Lambda 定时对账轮询**，沿用现有游标逻辑补漏 | 确定性 Trigger ID 原样保留，去重语义不变。原来对 "仓库外" 路径的限制可以改由 GitHub App **只安装在单个仓库**来保证。 |
| Feishu 入站 | `lark-cli event consume` 长连接子进程 + 每 60 秒补收 | 二选一：(a) 飞书事件订阅改成 **HTTP 回调 → API Gateway + Lambda**（verification token / encrypt key）；(b) 保留长连接，跑在一个 Fargate 小任务里。补收和 thread 轮询用定时 Lambda | 走 webhook 时 API Gateway 必须开公网，按 builder-security 要求做签名校验和速率限制。 |
| Outbox 出站 | `gh api` 评论 + HTML 标记；`lark-cli --idempotency-key` | SQS 消费者用 Lambda 直接调 GitHub REST 和飞书 OpenAPI；receipt 存 DB | 幂等标记和 idempotency-key 两套机制照搬。 |
| LLM（`dsh-llm`）| provider/model 路由 | **Bedrock Converse / InvokeModel**（Claude，用跨区 inference profile）；`eval.model` 和 `executor.model` 映射到 Bedrock model id | "model budget retry" 健康项对应 Bedrock `ThrottlingException` 退避。policy section 放在最后，正好有利于 **Bedrock prompt caching**：缓存点设在 environment 之前。 |
| Agent loop + Session（`dsh-agent`/`dsh-session`/`session-controller`）| 每个 ticket 一个持久 worker Session，加一个主 Session | **AgentCore Runtime**：`runtimeSessionId = workerSessionId(ticketId)`（满足长度要求）；容器内跑 Claude Agent SDK 或 Strands 作为 loop | AgentCore 的单个会话有空闲超时和最长寿命限制（具体值以文档为准），DSH 的"常驻 worker"要改成**逻辑会话 = ticket**，物理 microVM 可以重建，从持久化的 transcript 和 S3 Files 上的工作区恢复。 |
| inbox `steer` / `queue` / `inject` | 运行中插话、下一轮、静默注入 | 自己实现：每个 ticket 一个 inbox（DynamoDB），agent 在每个 step 之间拉取；或者用 AgentCore Runtime 的双向流（WebSocket）推送 | 这是语义上最难对齐的一处：DSH 原生支持"运行中 steer"。 |
| 会话持久化与投递去重（`sessionPersistence`、`AgentDelivery`）| 扫描历史里的 MessageId | **AgentCore Memory**（short-term events）存 transcript；投递去重表放 DynamoDB（`requestId` 作为主键，条件写） | `ticket/<id>/transcript` 资源要改成从 Memory 读取。 |
| Workspace（`workspaceRegistry`）+ per-ticket 目录 + prepare | `executionRoot/<name>`；operator 的 `git worktree add` | 每用户一个 **S3 Files** 挂载：`/mnt/<user>/tickets/<name>`；prepare 改成从同一挂载上的**共享 bare mirror** 执行 `git worktree add`，或者 `clone --reference` | 网络文件系统上的 git 锁文件和大量小文件 IO 可能慢，建议先压测；要考虑"仓库放 microVM 本地盘，靠 push 持久化，S3 Files 只放产物和缓存"。`verifyDirectory` 的检查保留。 |
| 内置工具（bash/fs/fs-search/jobs/web/todo/subagent/skill/compaction）| DSH preset 插件 | 容器内用 Agent SDK 自带的 Bash/Read/Write/Edit/Glob/Grep/Task/WebSearch/TodoWrite 和自动压缩；`allowedTools` 实现 restrict；PreToolUse hook 实现 guard（ticket 已结束、noWait、5 秒转后台） | 后台 job（5 秒转后台，结束时唤醒）要自己实现 job 管理。 |
| `orchestrator_*` 自定义工具 | 进程内注册，直接调 Engine | 做成 control plane 的内部 API（IAM SigV4）。以 MCP 形式经 **AgentCore Gateway** 暴露（Lambda 或 OpenAPI target），按角色给两套工具集：router 和 worker | Gateway 的 inbound 认证要能区分 router 和 worker，并把 `ticketId` 绑定到调用方身份，防止 worker 越权读写其他 ticket。 |
| 权限：`danger-full-access` + shim + 隔离 gitconfig + 剥环境变量 | 不是 OS 边界 | **microVM 会话隔离**加每个 runtime 一个 IAM 执行角色，比原方案强。GitHub 凭据改成 **AgentCore Identity** 发放的短时 GitHub App installation token，注入 git credential helper 和 `gh`；飞书 bot token 也放进 Identity 的 token vault | blocked commands 和 shim 仍可作为纵深防御保留；"只有面板能改执行环境"的 origin guard 要搬到 API 授权层。 |
| 系统提示 section、prompt 版本、skills | KV 里的不可变版本；skill scope | prompt 版本存 Aurora/DynamoDB（或 S3 加版本号）；每次请求在 agent 侧组装；skills 以 `SKILL.md` 文件形式下发到挂载目录（Agent SDK skills），或通过 Gateway 拉取 | 保留 revision 绑定和授权读取（`mayRead`）。 |
| 角色模型播种（`role-models.ts`）| 只给新 Session 注入 | Runtime 启动参数或 session 元数据里带 `modelId`；Bedrock 不存在"全局默认"污染的问题 | — |
| 设置与配置（schemastery、dsh-settings、volatile）| SQLite 版本化快照 | 业务设置放 DB（保留版本和乐观并发）；机器级配置放 SSM Parameter Store 或 AppConfig | — |
| 管理面板（`webServer`，回环 + 同源）| 只信任 127.0.0.1 | **API Gateway + Cognito（或 IAM Identity Center）认证** + S3/CloudFront 托管前端 | 原来"回环即可信"的前提在云上不成立，**必须**加认证（builder-security）。 |
| Health board | 内存 + 面板展示 | CloudWatch 指标和告警；健康条目可以放进 DB；**AgentCore Observability** 做 trace | — |

### 6.1 迁移时最需要注意的点

1. **单写者事务模型**：Engine 和 Effects 的正确性依赖本地强一致事务，建议保持一个 control plane 写库，不要把 Engine 拆成 Lambda 函数。
2. **steer 语义**：worker 运行中接收人的新消息是核心体验，AgentCore 侧要有 inbox 拉取或双向流方案。
3. **长生命周期 worker 和会话寿命限制**：ticket 可能持续数天（订阅 14 天内都会唤醒），必须能从 transcript 和工作区恢复会话。
4. **S3 Files 上跑 git**：在每用户隔离的前提下，验证 worktree、锁文件和性能；必要时仓库放 microVM 本地盘。
5. **凭据**：从"operator 本机的 gh 包装脚本"改成 GitHub App 加 AgentCore Identity 短时令牌，同时去掉对 OS 用户的隐式信任。
