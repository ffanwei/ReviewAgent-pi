# R-04b 讨论归档

## 2026-11-25 · 为什么单独拆 R-04b

- R-04 的 `DONE` 验收是「执行缝跑通、行锚点、组隔离」，不是 R-01 契约 §8 的 scan 语义。
- 当前 `synthesize-diff.ts` 把文件写成 `new file mode`，`ISSUE_DESCRIPTION` 也自述是 spike；MR 提示词又要求「只报本次新增」。生产必须换成中性文件快照 + scan Zone A。
- 保留 R-04 的 `DONE` 作为历史证据；新增 R-04b 表示契约补齐，避免把 `DONE` 误读为生产就绪。
- 决策：v1 用 `reviewMode` 分支，不改 MR 缺省路径；不追求一次性重写 `runReviewOutcome`。

## 2026-11-25 · 实现落地（DOING）

- 采用最小接线：`ReviewRunInput.reviewMode` + `fileSnapshot` 贯穿 `pass-runner` 到 `ReviewPassInput`；MR 缺省字段缺席，`SYSTEM_PROMPT` 字节未改。
- 阶段消息也必须换：只换 system prompt 不够，Phase 1/5/6 仍写着「本次 diff」。新增 `SCAN_PHASE_INSTRUCTIONS` / `SCAN_PHASE_ORDER`，repo 模式忽略 compact，避免 MR 指令混入。
- 合成 diff 仍保留为工具/证据门底稿；模型可见的初始消息改为 `=== path ===` 文件快照，不再出现 `new file mode`。
- 验证：真实 1 组 smoke 的审计 system prompt 含「仓库快照」、不含「本次 diff」；phaseLog 以 Code Understanding 起头；`source=repo-scan`。

## 2026-11-25 · 20 组 A/B 结论

- 同一快照、同一 20 组 / 89 文件：新 scan 语义 73 findings，旧 spike 语义 83；token +5.4%（6.92M vs 6.57M）。
- 判官各抽 60 条：precision 0.816 vs 0.776（+4.1pp）；P1 均为 1.00，P2 0.909 vs 0.893，P3 0.538 vs 0.579。
- 「本次新增」两版均为 0，指标在本样本不区分；真正变化来自提示词与阶段消息不再把既有代码说成变更。
- 结论：R-04b 验收通过；剩余缺口不变（R-05b 覆盖、R-09 持久化、R-06b 召回、R-07 增量）。
