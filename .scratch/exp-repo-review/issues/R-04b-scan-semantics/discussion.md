# R-04b 讨论归档

## 2026-11-25 · 为什么单独拆 R-04b

- R-04 的 `DONE` 验收是「执行缝跑通、行锚点、组隔离」，不是 R-01 契约 §8 的 scan 语义。
- 当前 `synthesize-diff.ts` 把文件写成 `new file mode`，`ISSUE_DESCRIPTION` 也自述是 spike；MR 提示词又要求「只报本次新增」。生产必须换成中性文件快照 + scan Zone A。
- 保留 R-04 的 `DONE` 作为历史证据；新增 R-04b 表示契约补齐，避免把 `DONE` 误读为生产就绪。
- 决策：v1 用 `reviewMode` 分支，不改 MR 缺省路径；不追求一次性重写 `runReviewOutcome`。
