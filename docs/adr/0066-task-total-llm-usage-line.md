# 0066. 整任务 LLM 账本：日志补 Agent 之后的一次性调用消耗

**状态**：已接受（2026-11-09）
**关联**：[ADR-0030](0030-run-summary-line.md)（收尾总结行只算「检视本体」）、[ADR-0045](0045-mcp-business-task-tools.md)（片级报文 / 收尾总结的一次性调用）、[ADR-0051](0051-one-shot-retry-and-classification.md)（一次性调用重试分类）、[ADR-0060](0060-run-log-in-session-dir.md)（`review-pi.log` = stderr 镜像）、[ADR-0062](0062-one-shot-timeout-default-300s.md)（一次性调用超时）、[ADR-0065](0065-console-english-and-unified-tips.md)（取消呈现投影后 tips / 总结仍是核外一次性调用）
**范围**：本仓 pi 线 0066。只新增**日志观测**：不改变检视请求字节、审计 / `run.json` / stdout 契约、退出码、`doneLine` 既有口径。

## Context

`doneLine`（ADR-0030）与审计 `usage` 的口径是 `record.baseline.usage` = 主会话 + 规则 Skill 会话。它回答的是「六阶段检视会话花了多少」，不是「这次任务一共花了多少」。

Agent 结束之后，CLI 仍会发起三类一次性模型调用：

- 片级中文 tips 语义生成（`cli/report-payload.ts`，MCP 开启时每片一次；失败会二分拆批多次；MCP 关闭时收尾补一次）；
- 收尾总结（`cli/review-summary.ts`，有已上报 finding 时一次）；
- 候选修复（`loop/candidate-repair.ts`，Agent 内 Phase 6 前，整个 run 最多 2 次）。

这些调用都走 `shared/one-shot-llm.ts` 的 `completeOneShot`；该函数此前只读 `choices[0].message.content`，**不解析响应里的 `usage`**，token 在解析点就被丢弃。`CandidateRepairFn` 更是只返回候选数组，连调用次数都不回传。

因此 `review-pi.log` 里的 token / 模型调用 / 成本**系统性偏小**，且无法从日志判断「钱花在哪」。

`review-pi.log` 本身只是 stderr 镜像（ADR-0060），不需要独立日志通道；缺的是一条在进程收尾时打印的整任务总账。

## Decision

### 1. 一次性调用层采集 usage，进程级 sink 只给 CLI 用

`completeOneShot` 在「HTTP 2xx + 可读出 content」时用 `shared/wire-usage.ts` 的 `extractChatUsage` 解析原始 usage，折算为 `LlmUsage`：

```text
inputTokens    = max(0, prompt_tokens − cacheRead − cacheWrite)
outputTokens   = completion_tokens
cacheReadTokens / cacheWriteTokens = 原样（缓写 > 0 才带）
```

同时通过可安装的进程级 sink 发出一条样本：

```ts
{ modelId, purpose?: "tips" | "summary" | "candidate-repair", usage?: LlmUsage }
```

纪律：

- sink 缺省为 `null`，库调用方 / 单测零行为变化；
- 只有 CLI 的 `review` 命令安装 sink，并在命令收尾清除；
- 失败尝试不记样本（没有可用的 usage）；响应未带 usage 仍记样本，但 `usage` 缺席，调用次数照计；
- 样本绝不携带 apiKey、请求正文或响应文本。

### 2. 收尾打印两行整任务账本

在阶段账本 `[time]` 之后、进程退出之前打印（stderr，因此自动进入 `review-pi.log`）：

```text
[usage] 任务总计 | 模型调用 23 次（Agent 20 + 一次性 3） | token 输入 ...（未命中） | 输出 ... | 缓存命中 ...（..%） | $...
[usage] 一次性明细 | 中文 tips 1 次（输入 ... / 输出 ... / 缓存 ...） | 收尾总结 1 次（...） | 候选修复 1 次（...）
```

- 总计 = Agent 内（`record.baseline.usage`）+ 一次性调用；
- 明细只在确有一次性调用时出现，按用途分项；响应未带 usage 的调用在对应分项里显式标注；
- 零模型调用（更早的输入错误）不输出，避免空行噪声。

### 3. 成本按模型分桶

一次性调用的模型不一定等于检视模型：tips / 总结使用 `model.presentation`（ADR-0021 / ADR-0045 / ADR-0065），候选修复使用检视模型。总成本因此按 `modelId` 分桶后分别 `calculateCost`，不对总 token 套单一单价。

### 4. 数据边界不动

本 ADR **不修改**：

- `record.baseline.usage`、审计 `usage`、`run.json`；
- `doneLine` 的字段与口径；
- stdout、退出码、wire 请求字节。

一次性消耗只进 CLI 内存账本与 stderr 日志；需要审计也包含一次性调用时，另立决策升级审计口径。

## Consequences

- `review-pi.log` 第一次能回答「整个任务所有 LLM 调用花了多少 token / 多少钱」；
- 候选修复虽然发生在 Agent 内，也因走同一 one-shot 层而被计入总账，不改变 `pass.usage` 的既有含义；
- 重试中的失败尝试没有 usage 可采，总账只覆盖成功回包；这是可观测性边界，不是漏记；
- 进程级 sink 是 CLI 观测缝，不是内核状态；默认关闭保证库消费方零影响。
