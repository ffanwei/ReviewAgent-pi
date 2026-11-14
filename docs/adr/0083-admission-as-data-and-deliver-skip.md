# 0083. 准入结果化：预期内跳过返回数据，交付收口到 `deliverSkip`

**状态**：已接受（2026-11-14，用户决策：新入口 + 旧 API 委托；`deliverSkip` 进交付 module；两片迁移；字节不变）
**关联**：[ADR-0075](0075-diff-too-large-skip-with-report.md)（diff 超字节门禁跳过）、[ADR-0078](0078-review-scope-include-exclude-regex.md)（过滤后无文件跳过）、[ADR-0081](0081-delivery-module-boundary.md)（交付 module；本 ADR 是其预留的第二个入口）
**范围**：本仓 pi 线 0083。只改 CLI 与 run 入口的**准入结果表示**与跳过交付结构；不改 CLI 参数、stdout 字节、退出码、stderr 文案、审计/产物、MCP 调用序列，也不改公开 `runReview` 的抛错契约。

## Context

两条「预期内跳过」用异常建模：

- `MrDiffTooLargeError`（ADR-0075，diff 超 `limits.boundary.maxDiffChars`）；
- `NoReviewableFilesError`（ADR-0078，过滤后没有可检视文件块）。

`cli/main.ts` 的 `catch` 里有两段近乎逐行相同的处理：补首个文件的空 `mrReviewResult`、发固定总结、写 `{ok:true, skipped, findings:[]}`、`return 0`。结构化字段（`diffLength` / `maxChars` / `droppedFiles` / `droppedChars`）生产侧只读 `.message`；第三个跳过原因会再克隆一份分支。跳过发生在 `run.start` 之前，进度消费者看不到结束原因（本次保持）。

## Decision

### 1. `ReviewSkip` / `ReviewRunOutcome`：预期结果进入类型

```ts
export type ReviewSkip =
  | { reason: "diff-too-large"; message: string; diffLength: number; maxChars: number }
  | { reason: "no-reviewable-files"; message: string; droppedFiles: number; droppedChars: number };

export type ReviewRunOutcome =
  | { kind: "reviewed"; result: ReviewRunResult }
  | { kind: "skipped"; skip: ReviewSkip };
```

`ReviewSkip` 只含数据；异常类退回成旧 API 的兼容适配器。

### 2. 入口切分：`prepareReview` + `executeReview` + 两个出口

- `prepareReview(input)`：解析缺省值、过滤、体积门、边界、分片计划；预期内跳过**返回** `{kind:"skipped"}`，不抛。
- `executeReview(input, prepared)`：发 `run.start` / `run.end`，装配 context 并执行 pass。
- `runReviewOutcome(input)`：新入口，CLI 使用；返回 `ReviewRunOutcome`。
- `runReview(input)`：保留公开契约；内部调 outcome，skipped 时按 `ReviewSkip` 重建原错误并抛出——现有测试与外部消费方零改动。
-「超体积」判定单源化为 `mr-input.ts` 的 `diffTooLargeError()`；`assertDiffWithinCharLimit()` 仍保留为抛错包装。

### 3. CLI：catch 只留真正的异常

`main.ts` 改为「先拿 outcome，再分支」：catch 只做 `progress.dispose()` + `auditMs` 留痕 + rethrow；`skipped` 走 `deliverSkip` 后写 stdout、`return 0`。

### 4. `deliverSkip` 进交付 module（ADR-0081 预留入口）

`cli/delivery.ts` 新增：

```ts
deliverSkip({ identity, skip, firstFile?, reporter?, started, reportedFiles, log })
  -> { stdoutDocument, summaryCalled }
```

顺序与原两段 catch 一致：按 `reason` 选固定总结 → 有 reporter 且 `started` 时补首个文件空 `mrReviewResult`、发 `saveReviewSummary`（失败只留痕）→ 返回 `renderJsonDocument({ok:true, caseId, skipped: reason, findings: []})`。不写 audit / run.json，不发进度事件。`summaryCalled` 回传给 main 的 `summaryCallCompleted`，`finally` 的 `finalizeDelivery` 照旧发 `endTask` 与第二段沉降。

### 5. 公开面 additive

`src/index.ts` 增加 `runReviewOutcome` / `ReviewRunOutcome` / `ReviewSkip`；`runReview` / `ReviewRunResult` 原样保留。

## Options（为什么不是别的）

- **直接改 `runReview` 返回联合**：否。破坏公开 API 与所有现有测试/外部消费方；等新入口稳定后再单独决策。
- **只抽 CLI 分类器、保留异常**：否。预期结果仍在控制流里，第三个原因仍要克隆分支。
- **新增 `admitMr()` 前置预检**：否。会把过滤/体积门算两遍，或需要把过滤结果回传给 `runReview`，改动面大于收益。
- **跳过路径补发 `run.end`**：否。改变进度事件与 stderr 字节契约，不是本候选目标。
- **`deliverSkip` 直接写 stdout**：否。与 `deliverReviewRun` 的「返回文档、main 写」纪律不一致。

## Consequences

- **好**：预期内跳过进入类型；main 的两段重复分支收成一个；第三个跳过原因只加一个 `reason` 与一段固定文案；跳过交付可用 fake reporter 单测。
- **代价 / 风险**：`runReview` 的兼容适配器需要重建异常（消息由字段派生，需与构造器保持同源）；`prepareReview` 与 `executeReview` 的切分点必须保住「跳过发生在 `run.start` 之前」。
- **测试面**：`review-admission.test.ts` 4 条（两种跳过载荷、旧入口抛错、正常路径）；`delivery.test.ts` 追加 4 条 `deliverSkip`；现有 ADR-0075 / ADR-0078 进程测试、全量 vitest、`pnpm test:replay` 6/6 锁字节。
