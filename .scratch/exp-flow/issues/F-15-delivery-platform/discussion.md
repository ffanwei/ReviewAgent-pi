# F-15 delivery / platform 讨论归档

> 任务总表：[`../../map.md`](../../map.md)。F-15 仍为 `TODO`；本文件先接收 F-01c 的 C2/C3 拆分。

## 2026-11-21 · 接收 F-01c C2/C3

- F-01 已按“Balanced 不回退”口径收口（v3 B 0.453 vs arm A 0.387），F-01c 的 C1（run.json `coverageSummary`）已完成。
- 以下两项拆到 F-15，不在 F-01 内继续：
  1. **C2 覆盖阈值策略**：`warn` / `fail` 的阈值、比例口径（hunk 级 `notReachedRatio`）、是否改退出码、与 truncated 的关系。需要产品口径，不能由实现自行决定。
  2. **C3 manifest / CI / preview 复用**：当前没有 review manifest / preview 本体；F-15 落地时复用 `summarizeCoverage()` 与 `audit.coverageSummary`，不复制逐 hunk 明细。
- 约束：C2 的 `fail` 不能在产物写出前中断；若实现，应在交付完成后给出明确退出码与 stderr 原因。C3 不得改变现有 stdout 单 JSON 契约。
- 底座：`packages/review-pi/src/run/coverage-ledger.ts` 的 `summarizeCoverage()`；`run-record.ts` 已投影到 `audit.coverageSummary`。
