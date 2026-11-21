# F-02 大 MR 准入与分片一致

- Status: `done`
- 优先级：P0
- 分支：`exp-flow`
- 对应问题：P0-2、V2
- 讨论归档：[discussion.md](discussion.md)

## 目标

`split.enabled=true` 时，大 MR 不再被 `limits.boundary.maxDiffChars` 整条跳过；先分片，片数 ≤ `maxShards` 就正常检视，超限在模型请求前显式失败。

## 改动

- `run/review-run.ts`：准入顺序改为「先 `planReviewShards`；只有单遍路径（`shards === null`）才过 `maxDiffChars` 体积门」。
- 分片路径不再触发 `diff-too-large`；片数超限沿用 `shard-planner` 的显式错误（含所需片数与 `maxShards`），发生在任何模型请求之前。
- 截取 / 覆盖留痕复用 F-01a：被截取 hunk 标 `not-reached(truncated)`。
- 测试：`review-admission.test.ts` 新增「超 maxDiffChars 但可分片 → reviewed」「片数超 maxShards → 显式失败」两例。

## 验收（摘要）

- 超 `maxDiffChars` 但片数 ≤ `maxShards`：返回 reviewed，不再 skipped。
- 片数 > `maxShards`：显式失败，不调模型。
- 单遍路径（split 关闭 / 不需要分片）仍按 `maxDiffChars` 拦截。
- 同一输入 + 同一配置 → 同一分片计划。
- F-02 不做大规模验证；只跑单样本准入检查 + 单测。

## 验收证据

- 单测：`review-admission.test.ts` 6 条（含「超 maxDiffChars 可分片 → reviewed」「超 maxShards → 模型前失败」）、`sharded-review.test.ts` 10 条通过。
- 全包：108 文件 / **1214 passed / 1 skipped**（2026-11-22）。
- 单样本：cline `d0a8db8`，merge-base diff 17,227 字符 / 5 文件；`maxDiffChars=8000`、`maxShardChars=10000` → `ok`（4 findings，71.0s），`run.json.shards[]` 1 片、`shardTruncation` 1 hunk；F-02 前同输入会 `diff-too-large` 跳过。
- 归档：`bench/experiments/2026-11-21-f02/f02-small-check/`；基准 `.../baseline-f91-v3/`。

## 待决

- 默认 `maxShards` 是否从 12 调大，留给产品 / F-15；F-02 只改语义，不擅自调默认成本护栏。
