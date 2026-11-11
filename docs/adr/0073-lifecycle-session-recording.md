# 0073. 会话扩展为全生命周期留痕（startTask → endTask）

**状态**：已接受（2026-11-11，随代码落地）
**关联**：ADR-0072（OpenCode 兼容会话导出）、ADR-0045（MCP 业务 tool）、ADR-0066（整任务 LLM 账本）、ADR-0039（分片）、ADR-0013（检视转录原生真源）
**跨仓**：本 ADR 为本仓 pi 线序列 0073；引用 DSH 兄弟仓决策须写全限定语「DSH 线 ADR-XXXX」。

## Context

ADR-0072 之后，OpenCode 兼容会话忠实镜像 pi agent 的**对话**（六阶段 + skill 子会话）。但一次检视还有一批**不在 agent 内**的步骤：候选修复、中文 tips 语义生成、MCP 总结，以及 `startTask` / `mrReviewResult` / `saveReviewSummary` / `endTask` 四个 MCP 业务工具。这些步骤的正文目前只留 usage（`one-shot-llm.ts` 的 `OneShotUsageSink` 只记 `{modelId,purpose,usage}`，全文被调用方消费后丢弃）、或落在 `mcp.json`（晚写、独立文件）。

目标：把会话从「agent 对话」扩展为「从 startTask 到 endTask 的**全生命周期留痕**」，让 viewer 在一条时间线里看到任务起止、检视对话、候选修复、tips、总结与业务上报。

## Decision

### 1. 承载层：只进 OpenCode 兼容版，原生真源不动

外部步骤没有 pi `AgentMessage` 形态，只能写成 OpenCode 事件（`system` / `user` / `assistant` / `tool` part）。原生 `{info,messages,view}` 一字不改（回放 / 诊断 / 审计真源保持纯净）；生命周期留痕是「观看层」能力，只写在兼容版。

### 2. 结构：单遍追加进主会话；分片另写聚合 lifecycle 会话

- **单遍 run**：把 OpenCode **主会话**拼成完整时间线
  `startTask` 标记 → agent 对话（现有 messages 原样中段）→ 外部步骤（按发生顺序）→ `endTask` 标记，同写进 `opencode/session-<runId>.json`。
- **分片 run**：run 级步骤（startTask / 各片 mrReviewResult / tips / summary / endTask）是**一次性**的，但分片有 N 个兄弟主会话、无聚合会话。故另写一个聚合生命周期会话 `opencode/session-<runId>-lifecycle.json`（`runId` = 聚合 runId = 首片 runId，与 `run.json` 的 `auditPath` 同源；id 必须 `session-` 前缀——OpenCode 会话 id 校验只认 `ses_`/`session-`），各 shard 主会话作为它的**子会话**（`parentID` 指向它，`subagent` part 逐片引用）。

### 3. 捕获通道：进程级 lifecycle 事件收集

新增一个进程级、单调递增序号的收集器，覆盖三类事件，按实际发生顺序（全程串行 await）落序：

1. **one-shot 三目的**（candidate-repair / tips / summary）：在 `completeOneShot` 里新增 `OneShotLifecycleSink`（与既有 `OneShotUsageSink` 并列），记**全文** `{purpose, system, user, response|error, startedAt, usage}`；
2. **MCP 四工具**（startTask / mrReviewResult / saveReviewSummary / endTask）：复用 `McpCallLog` 已捕获的 `{tool, startedAt, durationMs, ok, input, output}`，由 `onTaskCall` 同时喂给 lifecycle 收集器（`mcp.json` 照旧独立写）；
3. 事件在 `main.ts` 末尾组装成 OpenCode 消息。

### 4. 消息形态映射（与 agent 对话同一条时间线）

| 步骤 | OpenCode 形态 |
|---|---|
| `startTask` / `endTask` | `system`（text = 描述 + taskId） |
| agent 对话 | 现有 `system` / `user` / `assistant` / `tool`（原样中段） |
| `candidate-repair` / `tips` / `summary`（one-shot） | 一对 `user`（合成 prompt，含 `system` + `user`）+ `assistant`（模型输出） |
| `mrReviewResult` / `saveReviewSummary`（MCP tool） | 一条合成 `assistant` + `tool` part（`name`=tool 名、`state.input`=arguments、`state.content`=服务端回包；失败记 `state.status="error"`） |

### 5. 全量原文，不截断

tips / summary / candidate-repair 的 prompt（findings + 源码行）与 response（markdown / JSON）、MCP tool 的 input/output **全量**入会话（用户明确选全量；文件会显著变大，这是有意为之）。不引入截断，避免与「观看层要能点开看全量」冲突。

### 6. 失败语义：如实记录已发生的步骤

生命周期组装在 `runReview` **成功返回**之后（review 会话已写）进行，把实际发生过的外部步骤按序写入：失败步骤照记（one-shot 记 `error`、MCP tool 记 `state.status="error"`），没发生的（如 tips 在总结前就抛错）就不记，`endTask` 缺席即表示「未收尾」。`runReview` 本身抛错（检视失败）时沿用现状——不写 session（外部步骤仍留在 `mcp.json`）。

## Options（为什么不是别的）

- **也写进原生转录**：外部步骤无 pi `AgentMessage` 形态，塞进原生 `messages` 会污染回放/诊断真源。否。
- **独立 lifecycle 文件（单遍也分文件）**：用户要「都记录进 session、一条时间线」，分文件割裂时间线。否（只对分片 run 因「无聚合主会话」才另立聚合文件）。
- **只记 usage 不记全文**：看不到 prompt/response 正文，等于没记。否。
- **截断正文**：与「能点开看全量 tips」冲突。否（本轮选全量）。
- **分片 run 强制挂第一个 shard 主会话**：run 级步骤不是任一 shard 的属性，挂 s01 会歪曲时间线。否。

## Consequences

- **正**：viewer 在一条时间线看到任务起止 + 检视对话 + 修复 + tips + 总结 + 上报，可逐步骤追溯失败断点。
- **负 / 风险**：
  - 兼容主会话体积显著变大（全量 tips/summary prompt+response）；
  - `one-shot-llm.ts` 增加一个进程级 sink（全文），调用方（测试 / 其它入口）不装则零行为变化，但全文事件只在 CLI 真跑时安装；
  - 分片 lifecycle 会话给「兄弟 shard」新造一层父子关系，`session list` / `session delete` 的级联语义需要与 OpenCode 核对；
  - 生命周期留痕依赖 `mcp.json` 同源的 `onTaskCall` 回调——MCP 未开启时**没有** startTask/endTask/mrReviewResult/saveReviewSummary 事件（只有 candidate-repair + tips 进会话）。
- **中性**：原生转录、审计、`mcp.json`、`reviews_*.json` 全部不变。

## 验收标准

1. **单遍（进程面）**：一次真实/离线 run 后，`opencode/session-<runId>.json` 的消息序列 = system(startTask) → …agent 对话… → user/assistant(candidate-repair / tips) → … → system(endTask)；无 null、可 import。
2. **分片（单测）**：`opencode/session-<runId>-lifecycle.json` 存在，`info.parentID` 缺省（顶层），各 shard 主会话以其为父、末条 assistant 带 `subagent` part 指向 shard 会话。
3. **失败留痕**：tips 生成失败时，会话里仍有该步（`assistant` 无输出或 `tool` `state.status="error"`），`endTask` 缺席。
4. **真机 import**：`scripts/opencode-compat/verify.mjs` 扩展后对 lifecycle 会话同样 import/export 回读一致。

## 实施记录（2026-11-11）

| 文件 | 内容 |
|---|---|
| `src/shared/one-shot-llm.ts` | `OneShotLifecycleSink` + `setOneShotLifecycleSink` + 在 `completeOneShot` 成功/失败路径发全文事件 |
| `src/export/lifecycle.ts` | 进程级 `LifecycleCollector`（单调 seq 有序事件流）+ `buildLifecycleSession` 纯组装 + `writeLifecycleSessions`（单遍覆盖 / 分片聚合 + shard parentID 重写） |
| `src/cli/main.ts` | 安装 collector + one-shot sink + `onTaskCall` 双写；收尾 `writeLifecycleSessions` |
| 测试 | `lifecycle.test.ts`（顺序/形态/失败照记/无 null/id 唯一）、`bin.process.test.ts`（分片 lifecycle 聚合会话 + shard parentID 断言） |
