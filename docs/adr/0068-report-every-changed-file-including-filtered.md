# 0068. 变更文件全覆盖上报：被预过滤剔除的文件也发空 `mrReviewResult`

**状态**：已接受（2026-11-10，用户决策：只要文件变更了，不管是否被检视、是否被过滤，都要上报）
**关联**：[ADR-0061](0061-every-diff-file-reported-before-summary.md)（每文件必报；本 ADR 把「文件全集」从过滤后改为过滤前）、[ADR-0045](0045-mcp-business-task-tools.md)（业务 tool 与顺序契约）、[ADR-0057](0057-summary-covers-only-reported-findings.md)（总结只覆盖已上报意见）、[ADR-0066](0066-task-total-llm-usage-line.md)（收尾账本）
**范围**：本仓 pi 线 0068。只改 MCP 上报的**文件全集口径**与收尾补报；过滤规则、被检视的输入集合、findings / tips、审计 `mrFilter`、stdout 与退出码全部不变。

## Context

ADR-0061 要求「`saveReviewSummary` 之前每个变更文件都要有一条 `mrReviewResult`」，但「变更文件」取的是**过滤后** diff 的文件块（`splitDiffIntoFileBlocks(filteredDiff)`）。

于是出现一个实测到的空洞：一个只改测试文件的 MR（`limits.testFiles.skip` 缺省 `true`）在预过滤后 diff 变成空串，文件清单为空，`reportShardFindings` 走「零文件不调用」分支：

- 平台只收到 `startTask` / `saveReviewSummary` / `endTask`，**一条 `mrReviewResult` 都没有**；
- `saveReviewSummary` 发的是固定文案「本次检视未发现缺陷。」（零 findings 不调模型）；
- 平台侧无法区分「这些文件检视过、没问题」与「这些文件从未检视」——而它们其实**是变更文件，只是被过滤规则排除了**。

用户口径：变更即事实，文件是否进入模型检视、是否命中断言过滤，都不影响它必须在平台上留下一次登记。

## Decision

### 1. 文件全集取**过滤前**的 diff

新增 `run/mr-input.ts#listChangedFilePaths(diff)`：复用 `splitDiffIntoFileBlocks` 的块边界，返回过滤前 diff 的全部文件路径（按出现顺序去重；删除文件退回旧侧路径；`path === ""` 的前置块不进入结果）。

CLI 在读到 MR 文本后立即计算一次，作为「变更文件全集」。

### 2. 收尾补报 = 全集 − 已上报

`runReview` 返回后、`saveReviewSummary` 之前，若业务 tool 开启：

```
剩下的 = 变更文件全集 − reportedFiles（规范化后）
对每个剩下文件调用 mrReviewResult(taskId, filePath, reviewTips: [])
```

- **不重复**：已被片级回调上报过的文件（有 tips 或空 tips）都在 `reportedFiles` 里，不再补；
- **不改顺序契约**：补报仍是 `mrReviewResult`，整体仍严格早于 `saveReviewSummary`；
- **旁路**：补报失败只打一行 stderr（`MCP mrReviewResult 补报变更文件失败（…）`），不改检视结果与退出码；
- **计时**：计入 `[time]` 的「报文生成+上报」阶段；
- **可见**：成功补报时打一行 `MCP mrReviewResult 已补报 N 个变更文件 / 0 条意见（预过滤剔除或未进入检视）`。

### 3. 仍然不发无路径的空调用

`listChangedFilePaths` 返回空（diff 完全没有可解析块）时，收尾补报直接跳过——没有 `filePath` 的调用没有业务语义。ADR-0061 决策 4 在这一类输入上继续有效；它不再覆盖「有变更文件但全被过滤」的情形。

### 4. 其它口径不动

- 过滤规则与 `mrFilter` 审计不变（被过滤文件仍是「未进入检视」）；
- `reviews_en.json` / stdout / 退出码不变；
- 空包**不登记** finding，总结口径（ADR-0057）不变：全 test 的 MR 总结仍是「未发现缺陷」（现在每个文件都有登记，平台至少能看出它们被处理过）。

## Consequences

- 平台对每个变更文件都有登记：被过滤 / 被检视、有意见 / 无意见，都至少一条 `mrReviewResult`；
- 全 test / 全 lockfile 的 MR 不再出现「零 `mrReviewResult` + 总结说没问题」的静默组合；
- 成本：补报不调用模型，每个被过滤文件只多一次 MCP 调用；
- 仍存在的信息缺失：平台只知道「该文件被登记过」，不知道它「因过滤未检视」——MCP 契约没有这个字段。需要在本地看 stderr / 审计 `mrFilter` 区分；若平台将来要这个维度，应作为契约扩展另立 ADR；
- 因为补报按「全集 − 已上报」计算，分片运行时被过滤文件也只补一次（过滤后文件不会被分进任何片）。
