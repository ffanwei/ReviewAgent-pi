# 0116. 全量基准后回退 compact 与检索预算默认值

**状态**：已接受（2026-11-22）
**关联**：[ADR-0113](0113-stage-compression.md)（compact 默认）、[ADR-0114](0114-retrieval-budget-and-defaults.md)（检索预算默认）、[ADR-0115](0115-oneshot-empty-reply-retry.md)
**范围**：只回退两个默认值；功能保留为 opt-in，不删除代码。

## Context

iterF91 全量（91 条 / 588 GT）用当前默认（compact + 检索预算 3/4/40 万）跑了一轮：

| 指标 | 本轮 | v3 baseline |
|---|---:|---:|
| Precision | 36.0% | 38.1% |
| Recall | 17.7% | 24.5% |
| Balanced | **23.7%** | **29.8%** |
| findings | 264 | 320 |
| token | 60.77M | 53.10M |

按实例 bootstrap：ΔB = **−4.6pp，95% CI [−8.3, −1.1]**，显著负向。
分 GT 规模：GT≤2 命中 11→13；GT 3–5 35→23；GT>5 76→59——小 diff 受益，中/大样本回退。

S20 的 +9.6pp 只在 20 条小 diff 上成立；全量不支持把 compact/预算作为默认。

## Decision

- `limits.loop.stageCompression` 默认回 **`"off"`**（六阶段逐请求）；
- `limits.retrieval` 默认回 **全 0**（不限制）；
- 两者保留为 opt-in，配置可显式开启；
- `confidence.min = 0.3` 与 `evidence.mode = "warn"` **不回退**（不影响 findings / judge 判定）。

## Consequences

- 产品默认回到 v3 的六阶段、无预算行为；replay trace 已按 off 重录，6/6 通过。
- compact / 预算的代码、审计与测试保留；后续若要默认化，需先做同模型、同配置的全量成对复本，
  并考虑按 diff 规模自适应（小 diff compact、中大 diff off），而不是全局默认。
- 全量数据：`bench/experiments/2026-11-22-full/`；S20 证据仍保留在
  `bench/experiments/2026-11-22-f07/` 与 `2026-11-22-f08/`，作为“小样本方向”的反例边界。
