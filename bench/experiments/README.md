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
