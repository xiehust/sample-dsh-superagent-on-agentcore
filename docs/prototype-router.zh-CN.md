# dsh-superagent 原型中 router 的工作机制

本文说明 `dsh-superagent-prototype/`（DeepSeek dsh-superagent 原版）中 router 如何工作、如何管理上下文，以及本项目移植到 AWS 时做了什么改变。

## 1. router 是什么

可以把 router 想成一个**前台调度员**：它不写代码，只负责"来了一条消息，交给谁处理"。

- 整个部署只有**一个** router。它是一个长期存在的 DeepSeek Harness 会话，文档里叫 main Session，代码和提示词里叫 `orchestrator`。
  - 会话 id 存在 KV 的 `master-id` 中，重启后继续使用同一个会话（`src/app/runtime.ts:104`）。
  - 使用专用 preset `dsh-superagent-router`（`src/app/sessions.ts:48`）。
- 真正干活的是 **worker**（Executor）。每个任务（Ticket）对应一个 worker 会话和一个独立工作目录。
- router 的职责只有三件：
  1. 判断新消息是不是要做的事；
  2. 要做就开 Ticket 派给 worker；
  3. worker 做完后把结果回给提问的人。

## 2. 一次完整流程（示例）

用户在飞书群里 @ 机器人："能加个暗色模式吗？"

1. **消息进来**：程序（不是 AI）先把消息存进数据库，并生成一张简短的**候选卡片**。卡片包含：
   - 消息原文；
   - 所在的 thread；
   - 这个 thread 已有的 Ticket（open 的排在前面）；
   - 消息已经送达过的 Ticket（`delivered_to`）；
   - 消息里引用的 Issue/PR 对应的 Ticket（`referenced_tickets`）；
   - 如果是 worker 退回的消息，附上退回理由（`handed_back`）。
2. **卡片推给 router**：程序把卡片作为一条新消息塞进 router 的对话，唤醒它。
3. **router 做决定**：调用工具 `orchestrator_route`，对每条候选从下面四种里选一种。一次调用可以批量处理最多 20 条候选。
   - **accept**：新任务。给出标题、worktree 名和一句确认回复，程序随即开出 Ticket。
   - **attach**：消息是某个已有 Ticket 的追问，就并入那个 Ticket。只有消息明确指向该 Ticket 时才允许，比如引用了它的 PR 或 Issue，或者引用了它的确认消息。
   - **stop**：有权限的人要求停掉某个任务。
   - **ignore**：闲聊或无关讨论，写明原因。
4. **派活**：accept 之后，程序原子地创建 Ticket、Mandate、Assignment、订阅关系和确认回复，然后启动 worker，把**原始消息**交给它。
   - router 只能附一句不超过 30 词的路由备注。
   - router 不能把需求改写成自己的方案、验收标准或检查清单。
5. **worker 干活**：
   - worker 自己去读原始消息、thread 历史和代码，然后实现、验证、提 PR。
   - 群里的后续追问直接送到对应的 worker，由 worker 自己判断：属于本 Ticket 就处理；不属于就退回，退回的消息会重新变成 router 的候选。
   - 对这类追问，router 只会收到一条通知，唯一能做的操作是按用户要求 stop。
6. **回报**：
   - worker 完成或卡住时，提交一份简短报告。程序把报告推给 router，摘要最多 600 字符。
   - router 把结果或问题回到 Ticket 最初来源的那个对话里。
   - 普通进展不对外发。

```
飞书/GitHub 消息
      │
      ▼
 程序：存库 + 生成候选卡片
      │  (relay，唤醒)
      ▼
 router：orchestrator_route ── ignore ──▶ 结束
      │ accept / attach / stop
      ▼
 程序：建 Ticket / 投递给 worker
      │
      ▼
 worker：读原文、改代码、提 PR ◀── 后续追问直接送达
      │  报告 (relay，唤醒)
      ▼
 router：orchestrator_reply 回到原对话
```

## 3. router 的上下文管理

router 的对话会一直变长，所以设计的核心原则是：**只放路由需要的信息；状态存在数据库里；细节用指针按需去读。**

### 3.1 只收卡片，不收原文

推给 router 的内容都是截断过的摘要，需要细节时再用 `orchestrator_read` 按资源名去数据库查。资源名包括：

- `ticket/<id>`
- `trigger/<id>`
- `thread/<key>`
- `decisions`
- `settings/<block>`
- 等等

查询结果有长度和分页限制：

| 内容 | 限制 |
|---|---|
| 文本页 | 默认 4,000 字符，最多 8,000 |
| 列表 | 默认 20 条，最多 50 条，用 `next_offset` 翻页 |
| worker 报告摘要 | 600 字符；被截断时附带 `chars` 和读取指针 |

### 3.2 两种推送方式

程序通过一个持久化的 Effects 队列向 router 投递消息。投递按顺序进行，带去重；失败时从 2 秒开始指数退避重试，间隔最长 60 秒。

| 方式 | 是否唤醒 router | 内容 |
|---|---|---|
| **relay**（steer） | 是 | 候选卡片、`follow_up`、`worker_report`、`worker_attention` |
| **notice**（inject） | 否，只追加进对话 | `ticket_ended`、`settings_saved`、prompt 保存、requeue、退订、context follow |

notice 有两条额外规则：

- 同名 notice 还没送达时，新的会替换旧的。
- router 自己执行的操作不会再给它发对应的 notice。

实现见 `src/app/sessions.ts` 中的 `relay` / `notify` / `inject`。

### 3.3 系统提示词每次请求都重新拼装

规则和 Policy 不依赖对话历史，每次调用模型前都从当前设置重新生成。拼装顺序如下：

1. Shared 指令与角色
2. 团队的三个 section
3. Subscriptions 与 replies
4. `dispatch.md`（router 的分发规则）
5. `runtime/admission`（主动评估规则，仅 router）
6. Handoff 指令
7. `runtime/environment`
8. `runtime/policy`（仅 router）

Policy 段放在最后。这样修改 Policy 后，前面的提示词文本保持不变，并且立即生效。

与 worker 不同，router **不读** Harness 的 coding prompt，也不读仓库的 `AGENTS.md`。

### 3.4 主动评估使用有界窗口

对于不是直接 @ 机器人、而是可能触发某条规则的消息（inferred candidate），router 调用 `orchestrator_eval` 获取评估上下文（`src/app/assessment.ts`）。上下文包括：

- **Trigger 文本**：最多 4,000 字符。
- **相关 Ticket**：最多 8 个（`related_tickets`），以及总数 `tickets_total`。
- **Thread 窗口**：
  - 取 thread 的前 5 条消息，以及 Trigger 前后各 5 条；
  - 每条消息一般截到 400 字符，紧挨 Trigger 的前后各一条截到 1,200 字符；
  - 其余已加载的消息只给 50 字符的 stub，用 `orchestrator_eval_read` 按 id 展开。

每个 Eval 的窗口只加载一次并缓存，主机重启后也一样。Eval 结束时缓存会被释放。

如果候选卡片已经能看出与任何启用的规则无关，router 可以直接 ignore，不必评估。这种决定会记录为 `ignoredFromCard`。

### 3.5 用提示词约束它不装多余内容

`prompts/dispatch.md` 和 `prompts/shared.md` 规定 router：

- 不读代码、日志或 worker 的完整 transcript；不调查技术问题，也不排查 blocker。这是提示词规则，不是工具层面的限制。
- 不改写需求，不添加实现方案或检查清单。worker 会回到源头读原文。
- 多条候选能凭卡片直接决定的，用一次 `orchestrator_route` 批量处理。只有确实需要更多上下文的，才先 read 或 eval。
- 给其他 Ticket 的 note 最多 100 词，只算上下文，不授予任何权限。

因此 router 的上下文里基本只有：谁、什么事、交给了谁、结果如何。

### 3.6 压缩交给 Harness，状态以数据库为准

- 应用层不做自己的压缩。对话过长时由 DeepSeek Harness 自动压缩。
- 提示词要求 router 在压缩后重新查看 Ticket 摘要（"Check ticket summaries after compaction to avoid duplicate work"），而不是依赖对话记忆。
- 程序侧也有兜底：
  - accept 按 trigger ID 幂等，同一条消息不会开出两个 Ticket；
  - relay 和 notice 按 request id 去重。

### 3.7 不让它等待

`src/app/sessions.ts` 中的 `noWait` 守卫会拒绝三类调用：

- 执行 `sleep` 的 shell 命令；
- 超过 30 秒的 shell timeout；
- 超过 5 秒的 job wait。

router preset 也会在 5 秒后把 shell 命令转到后台。原因是新候选、报告和后台任务结果都会自动推送过来，router 停下来等只会让新消息积压。

## 4. 总结

> router 只做分发，记忆尽量轻：所有状态在数据库里，所有细活在 worker 里。

## 5. 本项目的实现方案

本项目（AWS 版）**没有 router 会话**。原型里 router 承担的两件事拆成了两个**无状态**的 Bedrock 调用：

- **Assessor**（`packages/cell/src/assessor.ts`）：每个候选调一次，决定 accept / attach / stop / ignore。
- **Replier**（`packages/cell/src/replier.ts`）：每份值得回复的 worker 报告调一次，决定回不回复、回什么。

这个选择来自需求 R5："Eval and reply writing are stateless Bedrock calls; there is no long-lived router session."

### 5.1 总体结构

```
GitHub webhook ─▶ API GW + Lambda ─┐
飞书长连接（host 内 Connector）────┤
                                   ▼
                     SQS FIFO（每个 cell 一个队列）
                                   │
                                   ▼
        ECS host 里的 cell：DSH core Engine + SQLite（Litestream 备份到 S3）
          ├─ Policy 闸门（确定性规则，不调模型）
          ├─ Assessor ── Bedrock（一次调用 / 候选）
          ├─ Replier  ── Bedrock（一次调用 / 报告）
          ├─ Executor ── InvokeAgentRuntime ─▶ AgentCore worker（每个 Ticket 一个会话）
          └─ Outbox   ── GitHub / 飞书 API（回复）
```

- **cell**：每个 (tenant, repo) 一个，内含原型的 DSH core Engine（代码原样复制到 `packages/core`）和一个 SQLite 文件。DynamoDB 租约保证同一时刻只有一个写者。
- **worker**：每个 Ticket 一个 AgentCore Runtime 会话，跑 Claude Agent SDK。工作目录和对话记录存在该 Ticket 专属的 S3 Files access point 上，换 microVM 后可以接着做。
- **回报通道**：worker 通过 worker-api 发事件（ack / report / handback / thread.follow 等），事件进入 cell 的 SQS 队列，再由 Engine 处理。

### 5.2 一次完整流程（同一个示例）

用户在飞书群里 @ 机器人："能加个暗色模式吗？"

1. **消息进来**：飞书 Connector 收到消息，查出这个群绑定的 cell，把消息放进该 cell 的 SQS 队列。
2. **规范化和闸门**：cell 把消息转成 DSH Trigger 存进 SQLite，然后过 Policy 闸门：发送者在不在名单里、有没有 @ 机器人。被闸门拒绝的消息直接记录，不调用模型。
3. **建 Eval，排队评估**：Engine 为这个 thread 开一个 Eval，把这段时间排队的消息合成一个批次，调用 `assessor.request(candidate)`，在持久化的 Effects 队列里加一个 `assessment` 任务。
4. **Assessor 做一次 Bedrock 调用**：
   - system prompt 就是原型 router 的提示词（`Prompts.compose('orchestrator')`），末尾加一段说明："你只被调用一次，没有对话历史，也没有其他工具；卡片上没有的信息一律视为未知。"
   - user 消息是一张 JSON 卡片。
   - 模型必须调用原型里同名、同 schema 的工具：
     - explicit（直接 @）的候选调用 `orchestrator_route`；
     - inferred（可能命中规则）的候选调用 `orchestrator_eval_decide`。
5. **执行决定**：结果交给 `engine.decide` 或 `engine.attach`，这部分与原型完全相同。accept 时建 Ticket，通过 Outbox 发确认回复，Executor 用 InvokeAgentRuntime 启动 worker。
6. **worker 干活**：读原始消息、clone 仓库、改代码、提 PR。群里的后续追问由 Engine 直接投递给 worker（`deliver`），不经过任何模型判断。worker 认为追问不属于本 Ticket 时就退回，消息重新变成候选。
7. **回报**：worker 发 `report` 事件。若状态是 `ready` / `blocked` / `failed` / `dropped`，或报告里带问题，就加一个 `compose` 任务。Replier 调一次 Bedrock，模型调用 `orchestrator_reply`，可以选择不发（`send=false`）或给出回复内容。回复先过 Engine 的 reply 闸门，再经 Outbox 发到原对话。

### 5.3 Assessor 看到的上下文

每次调用的上下文都从零拼装，内容固定、有上限：

| 部分 | 内容 |
|---|---|
| system prompt 前缀（走 prompt cache） | 原型 router 的全部提示词段落（Policy 段除外），加上无状态说明 |
| system prompt 尾部（cache 点之后） | Policy 段（启用的规则、accept 模式）。Policy 一改，只有这一段变，前缀缓存不失效 |
| 卡片：触发消息 | 本批次每条 Trigger 的消息卡片和来源链接 |
| 卡片：已有 Ticket | 这个 thread 上的 Ticket：标题、是否 open、强度、结束原因、最近一次报告摘要（≤300 字符） |
| 卡片：送达情况 | 每条 Trigger 的 disposition（送到了哪些 Ticket、被谁退回） |
| 卡片：thread 上下文 | **仅 inferred 候选**：从 GitHub/飞书现读这个 thread 最近 20 条消息 |

- 调用的截止时间等于 Eval 超时（`settings.eval.timeoutSeconds`），并发上限 4。
- 失败时这个 Eval 记为 `unavailable`，由 Engine 按原型规则重排和重试。
- 模型由 `settings.eval.model` 指定，默认 `global.anthropic.claude-sonnet-5-5`。Replier 用同一个模型。

### 5.4 本项目的上下文管理

原型的问题是"一条不断变长的对话怎么控制"。本项目没有这条对话：**每次调用都是一份自包含的快照，用完就丢。**

- **没有历史，也就不需要压缩**：不存在压缩后忘事、重复派活的风险。权威状态始终在 SQLite 里，每次拼卡片时现读。
- **不能按需再读**：Assessor 只有一个决策工具，没有 `orchestrator_read`。卡片要一次给够，卡片外的信息模型无从知道，所以提示词要求它"不要编造 ticket id 或引文"。
- **一个候选失败不影响其他候选**：一次调用只处理一个 Eval，失败只让这个 Eval 变成 `unavailable`。原型里 router 卡住时，所有候选都会排队。
- **不需要 notice**：原型里那些"不唤醒、只追加"的 notice（设置变更、Ticket 结束等）在本项目里没有接收者。`packages/cell/src/app/notices.ts` 只把它们记录下来给面板看。下一次调用读到的就是最新设置和状态。
- **重复处理由 Engine 兜底**：accept 仍按 trigger ID 幂等，Effects 按 key 去重。

## 6. 对比

| 方面 | 原型（DSH） | 本项目（AWS） |
|---|---|---|
| 判断者 | 一个长期存在的 main Session（router） | 每个候选一次无状态 Bedrock 调用（Assessor） |
| 回复者 | 同一个 router，调用 `orchestrator_reply` | 每份报告一次无状态 Bedrock 调用（Replier） |
| 范围 | 整个部署一个 router，管所有仓库 | 每个 (tenant, repo) 一个 cell，互相隔离 |
| 提示词 | `dispatch.md`、`admission.md` 等 | **同一套提示词**，外加一段无状态说明 |
| 决策工具 / schema | `orchestrator_route`、`orchestrator_eval_decide` | **同名同 schema**（`packages/cell/src/decisions.ts` 原样复制） |
| 决策执行 | DSH core Engine | **同一个 Engine**（`packages/core` 原样复制） |
| 上下文来源 | 对话历史 + 推送的卡片和 notice + 按需 `orchestrator_read` | 每次现拼的一张卡片，没有历史，不能再读 |
| 上下文增长 | 持续增长，依赖 Harness 压缩 | 不增长，每次大小有上限 |
| 主动评估上下文 | `orchestrator_eval` 窗口（前 5 条 + 前后各 5 条），可按 id 展开 | 最近 20 条 thread 消息，一次给全 |
| 批量处理 | 一次 `orchestrator_route` 可决定最多 20 个候选 | 一次调用决定一个 Eval（一个 thread 上的一批消息） |
| 后续追问 | 送给 worker，同时给 router 发 `follow_up` 通知，router 可 stop | 只送给 worker，不调用模型；停止任务走面板 Stop |
| 通知（notice） | 注入 router 对话 | 只记录给面板，没有接收者 |
| 等待控制 | `noWait` 守卫、5 秒 preset | 不需要：调用有截止时间，结束即释放 |
| 故障影响 | router 卡住或预算耗尽时，所有候选都要等 | 只影响单个 Eval（`unavailable` 后重试） |
| 管理操作 | 可以在对话里让 router 改设置、改 prompt、发 note、查状态 | 只能在面板里做（Settings / Stop / Retry / Pause） |
| 被忽略的消息 | 只有 Decision 记录 | 另有 `decision ignored` 日志、面板"最近被忽略"列表，以及 @ 消息被忽略时的提示回复（`eval.replyOnIgnore`） |
| worker | 本机 DeepSeek Harness 会话，共享主机 | AgentCore Runtime 会话 + 每个 Ticket 一个 S3 Files AP，用 ticket token 鉴权 |

## 7. 取舍

**得到的：**

- 行为可预测：每次判断的输入都是一张可复现的卡片，便于审计和测试。
- 没有上下文膨胀和压缩带来的遗忘。
- 能横向扩展：cell 之间互不影响，一个候选失败不会拖住其他候选。
- 成本可控：system prompt 前缀走 prompt cache，Policy 段放在 cache 点之后。

**失去的：**

- 跨候选的记忆：Assessor 记不住"刚才那条消息"，判断 attach 只能依靠卡片里列出的 Ticket 和报告摘要。
- 按需查资料：卡片外的 Ticket、Decision 和 thread 细节，模型都读不到。
- 对话式管理：不能在聊天里让机器人改设置、给其他 Ticket 发 note 或主动查 worker 状态，这些都改到面板里做。

这些能力在原型中依赖长期存在的 router，本项目有意放弃了。需要时，可以通过扩充卡片内容来补回，比如增加跨 thread 的相关 Ticket。

详见 [design.md](design.md) §1、§6。

## 8. FAQ

以下路径都相对于 `dsh-superagent-prototype/`。

**Q：thread 具体指什么？在飞书和 GitHub 里分别对应什么？**

thread 就是"一段对话"。同一 thread 里的消息被当作同一件事的上下文，Ticket 也按 thread 订阅。它的 key 写成 `source:id`。

GitHub：一个 Issue 或一个 PR 就是一个 thread（`src/sources/github-trigger.ts`）。

| 消息 | thread key |
|---|---|
| 新开的 Issue / PR（标题 + 正文） | `github:<编号>` |
| Issue/PR 下的评论、PR 的 review 和行内 review 评论 | `github:<编号>` |
| PR 的 CI 结果 | `github:<编号>` |
| 默认分支的 CI 结果 | `github:ci:<分支名>` |

- Issue 和 PR 在 GitHub 里共用一套编号，所以只看编号就够了。
- key 里不带仓库名，因为一个部署（本项目里是一个 cell）只对应一个仓库。

飞书：一条顶层消息加上所有回复它的消息，算一个 thread。thread id 是 `<chat_id>:<root_id，没有就用自己的 message_id>`（`src/sources/feishu-trigger.ts:16`）。

- 在群里直接发一条消息（不是回复）：开一个新 thread，`feishu:oc_xxx:om_这条消息`。
- 回复这条消息，或在它的回复串里继续回复：飞书会带上指向最初那条消息的 `root_id`，所以归入同一个 thread。
- 话题群：一个话题就是一个 thread。
- 私聊同理：每条不是回复的新消息各开一个 thread。
- 一个群不是一个 thread。同一个群里两条互不回复的消息属于两个 thread。

注意：飞书消息上还有一个 `channel.thread = feishu:<chat_id>`，它表示"往哪个群回消息"，是回复通道，跟上面的 thread 不是一回事。路由、订阅和关联 Ticket 用的都是 `chat_id:root_id` 这个 thread。

实际影响：在飞书里追问时，如果不点"回复"、而是直接另发一条，它会成为新 thread，卡片上不会带出原来的 Ticket，很可能被当成新任务。要并入原 Ticket，就回复原消息或机器人的确认消息。

**Q：Ticket 存在哪里？**

原型把所有状态存在本机 SQLite 文件 `<stateDir>/orchestrator.sqlite` 里（`src/app/runtime.ts:98`）。`ticket` 表每行一个 Ticket，主键是 id，内容是整段 JSON；`thread`、`trigger`、`disposition`、`decision` 等表的存法相同（`src/app/store.ts:72`）。本项目沿用这套表结构，SQLite 文件放在 cell 里，用 Litestream 备份到 S3。

**Q：怎么判断一个 thread 已经有 Ticket？**

靠订阅关系，不靠内容判断。`thread` 表每行有一个 `subscriptions` 数组，记录订阅它的 Ticket id。下面几种情况会写入订阅：

- accept 建 Ticket 时，订阅触发消息所在的 thread（`src/core/tickets.ts:52`）；
- attach 时订阅（`src/core/tickets.ts:122`）；
- Ticket 开了 PR，就订阅这个 PR 的 thread（`engine.bindThread`）；
- worker 认为某个 thread 相关时，也会订阅它（`followForContext`）。

生成卡片时按这个数组取出 Ticket（`src/core/part.ts:73`），open 的排前面、新的排前面，最多列 8 个，另给总数 `tickets_total`（`src/app/cards.ts:93`）。

**Q：订阅（subscription）是什么？**

订阅就是"这个 Ticket 关注这个 thread"，像邮件列表的订阅一样，存在 `thread.subscriptions` 里。它决定了新消息的去向（`src/core/intake.ts`）：

- **直接投递，不开 Eval**：thread 上来了新消息，程序先查订阅，把消息作为 Input 直接送到每个订阅它的 Ticket 的 worker，不经过 router。这就是正文里"后续追问直接送到对应的 worker"的机制。
- **唤醒已结束的 Ticket**：Ticket 已经结束时，只要有**人**在它订阅的 thread 上发言，就会把它唤醒。机器人和 CI 的消息不会唤醒；被人手动 stop 的 Ticket 不再接收任何消息。
- **没有归属的消息才进 Eval**：没有任何 Ticket 认领的人的消息，以及所有机器人的消息，才会排进 Eval 交给 router。
- **"仅作上下文"的订阅**：worker 通过 `followForContext` 订阅的 thread 标记在 `thread.context` 里。这种订阅只让 worker 看到那边的消息：它不唤醒已结束的 Ticket，那边的消息也仍然会进 Eval。

订阅会在这些情况下解除：worker 认为某个 thread 与本 Ticket 无关（`markUnrelated`，消息退回给 router），或者有人在面板上退订这个 thread（`engine.unsubscribe`）。

所以 `referenced_tickets` 的逻辑是："消息里提到了 #42"，那么"#42 这个 thread 被哪些 Ticket 订阅了"，这些就是被引用的 Ticket。

**Q：`referenced_tickets` 是怎么查找的？**

用正则扫消息原文，找 `#数字` 和 URL（`src/app/links.ts:48`）：

- 每个匹配交给 Source 解析成 thread。GitHub 把 `#12`、`12`、`.../pull/12`、`.../issues/12` 都解析成 `github:12`，只看编号、不看仓库名（`src/sources/github.ts:67`）。飞书不解析出 thread，所以消息里贴飞书链接查不到 Ticket。
- 再查这些 thread 的 `subscriptions`，去掉卡片上已经列出的 thread Ticket，最多取 4 个。
- 这是纯文本匹配。"回复了某条消息"另由 `repliedTo` 附上被回复的那条消息。

本项目的 Assessor 卡片没有这一项，只列当前 thread 上的 Ticket（`packages/cell/src/assessor.ts:66`）。
