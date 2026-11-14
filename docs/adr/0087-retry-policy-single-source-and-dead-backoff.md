# 0087. Agent stream 重试策略单源，并清理 MCP 死退避

**状态**：已接受（2026-11-14，用户决策：抽 policy factory；只清单源与死值，不合并四条 attempt loop；两片迁移）
**关联**：[ADR-0050](0050-mcp-business-tool-retry-and-timeout.md)（MCP 重试）、[ADR-0051](0051-llm-call-retry-and-timeout.md)（分层重试）、[ADR-0077](0077-buffered-stream-replay.md)（流中断重放）
**范围**：本仓 pi 线 0087。只统一 **agent 内会话**的 stream 重试/超时/重放映射，并清理 MCP 两条 loop 的死退避值；不改重试语义、尝试次数、超时值、MCP 失败分类，也不合并 ADR-0050/0051 的分层。

## Context

两个 agent 调用点（主检视回合 / 规则 Skill 会话）逐字重复：

```ts
maxRetries: Math.max(0, runtime.limits.retry.reviewTurnAttempts - 1),
maxRetryDelayMs: runtime.limits.retry.maxRetryAfterMs,
timeoutMs: runtime.limits.timeouts.reviewTurnMs,
replay: { attempts, budgetMs, baseDelayMs, maxDelayMs },
```

「总尝试次数含首次」的 `-1` 换算与 replay 四字段因此有两份。`mcp/report.ts` 另有 `RETRY_BACKOFF_MS = [100, 400, 1600]`，但两条 loop 最多 3 次尝试，第三次退避值从未被消费；`?? 1600` / `?? 400` 兜底不可达。

## Decision

### 1. `provider/review-turn-policy.ts`

```ts
reviewTurnStreamOptions(runtime): {
  maxRetries;        // retryPolicyFor(limits, "reviewTurn").maxAttempts - 1，下限 0
  maxRetryDelayMs;   // policy.maxRetryAfterMs
  timeoutMs;         // limits.timeouts.reviewTurnMs
  replay;            // StreamReplayPolicy（streamAttempts / streamReplayBudgetMs / baseDelayMs / maxDelayMs）
}
```

两个 agent 调用点展开该块，只保留各自的 `timeline` 作用域；`apiKey` / `fetch` / `maxOutputTokens` 仍由各调用点传入。复用既有 `retryPolicyFor`，不另立「总尝试次数」口径。

### 2. MCP 退避清理

```ts
export const RETRY_BACKOFF_MS = [100, 400] as const;
export const MCP_MAX_ATTEMPTS = 3;
```

- 事件批量 loop 与业务调用 loop 都使用 `MCP_MAX_ATTEMPTS`（不再用数组长度当尝试数）；
- `sleep(RETRY_BACKOFF_MS[attempt - 1] ?? 0)`：`?? 0` 只是 `noUncheckedIndexedAccess` 的类型护栏；
- 删除 `?? 1600` / `?? 400`。
- 行为不变：3 次尝试、两次等待 100 / 400 ms。

### 3. 两片迁移

1. policy factory + 单测；两个 agent 调用点切换。
2. MCP 死退避清理 + `report.test.ts` 重试用例。

## Options（为什么不是别的）

- **合并四条 attempt loop（one-shot / 事件批量 / 业务调用 / 探针）**：否。会同时重开 ADR-0050 与 ADR-0051 的分层边界；本次只做单源与死值。
- **只清死退避**：否。agent 侧的 `-1` 与 replay 仍有第二份。
- **把 factory 放进 `shared/llm-retry.ts`**：否。`shared` 不应知道 provider 的 stream 选项。
- **只保留 `[100,400,1600]` 并删 `??`**：否。第三个值仍是死数据，读代码的人仍会以为有第三档退避。

## Consequences

- **好**：`-1` 换算、`maxRetryDelayMs`、`timeoutMs` 与 replay 四字段只有一处；两个会话不可能再分叉。MCP 退避序列与尝试次数一致，死值消失。
- **代价 / 风险**：多一个 provider 层 module；`MCP_MAX_ATTEMPTS` 与 `RETRY_BACKOFF_MS` 导出（包内测试用，不进公开面）。
- **测试面**：`provider/review-turn-policy.test.ts` 3 条（缺省映射、`reviewTurnAttempts=1 → 0`、覆盖值逐字段透传）；`mcp/report.test.ts` 新增「3 次尝试 + 100/400」；现有 `pi-client` replay 测试与全部 MCP 进程测试原样通过；全量 vitest 1051 passed、`pnpm test:replay` 6/6。
