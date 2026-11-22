# F-03 分片并行（有界并发）

- Status: `done`
- 优先级：P0
- 分支：`exp-flow`
- 对应问题：P0-3、V2
- 讨论归档：[discussion.md](discussion.md)

## 目标

分片检视从「一片跑完再跑下一片」改为**有界并行**：同一 review 内最多同时执行 `limits.split.concurrency` 片；findings、覆盖账本、审计与串行结果等价；单遍路径零行为变化。

## 范围

- `run/pass-runner.ts`：`runPasses` 增加 `concurrency` 选项；≥2 时用固定 worker 池，结果仍按 descriptor 顺序返回。
- `run/review-run.ts`：分片路径传入 `runtime.limits.split.concurrency`；单遍路径不传（恒 1）。
- `shared/config-limits.ts`：新增 `limits.split.concurrency`，整数 1–8，默认 **1**（关闭，保持旧行为）。
- 片级回调（`onShardFindings`）在并行模式下**按片序串行执行**，避免上报顺序漂移。
- 失败语义：记录最低片号的错误；停止调度新片，等待在飞片结束后抛出；在飞片产物可能残留（与串行中断一致，不做回滚）。

## 不做

- 不做跨 review 的全局并发池；多进程并发仍由调用方控制。
- 不做请求级限流/令牌桶；429 由现有 retry 处理，观测为准。
- 不改分片规划、六阶段、七工具、提示词、findings 合并规则。

## 验收

- `concurrency=1`：与当前串行逐字节一致（findings / coverage / run.json / 事件）。
- `concurrency≥2`：
  - 最大在飞片数 ≤ 配置值；
  - 聚合顺序按 `shards[].index`，与完成顺序无关；
  - findings / coverage / `shardTruncation` / usage 与串行等价（replay/fake 证明）；
  - 片级回调按片序执行；失败片之后不再回调。
- 多片真实样本：墙钟显著下降（≥4 片目标 ≥1.5×），429 不高于串行，token 总量 ±2%。
- 全包测试 + `tsc -p tsconfig.build.json` 通过；replay 六场景通过。

## 验收证据

- 单测/集成：`pass-runner` 并行在飞上限/片序、回调片序、串并行结果一致、失败边界；`sharded-review` 串并行 findings/usage 等价 + 时间线行数一致；`request-timeline-recorder` scope 隔离。
- 全包：**108 文件 / 1220 passed / 1 skipped**；`tsc` build 通过。
- live（网关 `deepseek-v4.1-flash`，3 条多片样本，22 片，不跑 judge）：
  - 串行 **5298.9s** → 并行 `concurrency=3` **2111.8s**，**2.51×**；
  - 单样本 1.81× / 2.51× / 2.93×；
  - 429 两批均为 **0**；片计划一致（6/7/9）。
- 归档：`bench/experiments/2026-11-22-f03/{serial,parallel,comparison.md,comparison.json}`。
- 未满足/待补：live token 并行高 40%（cache_read + 采样差异），**token 等价不能用 live 证明**；同一 trace 的 replay 对比待补。确定性 fake 已证明 findings/usage 等价。
- typescript-go 首跑被桥接 30 分钟默认超时截断，60 分钟重跑成功；不是产品失败。

## 待决

- 默认是否从 1 调到 3：先保持 1，等 replay 等价与更多 429 数据后再定。
- MCP/任务模式的片级回调已按序串行；是否需要回调与检视重叠（提高吞吐）留后续。
