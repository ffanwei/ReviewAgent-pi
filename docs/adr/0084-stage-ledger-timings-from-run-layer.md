# 0084. 阶段账本：时间事实由 run 层产出，分片路径不再重复计时

**状态**：已接受（2026-11-14，用户决策：run 层产出 timings；单遍字节不变；两片迁移）
**关联**：[ADR-0039](0039-sharded-review-for-large-mrs.md)（分片）、[ADR-0053](0053-mcp-task-tool-fixed-settle-gap.md)（片间沉降）、[ADR-0065](0065-console-english-and-unified-tips.md)（移除呈现投影行）、[ADR-0076](0076-request-timeline-for-model-calls.md)（请求时间线）、[ADR-0081](0081-delivery-module-boundary.md)（交付 timings）、[ADR-0083](0083-admission-as-data-and-deliver-skip.md)（准入/跳过）
**范围**：本仓 pi 线 0084。只修阶段账本（stderr 的 `[time]` 行）的**时间口径与产出位置**；不改检视语义、审计/产物/请求字节、进度事件契约，也不改单遍路径的输出。

## Context

`cli/main.ts` 从进度事件反推每个 phase 的结束：`endedAt = nextPhaseStart ?? auditEndedAt`；`auditEndedAt` 是全局最后一次模型请求结束；`auditMs = auditEndedAt - runStartedAt`。分片时这不是事实：

- 片间报文生成发生在两遍之间，没有 request 事件；片 1 的 P6 会把报文时间吞进去；
- `auditMs`（墙钟跨度）与 `reportMs`（片间报文）覆盖同一段，stages 百分比之和可超过 100%；
- `progress-render.test.ts` 仍在断言 ADR-0065 已移除的「呈现投影」行。

## Decision

### 1. run 层产出时间事实

`ReviewRunResult` additive 增加 `timings`：

```ts
timings?: {
  auditStartedAt: number;        // run 起点
  auditEndedAt: number;          // 最后一个模型请求结束
  interPassReportMs: number;     // 仅在「后面还有下一遍」时累计
  reportCallbacksMs: number;     // 全部片级回调耗时（含最后一片之后）
  phaseSpans: Array<{
    round; index; phase; shardIndex?; startedAt; endedAt;
  }>;
};
```

只进 CLI 内存账本与返回值；不落审计 / `run.json` / 转录。

### 2. 采集点在 `runPasses`，不改进度事件

执行器包装每遍的 `emit`：

- `phase` 事件 → 关闭上一段、开新段；
- `request`/`end` → 记录本遍最后请求结束；
- pass 返回后用 `lastRequestEndAt ?? pass.finishedAt` 关闭最后一段；
- 围绕 `withRequestTimelineAppend` 计时，得到本遍 `reportCallbacksMs`；后面还有 descriptor 时计入 `interPassReportMs`。

`ExecutedPass` 增加 `timing: PassTiming`；`runPasses` 增加可选 `now()` 注入缝（缺省 `Date.now`）。进度事件消费者看到的字节不变。

### 3. 单遍路径零漂移

CLI 仅在 `run.record.shards !== undefined` 时使用 `timings`；单遍继续走既有事件时钟（phase 无 `endedAt`，`auditMs` 与 `reportMs` 不变），stderr 逐字节相同。

### 4. 分片投影

- `StageClock.phaseSpans` 元素增加可选 `endedAt`；`buildStageBreakdown` 用 `span.endedAt ?? next?.start ?? auditEndedAt`。
- 分片 run：用 `timings.phaseSpans` 覆盖事件 span；`auditMs = max(0, auditEndedAt - auditStartedAt - interPassReportMs)`；`reportMs = reportCallbacksMs + delivery.coverageMs`（`onShardFindings` 的计时被覆盖，不再参与口径）。
- 行集、顺序、标签与百分比格式不变；只有分片的错误数字被修正。

### 5. 修正过期渲染测试

`progress-render.test.ts` 的「呈现投影」行改为当前真实的 0 值阶段（「中文 tips 组装/落盘」）。

## Options（为什么不是别的）

- **只在 CLI 打补丁（`auditMs -= reportMs`）**：否。仍靠事件顺序推断 P6；且会把窗口外的覆盖补报也扣掉。
- **扩展 `phase` 事件（`state` / `durationMs`）**：否。改事件契约与消费方字节，收益不如 run 层直接产出。
- **单遍也改用返回 timings**：否。本次是修分片缺陷；单遍没有错误，没必要改其诊断输出。
- **把 `buildStageBreakdown` 搬进渲染模块**：暂不做。先完成口径修复；是否搬家另立候选。

## Consequences

- **好**：分片账本不再重复计时；phase 结束由「知道 pass 边界」的层给出；阶段账本的数值可被 run 层测试直接验证；候选 6（请求时间线）也更容易接。
- **代价 / 风险**：`runPasses` 多了一层 emit 观察与计时；`ReviewRunResult` 增加可选字段；分片的 stderr 数字会变化（这是修复本身）。
- **测试面**：`review-run-timings.test.ts`（分片 span 有序/不重叠、`auditEndedAt`、`interPassReportMs > 0`；单遍 `interPassReportMs = 0` 且无片号）；`progress-render.test.ts` 修正过期行；分片进程测试新增「stages 百分比之和 ≤ 100%」；全量 vitest 1033 passed、`pnpm test:replay` 6/6。
