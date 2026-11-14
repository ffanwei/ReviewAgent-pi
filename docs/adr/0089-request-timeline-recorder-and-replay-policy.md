# 0089. 请求时间线：recorder 拥有生命周期，重放策略抽成纯函数

**状态**：已接受（2026-11-14，用户决策：recorder + 两个 adapter；进程级 requestId；replay policy 独立单测；清理测试专用入口）
**关联**：[ADR-0076](0076-request-timeline-for-model-calls.md)（请求时间线）、[ADR-0077](0077-buffered-stream-replay.md)（流中断重放）、[ADR-0051](0051-llm-call-retry-and-timeout.md)（分层重试）
**范围**：本仓 pi 线 0089。只改请求时间线的**实现归属**：两种行的生命周期收进 `observability/request-timeline.ts`；重放预算/退避抽成纯函数；`requestId` 改进程级分配；删除测试专用 `runReviewTurn`。JSONL 行字段、脱敏白名单、文件布局、replay 行为与产物字节不变。

## Context

`request-timeline.ts` 只有行类型、脱敏、写盘与 sink；生命周期状态机在两个生产者各写一遍：

- `pi-client.ts` 的 `TimelineState` + `emitAttemptLine` + delta 计数 + `finishTimelineRequest`；
- `shared/one-shot-llm.ts` 的 `OneShotTimeline` + `finishOneShotTimeline`。

两者手拼同两种行。重放预算/退避（`withinReplayBudget` / `replayDelayMs`）内联在 `pi-client.ts`，唯一 replay 测试把 `budgetMs` 钉成 0，等于没测策略。`requestId` 在 agent 侧按 StreamFn 自增、one-shot 侧另有进程级计数器，同一 JSONL 内会撞号，只靠 `site` 区分。`runReviewTurn` 是测试专用的第二 provider 入口，没有 timeline / replay 覆盖。

## Decision

### 1. recorder 拥有两种行与状态机

`observability/request-timeline.ts` 新增：

```ts
createTimelineRecorder({ scope, model, baseUrl?, replay?, now?, requestId? })
  -> {
       requestId; bodyError;
       now(); beginAttempt(); endAttempt(probe, outcome);
       markStreamStarted(); markDelta(chars); markBytes(bytes);
       markBodyError(error); setUsage(usage);
       finish({ stopReason?, error? });   // 幂等
     }
```

- attempt / request 两种行只由 recorder 产出；`runId` 仍写 `null`，由 writer 的已知 runId 补齐（与现状一致）。
- headers 白名单、错误归因、`attempts: max(1, n)` 与现有字节口径一致。
- `bodyError` 暴露给重放判定；`markBytes` 累计响应体真实字节。

### 2. requestId：进程级唯一

`nextTimelineRequestId()` 模块级自增；同一次逻辑请求的所有 replay 共享同一个 `requestId`，靠 `replay` 区分。JSONL 的字段类型不变，号在文件内唯一。

### 3. 两个 producer 变 adapter

- `pi-client.ts`：每次逻辑请求分配一次 `requestId`；每次 replay 创建一个 recorder（同 id、不同 `replay`）。fetch 包裹 / body 观察 / 事件观察只调 recorder；删除 `TimelineState` 与手拼行。
- `one-shot-llm.ts`：一个 recorder 覆盖所有尝试与前后的 `response_format` 回退；`runId: null`、`replay: 0` 语义不变。

### 4. 重放策略抽成纯函数

`provider/stream-replay-policy.ts`：`withinReplayBudget` / `replayDelayMs`（不睡、不碰 IO）。`driveWithReplay` 只调用这两个函数，`sleep` 留在 driver。新增 `stream-replay-policy.test.ts`；`pi-client.test.ts` 的 replay 用例改为注入假时钟/预算。

### 5. 删除测试专用入口

`pi-client.ts` 的 `runReviewTurn` / `ReviewTurnInput` / `ReviewTurnOutcome` 删除；`pi-client.test.ts` 用一个本地 harness 直接走 `deepseekProvider().stream` + `captureWire`，测试与生产使用同一条序列化路径。

## Options（为什么不是别的）

- **只抽行构造 helper**：否。状态机仍两份，`finish` 幂等与 bodyError 仍各写一遍。
- **site 前缀字符串 requestId**：否。会改 JSONL 字段类型/字节；进程级计数器已足够唯一。
- **保留 `runReviewTurn` 并补 timeline/replay**：否。等于再造一条生产路径；测试 harness 更诚实。
- **把 replay 策略塞进 recorder**：否。观测与策略是两件事，纯函数才好单测。

## Consequences

- **好**：两种行与生命周期只有一个实现；重放预算/退避可隔离测试；同一 JSONL 的 requestId 唯一；测试不再跑生产没有的 provider 入口。
- **代价 / 风险**：recorder 的接口面比原来的两个私有状态机大；`one-shot` 的 `attempts` 现在统计所有尝试（含 `response_format` 回退），比旧实现更完整。
- **测试面**：`request-timeline-recorder.test.ts` 3 条（行字段/计数/白名单、错误与幂等、requestId 唯一）；`stream-replay-policy.test.ts` 2 条；现有 `request-timeline.test.ts` / `one-shot-timeline.test.ts` / `pi-client.test.ts` 原样通过；全量 vitest 1062 passed、`pnpm test:replay` 6/6。
