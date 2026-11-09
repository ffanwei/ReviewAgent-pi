# 0061. `mrReviewResult` 每文件必报：覆盖率优先，空列表兜底

**状态**：已接受（2026-11-09，用户决策）
**关联**：[ADR-0045](0045-mcp-business-task-tools.md)（业务 tool 与片级报文生成）、[ADR-0056](0056-mr-review-result-covers-files-without-tips.md)（无意见文件补空 tips）、[ADR-0057](0057-summary-covers-only-reported-findings.md)（总结只覆盖已上报意见）、[ADR-0058](0058-shard-report-split-retry.md)（报文生成二分重试）
**范围**：本仓 pi 线 0061。只改 `mrReviewResult` 的**覆盖完整性**：`saveReviewSummary` 之前，diff 里的**每个变更文件**都必须有一条 `mrReviewResult`。有意见带 tips，没有意见发 `reviewTips: []`；有 finding 但片级报文生成失败 / tips 全部被校验跳过的文件，也发 `reviewTips: []`。MCP 协议（每文件一条）、总结口径、退出码不动。

## Context

ADR-0056 把「无意见文件补空包」扩到了大部分场景，但保留了一条诚实原则：**有 finding 的文件如果报文生成失败，绝不发空包**——把「不知道」报成「没有问题」比漏报更糟。

实际运行中这条原则制造了新的信息空洞：

- 片级报文生成一次失败（超时 / 截断 / 非 JSON），该片所有有意见的文件都缺席 `mrReviewResult`；
- 平台侧只看到 `startTask` / `saveReviewSummary` / `endTask`，无法区分「这些文件没检视」与「检视了但客户端没上报」；
- 用户明确要求：**务必在 summary 前按 diff 文件完成所有变更文件的检视意见上报，就算没有也得上报一次空列表**。

用户进一步确认两个边界：

1. 有 finding 但片级报文生成失败的文件——**也发空包**（覆盖率优先）；
2. 整个 diff 解析不出任何文件——**沿用当前行为**：只打一行 stderr，不调用 `mrReviewResult`（没有文件可登记，空调用没有语义）。

## Decision

### 1. 每文件必报，以 `attempted` 集合为唯一排除面

`reportShardFindings` 在一次调用内维护 `attempted: Set<string>`（规范化路径）：

- `outcome.files` 里每个文件在上报**之前**就登记进 `attempted`（无论成功、失败）；
- 该片其余文件统一走 `reportFilesWithoutTips`，排除面 = `attempted`；
- `reportFilesWithoutTips` 处理一个规范化路径时，先过 `exclude` 判断、**再**登记进 `attempted`（两者通常是同一个 Set；顺序反了会把自己排除掉）。

由此保证：同一片内每个 diff 文件只发一条 `mrReviewResult`，且每个 diff 文件至少发一条。

### 2. 生成失败也发空包（推翻 ADR-0056 决策 2）

片级 `buildShardReport` 失败（`outcome.kind === "failed"`）时：

- stderr 留痕改为 `报文生成失败（…），有意见文件改报空列表（覆盖率优先，ADR-0061）`；
- 该片**所有文件**各发一条 `reviewTips: []`；
- 失败原因继续写入 `uncoveredReasonByMergeKey`（逐条 `tips 缺席该条：片级语义生成失败`）。

某文件的 finding 保留但 tips 全部被结构校验跳过时同理：该文件在 `outcome.files` 中缺席，最终由 `reportRemainingFiles()` 补空包。

### 3. 编排异常兜底

`catch` 分支在登记 uncovered 之后，best-effort 再调一次 `reportRemainingFiles()`；兜底自身失败只打一行 stderr。旁路纪律不变：上报失败永不改检视结果与退出码。

### 4. 零文件保持不调用

`input.files.length === 0`（空 diff / 预过滤后无残留）时只打一行：

`MCP mrReviewResult 无可上报文件（本片 diff 未解析出文件路径）`

不新增 `filePath: ""` 之类无意义调用。

### 5. 总结口径不变

空包**不登记** finding：`submittedFindingKeys` 只在 `reportFileResult` 成功且该条 tip 确实进入报文时写入。因此：

- 有 finding 但只发了空包的文件，其 finding 仍计入「未上报」，总结按 ADR-0057 输出固定「本次检视未向平台上报任何检视意见」；
- `reportedFiles` 会包含空包文件（平台确实收到了该文件的登记），但总结的 tips / findings 明细仍只覆盖真正上报的意见。

## Options（为什么不是别的）

- **保持 ADR-0056 诚实口径（有意见文件不发空包）**：否。用户明确选择覆盖率；远端缺 `mrReviewResult` 的排查成本高于「该文件暂未给出意见」的短时假阴性。
- **零文件也发 `filePath: ""` 的空调用**：否。没有文件路径的调用没有业务语义，服务端也无从归属；一行 stderr 足够。
- **把文件清单塞进 `saveReviewSummary` 兜底**：否。平台契约是 per-file `mrReviewResult`，换通道需要服务端配合，且会让「文件级结论」多真源。
- **按 finding 路径而不是 diff 文件清单补空包**：否。`input.files` 才是「本片 diff 实际触及的文件」；finding 可能指向 diff 外文件（模型误报），不能反过来缩小覆盖。

## Consequences

- **好**：`saveReviewSummary` 之前，平台对每个 diff 变更文件都有一次登记；`mcp.json` 里 `mrReviewResult` 条数 = diff 文件数（同一片内），缺失只剩「整片零文件」这一种可解释原因。
- **代价 / 风险**：报文生成失败时，有真实问题的文件会以「无意见」形态到达平台，构成**已知假阴性**；因此失败原因必须同时留在 stderr 与 `uncoveredReasonByMergeKey` 中，排障时以 `review-pi.log` / `mcp.json` 为准。
- **测试面**：`cli/bin.process.test.ts` 覆盖「s02 生成失败仍补空包（Q26b）」「generation failed 时 diff 文件仍上报（Q24a 两条）」「每文件只发一条」；ADR-0056 的决策 2 由本 ADR 取代。
