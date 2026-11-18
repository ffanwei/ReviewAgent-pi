# 0102. 上下文窗口预算：发送前收窄输出 + 溢出 400 降预算重试

**状态**：已接受（2026-11-18，用户决策）
**关联**：[ADR-0071](0071-recalibrate-large-mr-defaults-for-128k.md)（按 128K 标定分片阈值；本 ADR 补上窗口本身的预算）、[ADR-0077](0077-buffered-stream-replay.md) / [ADR-0101](0101-retry-clean-eof-stream-truncation.md)（流重放；本 ADR 的降预算重试与它们正交）、[ADR-0087](0087-retry-policy-single-source-and-dead-backoff.md)（重试策略单源）、[ADR-0025](0025-user-config-file.md)（配置面）、[ADR-0026](0026-config-surface-engine-and-endpoint-tier.md)（官方 / 网关判档）、[ADR-0002](0002-poc1-model-pinned-to-deepseek-api.md)（官方直连 wire 字节）、[ADR-0093](0093-single-source-review-model.md)（模型单源与目录画像）
**范围**：本仓 pi 线 0102。新增 `reviewer.contextWindow` 配置与两段请求期保护（B / A）；不改提示词、六阶段骨架、Finding schema、审计键集、退出码语义。

## Context

2026-11-17 的线上失败：

```
review turn failed: 400: {"code":"InvalidParameter","type":"invalid_request_error",
"message":"This model's maximum context length is 204800 tokens. However, you requested
32768 output tokens and your prompt contains at least 172033 input tokens, for a total of
at least 204801 tokens...","param":null}
```

三个事实：

1. **项目没有上下文窗口配置**。`reviewer.maxOutputTokens` 只管输出（网关档恒发 32768），`limits.boundary` / `limits.split` 是 diff 字符级护栏，不是 token 窗口；会话经工具往返可无限增长（`MAX_TOOL_CALLS = 100` × 单结果 8,000 字符）。
2. **模型目录画像与网关不一致**。pi-ai 目录里 `deepseek-v4-flash` 的 `contextWindow` 是 **1,000,000**，实际网关是 **204,800**；ADR-0025 修订删除了 `models{}` 覆盖，用户无处写真实窗口。
3. **400 是确定性的**。`llm-retry` 只重试 408 / 409 / 429 / 5xx / 传输；ADR-0101 的重放要求流已建立并读到 EOF，而 400 在 `start` 之前，均不覆盖。ADR-0071 也已明确「撞窗口仍 exit 1，无重试、无降级」。

结果：输入 172,033 + 输出 32,768 = 204,801 > 204,800，一次请求直接杀死整次 run。

## Decision

### B：发送前按窗口收窄输出预算

新增配置：

```jsonc
"reviewer": {
  "contextWindow": 204800   // 正整数或 null；null = 用内核模型目录画像
}
```

每次逻辑流请求（主会话、规则 Skill 会话）在调用 provider 之前：

```text
window          = reviewer.contextWindow ?? model.contextWindow
estimatedInput  = estimateContextTokens(context).usageTokens
                + ceil(trailingTokens × 1.25)        // 上游估算器按 4 字符/token；
                                                     // ADR-0071 实测 3.2–3.9，故保守 ×1.25
available       = window − estimatedInput − 4096     // 与上游 CONTEXT_SAFETY_TOKENS 同值
requested       = maxTokensFor(baseUrl, reviewer.maxOutputTokens)  // 网关档 32768
effective       = min(requested, available)
```

- `available < 2048`（`MIN_OUTPUT_TOKENS`）⇒ **本地 fail fast**，零请求，错误信息指明 `reviewer.contextWindow` 与「减少工具读取 / 分片」；
- 官方直连且未配置 `contextWindow` ⇒ 维持「不发 `max_tokens`」的 ADR-0002 字节纪律；
- 官方直连但显式配置了 `contextWindow`，且目录默认输出预算会溢出 ⇒ 破例下发收窄值（唯一例外，显式配置才生效）；
- 估算器使用 pi-ai 公开子路径 `@earendil-works/pi-ai/utils/estimate`；`usageTokens` 是精确前缀，只对字符估算的 trailing 部分乘保守系数。

### A：上下文溢出 400 时降预算重试

在缓冲驱动器 `driveWithReplay` 内，终止事件为 `error` 且 `isContextOverflow(error)` 时（pi-ai 公开 API，覆盖各 provider 的溢出文案，不匹配本仓自写字符串）：

- 若 `maxTokens` 有值、重试次数 < **2**、且在重放预算内：
  - `next = max(2048, floor(maxTokens / 2))`；
  - 若 `next < maxTokens`，用新预算重发同一请求；
  - 否则停止；
- 400 发生在 `start` 之前，失败尝试没有任何事件交给 agent，**重试无工具副作用**；
- 重试次数独立于 `streamAttempts` / `replay` 序号（后者只数流中断重放）；时间线新增 `overflowRetry` 序号用于区分；
- 降预算重试是新的物理请求（wire 已不同），`onPayload` / `onResponse` 照常触发，审计 `requests[]` 会多一条；失败尝试没有 usage，不影响成本统计口径；
- `streamAttempts: 1`（离线回放 lane / 显式关闭重放）不走 `driveWithReplay`，A 随之关闭，保持零漂移。

### 观测

- `request-timeline.jsonl` 的 `request` / `attempt` 行新增可选 `overflowRetry`（1..N）；缺席 = 非该路径；
- 本地 fail fast 的 message 含估算输入、窗口与配置键名，便于直接定位。

## Options（为什么不是别的）

- **解析 400 文案里的 input / window 数字**：文案随 provider 漂移；`isContextOverflow` 只做布尔判定，A 用减半兜底更稳。否。
- **直接接上游 `streamSimple` 的 clamp**：本仓走 `deepseekProvider().stream`，且目录窗口（1M）与网关（204800）不一致，clamp 会算错；需要自己的配置面。否。
- **把网关档默认 `maxOutputTokens` 降到 16384**：只能降低概率，输入继续增长仍会溢出。否。
- **输入侧压缩 / 会话截断**：改动最大，且会丢证据；留作后续。否。
- **所有 400 都降预算重试**：参数非法、鉴权等确定性错误重试无意义。否。
- **A 消耗 `streamAttempts`**：两个轴的语义不同（流中断 vs 窗口溢出），混用会让配置不可解释。否。

## Consequences

- **好**：配置正确时 400 不再发生；估算偏高时本地零请求 fail fast；估算偏低时 A 用一次减半兜底。
- **代价 / 风险**：
  - `reviewer.contextWindow` 必须填网关真实窗口，否则 B 仍按目录 1M 计算，只能靠 A；
  - 估算不保证精确（CJK、图片、工具 schema 都可能偏差），A 是必要兜底；
  - A 最多增加 2 次快速 400 往返；输入本身超窗时最终仍失败，但错误更早、更明确；
  - 官方直连在显式配置窗口且默认预算会溢出时会破例发送 `max_tokens`，这是 ADR-0002 的唯一例外；
  - 降预算重试会让审计 `requests[]` 多出物理请求条目（wire 确实不同），依赖固定条数的下游需按逻辑请求聚合。
- **测试面**：`config.test.ts`（contextWindow 解析 / null / 越界）、`pi-client.test.ts`（B 收窄、本地 fail fast、A 溢出重试成功、非溢出不重试、持续溢出两次后失败、时间线 `overflowRetry`）。全量测试与包级 `tsc -p tsconfig.build.json` 通过。
