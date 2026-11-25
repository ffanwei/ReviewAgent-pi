# R-10 讨论归档

## 2026-11-25 · 全仓 MCP 上报对齐

- 用户给定服务端契约：`fullRepoStartTask` / `fullRepoReportReviewResult` / `fullRepoFilerCurrentTips` / `fullRepoEndTask`，顺序同列；与 PR 共用同一 MCP server。
- `fullRepoFilerCurrentTips` 的 inputSchema 已确认：`{ taskId, invalidatedTips: [{ reason, tipsId }] }`；v1 每次传空数组，不处理历史意见失效。
- 默认口径：按批完成后逐文件上报，无意见文件补 `reviewTips: []`；失败 / 跳过组不上报；resume 不重报；沿用 `mcp.report.task` 与两段 5s 沉降。
- 分层：repo-spike 不 import mcp，CLI 通过 `onGroupReviewed` 回调组装报文。
