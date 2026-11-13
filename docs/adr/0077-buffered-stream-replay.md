# 0077. 流中断重放：缓冲一次响应，失败则在本层重发

**状态**：已接受（2026-11-13，用户决策）
**关联**：ADR-0051（LLM 调用重试与请求建立超时——本 ADR **局部替代**其决策 3 的「流中断不重试」）、ADR-0076（请求时间线：本次观测的直接产物）、ADR-0035（pi 内核四包按 npm 依赖消费，不 fork 上游）、ADR-0025（Review Runtime 显式下传）、ADR-0048（离线回放 lane）
**范围**：本仓 pi 线 0077。只改「流已开始后断开」的处置；wire 字节、六阶段骨架、审计 / `run.json` / 转录键集、退出码均不变。

## Context

2026-11-13 的线上失败：

```
[time] 审计明细 | P1 45.9s (91.5%) | P2 4.3s (8.5%)
review-pi: review turn failed: terminated
```

ADR-0076 先解决了「看不见」的问题：现在能拿到阶段、尝试序号、首/末增量时刻、
断流前空档与真实 `cause.code`。但**失败仍然杀死整次 run**——pi-ai 的
`retryProviderRequest` 只包住 `chat.completions.create(...).withResponse()`
（请求建立），拿到 200 之后流正文断开只会折叠成 `stopReason: "error"`，
不重试；`pi-agent-core` 见到 `stopReason: "error"` 直接结束 agent 循环；
本仓 loop 再把它升格为致命错误。

ADR-0051 决策 3 当时明确否掉了「流中断重试」与「整回合重放」，理由是
「重放会重复工具副作用并破坏 agent 消息状态」。这条否定的前提是：
重放意味着**从回合边界重来**。而「响应尚未交付」是另一回事——如果失败响应
从未被消费端看到，重放就与副作用无关。

## Decision

### 1. 在 `streamFn` 层缓冲重放，不做回合重放

`reviewStreamFn` 返回的流在「总尝试次数 > 1」时改为：

1. 本次尝试的事件**只进本地缓冲**，不转发给消费者；
2. 终止事件为 `error` 且失败可归因于「响应体读取」→ 丢弃缓冲，重发同一请求；
3. 成功（或重放耗尽）→ 把该次缓冲的事件原样推给消费者。

由此，失败响应里的 `toolCall` **从未被分发** → `pi-agent-core` 从未执行它 →
重放按构造无副作用。这绕开了 ADR-0051 拒绝回合重放的全部三条理由
（重复工具副作用、污染消息历史、重复计费——最后一条见「负后果」）。

**总尝试次数 = 1 时保持今天的真流式路径**（不缓冲），保证回放 lane 与
显式关闭重放的配置零漂移。

### 2. 触发条件只看结构化信号

重放条件（全部成立）：

- 终止事件是 `error`（不是 `done`）；
- `reason !== "aborted"`（我们自己掐的不重放：Skill 20 min 上限 / 用户中断）；
- **响应体确实读失败了**（body 包装捕获到异常）。

第三条是关键：`content_filter` 这类确定性 provider 拦截**走同一条 `error` 事件**，
但它的 body 是正常读完的。之前无法区分（`await fetch` 在响应头到达时就 resolve，
流中断不会 reject 它），所以本 ADR 顺带把 `response.body` 包了一层
（`getReader()` + `pull`，背压原样保留），拿到真实的 `cause` 与字节数。
**这是对 ADR-0076 决策 2「绝不 tee body」的修订。**

不重放 `stopReason: "length"`（截断是受控完成、退出码 0，不是失败）。

### 3. 次数与预算：两个闸门，先到者生效

新增配置（`limits.retry`）：

```jsonc
"streamAttempts": 13,          // 总尝试次数（含首次）：1 = 关闭重放
"streamReplayBudgetMs": 120000 // 重放总墙钟预算（毫秒，含退避）；0 = 不设上限
```

- **次数口径与仓库一致**：`streamAttempts` 是总尝试次数（含首次），
  `13` = 1 次首次 + 12 次重放。它与 `reviewTurnAttempts` 是**两个轴**：
  后者管「请求建立」，前者管「流已开始后断开」。
- **预算只用于判断「要不要再发起一次」**，已发出的尝试不会被打断：
  上界 = `streamReplayBudgetMs` + 单次尝试时长（软上限）。
  单次尝试本来就没有响应体超时（`reviewTurnMs` 只管建连），该性质未被本 ADR 改变。
- 退避复用 `limits.retry.baseDelayMs` / `maxDelayMs`（指数、封顶）。
  12 次退避合计约 85.5 s，因此「13 次」只在**快速失败**（单次 < ~3 s）时全额生效；
  几十秒级的慢断流实际只会跑 2–3 次，其余被预算挡住——这正是两个闸门的意义。

### 4. 重放不重复审计与进度

`onPayload` / `onResponse` 只在**首次尝试**触发，重放时从 provider options 中摘除。
否则审计 `requests[]` 会多出字节相同的重复请求、`requestId` 与进度计数会漂移。
`requestProgress.start()` 因此只发生一次，`end()` 覆盖全部重放的墙钟。

### 5. 时间线加 `replay` 与真实字节数

每次重放各写一条 `request` 行（`replay: 0/1/2…`，共享 `requestId`）与各自的
`attempt` 行，并新增 `bytes`（body 实际字节数）。这样「两次都断在同一秒数」与
「第二次好了」可分开看。

### 6. 一次性调用的归类修正

`one-shot-llm.ts` 里「2xx 之后读 body 抛错」从 `retryable: false` 改为
`retryable: true`（传输类）。这是对 ADR-0076 决策 6 的修订：当时只改标签是为了
不把行为变更混进「只观测」那次提交；现在行为变更正是本 ADR 的主题。

### 7. 回放 lane 固定单次尝试

`scripts/offline-replay/lib/lane.mjs` 显式写 `streamAttempts: 1`：回放按请求哈希
命中同一响应，重放只会把同一失败再放一遍并放大请求计数（同 ADR-0051 决策 5）。

## Options（为什么不是别的）

- **回合级重放（修剪 `agent.state.messages` 后重发 prompt）**：保留真流式，但
  整 prompt 重放会重跑已执行的工具（主会话只读、成本可接受，Skill 会话的
  `skill_bash` 有副作用）；只修剪最后一条消息又要补一条续写指令、改 wire 字节。
  否。
- **在 pi-ai 的 `retryProviderRequest` 层重试**：不 fork 上游（ADR-0035），且
  该层拿不到「响应是否已交付」的信息。否。
- **靠 `content_filter` 文案 deny-list 代替 body 观察**：ADR-0051 明令不靠字符串
  猜；文案集合随上游升级漂移。否（改为 body 观察）。
- **硬上限（预算到点 abort 在飞请求）**：会掐掉「马上要成功」的响应，且产生
  `aborted` 噪声、与「主动取消」语义混淆。暂不做（留作后续，如果观测到单次
  尝试确实能飘很久）。
- **失败尝试的 usage 也入账**：会让「成本 / findings」失去意义，且与审计 /
  `run.json` 的 usage 口径分叉。否。

## Consequences

- **正**：一次流抖动不再杀死整次 run；失败现场与重放次数都可事后复盘。
- **负 / 风险**：
  - **失去 token 级增量分发**（本产品当前没有 `.subscribe(` / `message_update`
    消费者，故不可见；将来若有人订阅，必须重新评估）；
  - **内存**：单次尝试的事件全量缓冲（约等于响应文本大小）；
  - **成本低估**：失败尝试的 token 不计入 `usage`，低估量 = 重放次数 × 单次 token；
  - **墙钟**：最坏 = 预算 + 一次尝试；`streamAttempts` 调大不改变这一点；
  - 包 `response.body` 与摘除 provider 回调都是新的拦截点，升级 pi-ai 时须复查。
- **中性**：`streamAttempts: 1` 完全等于今天的行为（真流式、无缓冲、无重放）。

## 验收标准

1. **单测（重放成功）**：第一次响应体报 `UND_ERR_SOCKET`、第二次正常 →
   `result()` 为成功消息；时间线 `request` 行 `replay` 为 `[0, 1]`，
   第 0 条 `error.kind === "transport"`；`onPayload` 只调用 **1** 次。
2. **单测（确定性拦截不重放）**：`content_filter`（body 正常读完）→ 不重放。
3. **单测（一次性调用）**：2xx 后读 body 断掉 → 重试至 `oneShotAttempts` 上限，
   `reason` 含 `response body read failed` 且不含 `not valid JSON`。
4. **端到端（真进程）**：网关桩第一次流请求发一帧后销毁 socket、第二次正常 →
   `exit 0`、findings 正常、时间线有 `replay 0`（error，`bytes > 0`）与
   `replay 1`（`stopReason: "stop"`）、审计 `requests[]` 仍为 6 条（不重复）。
5. **端到端（配置 `streamAttempts: 1`）**：持续断流 → `exit 1`、
   时间线只留一条 `replay 0` 的失败现场。
6. **单元测试口径**：注入一次流错误的用例显式固定 `streamAttempts: 1`
   （否则会真的重放十几轮）。
