# 0117. 全仓检视的 MCP 业务上报：独立四工具，复用同一 server

**状态**：已接受（2026-11-25）
**关联**：[ADR-0037](0037-mcp-progress-reporting.md)（事件面）、[ADR-0045](0045-mcp-business-task-tools.md)（PR 业务面）、[ADR-0053](0053-mcp-task-tool-fixed-settle-gap.md)（固定沉降）、[ADR-0086](0086-mcp-task-lifecycle-facade.md)（生命周期 facade）、[ADR-0090](0090-chinese-native-review.md)（`Finding.tips`）
**范围**：只加全仓检视（`repo-review`）的 MCP 业务调用；PR 的四个 tool、事件通道、检视内核均不改。

## Context

全仓检视（`repo-review`）此前完全不接 MCP：没有任务开始 / 结束，平台收不到
按文件的结果。平台为全仓检视定义了另一套业务 tool，名字与 PR 不同，但
`fullRepoReportReviewResult` 的报文与 PR 的 `mrReviewResult` 同形；两者部署在
同一个 MCP server 上，应复用现有 `mcp.report.server` 配置与连接能力。

全仓的执行单元是「组」（一批文件），组完成后即可上报；没有 PR 的
`saveReviewSummary` 总结步骤。

## Decision

1. **独立四工具，硬编码常量**（`MCP_FULL_REPO_TOOL_NAMES`）：
   - `fullRepoStartTask` / `fullRepoEndTask`：`{ taskId }`；
   - `fullRepoReportReviewResult`：`{ taskId, filePath, reviewTips[] }`，与
     `mrReviewResult` 同形，复用 `buildShardReport` / `readCodeLines` /
     `tip-format`；
   - `fullRepoFilerCurrentTips`：`{ taskId, invalidatedTips: [] }`；v1 不处理
     历史意见失效逻辑，恒传空数组。
2. **顺序**：`fullRepoStartTask` → `fullRepoReportReviewResult`（每组完成后
   多次）→ `fullRepoFilerCurrentTips` → `fullRepoEndTask`。无总结调用。
3. **每个 reviewed 组上报实际送检的全部文件**：有意见带 tips，无意见补
   `reviewTips: []`；失败 / 跳过 / 预算停止的组不上报（不把「没看」冒充成
   「没问题」）。`--resume` 跳过的已完成组不重报。
4. **开关与配置**：沿用 `mcp.report.task`（缺省 true）与同一 `mcp.report.server`；
   不新增配置键。MCP 关闭时零建连、零调用。
5. **`--taskId`**：repo-review 新增该旗标；MCP 打开时缺失即 fail fast，纯本地
   运行可缺席。
6. **分层**：`repo-spike/` 不 import `mcp/**`；`runRepoSpike` 只暴露
   `onGroupReviewed(batch)` 回调，由 CLI 组装报文并发送。回调抛错只留一行，
   绝不影响检视结果与退出码。
7. **沉降**：沿用 ADR-0053 的两段 5s（最后一批上报 → currentTips →
   endTask），仅进程测试环境变量可压到 0。

## Consequences

- 好：全仓任务在平台侧有开始 / 结束与增量文件结果；PR 路径零变化；上报逻辑
  与 PR 共用同一套校验、重试与 Markdown 断段，不产生第二份报文实现。
- 代价：全仓按文件上报，1600 文件的仓库约多 1600 次 `tools/call`（串行、
  每个组内顺序发送）；v1 不做批量 tool、不做重报去重、不写 `mcp.json`。
- 已知边界：崩溃发生在「组已 done、上报未完成」之间时，续跑不会补报该批；
  平台侧若需要严格至少一次，应在 `job.json` 增加 `reported` 标记。
- 测试：`mcp/full-repo-lifecycle.test.ts`（顺序 / 空数组 / 沉降 / 幂等）、
  `mcp/report.test.ts`（tool 名与平铺参数）、`cli/full-repo-report.test.ts`
  （按文件 tips / 空包 / 失败留痕）、`repo-spike/run.test.ts`（回调时点 /
  抛错不影响 / resume 不重报）。
