# 本地实验归档

每个实验 run 一个目录，归档 **top-level 结果 JSON、metrics、精简审计摘要、运行日志与 manifest**；
完整 `.reviewpi`（requests / transcripts / 逐 hunk 审计）体积很大，仍保留在外部 evaluation 结果目录，不复制进本仓。

归档脚本：`python bench/experiments/archive_run.py ...`（见脚本头注释）。
纪律：审计 config 快照中的 key / secret / token 字段一律写为 `[redacted]`；不复制用户配置文件。

## 2026-11-21 · F-01b iterB10 A/B

| 目录 | 说明 | P / R / B | 备注 |
|---|---|---|---|
| `2026-11-21-f01/f01b-off-c10` | arm A，补漏关 | 0.500 / 0.316 / 0.387 | 对照 |
| `2026-11-21-f01/f01b-on-v1` | v1 首轮 | — | candidate 回执缺 `hunk` 解析 bug，指标不用于归因 |
| `2026-11-21-f01/f01b-on-v1-fixed` | v1 修复后 | 0.449 / 0.358 / 0.398 | 补漏候选 15 / 命中 4 |
| `2026-11-21-f01/f01b-v2` | no-issue evidence + 候选优先 + 代码优先 | 0.439 / 0.432 / 0.435 | 候选 27 / 命中 7 |
| `2026-11-21-f01/f01b-v3` | 独立验证门 | 0.522 / 0.400 / **0.453** | 验证器 26 请求，拒 17，fail-open 4 |

## 2026-11-21 · F-02 准入与分片

| 目录 | 说明 | 结果 | 备注 |
|---|---|---|---|
| `2026-11-21-f02/baseline-f91-v3` | 91 条 iterF91，最佳配置（F-01b v3 + 验证门），10 并发；**不含 F-02** | **P 0.381 / R 0.245 / B 0.298** | 91/91 ok；320 生成 / 144 覆盖 GT；token 53,104,139；judge 261 请求 |
| `2026-11-21-f02/f02-small-check` | F-02 单样本准入检查（cline，merge-base diff 17,227 字符） | `ok`，4 findings | `maxDiffChars=8000` / `maxShardChars=10000`；F-02 前会 `diff-too-large` 跳过，F-02 后 `shards[]` 1 片、截取 1 hunk 留痕 |

> 桥接口径（2026-11-22）：外部 `aacr_reviewpi_bridge.py` 使用 `merge-base`（PR 范围）而不是 `base..head`；仓内 `bench/aacr-bench-v2/scripts/` 副本已同步。上表基准与单样本检查均按 merge-base 口径。

## 2026-11-22 · F-03 分片并行（串行 vs `concurrency=3`）

| 目录 | 说明 | 结果 | 备注 |
|---|---|---|---|
| `2026-11-22-f03/serial` | 3 条多片样本，串行（`concurrency=1`），网关 `deepseek-v4.1-flash` | 22 片 / **5298.9s** / 23.41M token | 不跑 judge；429=0 |
| `2026-11-22-f03/parallel` | 同 3 条、同配置，`concurrency=3` | 22 片 / **2111.8s** / 32.86M token | **2.51× 墙钟**；429=0 |
| `2026-11-22-f03/comparison.md` | 对比报告、token 偏高的解释与后续 replay 计划 | — | `comparison.json` / `compare_runs.py` 同目录 |

> F-03 的 live 对比证明墙钟与 429；findings/token 等价需 replay 同一 trace 证明，不能由 live 采样差异推出。

## 2026-11-22 · F-04 证据接地历史回放

| 目录 | 说明 | 结果 |
|---|---|---|
| `2026-11-22-f04/v3.json` | v3 iterF91 320 findings 的接地分布 | grounded 217 / unverified 103 / unverifiable 0 |
| `2026-11-22-f04/old-arm2.json` | 旧 0.6.1 arm2 1489 findings | grounded 1022 / unverified 463 / unverifiable 4 |
| `2026-11-22-f04/eval_grounding.mjs` | 零模型回放脚本（编译后的 grounding 模块） | 只读审计 + git show head 文件 |
| `2026-11-22-f04/README.md` | 方法与误杀风险说明 | drop 会排除约 32%，默认 off |

## 2026-11-27 · iterS41 小 diff 四臂对照

| 目录 | 说明 | P / R / B | 成本 |
|---|---|---|---|
| `2026-11-27-s41-ledger/no-repair-s20` + `no-repair-rest21` | 当前主线，补漏关；41 = 20 + 21 | 0.417 / 0.280 / 0.335 | 非缓存+output 1.81M；墙钟 7,504s |
| `2026-11-27-s41-ledger/repair-s41` | 当前主线 + 覆盖补漏，`maxRequests=8` | 0.398 / 0.301 / 0.343 | 非缓存+output 2.27M（+25.5%）；墙钟 9,768s（+30.2%） |
| `2026-11-27-s41-ledger/README.md` | 四臂口径、旧基线 / OCR 对照与决定 | — | — |
| `2026-11-27-s41-ledger/combined.json` | 四臂汇总指标与成本 | — | — |

> 补漏带来 +2.1pp recall / +0.8pp balanced，代价 +25.5% 非缓存成本；`maxRequests`
> 暂维持 8，两候选提示词 A/B 本轮不做。旧基线 0.273 / 0.350 / 0.307，OCR
> 0.314 / 0.382 / 0.345。

## 2026-11-27 · iterM20 混合样本 repair on/off

| 目录 | 说明 | P / R / B | 成本 |
|---|---|---|---|
| `2026-11-27-mixed-onoff/off` | 20 条混合 MR（15 小 + 5 大），repair 关 | 0.390 / 0.291 / 0.333 | 非缓存 865k；墙钟 3,533s |
| `2026-11-27-mixed-onoff/on` | 同集，repair 开（`maxRequests=8`） | 0.417 / 0.350 / 0.381 | 非缓存 1,102k（+27.4%）；墙钟 5,008s（+41.7%） |
| `2026-11-27-mixed-onoff/README.md` | 归因、分组与结论 | — | — |
| `2026-11-27-mixed-onoff/combined.json` | 总盘、分组、补漏漏斗与成本 | — | — |

> 表面 on 更好（B +4.7pp），但拆到 finding 级：6 条 `CR*` 只有 2 条命中 GT；
> 去掉 CR 后主检视仍有 B 37.2%（off 33.3%），说明涨幅主要来自主检视波动。
> repair 自身约 +0.8pp B，默认值暂维持 off。

## 2026-11-27 · cap-hit 6 条 `maxRequests` 8 vs 16

| 目录 | 说明 | P / R / B | 成本 |
|---|---|---|---|
| `2026-11-27-cap8-vs-16/cap8` | 6 条高缺口 session，`maxRequests=8` | 0.387 / 0.241 / 0.297 | 非缓存+output 495k；耗时合计 2,622s |
| `2026-11-27-cap8-vs-16/cap16` | 同集，`maxRequests=16` | 0.419 / 0.296 / 0.347 | 非缓存+output 683k（+37.9%）；耗时合计 3,487s（+33.0%） |
| `2026-11-27-cap8-vs-16/README.md` | 预算漏斗、CR 归因与逐 session 对比 | — | — |
| `2026-11-27-cap8-vs-16/combined.json` | 总盘、逐 session、补漏漏斗与成本 | — | — |

> 16 消除了 77 个预算跳过 hunk，但只多 1 条可明确归因的 GT（union
> state/movement:148）；补漏成本 +98.0%。默认 `maxRequests` 维持 8；下一瓶颈是
> 35 个模型主动省略的 `no-signal` hunk，不是预算。


