# F-02 讨论归档

> 票与验收在 [`ticket.md`](ticket.md)；任务总表在 [`../../map.md`](../../map.md)。

## 2026-11-21 · 开工与基准口径

- F-02 = 调整准入顺序，让 `split.enabled=true` 的大 MR 先分片，不再被 `maxDiffChars` 整条跳过。
- 基准：iterF91 91 条，使用当前最好配置 `benchmark-aacr-v2-f01b.jsonc`（官方 `deepseek-flash` + F-01b v3 补漏 + 验证门），并发 10；**基准代码不含 F-02**（临时回退 `review-run.ts` 的准入改动后构建）。
- 基准结果目录：`D:/Project/bench/aacr-bench/evaluation/results/iterF91/reviewpi/baseline-f91-v3-20261121`；日志 `.artifacts/f02/baseline-f91-best.log`。
- 基准跑完后归档到 `bench/experiments/2026-11-21-f02/baseline-f91-v3/`，再恢复 F-02 代码。
- 基准结果（2026-11-22 01:26）：
  - 91/91 `ok`，0 失败 / 0 跳过 / 0 429；
  - P **0.381**（122/320）/ R **0.245**（144/588）/ B **0.298**；
  - 总 token **53,104,139**（输入 49,024,151 / 输出 4,079,988）；样本耗时合计 24,734s；
  - judge 261 请求；生成 320 条、覆盖 GT 144/588。
  - 历史 F91 基线（0.6.1 / 网关模型）为 0.0781/0.1803/0.1090；本基准只作为 F-02 前后对照，不与历史数字混算。
- F-02 验证约束：**不做大规模验证**；只跑单测 + 单样本准入检查（用低 `maxDiffChars` / 小 `maxShardChars` 触发分片），结果同样归档。

## 2026-11-22 · 单样本准入检查与桥接口径修正

- 第一次 cline 单样本（`maxDiffChars=50000`）跑出 `ok`，但审计无 `shards`、diff 只有 5 文件 / 17,227 字符，未触发分片。
- 原因：外部桥接 `aacr_reviewpi_bridge.py` 已改为 **merge-base（PR 范围）** 语义，仓内归档副本仍是旧的 `base..head`（54 文件 / 100,151 字符）。差异不是 review-pi 行为，是桥接口径。
- 处理：仓内副本同步为外部版本（merge-base + `--rule-skill`），并在 README 记录；检查配置改为 `maxDiffChars=8000`、`maxShardChars=10000`（配置校验下限），强制 17KB diff 走 2 片。
- 结论口径：F-02 的单样本验证以 `run.json.shards[]` 存在且 `status=ok` 为准；`maxDiffChars` 只约束单遍路径。
- 复跑结果（01:35）：`ok`，4 findings，71.0s；diff 17,227 字符 / 5 文件，`maxDiffChars=8000` 下 F-02 前会 `diff-too-large` 跳过。
- 实际分片：`run.json.shards[]` 1 片（9,752 字符）；`shardTruncation` 记录 `state.ts` 丢弃 1 个 hunk（原 7 hunk / 保留 6），覆盖账本 `truncated=1`。片数为 1 是因为 planner 以文件/截取为单位，不是按 `maxShardChars` 硬切；准入路径已由 `shards !== null` 生效。
- 归档：`bench/experiments/2026-11-21-f02/f02-small-check/`（结果、审计摘要含 `shards` / `shardTruncation`、日志、manifest）。
