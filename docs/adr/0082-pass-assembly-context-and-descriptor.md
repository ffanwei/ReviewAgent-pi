# 0082. pass 装配：单遍与分片共享 run context 与 descriptor

**状态**：已接受（2026-11-14，用户决策：抽执行器统一装配；`ReviewPassInput` 叶子不动；两片迁移；输入输出逐字节不变）
**关联**：[ADR-0039](0039-sharded-review-for-large-mrs.md)（分片检视）、[ADR-0070](0070-single-file-truncation-and-tighter-diff-limits.md)（单文件截取留痕）、[ADR-0080](0080-model-fallback-on-model-not-found.md)（`modelFallback` 只进聚合审计）、[ADR-0081](0081-delivery-module-boundary.md)（交付 module；本 ADR 与其独立）
**范围**：本仓 pi 线 0082。只改 run 内核的 **pass 装配结构**：不改分片算法、检视语义、审计/产物/请求字节，也不改 `ReviewPassInput` 的公开形状。

## Context

`runReview` 有两条路径：单遍（`executeSinglePass`）与分片（`executeShardedPasses`）。两条路径各自手写同一个 `ReviewPassInput`（24 个字段），并静默分叉：

- 单遍传 `config` / `modelFallback` / `mrFilter` / 真实 `boundary`；
- 分片传 `boundary: { degraded: false }`，省略前三项（它们只在聚合审计写一次）；
- 规则包各自 `loadRuleSkillSet`；目录、片标签、`startedAt` 递进各算一次。

「哪些字段属于聚合审计」只活在注释与 ADR 正文里。ADR-0080 加一个 `modelFallback` 需要改 `contracts/run.ts`、`review-pass.ts`、两个调用点、聚合审计四处。近期工作已多次触碰这段装配（大 MR、截取、模型降级）。

## Decision

### 1. 一个新 module：`run/pass-runner.ts`

导出：

- `ReviewRunContext`：run 级、一次装配。身份/传输、已解析 `runtime`/`modelId`、路径（`runsRoot`/`runsDir`/`auditRoot`/`persistRecord`）、run 级审计值（`boundary`/`mrFilter`/`config`/`modelFallback`/tips 阈值）、规则包（`ruleSkills`/`ruleSkillAudit`）、执行缝（`startedAt`/`emit`/`onShardFindings`）。
- `PassDescriptor`：每遍一份，判别联合
  ```ts
  | { kind: "single"; diff: string }
  | { kind: "shard"; shard: Shard; total: number };
  ```
- `buildPass(context, descriptor, startedAt)`：**唯一的差异点**——派生 `diff`/`initialDiff`、目录布局、片标签、`emit` 包装、以及 run 级审计值是否进入本遍。
- `runPasses(context, descriptors, options?)`：串行执行；每遍之后执行片级回调与请求时间线续写；`startedAt` 递进；单遍 = 单元素。

### 2. context 在 `run.start` 之后装配

`buildRunContext(input, { startedAt, runtime, modelId, emit, boundary, mrFilter })` 是异步的：内部派生 `runsDir`/`auditRoot` 并装载规则包**一次**。调用点在 `run.start` 之后，保持规则包装载的 stderr 时序不变。context 不持有 `ReviewRunInput` 引用、不持有 `diff` / `shards`。

### 3. 聚合审计只从 context 取 run 级字段

`aggregateShards(context, executed)`。`ExecutedPass = { descriptor, pass }`；聚合时用 `descriptor.kind === "shard"` 收窄取片信息，不冗余第二份 `Shard`。

### 4. 单遍结果构造与分片聚合仍分开

本 ADR 只统一「pass 装配与执行」。单遍的 `RunRecord`/`RunResult` 构造留在 `executeSinglePass`；分片聚合留在 `aggregateShards`。不借机改 `RunRecord` / `RunResult` 形状。

### 5. 测试注入缝

`runPasses` 接受可选的 `runPass`（缺省真 `runReviewPass`）。module 测试用假 pass 锁顺序、目录、标签与 `startedAt` 递进，不调模型。`buildRunContext` 的规则包装载仍走既有 `ruleSkillLoader` 注入缝。

## Options（为什么不是别的）

- **只抽 builder**：否。字段漂移消失，但循环、目录、规则包装载仍两份。
- **改 `ReviewPassInput` 为 `{ context, descriptor }`**：否。叶子接口会被大面积改动，却换不来更深的 interface；seam 应在调用侧。
- **执行器连结果构造一起收**：否。会同时改 `RunRecord`/`RunResult` 形状，超出本次结构重构。
- **聚合继续吃参数袋**：否。run 级字段会继续散落在两个调用点与聚合签名里。
- **强制把 `delivery` 也接进来**：否。两者独立：`delivery` 消费 `ReviewRunResult`，不感知 pass 装配。

## Consequences

- **好**：加一个 run 级字段只改 context 与聚合一处；两条路径不会再出现「单遍加了、分片忘了」；module 测试可用假 pass 锁住顺序与目录，不再依赖重进程。
- **代价 / 风险**：多一层 `pass-runner`，`ReviewRunContext` 字段较多（但每条都有明确出处）；`runPasses` 的 `startedAt` 递进与回调时序是新的不变量，必须由测试守住。
- **测试面**：`pass-runner.test.ts` 9 条（builder 5 + executor 4：字段矩阵、聚合专属字段、目录/标签、回调时序、`startedAt` 递进、回调抛错旁路）；`review-run.test.ts` / `sharded-review.test.ts` / 全量 vitest / `pnpm test:replay` 6/6 锁字节与请求体。
