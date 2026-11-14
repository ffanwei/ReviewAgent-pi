# 0081. 交付 module：把 run 之后的收尾从 `main` 里抽出来

**状态**：已接受（2026-11-14，用户决策：边界 = `runReview` 返回后的全收尾；三个可独立上线的切片；CLI 参数与输入输出逐字节不变）
**关联**：[ADR-0037](0037-mcp-progress-reporting.md)（MCP 上报零核心耦合）、[ADR-0045](0045-mcp-business-task-tools.md)（业务编排在 CLI）、[ADR-0051](0051-llm-call-retry-and-timeout.md)（分层重试）、[ADR-0053](0053-mcp-task-tool-fixed-settle-gap.md)（固定沉降）、[ADR-0061](0061-every-diff-file-reported-before-summary.md)（每文件必报）、[ADR-0065](0065-console-english-and-unified-tips.md)（统一 tips）、[ADR-0076](0076-request-timeline-for-model-calls.md)（请求时间线）
**范围**：本仓 pi 线 0081。只改 CLI 内部结构：把 `cli/main.ts` 的 run 后收尾搬进 `cli/delivery.ts`。不改 CLI 参数与含义、stdout 键集与字节、退出码、stderr 行序与文案、产物格式、MCP 调用序列；不进内核，不改核内/核外边界。

## Context

`runReviewCommand`（`cli/main.ts:174-1057`）已经从 CLI 胶水长成一条多阶段交付状态机。`runReview` 返回之后的收尾同时拥有：

- 变更文件覆盖补报（ADR-0061 / ADR-0068）；
- 中文 tips 的过滤、语义组装与落盘（ADR-0052 / ADR-0065）；
- 检查总结的生成、裁剪与 `saveReviewSummary`（ADR-0057）；
- 两段固定沉降与 `endTask`（ADR-0045 / ADR-0053）；
- mcp.json、session 索引、lifecycle、trace、MCP flush/close（ADR-0036 / ADR-0054 / ADR-0072-0074）；
- 两套 LLM 账本所需的耗时统计（ADR-0066）。

问题不在行数，而在**顺序不变量没有归属**：

1. `mrReviewResult × N → settle → saveReviewSummary → settle → endTask` 只靠语句顺序与注释维持；
2. 「tips 先落盘、summary 后发」「tips 落盘失败延后到 summary 之后」靠一个外层可变变量与代码位置；
3. `reportShardFindings` / `reportFilesWithoutTips` 是模块私有函数，唯一测试面是 4,196 行的 `cli/bin.process.test.ts`；
4. `mcp/no-core-coupling.test.ts:56-58` 把「MCP 只能在 CLI 组装」钉成了「只能出现在 `main.ts` 这个文件名」；
5. 最近 60 次提交里 30 次改到 `main.ts`。

## Decision

### 1. 边界：只切 run 之后的收尾

交付 module 的起点是 `runReview` 返回或抛出之后，终点是 stdout 文档产出。**不包含**：

- run 前的组装（配置装载、MCP 建连、`startTask`、准入校验）；
- 两条「跳过检视」路径（`MrDiffTooLargeError` / `NoReviewableFilesError`）；
- stdout 写出、退出码、两套运行账本、进程级 sink 重置。

跳过路径将来可作为同一 module 的第二个入口（`deliverSkip(reason)`），本次不搬。

### 2. 输入：显式 `DeliveryInput`，run 半边复用 `ReviewRunResult`

```ts
DeliveryInput {
  run: ReviewRunResult;             // 现有域契约
  identity: { caseId, taskId, cwd };
  paths: { tasksRoot };
  repoPath: string;
  coverageFiles: readonly string[]; // 过滤前变更文件全集
  model: { modelId, baseUrl };
  limits: { confidenceMin, severityMin };
  mcp: { reporter?, started, submittedFindingKeys, reportedFiles, flushTimeoutMs };
  tips: { semanticByMergeKey, uncoveredReasonByMergeKey, reportedFiles };
  timing: { startedAt };
  ports: { oneShot, clock, log, progress? };
}
```

不传 `args`、不传整个 `config`；`reporter === undefined` 即业务关闭，`started` 只表示 `startTask` 是否成功发出。

### 3. 输出与失败：返回值，不是副作用

```ts
DeliveryOutcome {
  stdoutDocument?: unknown;   // 由 main 写 stdout
  timings: { coverageMs, tipsMs, summaryMs, settleMs, totalMs };
  deferredFailure?: unknown;  // tips 落盘失败：跳过索引与 stdout，但仍完成 finalize
}
```

- 已知失败（tips 落盘）进返回值；未知异常照旧向上抛，但 module 内部 `finally` 仍完成 `endTask` / 产物 / `flush` / `close`。
- 产物文件（tips、cwd 副本、mcp.json、lifecycle、trace、session 索引）由 module 写；fs 用真实临时目录测试，不抽 port。
- stdout 与账本由 `main` 写；交付只返回耗时。

### 4. 顺序：线性步骤，不做通用状态机

```
announceInput → reportMissingFiles → finishRunLine → assembleTips
  → persistTips → publishSummary → writeSessionIndex
  → buildStdoutDocument → finalize
```

11 条顺序不变量照现状守住（含「tips 失败跳过索引与 stdout、但 finalize 仍执行」）。顺序由调用序列 + fake ports 的调用日志断言，不引入状态转移表。

### 5. ports：四加一个

- `reporter`：`reportFileResult` / `saveReviewSummary` / `endTask` / `flush` / `close`，返回形状保持现状（`{ ok, reason? }`）。
- `oneShot`：现有一次性调用包装（summary / 报文生成）。
- `clock`：`now()` + `sleep(ms)`；测试注入假时钟，替代 `PIAGENT_TEST_TASK_TOOL_SETTLE_MS` 这个只为测试存在的生产分支。
- `log`：`(line) => void`，替代 module 内直接写 `process.stderr`。
- `progress?`：`{ finish(summary: ProgressSummary) }`；未注入时走 `doneLine` 的 stderr 分支。
- 生产 adapter 与 fake adapter 成对存在——每个缝都是真缝。

### 6. 测试面迁移：replace, don't layer

- 新增 `cli/delivery.test.ts`：fake ports + 临时目录，断言调用序、产物、返回的 stdout 文档与 `deferredFailure`。
- `bin.process.test.ts` 保留字节 / 产物 / 退出码用例；**删除纯顺序用例**。
- `mcp/no-core-coupling.test.ts` 从「断言 `main.ts` 文件名」改为「遍历 `cli/**` 检查 import」。
- slice 3 追加 `pnpm test:replay`，用冻结 trace 再对一遍请求体与产物。

### 7. 三个可独立上线的切片

1. **纯计算**：过滤口径、覆盖集合、summary 输入组装搬进现有 module；不建 `delivery.ts`。
2. **module 主体**：建 `cli/delivery.ts`，覆盖步骤 1–6 + 8；`main` 仍做索引与 finalize；建立 fake-port 顺序测试。
3. **收尾**：索引与 finalize 搬进 module；`main` 只剩组装、stdout、账本与退出码。

每片门槛：`tsc --noEmit` + 全量 vitest + `bin.process.test.ts`。输入输出不变的定义：CLI 参数与含义、stdout 字节、退出码、stderr 行序与文案、产物文件字节、MCP 调用序列。

### 8. 实现形态：单文件（阈值放宽）

`cli/delivery.ts` 保持单文件（三片迁移完成时约 744 行，超过设计期约定的「约 600 行再拆目录」）。理由：`deliverReviewRun` 与 `finalizeDelivery` 共享同一组 ports、失败语义与顺序不变量；拆目录会把 interface 文档与类型分散到多个文件。若后续新增一个独立 adapter 或文件超过约 900 行，再拆成 `cli/delivery/`（`index` + steps + finalize）。

## Options（为什么不是别的）

- **只抽 MCP 交付（覆盖补报 + summary + 沉降）**：否。tips 落盘与 summary 的顺序耦合（同一份语义）、`endTask` 与 lifecycle 的顺序耦合；切在中间会把刚建立的不变量重新拆散。
- **交付 module 直接写 stdout 与两套账本**：否。stdout 是进程边界；账本是整次进程运行（含 run 阶段 `auditMs` / 片间 `reportMs`）的投影，不是交付语义。module 返回文档与耗时，`main` 保留唯一进程出口。
- **显式状态机**：否。这是固定管线，不是可变协议；状态机让「跳过索引/stdout」这类分支更难读。不变量写进 interface 文档与测试。
- **保留两套顺序断言（module + 进程）**：否。接口是测试面；双份顺序断言只会让实现变化时维护两次。
- **把跳过检视一起搬**：否。它在 `runReview` 边界上，与「run 完成后的交付」不是同一条缝；作为独立候选处理。

## Consequences

- **好**：顺序与失败策略有了唯一归属；交付可用 fake ports 单测，不必 spawn 进程；`main.ts` 回到「组装 + 进程出口」；后续加交付步骤只改一个 module；候选「跳过交付」「阶段账本」「MCP 生命周期」都变便宜。
- **代价 / 风险**：module 较大（约 500–700 行），一次性迁移容易引入顺序漂移——用三个切片 + 字节验收网控制；`no-core-coupling` 的收紧需要同步改测试；ADR-0053 里「沉降在 `main.ts`」的描述需要状态注记（不改 5 秒与「临时」决策）。
- **测试面**：`cli/delivery.test.ts` 锁顺序、失败语义与产物；`bin.process.test.ts` 锁字节与退出码；`pnpm test:replay` 锁请求体与冻结 trace；`mcp/no-core-coupling.test.ts` 锁层间纪律。
