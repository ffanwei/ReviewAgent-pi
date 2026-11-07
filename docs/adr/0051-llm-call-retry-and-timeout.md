# 0051. LLM 调用：分层重试与请求建立超时

**状态**：已接受（2026-11-07，用户决策）
**关联**：ADR-0035（pi 内核四包改 npm 依赖，不 fork 上游）、ADR-0045（MCP 业务 tool 的一次性模型调用：片级报文 / 收尾总结）、ADR-0048（离线 trace 回放）、ADR-0050（MCP 业务 tool 重试与 60 s 超时）
**范围**：本仓 pi 线 0051。只加「LLM 请求失败后的重试」与「单次请求的建立超时」；检视提示词、工具面、审计键、退出码、产物字节全部不动。ADR-0050 管的是 **MCP 业务 tool 的网络调用**，本 ADR 管的是 **模型网关调用**，两者互不替代。

## Context

一次检视会发起多类模型调用，失败代价与可恢复性并不相同：

| 路径 | 形态 | 失败时今天的表现 |
|---|---|---|
| 主检视回合 / 规则 Skill 会话 | pi-ai 流式会话（多轮工具循环） | 传输抖动 / 429 / 5xx 直接变成 `stopReason: "error"`，整次检视可能失败 |
| 片级报文 / 收尾总结 | CLI 裸 fetch 一次性 completion | 一次失败就降级为模板或丢弃该片语义字段 |
| 内置中文呈现引擎 | 核外模块逐请求 completion | 单字段失败留空 / 整次投影降级 |
| smoke 双探针 | 裸 fetch 诊断请求 | 一次失败即判不可达，可能把环境瞬时抖动报成致命错误 |

这些路径此前**没有任何可配置的重试**，也没有单次请求超时（只有整会话 / 整批的外层兜底）。结果是把「网络瞬断」与「确定性错误」同等对待：前者本可一次重试恢复，后者重试只会浪费退避时间并把失败日志放大成噪声。

同时，pi-ai（`0.85.1`）的 `stream()` 已经提供 `maxRetries` / `maxRetryDelayMs` / `timeoutMs`，其 `retryProviderRequest` 只包住 `chat.completions.create(...).withResponse()` 的**请求建立阶段**：拿到响应头之后流正文再断开，会折叠成 `stopReason: "error"`，不会自动重放。这与「不破坏 agent 消息状态」的边界刚好吻合。

## Decision

### 1. 分层实现，不做「一个开关全加」

重试落在各层自己的接入点，共享同一份配置与同一个核外原语：

- **Agent 内会话**（主检视回合、规则 Skill 会话）：不 fork pi-ai，通过 `reviewStreamFn` 透传
  `maxRetries = reviewTurnAttempts - 1`、`maxRetryDelayMs = maxRetryAfterMs`、`timeoutMs = reviewTurnMs`；
- **核外一次性调用**（片级报文、收尾总结）：走本仓 `shared/llm-retry.ts` 的 `runWithRetry`；
- **内置呈现引擎**：逐请求走同一原语，策略经 `PresentationRuntime.retry` 穿参；
- **smoke 探针**：同一原语，但缺省单次尝试。

### 2. 配置面：`limits.retry` + 两个新超时键

```jsonc
"limits": {
  "timeouts": {
    "reviewTurnMs": 180000,   // 主检视回合 / 规则 Skill 会话的单次请求建立超时
    "oneShotMs": 90000        // 片级报文 / 收尾总结的单次请求超时
  },
  "retry": {
    "maxAttempts": 3,          // 全局缺省：总尝试次数（含首次）
    "baseDelayMs": 500,        // 指数退避基准
    "maxDelayMs": 10000,       // 单次退避上限
    "maxRetryAfterMs": 30000,  // 服务端 Retry-After 上限；0 = 不设上限
    "reviewTurnAttempts": 3,   // 主检视回合 / 规则 Skill 会话
    "oneShotAttempts": 3,      // 片级报文 / 收尾总结
    "presentationAttempts": 3, // 内置呈现引擎逐请求
    "smokeAttempts": 1         // smoke 探针（缺省不重试）
  }
}
```

口径纪律：**`maxAttempts` 一律表示「总尝试次数（含首次）」**，`3` = 首次 + 2 次重试。pi-ai 的 `maxRetries` 是「重试次数」，换算只在 `reviewStreamFn` 调用方做（`attempts - 1`），不泄漏到配置面。路径级次数缺省继承 `maxAttempts`；`smokeAttempts` 例外，缺省固定 `1`，要重试必须显式配置。

`baseDelayMs` / `maxDelayMs` 只作用于核外一次性调用；Agent 层的退避由 pi-ai 固定（0.5 s → 8 s 带抖动），本仓只透传次数、`maxRetryDelayMs` 与超时。

### 3. 重试边界：只重试「请求建立阶段」

- **可重试**：传输异常（DNS / 拒绝连接 / 连接中断）、请求建立超时、HTTP `408` / `409` / `429` / `5xx`、`x-should-retry: true`；
- **不重试**：其余 `4xx`、`x-should-retry: false`、配额 / 余额类 `429`、超过 `maxRetryAfterMs` 的 `Retry-After`、以及确定性非法输出（非 JSON、缺 content、空 completion）；
- **流中断不重试**：已收到 200 之后流正文断开，不在该层重放，也不做整回合重放——重放会重复工具副作用并破坏 agent 消息状态。该失败按既有 `stopReason: "error"` 上报；
- 所有分类只看结构化信号（异常类型、HTTP 状态码、响应头、配额文案指纹），**绝不靠字符串猜状态码**。

### 4. 外部注入的呈现引擎不被强制

`presentation.engine` 可以是用户自备模块，本仓无法控制其内部是否重试。契约是：`PresentationRuntime` 新增可选 `retry` 字段并穿参；不读该键的引擎行为不变。CLI 侧的外层总超时按 `perFieldTimeout × presentationAttempts` 推导（`retryAttempts`），保证内置引擎重试不会突破兜底，也保证外部引擎无论是否重试都不会被外层提前掐断。

### 5. 离线回放 lane 固定单次尝试

离线回放按请求体 SHA-256 严格命中 trace（ADR-0048）：同一个失败响应重放多次仍是同一失败，重试没有收益，只会让请求计数与断言失真。回放 lane 生成的配置固定 `limits.retry.*Attempts = 1`，与产品缺省解耦。

### 6. smoke 探针缺省不重试

smoke 是**诊断**命令：用户需要的是「现在到底通不通」，而不是「重试几次后通不通」。缺省单次尝试；确有抖动环境可在配置里显式提高 `smokeAttempts`。

## Options（为什么不是别的）

- **一个总开关（`llm.retry: true`）统一全加**：否。Agent 会话、一次性调用、呈现引擎、诊断探针的失败代价与可重试性不同；统一开关会让「只想让 smoke 快」与「想让主会话更韧」互相绑架。
- **在应用层整回合重放 Agent 失败**：否。整回合重放会重复工具副作用、重复计费，并破坏 agent 消息历史；pi-ai 的请求建立阶段重试是唯一安全边界。
- **fork pi-ai 改退避参数**：否（ADR-0035）。上游已提供 `maxRetries` / `maxRetryDelayMs` / `timeoutMs`，透传即可；fork 会重新引入内核维护面。
- **对确定性输出（非 JSON / 空 completion）也重试**：否。`temperature: 0` 下同一请求重放得到同样结果，重试只会把一次失败拖成三次失败。
- **无限重试 + 长退避**：否。默认 3 次尝试覆盖绝大多数瞬断；`maxRetryAfterMs` 防止服务端要求几分钟等待时把进程挂死。

## Consequences

- **好**：瞬时网络 / 网关故障有恢复机会；确定性错误不浪费重试；Agent 层只重试请求建立阶段，不污染消息状态；配置面集中且可逐路径覆盖；smoke 行为保持「诊断快」。
- **代价**：最坏耗时从「1 × 单次超时」变为「尝试次数 × 单次超时 + 退避」。缺省下主检视回合单请求最坏约 `3 × 180 s + 退避`，报文 / 总结约 `3 × 90 s + 退避`，呈现按字段数放大。已有的外层总预算（`skillPassMs`、呈现总超时）仍然兜底。
- **测试面**：`shared/llm-retry.test.ts` 覆盖分类、退避、次数、`x-should-retry`、`Retry-After`、配额 429、malformed；`cli/one-shot-llm.test.ts` 覆盖一次性调用重试与降级；`provider/gateway-probe.test.ts` 覆盖探针缺省单次与显式重试；`shared/config.test.ts` 覆盖 `limits.retry` 解析、继承与越界；`run/sharded-review.test.ts` 固定单次尝试以保持「分片」用例语义。
- **与 ADR-0050 的关系**：ADR-0050 的「3 次尝试」是 MCP 业务 tool 的网络调用，退避 100 ms / 400 ms 由 MCP 客户端实现；本 ADR 的「3 次尝试」是模型网关调用，退避 500 ms / 1 s / … 由 `shared/llm-retry.ts` 实现。两者共享「只重试瞬时失败」的原则，但配置键、实现层与失败分类互不复用。
- **与 ADR-0048 的关系**：回放 lane 固定单次尝试；录制 / 断言 / 并发阶梯语义不变。
