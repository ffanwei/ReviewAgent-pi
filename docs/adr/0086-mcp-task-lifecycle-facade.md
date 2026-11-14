# 0086. MCP 任务生命周期 facade：顺序与沉降收进 `mcp/task-lifecycle.ts`

**状态**：已接受（2026-11-14，用户决策：新建 facade 并接管 `startTask`；delivery 端口拆成 task/events；两片迁移）
**关联**：[ADR-0045](0045-mcp-business-task-tools.md)（四个业务 tool 与顺序契约）、[ADR-0050](0050-mcp-business-tool-retry-and-timeout.md)（业务调用重试）、[ADR-0053](0053-mcp-task-tool-fixed-settle-gap.md)（固定沉降）、[ADR-0081](0081-delivery-module-boundary.md)（交付 module）
**范围**：本仓 pi 线 0086。只改 MCP 业务生命周期的**实现位置**：顺序、两段沉降与 `endTask` 归属从 `cli/delivery.ts` / `cli/main.ts` 收进 `mcp/task-lifecycle.ts`。不改 tool 报文、重试、审计/产物字节、退出码、进度事件。

## Context

`McpReporter.task` 只暴露四个裸方法；「start → 片级结果 → 总结 → endTask」的顺序与两段固定沉降散在调用方：

- 第一段沉降在 `cli/delivery.ts` 的 `publishSummary`；
- 第二段与 `endTask` 在 `finalizeDelivery`；
- `startTaskSent` / `summaryCallCompleted` 由 `main.ts` 记账；
- 沉降常量与 env 解析在 `mcp/task-tools.ts`。

调用方必须重新推导顺序与等待；`flush()` 也不知道在途 task 调用。沉降是待优化清单 M-001 的临时措施，当前散落使删除需要改多处。

## Decision

### 1. 一个生命周期 facade

`src/mcp/task-lifecycle.ts`：

```ts
createTaskLifecycle({ task, taskId, settleMs, now, sleep, log })
  -> {
       readonly started: boolean;
       start(): Promise<TaskCallResult>;
       reportFile(args): Promise<TaskCallResult>;
       saveSummary(args, { settleBefore?: boolean }): Promise<SettledTaskResult>;
       finish(): Promise<SettledTaskResult>;   // 幂等
     }
```

- `start()` 成功才置 `started`。
- `saveSummary` 缺省先沉降（`mrReviewResult → saveReviewSummary`），再调 `saveReviewSummary`；跳过检视路径传 `settleBefore:false`（保持既有「不等直接发」）。
- `finish()`：`started && summaryCalled` 时沉降（`saveReviewSummary → endTask`），然后仅在 `started` 时补 `endTask`；第二次调用返回上次结果。
- `SettledTaskResult` 带 `waitedMs`，让调用方把等待计入阶段账本（ADR-0084）。
- 沉降行由 facade 在等待前打出，文案与既有 `waitTaskToolSettle` 一致。
- `TASK_TOOL_SETTLE_MS` / `TASK_TOOL_SETTLE_ENV` / `resolveTaskToolSettleMs` 移入本模块；`task-tools.ts` 只保留 re-export 兼容。

### 2. delivery 端口拆分

- `DeliveryTaskPort`：`started` / `reportFile` / `saveSummary` / `finish`。
- `DeliveryEventsPort`：`flush` / `close`（事件通道，与业务开关独立）。
- `DeliveryInput.mcp` 改为 `{ task?, events?, submittedFindingKeys, reportedFiles, flushTimeoutMs }`。
- `DeliveryFinalizeInput` 去掉 `started` / `summaryCalled` / `settleMs`；`DeliveryOutcome.summaryCalled` 删除。
- `deliverSkip` 用 `task.started` 门控，`saveSummary({settleBefore:false})`。
- `finalizeDelivery` 用 `task.finish()`；`endTask` 失败行仍由 delivery 打。

### 3. main 组合

建连后创建 facade 并 `start()`；传给 delivery 的是 `task`（facade）与 `events`（reporter 的 flush/close）。删除 `startTaskSent` / `summaryCallCompleted` / `taskToolSettleMs` 记账与两个 reporter adapter。

### 4. 两片迁移

1. facade + 单测；不改生产接线。
2. 接线 + 删除 delivery 内两段沉降/记账；更新 M-001 清单代码位置。

## Options（为什么不是别的）

- **挂到 `McpReporter` 上**：否。reporter 会变成有状态的生命周期对象；facade 只依赖四个 task 方法，更容易用 fake 测试。
- **只把常量/等待函数搬进 reporter 层**：否。顺序仍散在 delivery/main，M-001 的删除仍需多处改。
- **facade 也拥有 `flush`/`close`**：否。事件通道与业务生命周期是两条旁路，混在一起会让业务关闭时的事件收尾变复杂。
- **`saveSummary` 拆成两个方法**：否。只有两个调用点，显式 `settleBefore:false` 足够。

## Consequences

- **好**：顺序与两段沉降只有一个归属；删除 M-001 的 5 秒只需改 `task-lifecycle.ts` 一处；delivery/main 不再记账 `started` / `summaryCalled`；facade 可用 fake task + 假时钟单测。
- **代价 / 风险**：delivery 端口从一个大口拆成两个；`SettledTaskResult` 多一个 `waitedMs` 字段；跳过路径的「不沉降」需要显式 `settleBefore:false`。
- **测试面**：`mcp/task-lifecycle.test.ts` 6 条（正常顺序、未 start、跳过路径、总结失败、`settleMs=0`、幂等）；`cli/delivery.test.ts` 改为 fake task/events；现有 MCP 进程测试（顺序、startTask 失败、中文产物落盘失败、跳过检视）原样通过；全量 vitest 1047 passed、`pnpm test:replay` 6/6。
