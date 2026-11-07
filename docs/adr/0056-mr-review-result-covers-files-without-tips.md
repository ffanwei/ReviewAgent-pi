# 0056. `mrReviewResult` 覆盖率优先：无意见文件一律补发空 tips

**状态**：已接受（2026-11-07，用户决策）
**关联**：[ADR-0045](0045-mcp-business-task-tools.md)（业务 tool 与片级报文生成）、[ADR-0052](0052-tips-four-tier-severity-and-confidence-filter.md)（置信度过滤）、[ADR-0054](0054-mcp-business-call-log.md)（`mcp.json` 留痕）
**范围**：本仓 pi 线 0056。只改 `mrReviewResult` 的**覆盖口径**：本片 diff 触及、但没有可发中文意见的文件，无论原因是「本来零 finding」「全部被置信度过滤」还是「同片其它文件报文生成失败」，都按文件发一次 `reviewTips: []`。有意见但报文生成失败 / tips 校验被跳过的文件仍**绝不**发空包。英文 findings、`reviews_tips_zh.json`、`saveReviewSummary` 口径不动。

## Context

ADR-0045 修订时把 `mrReviewResult` 的覆盖范围扩到「该片 diff 触及的全部文件」，但留了一个条件：**空 tips 上报只在该片报文生成成功时发生**——生成失败整片跳过。ADR-0052 又补了一条：全被置信度过滤的文件不报 `reviewTips: []`。

两条规则叠加后，远端会出现一个无法区分的信息空洞：

- 同一片里 `F1` 的报文生成失败，`F2` 明明零 finding，却因为「整片跳过」一条 `mrReviewResult` 都没有；
- 某个文件的 finding 全部低于 `limits.confidence.min`，平台既收不到该文件的 tips，也收不到「已检视、无意见」的登记；
- 结果：`startTask` / `saveReviewSummary` / `endTask` 都在 `mcp.json` 里，唯独 `mrReviewResult` 缺席——平台只能猜「文件没检视」还是「检视了没问题」。

用户决策（2026-11-07）：**任何文件没有检视意见时，都要返回一次该文件 + 空 `reviewTips` 列表**。漏报「已检视」比多说一句「无意见」代价更高。

## Decision

### 1. 无意见文件一律补发空 tips

`reportShardFindings` 的覆盖面改为「本片 diff 触及的文件，只要没有可发的 tips，就发一次 `reviewTips: []`」：

- **零 finding**：照旧逐文件发空包（行为不变）；
- **全部被置信度过滤**（`keptFindings.length === 0`）：不再把 finding 指向的文件排除出空包上报；本片所有文件都发空包；
- **部分被置信度过滤**：排除面从「所有 findings 指向的文件」收窄为「**保留**（未被过滤）的 findings 指向的文件」；只有过滤条目的文件按「无意见」补空包；
- **片级报文生成失败**：有意见的文件不发（见第 2 条），**无意见的文件仍逐文件发空包**。

### 2. 有意见的文件仍然绝不发空包

以下情况该文件**不**发 `reviewTips: []`——把「不知道」报成「没有问题」比漏一条更糟：

- 片级 `buildShardReport` 失败（模型无响应 / 非 JSON / 无 `tips` 数组）；
- 该文件的 finding 保留，但 tips 全部被结构校验跳过（`code` 取不到、`category` 无法归一、终检失败等）。

这两种情况保留既有 stderr 留痕（`跳过本片有意见文件（报文生成失败：…）` / 逐条 `跳过单条意见`），只是不再连带吞掉同片其它文件的空包。

### 3. 零静默

本片一个文件路径都没解析出来（空 diff / 预过滤后无残留）时，打一行：

`MCP mrReviewResult 无可上报文件（本片 diff 未解析出文件路径）`

避免事后把「本来就无文件可报」误判成调用链断了。

### 4. `mcp.json` 与判定口令

四个业务调用（含每文件一条 `mrReviewResult`）继续全部进 `runs/mcp.json`（ADR-0054）。排查时可直接数 `calls[].tool`：无意见 run 也应有 `startTask, mrReviewResult…, saveReviewSummary, endTask`。

## Options（为什么不是别的）

- **维持「生成失败整片跳过」**：否。英文 findings 已经定型，模板生成失败只影响部分文件的中文 tips；同片其它文件的「已检视」登记没有理由陪葬。
- **无意见也一律发空包（包括有意见但生成失败的文件）**：否。那会把真实问题的文件标成「无问题」，制造假阴性。
- **只改全过滤、不改生成失败**：否。两者造成的远端空洞相同，只修一半会留下同样难排查的缺口。
- **把 `files` 清单写进 `saveReviewSummary` 兜底**：否。平台契约是 per-file `mrReviewResult`，换通道需要服务端配合，且会让「文件级结论」多真源。
- **空包只在 `startTask` 成功后发**：否。`startTask` 失败与文件是否有意见无关；现有编排也已独立于 `startTaskSent`。

## Consequences

- **好**：平台对每个 diff 文件都能拿到「已检视」结论；「mcp.json 缺 mrReviewResult」不再有多种无法区分的原因；过滤 / 生成失败的诊断边界更清晰。
- **代价 / 风险**：无意见文件的上报条数会变多（每文件一条），服务端需承受与文件数成正比的调用量；有意见但报文失败的文件仍会缺席，远端仍要靠 stderr / 总结判断，不会因为本 ADR 变成「全绿」。
- **测试面**：`cli/bin.process.test.ts` 覆盖「零 finding 补空包」「全部被置信度过滤补空包」「报文生成失败时无意见文件仍补空包、有意见文件跳过」三条；ADR-0045 / ADR-0052 的相关子决策由本 ADR 取代。
