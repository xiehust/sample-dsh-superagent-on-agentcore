# 面向 agent 的通用 LLM 模型 router：初步设计结论

> 状态：讨论中（初稿，2026-11-04）。以下都是阶段性结论，第 8 节的问题定下来之后再细化。

## 1. 背景与目标

- 目标：做一个通用的 LLM 模型 router，把请求分到不同模型上，在成本、质量、延迟、可用性之间取舍。
- 调用方是 agent。agent 的请求是多轮的，带工具，上下文很长，每一轮都在同一段前缀后面追加内容。所以 router 必须把 prompt cache 当作一等约束。
- 参考对象：dsh-superagent 原型里的 router（见 [prototype-router.zh-CN.md](prototype-router.zh-CN.md)）。它是**任务分发器**，判断一条消息交给哪个 worker，不负责选模型。能借鉴的是它的结构性设计，不是具体逻辑。

## 2. 从 DSH router 借鉴什么

DSH 最核心的一条：**只在边界上做决策，之后按订阅关系直接投递，不再重新判断。** 放到模型 router 上，这正是保住 prompt cache 的关键。

| DSH | 模型 router |
|---|---|
| thread 有了 Ticket 后，追问按订阅直接投给 worker，不再经过 router | session 第一个请求选定模型后，后续请求查表直通，不再分类（粘性） |
| worker 退回（handback）后，消息重新变成候选 | 检测到当前模型搞不定才升级，而且只在边界处切换 |
| Policy 闸门（确定性规则，不调模型）在 Assessor 之前 | 分层决策：规则 → 轻量分类器 → LLM 判官（少用） |
| router 只看截断过的卡片，不看全文 | 分类只用紧凑特征：首条任务、工具集签名、上下文长度、调用角色。不读整段 transcript |
| router 不改写需求，原文交给 worker | 网关原样透传请求，不往前缀里注入动态内容 |
| 稳定前缀在前，Policy 段放在 cache point 之后 | 网关非注入不可的内容，放在最后一个 cache point 之后 |
| 状态存在数据库，决策幂等，单个 Eval 失败不影响其他 | session 与模型的绑定存在外部存储，路由决策可复现、可审计 |

## 3. 关键约束：prompt cache

### 3.1 缓存绑定在哪些东西上

- **模型**：换模型，整段前缀全部 miss，没有例外。
- **前缀字节**：前缀靠前的位置有任何改动，后面全部失效。顺序是 tools → system → messages。
- **TTL**：每次命中都会重置。很多模型是 5 分钟，部分模型可以配 1 小时（返回的 `cacheDetails.ttl` 取值 `5m` / `1h`）。
- **服务器**：Bedrock 文档写明，缓存存在处理该请求的那台服务器上。请求如果被别的服务器（比如另一个 Region）处理，或者在相同请求开始返回之前就并发发出，都会重新写入，读不到已有缓存。
- **thinking 参数**：开启、关闭或调整 budget，会让 messages 段的缓存失效，system 和 tools 段保留。`effort` 会不会同样失效，文档没写，需要实测（见第 9 节）。
- **最小长度**：每个 checkpoint 之前的累计前缀要达到模型的最小 token 数（不同模型从 512 到 4,096 不等），否则不缓存。
- **用量字段**：Converse 返回的 `inputTokens` 只含未走缓存的部分。总输入 = `inputTokens` + `cacheReadInputTokens` + `cacheWriteInputTokens`。

### 3.2 切换代价不对称

以下数字只用来说明量级，假设：

- 大模型输入单价是小模型的 5 倍；
- 缓存读按输入单价的 0.1 倍计，写按 1.25 倍计（Claude 的常见比例，具体以 Bedrock 价格页为准）；
- 只算已有前缀 P 的成本，单位是"小模型输入单价 × P"。新增 token 和输出 token 另算，它们只会让降级更快回本、让升级更贵。

| 这一轮的操作 | 前缀成本 |
|---|---|
| 留在大模型（命中） | 0.5 |
| 降级到小模型（重新写入） | 1.25 |
| 留在小模型（命中） | 0.1 |
| 升级到大模型（重新写入） | 6.25 |

- **降级**：当轮多付 0.75，之后每轮省 0.4，大约 2 轮回本。剩余轮次多就值得。
- **升级**：当轮前缀成本是留在小模型的 60 多倍。上下文越长，绝对金额越大，还要重新 prefill 整段上下文，首 token 延迟变长。所以主循环里尽量不升级。
- **对比方案 D**（见 4.4）：只把摘要发给大模型。摘要按前缀的 10% 算，大模型这部分约 0.5～0.63，加上小模型主循环命中的 0.1，合计约 0.6～0.7，远低于直接升级的 6.25。

切换判断可以写成：

```
一次性切换代价 ≈ P × (新模型写入单价 − 原模型读取单价) + 首 token 延迟惩罚
预期收益     ≈ 预计剩余轮数 × 每轮差价（前缀读取差价 + 输出差价）
切换条件     ：预期收益 > 一次性切换代价 × 滞回系数（大于 1，防止来回切）
```

### 3.3 冷点（免费切换点）

下面这些时刻，所有模型的缓存本来就是冷的，切换没有额外代价，只剩两个模型本身的价差：

- session 刚开始；
- compaction 之后（前缀被改写）；
- 空闲超过 TTL，比如在等人审批；
- 新开 sub-agent（全新上下文）。

### 3.4 跨模型续写的格式问题

Claude 的 thinking 块带签名，GPT 的 reasoning 项也是各家私有格式，不能互相传。切换模型时，一般要剥离或转换这些历史内容。这样一来，即使之后切回原模型，前缀也已经变了，A→B→A 来回切的代价很高。

## 4. 设计方案（按决策粒度划分，可以组合）

| 方案 | 决策粒度 | 对缓存的影响 | 收益空间 | 实现难度 | 前提 |
|---|---|---|---|---|---|
| A 任务级路由 | 每个任务一次 | 无 | 小，只能依据任务开头判断 | 低 | 无 |
| B session 粘性网关 | 按 session，冷点重判 | 只在冷点或能回本时切 | 中到大 | 高 | session 识别、cache 账本 |
| C 按调用角色路由 | 每次调用按角色 | 无，旁路调用本来就是新上下文 | 中 | 低 | 调用方标注角色，或网关能识别 |
| D 不切模型的升级通道 | 主循环不切，按需咨询 | 无 | 大，但质量风险也最大 | 中 | 能改 agent 的工具集 |
| E 同模型调节与亲和 | 按轮或按 session | effort 待实测；亲和能提高命中 | 小到中 | 低到中 | effort 实测结果 |

### 4.1 A：任务级路由（DSH 式）

- 建 session 时选模型，全程固定。缓存命中最好，实现最简单。
- 缺点：任务中途变难或变简单时无法调整。
- 本项目现在就是这种（见第 7 节）。

### 4.2 B：session 粘性网关，只在冷点重新路由

- 一个兼容多种 API 协议的代理。session 第一个请求分类并绑定模型，之后直通。
- 只在冷点，或者按 3.2 的公式算出能回本时，才重新路由。加滞回，防止在两个模型之间来回切。
- **session 识别**：
  - 显式：自家 agent 在 header 里带 session id 和调用角色。
  - 隐式：对 tools、system 和第一条 user 消息算前缀哈希。fork 出来的 sub-agent 第一条消息通常不同，会被识别成新 session。compaction 之后第一条消息通常被摘要替换，也会被当成新 session，正好落在冷点上。
  - 再对整段前缀逐段算哈希（类似 radix tree），判断本次请求是不是上次请求的延续，用来估计缓存冷热。
- **cache 账本**：按 session × 模型 × Region/账号，记录最后请求时间、前缀长度和哈希、上次返回的 cacheRead/cacheWrite。距上次命中不超过 TTL、且本次前缀是上次前缀的延续，就判为热。这只是估计，用每次返回的 usage 校准。
- **升级信号**：网关看不到语义，只能从信号推断"任务变难了"，比如工具连续报错、重复同一操作、测试失败、模型自述做不了、输出解析失败后重试。
- 优点：通用性最好，对 agent 透明。

### 4.3 C：按调用角色路由

- 主循环固定用强模型。sub-agent、compaction/摘要、工具输出消化、标题生成、分类检查这些旁路调用走小模型。
- 旁路调用本来就是新上下文，不碰主线缓存；它们自己的固定 system prompt 也能缓存。
- Claude Code 也是类似做法：旁路任务用小模型，sub-agent 可以单独指定模型。本项目的 eval/reply/worker 分角色配模型也是这个思路。

### 4.4 D：不切模型的升级通道

- 小模型跑主循环。卡住时调用 `consult_expert(question, summary)` 这类工具，只把精简后的上下文发给大模型，答案作为工具结果回到主循环。主循环的模型不变，缓存不受影响。
- 也可以反过来做 planner–executor：大模型规划，把可并行的执行步骤派给小模型 sub-agent。
- 这对应 DSH 里"router 只附一句备注，worker 自己回源读原文"：传给专家的是指针和摘要，不是整段历史。
- 前提是能改 agent 的工具集，只适用于自家 agent。

### 4.5 E：同一模型内的调节手段，以及服务器亲和

- **effort**：如果实测确认改 effort 不破坏缓存，它就是最便宜的按轮调节手段；否则也只能在冷点调。
- **Region 和账号亲和**：
  - 长 session 固定落在同一个 Region。
  - 多账号扩配额时，缓存不会跨账号共享，需要把 session 绑定到账号。
  - fallback 顺序：同模型换 Region 或账号 → 同家族其他模型 → 其他家族。每一级都按冷点规则记账。
- **并发扇出预热**：N 个共享前缀的 sub-agent，先发 1 个，等它开始返回再发其余的。否则 N 个请求都会各自写入缓存。
- 如果是自托管模型（vLLM、SGLang 等），这一层就是按前缀把请求打到同一副本的负载均衡（KV-cache-aware）。

## 5. 已排除：Bedrock Intelligent Prompt Routing

结论：太简单，不考虑。依据：

- 只能在同家族的两个模型之间路由（pairwise），文档列出的是 Nova Lite/Pro 和 Llama 3.x，没有本项目用的 Claude 5.5、GPT-6；
- 逐请求路由，没有 session 粘性，和 agent 场景的缓存需求冲突；
- 针对英文 chat 场景优化；
- 不能用应用自己的效果数据调整路由。

## 6. 初步建议

主干用 B + C。D 作为自家 agent 的升级通道。E 的 Region/账号亲和和扇出预热放进网关。

```
agent ─▶ 网关 ─ session 识别 ─ 已绑定且缓存热？──是──▶ 直通原模型（同区、同账号）
                                  │ 否（冷点）
                                  ▼
               决策：规则 → 分类器 →（LLM 判官）+ 切换代价模型
                                  ▼
       适配层：格式转换（同样输入必须产出同样字节）、补上或去掉 cache point、effort 字段 ─▶ Bedrock / 其他供应商
       ◀── usage（cacheRead/cacheWrite）写回账本，用于观测和以后训练决策器
```

### 6.1 网关的透传原则

- 格式转换必须确定：同样的输入产出同样的字节。字段顺序、工具顺序固定，不生成随机 id。
- 不按请求注入动态内容（时间戳、request id、路由备注）。非注入不可的内容放在最后一个 cache point 之后。
- 同一个 session × 模型内，不增删工具，也不改 system。
- 客户端没放 cache point 时，网关按模型能力补上：tools 末尾、system 末尾、最后一条消息上的滚动断点。模型不接受显式 cache point 时去掉。本项目实测 GPT-6 Luna 会拒绝 system 里的 cachePoint，它走的是隐式缓存。

### 6.2 决策器分层

1. **规则**（相当于 DSH 的 Policy 闸门）：调用角色、租户配置、上下文长度阈值、工具集签名。
2. **轻量分类器**：对首条任务描述做 embedding 或用小模型分类，耗时在毫秒级。
3. **LLM 判官**：只在 session 开始、规则判断不了时调用一次。它自己的 system prompt 也走缓存，和 assessor 一样。
4. **闭环**：记录每个 session 的模型、轮数、token（含 cacheRead/cacheWrite）、切换次数和原因、结果（测试是否通过、PR 是否合并、是否返工）。以后用这些数据调规则、训练分类器，或者做 bandit。

第一版只用规则路由，先把数据记全。

### 6.3 观测指标

- 每个 session 的成本；
- cache 命中率：cacheRead / 总输入；
- 切换次数，以及其中落在冷点上的比例；
- 首 token 延迟；
- 升级后的任务成功率。

## 7. 本项目现状：可以复用的部件

- **能力目录**：`packages/contracts/src/models.ts` 的 `MODEL_CATALOG` 记录了每个模型在各调用面上的差异，包括能否强制 toolChoice（`forceTool`）、是否接受显式 cachePoint（`promptCache`）、可用的 effort 档位。泛化成 router 的能力目录时，还要补上缓存语义：显式还是隐式、最小 token 数、TTL 选项。
- **角色路由和按任务固定**：`resolveModel(role, settings, workerType)` 按 eval/reply/worker 选模型；worker 类型在 Ticket 第一次分配时确定，之后不变。这已经是 A + C 的雏形。
- **缓存放置**：`packages/assess/src/model.ts` 的 `systemBlocks` 采用"稳定前缀 + cachePoint + Policy 段"的结构；`Usage` 已经收集 `cacheReadTokens` / `cacheWriteTokens`。
- **三种协议并存**：
  - assessor/replier 走 Converse；
  - Claude worker 设置了 `CLAUDE_CODE_USE_BEDROCK=1`，走 Anthropic Messages 格式（`worker/container/agent_core.py`）；
  - Codex worker 走 Bedrock 的 Responses API（`worker/container/codex-config.toml`）。

  所以如果只做 Converse，连本项目的 worker 都接不进来。
- **跨区 profile**：默认模型 id 都是 `global.` 前缀。根据 3.1 的服务器亲和规则，命中率可能受影响，可以先从 assessor 的 usage 指标里看看实际命中率。

## 8. 待定问题

1. **调用方**：只给自家 agent 用（Claude Agent SDK、Codex worker、assessor），还是也要接 Claude Code、Cursor 这类只能改 base URL 的第三方 agent？这决定能不能依赖 header、能不能用方案 D。
2. **协议和供应商**：本项目现有的三种协议、只后端接 Bedrock；只做 Anthropic Messages；还是多协议、多供应商（再接 OpenAI、DeepSeek 等直连）？
3. **形态**：决策核心写成库、网关只当外壳；进程内库；还是独立网关服务？独立服务要考虑鉴权和网络暴露面。
4. **首要目标**：降成本且质量不降、提质量、可用性（fallback 和扩配额），还是降延迟？

## 9. 待验证事项

- **effort 与缓存**：同一前缀、不同 effort，连续调用 Claude 5.5 和 GPT-6.x，对比 `cacheReadInputTokens`，确认改 effort 会不会让缓存失效。
- **跨区 profile 命中率**：`global.` profile 和单区 model id 的命中率对比。
- **1 小时 TTL**：哪些模型支持，写入怎么计价，适不适合"等人审批"这类长空闲。
- **扇出预热**：等第一个请求开始返回后再发其余请求，后面的请求是否都能命中。
- **A→B→A 回切**：切回原模型时，能不能部分命中切换点之前的前缀。
- **隐式缓存模型**（如 GPT-6 Luna）：命中行为如何，怎么观测。

## 10. 参考

- [Prompt caching for faster model inference](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html)：checkpoint 最小长度、TTL、服务器亲和、用量字段
- [Extended thinking（与 prompt caching）](https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-extended-thinking.html)：thinking 参数变化导致的缓存失效
- [Understanding intelligent prompt routing in Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-routing.html)：支持的模型与限制
- [prototype-router.zh-CN.md](prototype-router.zh-CN.md)：DSH router 的工作机制和本项目的移植
