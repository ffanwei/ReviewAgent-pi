# 0057. 收尾总结按 `mrReviewResult` 实际收下的意见生成

**状态**：已接受（2026-11-07，用户决策）
**关联**：[ADR-0045](0045-mcp-business-task-tools.md)（业务 tool、片级报文与总结上报）、[ADR-0052](0052-tips-four-tier-severity-and-confidence-filter.md)（置信度过滤）、[ADR-0056](0056-mr-review-result-covers-files-without-tips.md)（无意见文件补空包）
**范围**：本仓 pi 线 0057。只改 `saveReviewSummary` 的**总结口径**：输入从「本地 findings 全量」改为「`mrReviewResult` 实际成功上报的意见集合」。tips 生成、报文组装、英文真源、`reviews_tips_zh.json`、退出码均不动。

## Context

`saveReviewSummary` 的 Markdown 总结一直以本地聚合 findings 为输入，而平台明细来自 `mrReviewResult`。两者覆盖面并不相同：

- 置信度过滤（ADR-0052）丢弃的低置信意见只在本地缺席中文 tips，仍会进入总结；
- 片级报文生成失败时，该片文件不发 `mrReviewResult`（ADR-0045 / ADR-0056），但其 findings 仍会进入总结；
- 逐条结构校验跳过（`code` 取不到、`category` 不可归一、终检失败）或单文件上报失败时，同样只在平台上缺席，总结却照写。

结果：平台收到一份说「共发现 N 条问题」的总结，`mrReviewResult` 明细里却只有 M 条（甚至 0 条）。评审人无法判断总结与明细哪个为准，也看不出差额去哪了。

用户决策（2026-11-07）：**总结必须以最终 `mrReviewResult` 提交的所有问题为准**。

## Decision

### 1. 已上报集合是唯一信源

片级上报编排在每条 `reportFileResult` **成功**后，把该文件报文里每条 tip 对应的 finding 以**合并键** `(file, line, title)` 登记进 run 级 `submittedFindingKeys`。判定成功只看 MCP 调用结果，不看本地是否生成了 tips：

- 报文组装成功、上报成功 → 登记；
- 片级生成失败（`kind:"failed"`）→ 不登记；
- 单条结构校验跳过（源码行取不到 / 路径非法 / 终检失败）→ 不登记；
- 单文件 `mrReviewResult` 传输失败 → 该文件全部条目都不登记；
- 置信度过滤在生成前就丢弃 → 天然不登记。

`submittedFindingKeys` 用合并键而不是 finding id：分片各自从 `F001…` 起编号，id 跨片必撞；合并键在 `mergeShardFindings` 前后稳定。

### 2. 总结输入按集合裁剪

`buildReviewSummary` 的输入改为：

- `findings` = 已上报集合（按呈现投影的 `findingLinks` 做 id 映射后，从投影版 findings 里取子集；未投影时 id 原样）；
- `tips` = 统一/回落 tips 文档中 `id` 属于该集合的条目（无法归属到 finding 的引擎自造条目一并剔除）；
- `reportedFiles` 语义不变（成功上报的文件）。

模型提示词与降级链不变（ADR-0045 决策 2）：有已上报意见 → 模型；模型失败 → 确定性模板；模板只陈述已上报集合的事实。

### 3. 零已上报意见的两种固定文案

复用「零意见不调模型」的既有口径，但区分两种零：

- **本地确实零 findings** → `# 检视总结\n\n本次检视未发现缺陷。`（原文案，不变）；
- **本地有 findings 但一条都没上报** → `# 检视总结\n\n本次检视未向平台上报任何检视意见。`

第二条是 ADR-0056 诚实原则的延伸：**绝不把「没上报」谎报成「未发现问题」**。同样不展开平台没收到的明细——总结必须与 `mrReviewResult` 的覆盖面一致。

### 4. 零静默

发生裁剪时 stderr 打一行：

`MCP … 检视总结只覆盖已上报的 N 条意见（M 条未上报，未计入）`

让「总结比本地 findings 少」这件事当场可见，而不是事后靠对数发现。

## Options（为什么不是别的）

- **继续用本地 findings 全量**：否。这正是「总结说 N 条、平台只有 M 条」的来源。
- **总结里补一句「另有 M 条未上报」**：否。总结是平台侧结论；把平台没有的条目写进去，等于让总结承担它没有的数据面。差额留在 stderr 与 `mcp.json` 里核对，不进平台结论。
- **用 `semanticByMergeKey` 当已上报集合**：否。它的覆盖面更宽（tips 允许 `code` 空串、路径非法），包含只进了 tips 却没进报文的条目。
- **上报失败也补空包/补条目让两边对齐**：否。已经在 ADR-0056 否决过——把「不知道」报成「没有问题」更糟。
- **零上报时仍调模型概括空集合**：否。没有输入可概括，固定文案更稳定，也省一次调用。

## Consequences

- **好**：总结条数与 `mrReviewResult` 明细严格一致；「总结说 N 条、平台只有 M 条」不再出现；差额有 stderr 行可追。
- **代价 / 风险**：总结会随上报成败波动（同一次检视，报告生成失败时总结会变小）；已上报集合为空时会发送「未向平台上报任何检视意见」而非缺陷摘要——这是有意的诚实降级。
- **测试面**：`cli/review-summary.test.ts` 覆盖两种零口径；`cli/bin.process.test.ts` 覆盖「分片部分失败 → 总结只含已上报片」「片级全灭 → 固定未上报文案」「全被置信度过滤 → 固定未上报文案」，并直接断言总结请求体不含未上报文件。
