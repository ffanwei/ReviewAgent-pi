# iterS41 小 diff 对照（2026-11-27）

41 条 <50KB 小 diff 的四臂对照，用于回答两件事：

1. 当前主线（重复键修复 + 两候选提示词）相对旧基线 / OCR 的 precision、recall、成本；
2. 覆盖缺口补漏（coverage repair）在小 diff 上的收益是否抵得过成本。

本目录只归档 **top-level 结果 JSON、metrics、精简审计摘要与 manifest**；完整
`.reviewpi`（requests / transcripts / 逐 hunk 审计）留在外部 evaluation 结果目录。

## 口径

- 数据集：`bench/aacr-bench-v2/configs/iterS41.jsonl`（`iterS20` 20 条 + 其余 21 条小 diff，
  语言 round-robin，非无偏基准）。
- 指标：`file_semantic`（按文件语义匹配，`line_k=1`）。precision = 命中 / 生成；
  recall = 命中 GT 备注 / 期望 GT 备注；balanced = 2PR/(P+R)。
- 当前 no-repair 臂由两次运行合并：`no-repair-s20`（20 条）+ `no-repair-rest21`（21 条）。
  合并精度按两次运行各自 `file_semantic_match_rate` 以生成数加权；召回按命中备注汇总。
- 旧基线 / OCR 基线来自 `bench/aacr-bench-v2/metrics/configs/iterS41-baseline.json`。
- 运行代码早于 P0/P1 提交；manifest 里的 `review_pi_commit` 是归档时的 HEAD，
  不是运行时的代码版本。补漏开关来自 `benchmark-aacr-v2-repair.jsonc`。

## 结果

| 臂 | P | R | B | 生成 | 命中 GT 备注 | 期望 GT |
|---|---:|---:|---:|---:|---:|---:|
| 当前 no-repair（S20+rest21） | 41.7% | 28.0% | 33.5% | 120 | 52 | 186 |
| 当前 repair（maxRequests=8） | 39.8% | 30.1% | 34.3% | 133 | 56 | 186 |
| 旧基线（arm2） | 27.3% | 35.0% | 30.7% | 227 | 62 | 186 |
| OCR | 31.4% | 38.2% | 34.5% | 207 | 65 | 186 |

> 历史 v3 口径在 41 条上曾报 41.9 / 32.8 / 36.8，但该次合并没有独立的
> metrics 文件落入本仓，本归档不把它作为可复核基线；仅作参考。

## 成本

| 臂 | 墙钟 | input | output | cache read | total tokens | 非缓存 + output |
|---|---:|---:|---:|---:|---:|---:|
| 当前 no-repair | 7,504.2s | 924,022 | 882,347 | 18,618,496 | 20,424,865 | 1,806,369 |
| 当前 repair | 9,767.5s | 963,664 | 1,303,611 | 15,382,784 | 17,650,059 | 2,267,275 |

- repair 相对 no-repair：墙钟 **+30.2%**，非缓存 + output **+25.5%**。
- `total tokens` 跨臂不可比：两次 no-repair 运行与 repair 运行的缓存命中结构不同；
  成本比较只看「非缓存 + output」。
- 补漏自身：128 次请求、32 条候选、14 条接受、19 条拒绝；另有 89 个 hunk 因
  `maxRequests=8` 被跳过。命中增量 +4 条 GT（recall +2.1pp）。

## 结论与决定

- **收益**：repair 把 recall 从 28.0% 提到 30.1%，balanced +0.8pp；代价是 precision
  -1.9pp、非缓存成本 +25.5%、墙钟 +30.2%。属于「小幅召回换显著成本」，不是免费改进。
- **成本上限暂不提高**：`maxRequests` 维持 8。其余 89 个 hunk 若纳入，补漏调用量大致
  再翻一倍，而当前 32 条候选里已有 19 条被拒；在候选选择质量提升前提高上限预期收益低。
- **两候选提示词 A/B 本轮不做**：当前提示词已稳定用于 S20 / rest21 / repair 三次运行，
  回放 trace 已重录并通过；先保留现状，等下一轮需要归因「候选选择」时再单独 A/B。
- **相对旧基线**：当前 no-repair 的 precision +14.4pp、balanced +2.9pp，但 recall
  -7.0pp；说明改进主要来自降噪，召回仍是短板。
- **相对 OCR**：当前 repair 的 precision +8.4pp、recall -8.1pp，balanced 基本持平
  （34.3% vs 34.5%）；OCR 仍以更高召回、更低精度为特征，且非缓存成本约 4.5 倍。

## 目录

| 路径 | 说明 |
|---|---|
| `combined.json` | 四臂汇总指标与成本（由三份 `metrics.json` + S41 baseline 生成） |
| `repair-s41/` | 41 条，补漏开启；`metrics.json` / `results/` / `audit-summary.json` / `manifest.json` |
| `no-repair-s20/` | 20 条，补漏关闭 |
| `no-repair-rest21/` | 其余 21 条，补漏关闭 |

## 复现

```bash
python bench/experiments/archive_run.py \
  --results-dir D:/Project/bench/aacr-bench/evaluation/results/iterS41/reviewpi/exp-repo-review-iterS41-repair-20261127 \
  --out bench/experiments/2026-11-27-s41-ledger/repair-s41 \
  --label repair-s41 \
  --dataset bench/aacr-bench-v2/configs/iterS41.jsonl
```

no-repair 两臂把 `--results-dir` / `--out` / `--label` / `--dataset` 换成对应目录与
`iterS20.jsonl` / `iterS41-rest21.jsonl`。`combined.json` 的口径见文件内
`definition.metric`。
