# R-10 · 全仓检视 MCP 上报

- Status: DOING（实现、单测与 stub 端到端完成；待真实 server 联调）
- Branch: `exp-repo-review`
- Created: 2026-11-25

## 问题

`repo-review` 此前完全不接 MCP：平台收不到全仓任务开始 / 结束与按文件的检视意见。
平台为全仓检视提供了独立的一套业务 tool，与 PR 的四工具并列、部署在同一 MCP server。

## 契约（服务端）

| 顺序 | tool | 参数 |
|---|---|---|
| 1 | `fullRepoStartTask` | `{ taskId }` |
| 2 | `fullRepoReportReviewResult` | `{ taskId, filePath, reviewTips[] }`，与 `mrReviewResult` 同形 |
| 3 | `fullRepoFilerCurrentTips` | `{ taskId, invalidatedTips: [] }`；v1 不处理失效逻辑 |
| 4 | `fullRepoEndTask` | `{ taskId }` |

## 实现

- `mcp/task-tools.ts`：`MCP_FULL_REPO_TOOL_NAMES`、`FullRepoCurrentTipsArgs`、`InvalidatedTip`。
- `mcp/report.ts`：`McpReporter.fullRepo` 命名空间，复用 `callTaskTool` 的重试 / 留痕。
- `mcp/full-repo-lifecycle.ts`：start → 逐批 report → currentTips → endTask，两段 5s 沉降、幂等 finish。
- `repo-spike/types.ts`：`RepoReviewedBatch`。
- `repo-spike/run.ts`：`deps.onGroupReviewed`，只在 reviewed 组、job 落盘后触发；回调失败不影响退出码；resume 的 done 组不触发。
- `cli/full-repo-report.ts`：复用 `buildShardReport` / `readCodeLines` / `tip-format`，按文件上报 + 补齐空包。
- `cli/repo-spike-command.ts`：建 reporter、start、注入回调、finally 发 currentTips + endTask + close。
- `cli/args.ts`：repo-review 新增 `--taskId`（R-11 起与 review 同口径：必填）。
- `cli/report-files.ts`：日志 tool 名参数化。

## 默认口径（待真实 server 确认）

- 每个 reviewed 组上报其实际送检的全部文件；无意见文件补 `reviewTips: []`。
- 失败 / 跳过 / 预算停止的组不上报。
- `--resume` 不重报已完成组。
- 沿用 `mcp.report.task` 开关与同一 `mcp.report.server`；不发事件流。
- currentTips 在 start 成功后总会发（含失败路径），再 endTask。

## 验收

- 全包 1307 passed / 1 skipped；`pnpm build` 通过。
- 单测覆盖：四 tool 名与平铺参数、生命周期顺序 / 空数组 / 沉降 / 幂等、按文件 tips 与空包、回调时点 / 抛错不影响 / resume 不重报。
- 进程级 stub 端到端：`repo-review --taskId repo-t1 --files service/cmd/main.go` 实测四工具顺序为 `fullRepoStartTask → fullRepoReportReviewResult → fullRepoFilerCurrentTips → fullRepoEndTask`，report 的 `filePath` / `reviewTips` 与 `currentTips` 空数组均正确，未误用 PR 四工具。
- 待办：接真实 MCP server 做一次 `repo-review --taskId` 联调，核对平台展示。
