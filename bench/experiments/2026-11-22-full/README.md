# 全量基准：iterF91（2026-11-22）

配置：`benchmark-f09-full.jsonc`（compact、检索预算 3/4/40 万、confidence 0.3、evidence warn、repair off）
模型：网关 `deepseek-v4.1-flash`；judge：`deepseek-v4-pro`（1 轮）；并发 c=5。

## 结果

| 指标 | 本轮 | v3 baseline（2026-11-21） |
|---|---:|---:|
| Precision | 36.0% | 38.1% |
| Recall | 17.7% | 24.5% |
| Balanced | **23.7%** | **29.8%** |
| findings | 264 | 320 |
| 覆盖 GT | 104 / 588 | 144 / 588 |
| 请求 | 1,573 | — |
| 工具调用 | 2,780 | — |
| 检索预算跳过 | 106 | — |
| token | 60.77M | 53.10M |
| 平均耗时 | 203.1s | — |

- 91/91 ok，0 failed / 0 skipped；串行耗时合计 18,485s。
- 按实例 bootstrap：ΔB = **−4.6pp，95% CI [−8.3, −1.1]**（显著负向）。
- 分 GT 规模：GT≤2 命中 11→13；GT 3–5 35→23；GT>5 76→59。
- 42 个实例触发检索预算；有跳过组 Δ−14、无跳过组 Δ−13，预算不是唯一主因。

## 判读

- 全量上 compact + 预算默认组合相比 v3 baseline 明显回退，不能作为产品默认。
- S20 的 +9.6pp 只在 20 条小 diff 上成立；全量显示中大型样本被拖累。
- 按验证前规则回退：`stageCompression` 默认回 `off`、`retrieval` 默认回 0（均保留 opt-in）；
  ADR-0116 记录回退与证据。
- 模型标识：v3 记录 `deepseek-flash`（上游目录 V4.1 Flash 别名），本轮 `deepseek-v4.1-flash`；
  若两者并非完全同一服务，回退结论仍偏保守。

## 文件

- `results/`：91 条归档结果 + 精简审计 + manifest
- `full.log`：桥接运行日志
- `full-metrics.json`：judge 汇总
- `metrics_claude_*.json`：judge 原始输出
- `comparison-v3.json`：`compare_arms.py` 输出
