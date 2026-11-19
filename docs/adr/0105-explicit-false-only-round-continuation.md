# 0105. Evidence Verification 的 complete 只在显式 false 时续轮

**状态**：已接受（2026-11-19，用户决策）
**关联**：[ADR-0046](0046-configurable-max-rounds.md)（轮次上限与最后一轮强制 complete）、[ADR-0096](0096-phase-json-parse-retry.md)（阶段 JSON 解析重试与三层恢复）、[ADR-0047](0047-tolerant-model-json-extraction-and-parse-failure-visibility.md)（解析失败可见性）
**范围**：只收窄 Phase 6 `complete` 的解析口径。六阶段指令、请求字节、`limits.loop.maxRounds`、候选拦截链、审计 / `run.json` / 产物形状均不变。

## Context

ADR-0046 之后，轮次决策是：

```text
complete = 模型返回的 complete
if complete                         → 停
if round >= maxRounds               → 强制 complete = true，停
else                                → 开下一轮（完整六阶段重跑）
```

问题出在第一行的解析口径。`parseVerificationReply` 原先只认严格相等：

```ts
const complete = record.complete === true;
```

于是 `complete` **字段缺失、写成字符串 `"true"`、写成 `null` 或任何非布尔值**，都会被读成 `false`，进而触发一次完整的六阶段重跑（约 6 次模型请求 + 重复上下文）。这不是“模型明确要求再审”，而是“模型漏写/写歪了一个开放判据字段”被放大成成本最高的恢复路径。

该字段本身没有可执行判据（ADR-0046 记录：只有提示词一句开放定义，代码零推导，且与 `verdicts` 正交）。既然它只是“要不要再来一轮”的意愿信号，**没有信号时应默认停止**，而不是默认重跑。

## Decision

### 1. 只有显式布尔 `false` 才请求下一轮

`parseVerificationReply`（`shared/parse.ts`）对**结构完整（含 `verdicts` 数组）**的回复改为：

```ts
const complete = failure === undefined
  ? record.complete !== false
  : record.complete === true;
```

- `complete: false` → 续轮（受 `maxRounds` 上限约束，语义不变）；
- `complete: true` / 缺失 / `"false"` / `"true"` / `null` / 其它值 → 视为完成，立即停。

### 2. 结构不可用的回复仍保留轮级恢复

非 JSON、非对象等解析失败分支保持 `complete: false`。连 `verdicts` 数组都没有的结构不完整回复也按保守口径处理：**只有显式 `true` 才停，其余仍按续轮**。理由与字段缺失不同：此时**核验根本没有发生**（`verdicts` 为空，全部候选会被 `VERIFICATION_FAILED` 拦下）；先走同阶段重试 / 离线 salvage / 短窗口修复（ADR-0096），仍失败时保留一次轮级恢复机会，避免静默产出 0 findings。该路径仍由 `maxRounds` 封顶。

### 3. 离线 salvage 不再把 complete 当验收字段

`salvageVerificationReply`（`loop/json-salvage.ts`）原先要求 `typeof complete === "boolean"`，缺失即拒绝 salvage。现改为：`verdicts` 数组合法即可 salvage；`complete` 缺失 / 非布尔值按 `true`，只有显式 `false` 保留续轮意图。裁决条目本身的字段完整性与条目数验收不变。

### 4. 不改提示词

Phase 6 指令继续要求模型输出 `complete`。本次只改“没收到明确信号时怎么处理”，不动请求字节，离线回放的请求指纹不受影响。

## Options（为什么不是别的）

- **整体移除 `complete` 字段**：等于删除多轮机制，`limits.loop.maxRounds` 变成死配置，还牵连 Phase 6 指令、解析契约与审计叙述；为一个“漏字段放大成本”的问题付出产品能力代价，放弃。
- **维持严格 `=== true`**：字段缺失即重跑，正是本 ADR 要修的行为；放弃。
- **要求显式 `true` 才算完成**：比现状更严，且与“默认停止”的意图相反；放弃。
- **缺失时记审计 note 再续轮**：留痕不改变“多跑一轮”的成本；观测价值不足以抵消成本；放弃。

## Consequences

- **正**：模型漏写 `complete` 不再触发约 6 次请求的完整重跑；轮次成本更可预测。
- **负/风险**：模型若真想说“再审一轮”却写歪了字段，将不再续轮。由于该判据本就开放且无判据可校验，这个损失可接受；需要多轮的场景应显式输出布尔 `false`。
- **中性**：显式 `false` 的续轮路径、`maxRounds` 上限、最后一轮强制 complete、截断语义（`truncated` 只由模型输出撞上界翻转）全部不变；审计与产物形状不变。

## 验收标准

1. **字段缺失**：Phase 6 返回合法 `verdicts` 但无 `complete` ⇒ `rounds=1`、`complete=true`、不再发第二轮请求。
2. **非布尔值**：`"complete":"false"` / `"complete":null` ⇒ 视同完成，不续轮。
3. **显式 false**：`"complete":false` ⇒ 仍按 `limits.loop.maxRounds` 续轮；到上限强制 complete。
4. **不可解析**：Phase 6 整段非 JSON ⇒ `complete=false`，走既有恢复链后仍可触发轮级重试。
5. **salvage**：`verdicts` 可修复但缺 `complete` ⇒ salvage 成功且按完成处理；显式 `false` 保留续轮。
6. **测试**：`pnpm --filter @baize/review-pi test`、`pnpm --filter @baize/review-pi typecheck` 全绿。
