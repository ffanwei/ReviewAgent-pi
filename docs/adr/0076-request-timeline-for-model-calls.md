# 0076. 模型调用请求时间线：让「流中途断开」可定位

**状态**：已接受（2026-11-13，用户决策）
**关联**：ADR-0013（转录与意见导出；决策 10 拒绝「逐消息耗时仪器」）、ADR-0025（Review Runtime 显式下传，不做全局单例）、ADR-0035（pi 内核四包按 npm 依赖消费，不 fork 上游）、ADR-0045（一次性模型调用：片级报文 / 收尾总结）、ADR-0051（LLM 调用重试与请求建立超时）、ADR-0055（运行进度投影）、ADR-0073（生命周期会话留痕：one-shot 事件已带 `startedAt`）
**范围**：本仓 pi 线 0076。只加「模型调用失败现场」的留痕；六阶段骨架、wire 字节、审计 / `run.json` / 转录键集、退出码、重试语义全部不动。

## Context

2026-11-13 的一次真实运行以 `review turn failed: terminated` 结束：

```
[time] 审计明细 | P1 45.9s (91.5%) | P2 4.3s (8.5%)
review-pi: review turn failed: terminated
```

`terminated` 是 Node 内置 `fetch`（undici）在**响应体读一半时 socket 被对端关闭**抛出的
`TypeError`（`cause` 通常为 `SocketError: other side closed` / `UND_ERR_SOCKET`）。pi-ai 把它
折叠成 `stopReason: "error"` + `errorMessage`，本仓 loop 再把它升格为致命错误（退出码 1）。

排障时发现四层信息缺口，且彼此独立：

1. **失败不落任何产物**：`review-pass.ts` 的 `await runAgentReviewLoop(...)` 一抛错，审计、
   skill 转录、主转录、reviews 导出全部跳过——现场只剩 `review-pi.log` 里的一行错误。
2. **请求没有时间戳**：`audit.requests[]` 的 `WireRequest` 只有
   `model/effort/messages/tools/wireBody`；`PhaseRecord` 只有 `requestCount`。
3. **请求计时明确不进产物**：`contracts/progress.ts` 声明的纪律是「`durationMs` 只由发射点
   用 `Date.now()` 差值算出，只进显示、不落盘、不进任何指标」（ADR-0013 决策 10 的延续）。
   且非 TTY 下「请求进行中」的状态行直接返回 `undefined`——**失败的那次请求在日志里完全隐形**
   （`request.end` 只在 `shouldStopAfterTurn` 发，错误路径走不到）。
4. **根因被丢弃**：pi-ai 的 `normalizeProviderError` 只取 `error.message`（`error-body.js`），
   `TypeError: terminated` 的 `cause.code` 不进 `errorMessage`。

同时确认了两个与采集点有关的事实：

- pi-ai 的 `retryProviderRequest` 只包住 `chat.completions.create(...).withResponse()`，
  `onPayload` 在重试循环**外**只调一次、`onResponse` 只在**成功那次**调——所以
  「第几次尝试」只有包 `fetch` 才看得见；
- `AssistantMessageEventStream` 是 `EventStream<AssistantMessageEvent, AssistantMessage>`，
  `push` 是公开方法——所以「首 / 末增量时刻」可以在**不新建流、不消费、不转发**的前提下
  由覆盖实例 `push` 得到（不需要 fork 上游）。

## Decision

### 1. 新增「请求时间线」留痕，只观测

新增 `runs/**/request-timeline.jsonl`：一次 run 里每次模型调用的时间戳留痕。它**不是**
审计、不是运行记录、不是转录、不是运行日志——它是**失败现场**。

纪律：不改 wire 字节、不改退出码、不改重试语义、不通告 MCP 事件通道、不进 `run.json` /
`audit.json` / `.review-pi-session.json`，也**不被 `export` 读取**。它没有下游读取方，
因而不是契约产物。

### 2. 两个采集点，互补且不可替代

| 采集点 | 拿到 | 拿不到 |
|---|---|---|
| 包注入的 `fetch` | 尝试序号、HTTP status、响应头（白名单）、`cause.code` | 增量时刻 |
| 覆盖 `AssistantMessageEventStream.push` | `start`、首 / 末 `text_delta` / `thinking_delta` / `toolcall_delta`、停因 | `cause.code`、status |

**绝不替换异常对象**：fetch 包裹原样 rethrow。理由：openai SDK 的重试判定依赖错误对象的
`status` / `headers`，替换成新 `Error` 会让既有的「建连失败重试 3 次」静默失效。根因只写进
时间线，不拼进 `errorMessage`。

**绝不 tee body**：真字节数需要包 `response.body`，会动背压与流式行为。时间线记录
`deltaCount` / `deltaChars`（增量条数与字符数），不冒充字节。判定断流类型靠三段时长：
首字延迟、流持续、断流前空档。

### 3. 观察者 sink 是全局的，但不是「运行时值」

沿用 `setOneShotUsageSink` 的先例：`setRequestTimelineSink(sink)`。

ADR-0025 禁的是**运行时配置**走全局单例；观察者 sink 不参与决策，不在这一条的射程内。
代价与约束：分片目前串行（`executeShardedPasses` 的 `for` 循环内 `await`），每片开始时
重新绑定各自目录的文件；**若将来改并行分片，必须先改这里**（否则串写）。

### 4. 字段白名单与脱敏

一行一个 JSON 对象，`kind` ∈ `attempt` / `request`。headers 只留
`content-type` / `retry-after` / `x-should-retry` / `x-request-id` / `server`；错误只留
`name` / `code` / `errno` / `syscall` / `message`（截断 500 字符）与 `status`。
**绝不写入**：请求体、messages、工具入参、代码片段、apiKey、`authorization`、`set-cookie`、
`address` / `port` / `hostname`（内网拓扑）。

### 5. 失败仍不落 partial audit / transcript

「失败 = 零契约产物」的性质不变。时间线在 pass 开始时同步打开、逐行 `writeSync` 追加，
进程被 kill / 走 uncaught 兜底时已发出的行仍在磁盘上——这正是本 ADR 要的抗崩溃性质。
失败时由 `review-pass` 在 rethrow 前打一行人读摘要（`request-timeline:` 前缀），它同时被
`review-pi.log` 镜像。

### 6. 一次性调用的归因修正：只改标签，不改重试

`one-shot-llm.ts` 原来把 `JSON.parse(await response.text())` 包在同一个 `try` 里：2xx 之后
body 断掉会被误判成「不是合法 JSON」（确定性 malformed → 不重试），比没有日志更糟。
改为分开：解析失败才叫 malformed；读 body 抛错记为 `transport` + 真实原因，**`retryable`
仍为 `false`**（行为不变）。是否该重试留待后续 ADR。

### 7. 局部豁免 ADR-0013 决策 10 的「时钟不落盘」

本文件是本仓**唯一**允许把时钟写进产物的内核产物。该豁免仅限
`request-timeline.jsonl`，不外溢到审计 / 运行记录 / 进度事件。ADR-0073 已为 one-shot
生命周期事件开过同类先例（`OneShotLifecycleEvent.startedAt`），本次是把同一性质扩展到
Agent 回合。

## Options（为什么不是别的）

- **只扩 stderr / `review-pi.log`**：满足「当场看懂」，但机器不可读、无历史、无法回答
  「4.3s 是阶段窗口还是流的存活时间」。否。
- **失败时一次性写 `diagnostics.json`**：简单，但进程可能走 uncaught / `exitGracefully`
  兜底——「只在正常收尾写」的文件恰恰在最需要它的时候是空的。否（改为同步追加 JSONL）。
- **扩 `RunProgressEvent` 加时刻字段**：改契约，且事件会经 MCP 事件通道出站（有字段白名单），
  非 TTY 下还不输出。否。
- **失败也落 partial audit / transcript**：会引入「半份契约产物」，`export` / `session-index`
  等下游全部要开始处理残文件。否。
- **靠字符串猜错误类型**：`terminated` 这类 message 不稳定，且 ADR-0051 明令只看结构化信号。
  否（只读 `cause.code` / `status`）。
- **整回合重放失败回合**：重试策略是另一个决策（ADR-0051 决策 3 明确否掉），本次只做观测，
  不混在一起。

## Consequences

- **正**：流中断类失败的现场从「一行 `terminated`」变成「阶段 + 轮次 + 片 + 尝试序号 +
  首字延迟 + 流持续 + 断流前空档 + `cause.code`」；失败 run 也能事后复盘。
- **负 / 风险**：
  - 新增一种产物形态，需要后续维护者知道它「不是契约」；
  - 包 `fetch` 与覆盖 `push` 是新的拦截点，虽不改变语义，但升级 pi-ai 时要复查这两个假设；
  - 分片若改并行，全局 sink 会串写（已在决策 3 标注）。
- **中性**：正常 run 的时间线只有几十 KB（上限 4 MB / 20000 行）；`runId` 在首个请求完成前
  为 `null`（与 `run.end` 进度事件对 `runId?` 的既有口径一致）。

## 验收标准

1. **单测（采集）**：`reviewStreamFn` 注入 fake fetch → 产 1 条 `attempt` + 1 条 `request`，
   `request` 带 `firstDeltaAt` / `lastDeltaAt` / `deltaChars` / `usage`，`baseUrlHost` 只含 host
   （`pi-client.test.ts`）。
2. **单测（未装观测器零漂移）**：没有 sink 时完全不包 fetch、不产行。
3. **单测（脱敏）**：`authorization` / `set-cookie` / `x-api-key` 不出现在 headers 投影里；
   `address` / `hostname` 不出现在错误归因里（`observability/request-timeline.test.ts`）。
4. **单测（上限 / 追加 / close）**：行数触顶写 `truncated` 后停止；`mode:"a"` 保留已有行。
5. **单测（一次性调用归因）**：2xx 后读 body 断掉 → `reason` 含 `response body read failed`
   且**不含** `not valid JSON`，尝试次数为 1；真正的非法 JSON 仍归 malformed
   （`shared/one-shot-timeline.test.ts`）。
6. **端到端（真进程）**：
   - 成功 run 产 `runs/request-timeline.jsonl`，含 `site:"main"` 的 `request` 行；
   - 网关桩发一帧 SSE 后销毁 socket → exit 1、stderr 含 `request-timeline:`、
     时间线含 `attempt` 与 `error` 非空的 `request` 行、**不产** `run.json`
     （`cli/bin.process.test.ts`）。
