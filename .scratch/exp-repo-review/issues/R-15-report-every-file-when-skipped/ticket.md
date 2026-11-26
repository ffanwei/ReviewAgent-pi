# R-15 跳过检视按文件上报

- Status: `DONE`
- 优先级：P1
- 分支：`exp-repo-review`

## 问题

`deliverSkip`（diff-too-large / no-reviewable-files）只对**首个变更文件**发一条
空 `mrReviewResult`（ADR-0075 旧口径）。平台无法按文件区分「已受理但未检视」
与「从没收到这个文件」。用户要求：每个变更文件都上报一次，不管有没有意见。

## 方案

- `SkipDeliveryInput.firstFile` → `files: readonly string[]`（过滤前 diff 的变更文件全集）；
- 跳过路径复用 `reportFilesWithoutTips`：逐文件发空 tips，路径规范化 / 去重 / 失败留痕沿用；
- 顺序保持「全部文件 → saveReviewSummary → endTask」；退出码、总结模板、stdout 不变；
- 全仓 reviewed 组本来就是逐文件上报；补零意见组「5 文件 = 5 次调用」回归测试。

## 验收

- `delivery.test.ts`：3 个文件 → 3 次 `report`，再 summary；
- 进程级 `ADR-0119`：2 个文件全部被 `--include` 剔除 → 2 次 `mrReviewResult`，均为空 tips；
- 全仓进程级：5 文件零意见组 → 5 次 `fullRepoReportReviewResult`；
- `full-repo-report.test.ts`：零意见 5 文件 → 5 次空包；
- 全包 1328 passed / 1 skipped（含新增用例）；build / typecheck 通过。

## 决策记录

`docs/adr/0119-report-every-file-when-skipped.md`（部分取代 ADR-0075 的上报粒度）。
