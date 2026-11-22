# F-03 讨论归档

> 票与验收在 [`ticket.md`](ticket.md)；任务总表在 [`../../map.md`](../../map.md)。

## 2026-11-22 · 开工与收益边界

- 现状：`runPasses`（`packages/review-pi/src/run/pass-runner.ts`）是串行 `for + await`，ADR-0039 明确第一版串行、并行推迟；ADR-0048 把「每进程严格串行」当作容量前提。
- 收益只在**多片** review：串行总耗时 ≈ 各片之和，并行 ≈ 最慢片 + 合并/回调。
- 先量当前基准的真实分片工作量（merge-base 口径）：
  - iterF91 实际 diff 中位数 10,015 字符，最大 79,130 字符；
  - 默认 `maxShardChars=120,000` → **0/91 分片**；
  - 调到 50,000 → 5/91（平均约 2 片）；30,000 → 15/91（平均约 2.1 片）。
- 结论：F-03 是**延迟特性**，不会改变 iterF91 的 P/R/B；收益主要来自真实大 MR（4–12 片）。验证不跑 91 条真实测评，用单测 + replay 证明等价，再用 3–5 个多片样本短时计时验证墙钟与 429。
- 实施口径：`limits.split.concurrency` 默认 1（关闭），允许 1–8；先保证 `concurrency=1` 零行为变化，再逐步打开。

## 2026-11-22 · 实现落地

- 配置：`limits.split.concurrency`（1–8，默认 1）；`PiAgent.example.jsonc` 同步。
- `runPasses`：`concurrency=1` 走原串行实现（逐字节不变）；≥2 用固定 worker 池，`ExecutedPass[]` 按片序返回。
- 片级回调：并行下按片号串行排队（不跟随完成顺序），失败片及之后不再回调；回调排队不阻塞 worker 取下一片。
- 失败语义：记录最低片号错误，停止取新片、等在飞片结束再抛；不做请求级取消。
- 请求时间线：`setRequestTimelineSink` 改为 AsyncLocalStorage scope + fallback；每个并行 pass / 回调独立 scope，避免并发遍互写 `request-timeline.jsonl`。
- 测试：`pass-runner` 新增 4 例（在飞上限/片序、回调片序、串并行结果一致、失败边界）；`sharded-review` 新增串并行 findings/usage 等价例；`request-timeline-recorder` 新增 scope 隔离例；全包 **1220 passed / 1 skipped**，`tsc` build 通过。
- 发现（非 F-03 引入）：单测路径的 shard runDir 在 pass 开始前尚未创建，pass 级 `request-timeline.jsonl` 打开失败（CLI 路径目录已存在）；本轮不修，时间线隔离由 scope 单测覆盖。
- 下一步：3 条真实多片样本（typescript-go 79k / immich 65k / elasticsearch 58k，`maxShardChars=10000`）串行 vs `concurrency=3` 计时，不跑 judge，记录墙钟、429、token。

## 2026-11-22 · 修复 pass 级时间线目录缺失

- 现象：`runReviewPass` 在 `executeReviewPass` 之前打开 `request-timeline.jsonl`，但 `runDir` 可能尚未创建；单测路径的 shard 目录、以及 CLI 分片路径的 `shards/attempt-…/sNN` 都可能命中。
- 实测：F-03 串行 live 批次的前三片 `request-timeline.jsonl` 均为 0 字节，确认不只是单测路径。
- 修复：`runReviewPass` 在创建时间线写入器前 `await mkdir(input.runDir, { recursive: true })`；失败旁路仍保留。
- 测试：`sharded-review` 的 F-03 用例恢复时间线断言（每片行数 >0，串/并行行数一致）；全包与 build 待跑。

## 2026-11-22 · 网关切换与 live 对比

- 测评接口切到网关 `apigateway-cn-beijing.volceapi.com/v1`，检视 `deepseek-v4.1-flash`，judge `deepseek-v4-pro`；旧官方接口的串行批次停止并丢弃，串/并行均在网关重跑。
- 串行 3 条（22 片）：immich 1091.9s / elasticsearch 1288.3s / typescript-go 2918.7s，合计 **5298.9s**。
- 并行 c=3（22 片）：immich 603.4s / elasticsearch 513.1s / typescript-go 995.3s，合计 **2111.8s**。
- 墙钟加速 **2.51×**（单样本 1.81× / 2.51× / 2.93×）；429 两批均为 0。
- typescript-go 首跑被桥接默认 30 分钟超时截断（1803.6s），用 `--timeout-minutes 60 --force` 重跑；不是产品失败。
- token 并行比串行高 40%，主要是 `cache_read` 上升 + live 采样导致轮次/输出不同（findings 12 vs 7、18 vs 15、19 vs 14）；token 等价需 replay，不能由本次 live 推出。
- 归档：`bench/experiments/2026-11-22-f03/{serial,parallel,comparison.md,comparison.json,compare_runs.py}`。
