# 0119. 跳过检视也按变更文件逐个上报空 tips

**状态**：已接受（2026-11-25）
**关联**：[ADR-0061](0061-every-diff-file-reported-before-summary.md)（每个变更文件必报）、[ADR-0068](0068-report-every-changed-file-including-filtered.md)（过滤文件也报空 tips）、[ADR-0075](0075-diff-too-large-skip-with-report.md)（跳过检视仍上报的首个文件口径）、[ADR-0078](0078-review-scope-include-exclude-regex.md)（范围正则导致的跳过）
**范围**：只改跳过交付（`deliverSkip`）的上报粒度；不改跳过判定、退出码、总结模板与 stdout 形状。

## Context

`review` 在两种情况下会跳过检视：过滤后 diff 超过体积门（`diff-too-large`）、
过滤后没有任何可检视文件（`no-reviewable-files`）。ADR-0075 当时选择只对
**第一个改动文件**发一条空 `mrReviewResult`，理由是大 diff 可能上千文件，
逐文件上报「无必要」；ADR-0078 的跳过路径沿用了同一口径。

实际接入平台后，这个口径让远端无法按文件登记「变更已受理但未检视」：
同一 MR 的其余文件在平台上完全缺席，和「从未收到这个文件」无法区分。
用户明确要求：**每个变更文件都上报一次，不管有没有检视意见。**

## Decision

1. `deliverSkip` 的入参由 `firstFile?: string` 改为 `files?: readonly string[]`，
   传**过滤前 diff 的变更文件全集**；
2. 跳过路径复用 `reportFilesWithoutTips`：每个文件各发一次
   `mrReviewResult` / `fullRepoReportReviewResult`，`reviewTips: []`；
   路径规范化、非法路径跳过、同文件去重沿用现有实现；
3. 上报顺序保持「全部文件 → `saveReviewSummary` → `endTask`」；
4. 失败语义不变：单个文件上报失败只留痕，不改变退出码；跳过仍 exit 0，
   总结仍显式写「跳过检视」，不谎报「未发现缺陷」；
5. 全仓路径（每组 reviewed）本来就按文件逐个上报；本次补一条零意见组的
   回归测试，锁定「5 个文件 = 5 次调用」而不是合并成一条。

## Consequences

- **正**：平台对每个变更文件都有一条登记，可以区分「已受理未检视」与
  「从没收到」；与 ADR-0061 / ADR-0068 的「每文件必报」口径一致。
- **负 / 风险**：
  - 体积门场景下 MCP 调用数 = 变更文件数，超大 MR 可能产生数百到数千次
    业务调用；上报是顺序 await，墙钟会随文件数增长；
  - 空 tips 只表示「无意见登记」，不代表「已检视且安全」；跳过语义仍由
    `saveReviewSummary` 的固定文案承载。
- **不做**：不新增配置开关；不改变跳过判定；不在失败 / 未执行的全仓组上
  补报（避免把「没看」冒充成「没问题」）。
