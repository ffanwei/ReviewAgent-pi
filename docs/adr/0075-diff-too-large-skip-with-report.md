# 0075. diff 超字节门禁时跳过检视，仍上报空意见与固定总结

**状态**：已接受（2026-11-11，随代码落地）
**关联**：ADR-0045（MCP 业务 tool 生命周期）、ADR-0061（summary 前每个改动文件必报）、ADR-0068（过滤文件也报空 tips）、ADR-0071（大 MR 阈值重标定）
**跨仓**：本 ADR 为本仓 pi 线序列 0075；引用 DSH 兄弟仓决策须写全限定语「DSH 线 ADR-XXXX」。

## Context

过滤后 diff 超过 `limits.boundary.maxDiffChars` 时，原实现（`assertDiffWithinCharLimit`）直接抛错，整条 `review` 命令 exit 1。对启用了 MCP 业务上报的场景，这意味着平台只收到 `startTask` + `endTask`（「有始有终」的空壳），中间没有任何 `mrReviewResult` / `saveReviewSummary`——平台无法区分「真的没发」与「检视被体积门禁拦下」。

## Decision

### 1. 超门禁 = 「跳过检视」，不是失败

`assertDiffWithinCharLimit` 抛结构化错误 `MrDiffTooLargeError`（`kind="diff-too-large"`，带 `diffLength`/`maxChars`），消息不变。`main.ts` 捕获后走**跳过**路径（exit **0**），而不是让命令失败。

### 2. 跳过路径仍保证「至少一次上报意见 + 一次总结」

CLI 捕获 `MrDiffTooLargeError` 后：

- 平台上报开启时，对**第一个改动文件**发一条空 `mrReviewResult`（`reviewTips: []`，复用 `reportFilesWithoutTips`）；
- 随即 `saveReviewSummary`，markdown 固定为 `# 检视总结\n\nDiff 超大，跳过检视。`（`DIFF_TOO_LARGE_SUMMARY_MARKDOWN`，不调用模型）；
- `finally` 里照旧发 `endTask`（有始有终）。

最终平台侧顺序：`startTask → mrReviewResult(空) → saveReviewSummary(跳过) → endTask`。

### 3. stdout 与退出码

- stdout = 单个 JSON `{ ok: true, caseId, skipped: "diff-too-large", findings: [] }`（无 runId——没发过模型请求，不存在 runId；无 auditPath/rounds/toolCalls）；
- 退出码 **0**（跳过是「受控完成」的一种，与 ADR-0068/0071 的降级口径一致）。

## Options（为什么不是别的）

- **保留 exit 1 硬失败**：平台只有 start/end 空壳，无法区分「没发」与「被拦」。否（本 ADR 的动机）。
- **报全部改动文件的空 tips**：volume 门时 diff 可能上千文件，逐文件 `mrReviewResult` 无必要——跳过的语义由总结承载，一条空意见足作「看过但跳过」的信号。否（取「一个文件」）。
- **总结仍调模型生成**：跳过场景无 findings 输入，调模型只会复述「没检视」。否（固定文案，零成本）。

## Consequences

- **正**：任何场景平台都收到完整的 `startTask → mrReviewResult → saveReviewSummary → endTask` 生命周期；「跳过」通过总结文案显式传达，不再隐没。
- **负 / 风险**：
  - 命中门禁的产品语义从「命令失败应该被上层脚本感知」变成「成功但 skipped」——依赖 exit 1 判「MR 太大需拆分」的脚本需改为读 stdout 的 `skipped` 键；
  - `diifLength` 是过滤后的字符数（`filterDiffForReview` 之后），与 CLI 入口的原始 diff 长度可能不等。
- **中性**：不改 `guardMrBoundary`（`maxFiles`/`maxDiffLines` 仍是告警降级）、不改分片（`maxShardChars` 仍照跑）。

## 验收标准

1. **单测**：`assertDiffWithinCharLimit` 超限抛 `MrDiffTooLargeError`（`kind`/`diffLength`/`maxChars` 正确）（`mr-input.test.ts`）。
2. **端到端（真机）**：`maxDiffChars` 极小 + MCP 开启 → exit 0、stdout `skipped:"diff-too-large"`、平台收到 `startTask → mrReviewResult(空) → saveReviewSummary("Diff 超大，跳过检视。") → endTask`。

## 实施记录（2026-11-11）

| 文件 | 内容 |
|---|---|
| `src/run/mr-input.ts` | `MrDiffTooLargeError` 结构化错误；`assertDiffWithinCharLimit` 改抛它 |
| `src/cli/review-summary.ts` | `DIFF_TOO_LARGE_SUMMARY_MARKDOWN` 固定文案 |
| `src/cli/main.ts` | 捕获 `MrDiffTooLargeError` → 跳过路径（空 `mrReviewResult` + 固定 `saveReviewSummary` + stdout `skipped` + exit 0） |
| 测试 | `mr-input.test.ts`（结构化错误断言） |