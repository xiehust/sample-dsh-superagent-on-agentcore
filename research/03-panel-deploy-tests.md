# 03 · dsh-superagent：Panel、部署模型与测试契约

> 范围：`dsh-superagent-prototype/` 的 docs/005、docs/006、SETUP.md、README、package.json、tsdown.config.ts、src/client/*、src/app/{api,http}.ts、src/app/views/*、tests/*、examples/、scripts/、locale/。
> 路径均相对 `dsh-superagent-prototype/`。只读调研，未改动原型。

## TL;DR

- Panel 是 **DeepSeek Harness（DSH）Web 宿主里的一个插件页面**（侧边栏 “Superagent”），不是独立 SPA。纯 React，编译为 CJS 并由 `window.__ModuleLoader__` 加载（`tsdown.config.ts:12-14`、`src/client/index.tsx:50-58`）。
- 前后端契约是**一张类型化表**：`src/app/api.ts:20-46` 定义了 25 条 JSON/REST 路由，挂在 `/orchestrator/api/`。**没有流式**：Panel 每 5 s 轮询（页面隐藏时 ×6，重启期间 1 s）（`src/client/api.ts:59-90`、`src/client/provider.tsx:89`）。
- 鉴权**只有** loopback 加同源检查（`Host` 必须是 127.0.0.1/localhost、必须带 `x-orchestrator-request: 1` 头、`Origin` 必须同源，`src/app/http.ts:74-78, 229-231`）。**没有用户身份**：所有 Panel 写操作的 origin 一律记为字符串 `'panel'`（`http.ts:195,201,210`）。
- 部署形态是**一个 DSH 进程 = 一个 profile = 一个 stateDir = 一个 GitHub 仓库 = 一个 agent 账号**，SQLite 加文件锁保证单实例（`src/app/runtime.ts:93-98`、`src/deployment.ts:53-57`）。
- 测试共 60 个 spec，约 14k 行。最核心的契约在 `core-engine`（113 例）、`runtime`（91）、`sources`（71）、`runtime-concurrency`（56）、`policy`（41）。Panel 测试依赖一个**按 `Api` 类型实现的假服务器**，它会检查请求是否误用接口（`tests/fixtures/panel-server.ts:1-4`），可以直接改造成移植后的 API 契约测试。

---

## 1. Panel：人看到什么、能做什么

### 1.1 设计目标（docs/005-panel.md:5-11, 50-58）
页面按顺序回答三个问题：① 现在有没有事需要我处理？② 系统是否健康、行为是否正确？③ 某项工作从 Trigger 到 Eval 再到 Ticket 的完整历史。另有几条原则：计数必须等于它所链接列表的长度（“Honest state”）、健康状态不额外占用版面、破坏性操作必须确认、每个设置块只有一个保存栏。

### 1.2 页面 / 路由（`src/client/route.ts:6-27`）
Tabs：`overview | source | trigger | eval | execution | settings`；Settings 子组：`source | eval | execution | prompts | deployment`。当前路由存在 `sessionStorage['dsh-superagent/route']` 里，没有 URL 路由（`route.ts:48-66`）。

| 页面 | 展示 | 人能做的动作 | 调用的 API |
|---|---|---|---|
| **Overview** (`overview.tsx`, `views/overview.ts:38-79`) | `problems`（setup / no-source / no-allowed / source-error / executor-paused / runtime-error / eval-overdue / eval-unavailable / outgoing 投递失败）、`person`（等人的 Ticket）、`executor` 负载、24h `flow` 计数 | Resume 处理；对 unavailable Eval 选 **Evaluate again**（requeue）或 **Dismiss**；对 Ticket 选 Retry / Stop / 去 Channel 回答 / 打开 worker Session；setup 问题选 **Check again** | `GET overview`、`POST executor/pause`、`POST triggers/:id/requeue`、`POST decisions/:id/dismiss`、`POST setup/check` |
| **Source** (`source.tsx`) | 每个 Source 的状态（`missing/off/error/setup/starting/paused/ready`）、健康、当日 stats、被过滤的 Trigger、被丢弃的消息及原因（`channelGone/channelIgnored`） | 刷新 Feishu 群列表 | `GET sources`、`POST sources/:id/labels` |
| **Trigger** (`trigger.tsx`, `thread.tsx`) | Thread 列表（过滤器 `subscribed/evaluating/recent/all`）；Thread 详情是倒序时间线，含 Decision 和 Subscription，可前后翻页 | **Evaluate again**、**Unsubscribe**（需确认） | `GET threads`、`GET threads/:key?before|around`、`POST triggers/:id/requeue`、`POST threads/:key/unsubscribe` |
| **Eval** (`eval.tsx`) | Decision 列表（`work/stop/ignore/unavailable/all`），附理由和命中的规则 | 编辑 Policy（规则增删改、停用、复制）、各 Source 的 allowed list 与 admission table、**Sync now** | `GET decisions`、`PUT settings/policy`、`PUT settings/eval`、`POST policy-sync/:id`、`GET policy/history` |
| **Execution** (`execution.tsx`, `ticket.tsx`) | Executor 状态；Ticket 列表（`open/person/working/idle/ended`）；Ticket 详情含 stage、Mandate（来源 Trigger、Decision、strength）、attention 问题、未投递的 Input、订阅的 Thread、Assignments、环境变量 | **Pause/Resume**、**Retry**（需确认）、**Stop**（需确认，双击只发一次请求）、**Open Session**（跳到 DSH 里的 worker 会话）、**Answer in GitHub/Feishu**（外链） | `GET tickets`、`GET tickets/:id`、`POST tickets/:id/retry|stop`、`POST executor/pause` |
| **Settings › Sources** | 每个 Source 一张卡：开关、repo/cli、已验证的账号信息；GitHub 的 observeIssues/Pulls/Comments/Ci | 保存（修改账号会触发重启） | `GET settings`、`PUT settings/source:<id>` |
| **Settings › Execution** | worker model、maxWorkers(1–16)、directory、prepare 命令（点击变量即可插入）、blockedCommands | 保存 | `PUT settings/executor`、`GET models` |
| **Settings › Prompts** (`prompts.tsx`) | 团队 sections、内置 parts、skills；**Full prompt** 视图（与已保存版本或默认值做 diff）；History；“Default updated” 提示 | **Edit / Preview / Save**（按 baseRevision 做乐观锁）；Reset 某个 part；**Keep my text / Use the new default** | `GET prompts?revision&offset`、`POST prompts/preview`、`PUT prompts` |
| **Settings › Deployment** (`deployment.tsx`) | 启动问题、stateDir、机器限额（DSH 的 Plugin Manager 也展示同一页） | 修改限额（无需重启）、**Check again** | DSH 宿主的 `configForms`，不走 `/orchestrator/api` |
| **Header 搜索** (`app.tsx:121`) | 按文本、id、Feishu message id、GitHub URL、`#12` 搜 Trigger / Thread / Ticket | — | `GET search?q=` |

**关于 “approve / cancel / re-run / eval” 的直接回答：**
- **Panel 里没有 approve 按钮。** 授权在 Policy 层完成：allowed list、admission table，以及 `eval.mode = off|observe|auto`（`src/policy.ts:84`）。`observe` 模式下，推断出的工作只记为 `would_accept`，不会执行（`policy.ts:37,55`）。人要回答 Ticket 提的问题、review PR，都要**回到原 GitHub/Feishu 会话**里操作（`ticket.tsx` 中的 `answerIn` 链接）。Ticket 的 `person` stage 有 5 种 action：`delivery|answer|review|blocked|failed`（`src/core/stage.ts:5-21`）。
- cancel 对应 **Stop Ticket**；re-run 对应 **Retry Ticket**（只在 blocked/failed 或投递失败时可用，`stage.ts:24-26`）和 **Evaluate again**（重新跑 Trigger 的 Eval）。
- 全局暂停是 **Pause processing**。暂停期间 Source 仍然收录 Trigger，但 Eval、派发和对外投递全部挂起（`runtime.ts:199-200`）。
- 能编辑 prompt；没有离线 “eval benchmark”。“Eval” 指的是对每条请求做准入判断（Decision），不是模型评测。
- **深度介入要靠 DSH 原生会话 UI**：Panel 的 “Open Session” 调用 `ctx.uiWorkspace.openSession`（`index.tsx:34-43`），人直接在 worker 会话里聊天或干预。移植时这一块需要自己补。

### 1.3 HTTP API 契约
- 基址：`http://127.0.0.1:<port>/orchestrator/api/<route>`，JSON 进出，响应头带 `cache-control: no-store`（`http.ts:72-73`）。请求体上限默认 128 KiB；prompts 的上限是 `4×promptMaxChars+4096`（`http.ts:62-71,154`）。
- 完整路由表见 `src/app/api.ts:20-46`。其中 docs/006 承诺**稳定、供 agent 调用**的子集（`docs/006-deployment.md:167-179`）：`GET state`、`GET settings`、`GET sources`、`PUT settings/<block>`（`{value, revision}` 乐观锁）、`POST executor/pause`、`POST setup/check`、`POST policy-sync/<id>`、`GET/PUT prompts`（`{config, baseRevision}`）、`POST tickets/<id>/retry|stop`。其余路由跟随 Panel 变化。
- 设置块：`policy | eval | executor | source:<id>`（`http.ts:147-149`）。保存后返回 `{revision, restarting, policy_changed}`；修改账号或 CLI 时**先做 setup 校验**，校验失败返回 400 并带 `setup` 字段，成功则进程重启（`docs/006:207`）。
- 错误模型（`http.ts:81-91`、`docs/006:193-198`）：400 有四种形态（`issues[]` 是 zod 校验错误，`setup` 是账号检查失败，`code+values` 是 UserError，另有非 JSON / 超大请求体）；404 表示不存在；409 表示 revision 过期；500 表示其他错误。客户端把**响应体为空的 404**解释为“dsh-superagent 正在重启”，即 `unreachable`（`src/client/api.ts:48-55`）。
- 分页：tickets/threads 用 `offset/limit`（默认 20，最大 1000）；thread 详情用游标 `before/around`（默认 50，最大 100）；decisions 默认 30，最大 200（`http.ts:138-146`）。
- `GET state` 返回 `{setup:{machine, problem, feishuProblem, accounts}, load:{running, queued, maxWorkers}, masterId, paused, health:{<part>:{state, detail, at}}}`（`http.ts:97-110`）。`scripts/dsh-superagent status` 也依赖它。
- 双语：zh/en 字典都在 `src/client/locales.ts`（770 行）。`locale/*.json` 只放插件元数据（6 行）。服务端只返回英文文本和结构化的 `code/values`，由客户端本地化。

---

## 2. 部署模型

### 2.1 运行什么（docs/006:5-19）
- **单个 Node 进程**：`dsh --profile superagent`，跑在 tmux 会话 `dsh-superagent` 里。它是 DSH Web profile 的一个副本，加载本 bundle 的三个插件：`dsh-superagent`、`dsh-superagent/github-watch`、可选的 `dsh-superagent/feishu-watch`（`cordis.patch.yml:16-24`）。Panel 由 DSH 自带 webserver 提供，**只能绑定 127.0.0.1**（`examples/profile.cordis.patch.yml:3-6`）。不是 loopback 时插件直接拒绝启动（`http.ts:229`）。
- 进程内角色：一个 **master/router Session**（主 Session，负责路由和判断，preset 为 `dsh-superagent-router`，只读 fs）和 N 个 **Executor Session**（preset 为 `dsh-superagent-worker`，并发上限 `maxWorkers` 默认 3、最大 16，`src/limits.ts:6`）。两个 preset 都以 operator 的 OS 用户身份、`danger-full-access` 运行。shell 命令前台超过 5 s 就转入后台（`cordis.patch.yml:25-131`、`docs/006:19`）。
- **单实例保证**：用 `proper-lockfile` 锁住 stateDir，30 s stale（`runtime.ts:93`）；`scripts/dsh-superagent` 也会拒绝重复实例（`docs/006:107`）。

### 2.2 实例粒度
`Deployment = Machine + { repository; github:{cli,login,noreply}; feishu? }`（`src/deployment.ts:53-57`）。**一个实例只服务一个 github.com 仓库**（不支持 GHES）、一个 agent GitHub 用户，外加最多一个 Feishu bot。多个仓库只能部署多个 profile，各用不同端口和不同 stateDir。

### 2.3 所需凭据与账号
| 项 | 形式 | 备注 |
|---|---|---|
| Agent GitHub **用户账号**（不能是 GitHub App） | `gh` wrapper，例如 `GH_CONFIG_DIR=~/.config/gh-agent gh "$@"` | 因为要读该账号的 notifications（`docs/006:33-47`），对仓库需要写权限 |
| 可选：auto-merge 账号 | 另一个 gh CLI | agent 自己不开 auto-merge（`SETUP.md:23`） |
| Feishu/Lark 自建应用 + bot | `lark-cli` wrapper，独立配置目录，`strict-mode bot` | 带用户身份的 CLI 会被拒绝（`docs/006:49-69`） |
| LLM | DSH profile 的 model provider | Eval 和 Executor 可以各自指定 `{provider, model, reasoningEffort}`（`policy.ts:70,86,92`） |

Setup 会清掉名字含 KEY/PASSWORD/SECRET/TOKEN 的环境变量，以及 `GH_TOKEN/GITHUB_TOKEN`。它在 `worker-bin` 写入 shim（`gh` 指向 agent CLI、`lark-cli` 指向 bot CLI、blocked commands 直接失败），在 `worker-gitconfig` 写入专属 git 配置（`GIT_CONFIG_GLOBAL`、`GIT_CONFIG_NOSYSTEM=1`，credential helper 指向 agent CLI）（`docs/006:216-227`、`src/infra/environment.ts:19-50`）。

### 2.4 主机要求（docs/006:21-27）
Node 22.19+ 或 24+、pnpm、git ≥ 2.32、Python 3.8+（用于 service 脚本）、tmux、gh ≥ 2.48、DSH `^0.2.1-alpha.2`（`package.json:53-56`）、可选的 git-lfs 和 lark-cli 1.0.90。

### 2.5 文件系统布局
```
$DSH_HOME(~/.dsh)/profiles/superagent/cordis.patch.yml   # webserver 端口 + stateDir + feishu 开关
<stateDir>/orchestrator.sqlite                          # 全部状态（settings 版本化、tickets、threads…）
<stateDir>/  (lockfile)                                  # 单实例锁
<stateDir>/worker-bin/                                   # gh / lark-cli / blocked 命令 shim
<stateDir>/worker-gitconfig                              # agent 专属 git 配置
<stateDir>/work/<ticket>/                                # 默认的 Ticket 目录（executor.directory 可改）
<checkout>/.artifacts/dsh-superagent-<profile>-*.log      # 启动日志，保留 20 份
<checkout>/.artifacts/control/profiles/<profile>/         # stop 标记 / 锁 / pid
```
每个 Ticket 的工作区由 `prepare` 命令生成，典型做法是从本地 clone 执行 `git worktree add -b agent/$DSH_SUPERAGENT_NAME $DSH_SUPERAGENT_DIR`（`docs/006:149-154`）。可用变量有 `DSH_SUPERAGENT_{DIR,NAME,TICKET,BLOCKED_COMMANDS}`，GitHub Source 另外注入 `..._GITHUB_REPOSITORY/_PR_HEAD`（`src/app/execution-environment.ts:11-29`）。数据库文件只有 owner 可读（`tests/store.spec.ts:249`）。

### 2.6 运维与升级
- `scripts/dsh-superagent start|stop|restart|status`（Python，250 行）。退出码：0 正常；1 未运行或无响应，重启可能修好；2 有部件报错，重启修不好；3 在等 setup（`docs/006:113-124`）。
- 在 operator **自己的** DSH profile 里配一个**每小时自检**的 agent 计划任务，exit 1 时自动 `--respect-stop restart`（`docs/006:133-141`）。
- 升级流程：等所有 Executor 结束当前 turn，备份 sqlite，`git pull && pnpm install && pnpm build`，然后 restart。重启会结束正在运行的 Assignment，并带 recovery note 重新拉起。DB 迁移是单向的，回滚只能靠备份（`docs/006:233-242`）。未被团队覆盖的 prompt parts 跟随新默认值；被覆盖的 parts 标记为 “Default updated”。

---

## 3. 多租户假设

- **单团队、单仓库、单 operator。** 配置、Policy、Prompts 都是实例级单例：settings 只有一份（`store.settings()`），prompts 只有一份 `current`。
- **Panel 没有用户身份。** 没有登录、没有 RBAC。能访问 `127.0.0.1:<port>` 的任何人（实际就是 operator 本机）都拥有全部权限。审计只记录 `origin ∈ {panel, tool, sync}`（`policy.ts:109`）。`'panel'` 是唯一能改执行环境和账号 CLI 的 origin，用来防主 Session 被 prompt 注入后调工具改配置。代码注释明确说这**不是 OS 级安全边界**（`src/app/settings.ts:45,51,143`）。
- **“用户”只出现在 Source 侧。** 请求者身份是 Source 里的 actor（GitHub login / Feishu `ou_…`），由 Policy 的 allowed list 和 admission table 决定能否发起工作。一个请求能否变成 Ticket，取决于 `strength = explicit|inferred` 和 Mandate（`tests/policy.spec.ts:53-162`）。这是**授权**，不是租户隔离：所有 Ticket 共用同一个 agent 账号、同一个 OS 用户、同一个 stateDir 和同一份 worker 环境。
- **隔离程度很低。** worker 能读 operator 的 home 目录，也能按路径执行程序（`docs/006:19`）。官方建议是给 agent 开一个专用 OS 账号。每个 Ticket 有独立目录和独立 DSH Session，但没有文件系统隔离。
- 对我们的含义：AWS 版的 **per-user** 要新增两层概念：tenant（团队/仓库）和 panel user（Cognito 身份）。“per-user S3 Files mount”在原型里**没有对应物**，最接近的是 `<stateDir>/work/<ticket>`，即 per-ticket 工作目录。

---

## 4. 测试：移植时应保留为验收标准的契约

运行方式：`pnpm check` = typecheck + vitest + build（`README.md:35`、`package.json:47-52`）。Panel 测试用 jsdom 加 `tests/fixtures/panel.tsx` 渲染；`panel-server.ts` 是按 `Api` 类型实现的假后端。

### 4.1 领域内核（最高优先级，与传输层无关）
| Spec | 关键断言（行号为该文件中的 `it`） |
|---|---|
| `core-engine.spec.ts`（113） | **Intake**：Trigger 只存一次，跨 Thread 只在主 Thread 上做 Eval（75-83）。**Eval**：同一 Thread 内串行加 debounce（104）；accept 会**原子地**创建 Ticket、Mandate、Subscription、ack 和 Assignment，要么全成要么全不成（115,136）；评估期间 Policy 版本变化则记为 unavailable（146）。**订阅扇出**：人的追问投递给 worker；Assignment 运行前 Input 不投递（187-243）。**Resume/Stop**：被人 stop 的 Ticket 不会被唤醒；Mandate 不再满足 Policy 时不 resume（289-346）。**Hand-back**：worker 认定无关的消息退回 Eval（394-427, 655）。**中断**：Assignment 被打断后带 note 重启（702）。**Pause**：暂停期间 Eval 不过期，deadline 顺延（735）。**Worker 报告**：`ready/blocked/failed/waiting/dropped` 的语义；final report 结束 Ticket；对已结束 Ticket 的报告会被拒绝（779-835）。**PR 合并即结束**：没有它开出的 PR 仍处于打开状态时 Ticket 结束（1053）。**回复**：ack、answer、result 各只发一次，result 只针对 ready 的 Ticket（1026, 1278） |
| `policy.spec.ts`（41） | Source 作用域（31-49）；gate：allowed 加 addressed 才算 explicit，否则为 inferred 或拒绝（53-84）；admission table 每个单元格的语义及 Mandate 失效（90-205 含 `it.each`）；Policy 版本由 rules、mode 和各 Source 部分共同决定（224）；`auto` 模式下推断工作只依据已启用的命中规则（287）；Policy 变化时通知受影响的 Ticket（346-391） |
| `followups.spec.ts`（16） | 追问绕过 Eval 直接给 worker，并用 card 通知主 Session；一阵连续追问只花 1–2 次模型调用（14-103） |
| `effects.spec.ts`（13） | 本地 outbox：事务提交后才执行 effect；按 key 去重；同类有并发上限；指数退避，连续失败 3 次报 error；ordered kind 严格按序；重启后继续（29-204） |
| `store.spec.ts` / `migration.spec.ts` | settings 按 revision 存快照（192）；拒绝打开比当前构建新的 DB（18）；迁移单步失败则整体不变（199） |

### 4.2 运行时与并发
| Spec | 关键断言 |
|---|---|
| `runtime.spec.ts`（91） | 端到端链路：显式 mention 成为 candidate，accept 后建 Ticket、发 ack、订阅、起 worker（219）；proactive 观察只在 `auto` 且判定为正时建 Ticket（265）；worker 报告绑定 PR，ready 时结束（320）；重启后带 recovery note 重新拉起（523, 1443）；setup 未完成时等待，问题定位到具体 place（813-909）；**只有 panel 能改执行环境和账号**（897-909）；prepare 每个新 Ticket 只跑一次（1079）；GitHub-only 部署（1113）；同一 stateDir 拒绝第二个进程（1368）；设置保存会拒绝未知 model、未安装的 kind、超大 prompt、过期 revision（1301） |
| `runtime-concurrency.spec.ts`（56） | `maxWorkers` 的槽位计算会把正在启动的 launch 算进去（158, 853）；为人的消息保留唤醒槽（777）；provider 短暂故障最多重试 3 次（191）；后台 job 或 subagent 运行期间保持 busy；idle 30 分钟后杀掉 job（264-475）；Stop 时杀掉 job 并释放 subagent（292）；关于消息“被读到”的判定，以 step 真正拿到为准（630-747） |
| `sources.spec.ts`（71） | GitHub：notifications 轮询、PR 和分支绑定 Ticket、PR 关闭或合并时结束、Ticket 结束后 Thread 继续轮询两周、ETag、游标、连续失败才算 error（327-972）。Feishu：事件消费、话题轮询与历史恢复、从群成员同步 allowed list（92-326, 1029-1187） |
| `tools.spec.ts`（26） | 主 Session 的工具：所有 routing 工具返回同一种形状（decision、why、ticket card）；批量路由时单条失败不回滚其他条（107-166）；Executor 只能看到自己 Ticket 能触及的 id（445） |

### 4.3 API 与 Panel
| Spec | 关键断言 |
|---|---|
| `http.spec.ts`（4） | 每类错误对应自己的状态码（28）；路径参数解码（55）；**只接受 loopback 上的同源请求**（70）；prompt 保存冲突返回 409，请求体超过 128 KiB 返回 400（83） |
| `panel-overview.spec.tsx`（13） | Overview 顺序为 person Ticket、problems、24h 计数、Executor；problem 行内直接给出 requeue / dismiss / resume / 去设置的按钮；拒绝原因按 code 本地化（9-142） |
| `panel-execution.spec.tsx`（12） | Ticket 按 “等谁” 分组；Stop 要确认，双击只发一次（43, 217）；Ticket 不存在和后端无响应要区分开（78, 159） |
| `panel-eval.spec.tsx` / `panel-prompts.spec.tsx` / `panel-settings.spec.tsx` / `panel-deployment.spec.tsx` | 草稿跨重新挂载保留，遇到他人保存时按 sender 或 rule 粒度合并（eval:27）；prompt 冲突时 rebase 后重试（prompts:33）；保存栏只在有改动时出现（settings:77）；setup check 后每秒读一次 state，直到服务先停止响应再恢复响应（deployment:112-133） |
| `service-script.spec.ts`（15） | 退出码 0/1/2/3 的语义；拒绝双实例；stop 只等待自己停掉的那个进程（69-222） |
| `docs.spec.ts` / `class-docs.spec.ts` / `locales.spec.ts` | 文档、注释和字典与代码保持一致，例如 zh/en key 完全对齐 |

**建议的移植验收集**：①`core-engine`、`policy`、`followups`、`effects` 原样保留，它们是纯领域逻辑，可以作为共享库的单测；②`runtime` 中的端到端链路（219/265/320/523/1368）改写为对 control plane 的集成测试；③把 `panel-server.ts` 换成调用真实 API 的契约测试，同时保留 `http.spec` 的错误模型；④`runtime-concurrency` 中关于槽位和 Stop 的用例，映射到 AgentCore 会话的并发与取消语义。

---

## 5. 移植到 AWS 的建议

### 5.1 映射
| 原型 | AWS 方案 | 说明 |
|---|---|---|
| DSH 插件页（React，注入宿主 UI） | **独立 React SPA**，放 S3 并通过 CloudFront + OAC 分发 | 需要去掉 `@deepseek-ai/dsh-client-*` 依赖。`controls.tsx/widgets.tsx` 自带样式；`client.css` 已经包含在仓库里 |
| loopback 加 `x-orchestrator-request` | **Cognito User Pool**（Hosted UI + PKCE），配 API Gateway HTTP API 的 JWT authorizer | 可以保留 `x-orchestrator-request` 作为 CSRF 头 |
| `origin:'panel'` | `origin:{kind:'panel', userSub, email}` 写入审计 | 用 Cognito group 区分 `admin`（能改账号和执行环境）和 `operator`（能 Stop、Retry、Pause） |
| `/orchestrator/api/*`（25 条） | API GW 加 **Lambda**（读视图、简单写操作） | 读侧视图（`views/*.ts`）是纯函数，可直接复用，前提是 Store 换成 DynamoDB 或 Aurora |
| 单进程常驻循环（passes、effects、Source 轮询、主 Session） | **常驻 control-plane 服务**（ECS Fargate 单任务，或 EventBridge Scheduler 加 Step Functions） | Engine 依赖进程内串行和事务语义（`effects.spec`）。MVP 建议先用 **1 个 Fargate 任务**直接跑现有 runtime，Store 换成 Aurora Serverless v2 或 DynamoDB 事务写 |
| Executor DSH Session（本机进程、共享 OS 用户） | **AgentCore Runtime 会话**，每个 Ticket 一个 session id；每个 Ticket 或用户挂载 S3 Files | 天然得到原型缺少的隔离。`maxWorkers` 槽位由 control plane 计数 |
| `<stateDir>/work/<ticket>` 加 `prepare` 命令 | S3 Files 挂载点下的 `/<tenant>/<user>/<ticket>` 目录，在 AgentCore 容器内执行 prepare | worktree 要求本地 clone，可改为容器内 `git clone --depth` |
| `gh`/`lark-cli` wrapper 与 shim | Secrets Manager（agent PAT 或 GitHub App installation token、Feishu app secret）；AgentCore Identity / outbound credential | 原型要求必须是**用户账号**（因为读 notifications）。在 AWS 上改用 GitHub App webhook 收事件，就不再需要用户账号 |
| Source 轮询 | GitHub App **webhook** 经 API GW 进入 SQS；Feishu 事件订阅走 HTTP 回调 | 可去掉轮询、ETag 和游标逻辑，但要保留“Ticket 结束后 Thread 继续跟两周”等语义 |
| 5 s 轮询 | MVP 保持轮询；后续可接 API GW WebSocket 或 AppSync 推 `state/overview` 增量 | 契约里本来就没有流式，轮询完全够用 |
| “Open Session” 跳到 DSH 会话 | Ticket 页内嵌 **worker transcript 查看器**（读 AgentCore 会话或 S3 里的日志），外加“给 worker 发消息”（等价于在 Thread 里追问） | 原型这部分依赖 DSH UI，需要新建 |
| `scripts/dsh-superagent` 与每小时自检 | ECS 健康检查加 CloudWatch Alarm；`GET state` 的 health map 发成 CloudWatch 自定义指标 | 退出码 0/1/2/3 的语义映射为告警级别 |
| SQLite 迁移与备份 | Aurora 快照或 DynamoDB PITR | — |

### 5.2 多租户设计（原型没有，需要新增）
- `tenantId` 对应一个 Deployment（repo、agent 账号、Policy、Prompts）；DB 的所有表都加 tenant 分区键。
- `userId` 有两种含义：一是 Panel 用户（Cognito sub），用于鉴权和审计；二是 Source actor（GitHub login / Feishu open_id），用于 Policy。两者需要一张**映射表**，“per-user S3 mount” 按 Mandate 的 actor 映射成的 userId 决定。
- 建议路径：`s3files:/<tenant>/<user>/<ticket>/`。AgentCore 会话以 per-user IAM 会话策略（只允许访问该前缀）挂载。

### 5.3 MVP 子集
1. **只做 GitHub Source**（runtime.spec:1113 已证明可行），只支持一个 tenant 和一个 repo；Cognito 只建一个 operator 组。
2. **API 只实现稳定子集**：`GET state`、`GET overview`、`GET tickets`、`GET tickets/:id`、`POST tickets/:id/stop|retry`、`POST executor/pause`、`GET/PUT settings/{policy,eval,executor,source:github}`（保留 revision 乐观锁和 400/404/409 错误模型）、`GET/PUT prompts`。
3. **Panel 页面**：Overview、Execution（列表加详情）、Settings › Sources/Policy/Execution/Prompts（只做编辑和保存，Full prompt diff 与 History 后做）。Trigger/Thread 时间线、Eval 列表、搜索、Feishu、admission table UI 放到第二期。
4. **执行**：每个 Ticket 起一个 AgentCore 会话并挂载 S3 Files；prepare 等价于容器内 clone 加切分支；worker 报告 `ready|blocked|failed|waiting` 通过回调写回 control plane。
5. **验收**：§4 建议的四组测试，其中 core-engine 和 policy 必须全绿。

### 5.4 风险与注意点
- Engine 的正确性大量依赖“同进程、同一事务”的原子性（`core-engine:136`、`runtime:1327`）。拆成 Lambda 后要保证 accept 链路仍是**单事务**（DynamoDB `TransactWriteItems` 最多 100 项，或使用 Aurora）。
- 主 Session（router）是长生命周期的 LLM 会话，会接收 card 和通知（`followups.spec:103`）。放到 AgentCore 时需要保持会话常驻或支持 resume，并控制模型调用次数。
- “只有 Panel 能改执行环境”是防 prompt 注入的关键护栏，移植后要用 IAM 或 Cognito 角色**真正强制**，原型里只是软约束。
- `eval.mode` 默认是 `observe`。保留这个“先观察、后自动”的上线节奏（`SETUP.md:55`）。
