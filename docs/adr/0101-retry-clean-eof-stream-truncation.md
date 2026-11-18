# 0101. 干净 EOF 截断也纳入流重放

**状态**：已接受（2026-11-18，用户决策）
**关联**：[ADR-0077](0077-buffered-stream-replay.md)（缓冲重放；本 ADR 修订其决策 2 的触发条件与决策 3 的缺省值）、[ADR-0051](0051-llm-call-retry.md)（重试分层与「不靠字符串猜」纪律）、[ADR-0076](0076-request-timeline-for-model-calls.md)（请求时间线）、[ADR-0089](0089-request-timeline-recorder-and-replay-policy.md)（重放策略纯函数）
**范围**：本仓 pi 线 0101。扩展「流已开始后失败」的重放触发条件，并同步调整两个重放闸门的缺省值；闸门语义、wire 字节、六阶段骨架、审计 / `run.json` / 转录键集、退出码均不变。

## Context

2026-11-17 的线上失败：

```
review-pi: review turn failed: Stream ended without finish_reason
```

现场核对：`request-timeline.jsonl` 里 `error.rawStopReason` 为空，`bodyError` 也为空。原因是 **HTTP 响应体正常读完（干净 EOF），但 OpenAI-compatible 流始终没有发 `finish_reason`**——pi-ai 的 `openai-completions` 在 `hasFinishReason === false` 时抛错。

ADR-0077 的重放判定只认「响应体真的读失败」（`recorder.bodyError !== null`）：

```ts
const shouldReplay = failed && recorder.bodyError !== null && ...;
```

干净 EOF 的 `reader.read()` 返回 `{ done: true }`，不会记 `bodyError`，因此这类失败落在盲区：**流已开始、内容已产出、连接被正常收尾，但协议层缺完成信号**。它最常由网关 / 反代的读超时或空闲回收造成。

## Decision

### 1. 新增第二类可重放失败：干净 EOF 截断

`driveWithReplay` 的判定改为：

```ts
const shouldReplay =
  failed &&
  (recorder.bodyError !== null || isTruncatedStreamEnd(terminal, events)) &&
  replay + 1 < params.replay.attempts &&
  withinReplayBudget(startedAt, params.replay.budgetMs, params.now);
```

`isTruncatedStreamEnd` 只认**结构化信号**：

- 终止事件是 `error`，且 `reason !== "aborted"`；
- `terminal.error.rawStopReason === undefined`——没有任何 `finish_reason` 到达；
- 本次尝试收到过 `start` 事件——流已建立，排除建连失败 / HTTP 4xx 这类确定性请求错误。

**不匹配错误文案**（延续 ADR-0077 决策 2 的纪律）。

### 2. 保持排除项

- `content_filter` / `network_error`：走同一条 `error` 事件，但会落 `rawStopReason`，**不重放**；
- `aborted`：主动取消，不重放；
- `done`（含 `stop` / `length`）：不是失败，不重放；
- 没有 `start` 的失败：不重放。

### 3. 默认值同步调整（同日用户决策）

- `limits.retry.streamAttempts`：缺省 **13 → 3**（1 次首次 + 2 次重放）；
- `limits.retry.streamReplayBudgetMs`：缺省 **120 s → 600 s**。

理由：本次线上失败发生在约 287 s 的长流上，120 s 预算在第一次尝试结束时就已经耗尽，任何触发条件的放宽都不会真正重试；600 s 才能覆盖一次长流重试。次数收为 3 是为了把最坏成本压在 3 倍以内——长流场景下预算通常会先到，13 次只对秒级失败有意义，6 次同样是过配。

闸门语义不变：两个闸门先到者生效，已发出的尝试不被打断。最坏墙钟 ≈ 预算 + 一次尝试；以 287 s 的单次失败为例，3 次尝试约 14.4 分钟。

### 4. 安全性不变

ADR-0077 的缓冲语义保证：失败尝试的全部事件从未推给 `pi-agent-core`，tool call 从未分发，消息历史不被污染。干净 EOF 截断同样走这条路径，重放无工具副作用；失败尝试的 token 不计入 `usage`（既有成本低估口径不变）。

## Options（为什么不是别的）

- **匹配错误字符串 `Stream ended without finish_reason`**：上游文案会漂移，且违反「只认结构化信号」纪律；`rawStopReason` 已能区分。否。
- **所有 `error` 都重放**：会把 `content_filter` 这类确定性拦截也重试，浪费次数与预算。否。
- **把 `content_filter` 也重放**：确定性结果，重试只会得到同样的错误。否。
- **维持 13 次 / 120 s 默认值**：长流失败在预算检查前就已耗尽，等于本 ADR 对目标场景无效。否。
- **次数取 6**：长流场景预算先到，6 次用不满；短失败场景 3 次已足够，6 次只放大成本。否。
- **在 agent 循环层重试整个回合**：会重跑已执行的工具（skill 会话的 `bash` 有副作用），ADR-0077 已否决。否。

## Consequences

- **好**：网关干净 EOF 截断不再直接杀死整次 run；与脏断流共用同一条重放路径与时间线观测。
- **代价 / 风险**：
  - 如果截断是**确定性**的（例如反代固定在 300 s 收尾），重放只会把失败推迟一倍墙钟；
  - 长流失败后再重放会显著增加 token 成本（失败尝试不入 usage）；
  - 最坏成本 = 3 次尝试的 token（失败尝试不入 usage）；
  - 最坏墙钟 ≈ 600 s + 一次尝试（287 s 失败时约 14.4 分钟），调用方需确认外层 job 超时能容纳。
- **测试面**：`pi-client.test.ts` 新增四例——干净 EOF 重放成功（时间线 `replay` `[0,1]`、首条 `error.kind === "provider"`）、`content_filter` 不重放、无 `start` 的 4xx 不重放、`aborted` 不重放。包级 `tsc -p tsconfig.build.json` 通过。
