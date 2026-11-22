# 0112. 分片检视的有界并行（F-03）

**状态**：已接受（2026-11-22，F-03 实施中）
**关联**：[ADR-0039](0039-sharded-review-for-large-mrs.md)（大 MR 分片；原文「第一版串行、并行推迟」由本 ADR 局部修订）、[ADR-0048](0048-offline-trace-replay-and-concurrency-ramp.md)（进程级并发阶梯；本文把「每进程严格串行」限定为默认值）、[ADR-0045](0045-mcp-business-task-tools.md)（片级回调）、[ADR-0076](0076-request-timeline-observability.md)（请求时间线）、[ADR-0037](0037-mcp-run-progress-events.md)（进度事件流）
**范围**：只改分片调度与配置面；不改分片规划、六阶段、七工具、提示词、findings 合并规则、单遍路径。

## Context

ADR-0039 第一版选择串行：确定性最好、失败定位简单、缓存行为可预测。代价是多片大 MR 的墙钟 ≈ 各片耗时之和。

现状事实：

- `run/pass-runner.ts` 的 `runPasses` 是 `for + await`，一片跑完再跑下一片；
- 片级回调（ADR-0045）在每片结束后、下一片开始前串行执行；
- 请求时间线（ADR-0076）的 sink 是**进程级单值**（`setRequestTimelineSink`），并行会让两片互相覆盖；
- `ExecutedPass[]` 的数组顺序就是片序，聚合（findings / 覆盖账本 / usage）依赖这个顺序。

F-03 之前先量了工作量（merge-base 口径）：iterF91 实际 diff 最大 79,130 字符，默认 `maxShardChars=120,000` 下 **0/91 条分片**；把阈值调到 50,000 才有 5/91。也就是说，并行是**延迟特性**，只对真实多片大 MR 有意义，不改变 benchmark 的 P/R/B。

## Decision

### 1. 配置面

`limits.split.concurrency`：

- 整数 **1–8**，缺省 **1**；
- 1 = 保持串行旧行为（零字节漂移）；
- 仅分片路径读取；单遍路径即使配置 >1 也只跑 1 片；
- 上限 8 是显式护栏：benchmark 已有 10 个进程并发，进程内再放大 8 倍会形成 80 路请求风暴。

### 2. 有界 worker 池

`runPasses` 增加 `concurrency` 选项；`concurrency ≥ 2` 时：

- 固定 N 个 worker 共享一个递增片号，最多 N 片在飞；
- `ExecutedPass[]` 仍按 descriptor 顺序返回（完成顺序只影响调度，不影响聚合）；
- 每片的 `startedAt` 统一取 run 的 `context.startedAt`；并行没有「上一片结束」这个串行起点；
- `PassTiming.interPassReportMs` 在并行模式恒为 0；`reportCallbacksMs` 仍记该片回调自身的耗时。

### 3. 片级回调按片序串行

`onShardFindings`（平台上报 + 报文生成）在并行模式下：

- 回调排队，按片号 `1 → N` 串行执行，不跟随完成顺序；
- 不阻塞 worker 取下一片（回调与后续片检视可重叠）；
- 某片失败时，失败片及之后已排队的回调不再执行，等待方被唤醒，避免挂死。

### 4. 失败语义

- 记录错误所属片号；停止调度新片，已发出的片等待自然结束（暂不做请求级取消）；
- 全部 worker 结束后，抛**最低片号**的错误，尽量贴近串行「先遇到先抛」；
- 在飞片可能已写产物；与串行中断一致，不做回滚；
- 片级回调自身的异常仍按 ADR-0045 旁路处理（不改变退出码）。

### 5. 请求时间线隔离

`setRequestTimelineSink` 的进程级单值改为 **AsyncLocalStorage 作用域 + fallback**：

- `runWithRequestTimelineScope` 为每个并行 pass、每个片级回调建立独立 scope；
- scope 内的 `setRequestTimelineSink` 只影响本异步上下文；
- scope 外（CLI 收尾、单遍旧路径）仍走 fallback，行为不变；
- 保证每片写自己的 `request-timeline.jsonl`，不跨片串写。

### 6. 明确不做

- 不做跨 review 的全局并发池；
- 不做请求级限流 / 令牌桶（429 仍由现有 retry 处理，靠观测验收）；
- 不做失败取消（AbortSignal 未贯穿模型层）；
- 不改变进度事件契约：仍只有一次 `run.start` / `run.end`，片内事件带 `shard` 标签；并行模式下不同片的事件可以交错，消费方不得依赖全局顺序。

## Options（为什么不是别的）

- **保持串行**：多片大 MR 的墙钟无法下降；F-03 的存在理由就是延迟。否。
- **无界 `Promise.all`**：片数 12 时请求风暴、429 和内存都不可控；否。
- **默认 3–8**：改变现有行为、需要重录回放与更大范围回归；先默认 1，按真实多片数据再调。否。
- **只并行无回调的 CLI 路径**：实现更简单，但 MCP/任务模式（片级上报）拿不到收益；本 ADR 用「按片序串行回调」覆盖。否。
- **按完成顺序聚合**：findings 合并规则依赖片序；会改变输出顺序与去重代表项。否。

## Consequences

**正**：

- 多片大 MR 的分片阶段墙钟从「各片之和」降到「最慢片 + 调度/回调」；
- token 与提示词不变，质量指标不应变化；
- 默认关闭，回滚只需把 `concurrency` 设回 1。

**负 / 风险**：

- 并行放大瞬时请求数，429 / 重试可能上升；需要真实多片样本观测；
- 进度事件交错，CLI/MCP 消费方不能假设顺序；
- 失败时在飞片不能取消，错误返回时间可能晚于串行；
- 片级回调虽按序，但可能与后续片检视重叠，平台侧收到意见的时机提前。

## 验收

- `concurrency=1`：与串行逐字节一致（findings / coverage / run.json / 事件）。
- `concurrency≥2`（fake / replay）：最大在飞片数 ≤ 配置值；聚合按片序；findings / coverage / usage 与串行等价；回调按片序；失败后不回调失败片及之后。
- 多片真实样本（3–5 条，不跑 judge）：≥4 片目标墙钟 ≥1.5×；429 不高于串行；token 总量 ±2%。
- 全包测试 + `tsc -p tsconfig.build.json`；replay 六场景。

## 实施记录（2026-11-22）

- 代码：`runPasses` 有界 worker 池、片序回调、AsyncLocalStorage 时间线；`review-pass` 在打开时间线前建 `runDir`。
- 测试：全包通过；新增在飞上限/片序、回调片序、串并行 findings/usage 等价、失败边界、时间线 scope 隔离用例。
- live（网关 `deepseek-v4.1-flash`，3 条多片样本，22 片，不跑 judge）：
  - 串行 5298.9s → 并行（`concurrency=3`）2111.8s，**2.51×**；
  - 单样本 1.81× / 2.51× / 2.93×，片数越多收益越大；
  - 429 两批均为 0；
  - token 并行高 40%，主要是 `cache_read` 与 live 采样差异，不作为等价性证据。
- 归档：`bench/experiments/2026-11-22-f03/`（serial / parallel / comparison.md / comparison.json）。
- 等价性：确定性 fake 集成测试通过；同一 trace 的 replay 对比仍待补，不能由 live 采样差异证明。
