# 0085. 工具适配器：七工具 → `AgentTool` 只保留一份投影

**状态**：已接受（2026-11-14，用户决策：共享 `buildAgentTools`；预算/审计/计数由 hooks 注入；两片迁移；字节不变）
**关联**：[ADR-0016](0016-progress-events.md)（进度投影）、[ADR-0037](0037-mcp-progress-reporting.md)（MCP 上报）、[ADR-0039](0039-sharded-review-for-large-mrs.md)（分片）、[ADR-0051](0051-llm-call-retry-and-timeout.md)（重试分层）
**范围**：本仓 pi 线 0085。只改工具桥接层的结构：wire 名 / 入参剥离 / 失败文本 / 进度包装只保留一份；不改工具面、审计字节、进度事件、预算语义或检视结果。

## Context

主 loop（`loop/agent-review-loop.ts`）与规则 Skill 会话（`knowledge/skill-pass.ts`）各自把 `toolkit.schemas` 投影成 `AgentTool[]`。两份代码逐字重复：

- `JSON.parse(parametersJson)` + `knownArgumentKeys` + `stripUnknownArguments`；
- `toWireToolName(schema.name)` / `label = schema.name`；
- 失败文本 `Error: ${message}`。

差异只在 execute 内部：主 loop 有 `MAX_TOOL_CALLS` 预算、`toolCallLog` 审计与截断留痕；skill 会话只有一个调用计数。漂移已经发生——skill 适配器的注释明确写「无预算截断」。任何 wire 名、入参投影或错误字节的调整都必须改两处，测试也各测各的。

## Decision

### 1. 一个适配器

`src/tools/tool-adapter.ts`：

```ts
buildAgentTools(toolkit: ReviewToolkit, hooks: ToolAdapterHooks = {}): AgentTool[]
```

适配器拥有：

- `name = toWireToolName(schema.name)`、`label = schema.name`、description、parameters；
- `prepareArguments = stripUnknownArguments(args, knownArgumentKeys(parameters))`；
- 失败文本 `Error: ${message}`（唯一产出点）；
- 可选 `withToolProgress`（注入 `progress` 时才包装）。

### 2. hooks 契约

```ts
interface ToolCallInfo {
  readonly name: string;           // 点分审计名（schema.name）
  readonly argumentsJson: string;  // JSON.stringify(prepareArguments 之后)
}
interface ToolAdapterHooks {
  beforeExecute?(call): { kind: "run" } | { kind: "skip"; text: string };
  onResult?(call, result): void;
  onError?(call, text): void;      // 已是最终 "Error: …" 文本
  progress?: { emit: RunProgressSink; limits?: ToolProgressLimits };
}
```

适配器**无状态**；预算、审计、计数、截断留痕全部留在调用方 hooks 里。

### 3. 两个生产调用方

- **主 loop**：`beforeExecute` 检查 `executedToolCalls >= MAX_TOOL_CALLS`，耗尽时累加 `phaseSkippedToolCalls`、追加 `TRUNCATION_TOOL_BUDGET`、写 `toolCallLog` 并返回 skip 文本；否则预约预算并返回 run。`onResult` / `onError` 写 `toolCallLog`；`progress` 传 `emitProgress` + `progressLimits`。
- **规则 Skill 会话**：`beforeExecute` 只调 `toolCallCount += 1`；`progress` 传同一组 emit/limits（与原实现一致）；无预算、无审计。Skill bash 工具仍走既有的 `countToolCalls` + `withToolProgress`。

### 4. 两片迁移

1. 抽 `tool-adapter.ts` + 主 loop 切换；预算/审计/进度 hooks 原样搬入。字节不变。
2. Skill 会话切换；删除第二份投影；新增跨适配器一致性测试。

## Options（为什么不是别的）

- **只抽 `wireTool(schema)`**：否。execute 仍两份，预算与错误文本继续漂移。
- **让 Skill 会话复用 loop 的适配器**：否。两者的审计/预算策略不同，共享 hooks 才是正确的缝。
- **把预算/审计也塞进适配器**：否。适配器会重新长出两种模式的分支，depth 反而下降。
- **公开导出 hooks 类型**：否。包内工具桥接细节，不进 `src/index.ts`。

## Consequences

- **好**：wire 名、入参剥离、失败文本只有一处；主 loop 与 skill 会话不会再出现「一边加了、一边忘了」；适配器可用 fake toolkit 单测，不必驱动 Agent。
- **代价 / 风险**：多一层 hooks 间接；`beforeExecute` 的 skip 契约需要两个调用方都理解（预算 vs 计数）。
- **测试面**：`tools/tool-adapter.test.ts` 7 条（投影、成功/失败 hooks、skip 不执行、进度包装、无 hooks、跨适配器一致性）；现有 `agent-review-loop.test.ts`（预算 100 / 跳过批 / `toolCallLog`）与 `skill-pass.test.ts` 原样保留；全量 vitest 1040 passed、`pnpm test:replay` 6/6。
