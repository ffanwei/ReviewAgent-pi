# 0080. `--model` 不可用时的前置探测与单边降级

**状态**：已接受（2026-11-13，用户决策：启动前置探测 + 默认关闭 + 只认 model-not-found + 只做 `--model → model.default` 一条边）
**关联**：[ADR-0025](0025-user-config-file.md)（配置是唯一来源、env 层关闭）、[ADR-0021](0021-presentation-model-follows-review-model.md)（`model.presentation` 跟随本次检视模型）、[ADR-0045](0045-mcp-business-task-tools.md)（`startTask` 早于 diff、预检失败也要有始有终）、[ADR-0051](0051-llm-call-retry-and-timeout.md)（分层重试与超时）、[ADR-0066](0066-task-total-llm-usage-line.md)（任务总 LLM usage 账本）、[ADR-0080 相关实测](../../packages/review-pi/src/provider/gateway-probe.ts)（探针的 8 类结构化诊断）
**范围**：本仓 pi 线 0080。改 `reviewer` 配置面一个键、CLI 启动时序（新增一次可选探测）、审计与 `run.json` 一个可选键、MCP 总结一行；不改 stdout JSON 键集、不改 `smoke` 命令、不新增 CLI 旗标、不动单次请求的序列化字节。

## Context

平台 / 运维常以 `--model ep-xxxx`（接入点 ID）驱动检视，`model.default` 则写的是网关上稳定可用的模型。接入点被下线 / 改名 / 未部署时，`--model` 的第一次真实请求会被网关以 404 拒绝，而 `model.default` 仍然可用。

今天的行为是**一路跑到第一次模型请求才失败**：

- 失败点晚于 MCP `startTask`、`runs/<taskId>/` 建目录、规则包装载、diff 解析与进度头打印；
- 错误文本是 pi-ai 折叠后的原始文案（`404: {"error":...}`），没有 `smoke` 那套人话归类；
- 重试口径对此无解：pi-ai 只重试 `408/409/429/5xx/无 status`，**404 不重试**（一次即死，这也意味着"先试一下"很便宜）。

同时，"自动换模型"与仓库的三条既有纪律直接冲突，必须先定边界：

1. **一次 run 只有一个 `model`**：审计 / `run.json` / `reviews_en.json` / 成本计算 / 进度头都是单值；
2. **模型是评测量**（ADR-0008）：静默替换会让"这份检视是谁做的"变成假话；
3. **失败面不扩大**：本仓刚把 `smoke` 的双探针当作**独立诊断命令**，不默认参与检视（ADR-0051 第 6 条：诊断要快、要单次）。

## Decision

### 1. 配置面：一个键，默认关闭

```jsonc
"reviewer": {
  "modelFallback": "off"   // "off" | "on-model-not-found"
}
```

- 值域区分大小写；非法值装载期 fail fast（不静默取缺省）。
- **默认 `off`**：探测一次都不发，逐字节维持旧行为。ENV 层仍是关闭的（ADR-0025），也不新增 CLI 旗标——开关是部署策略，不是本次检视的事实；给旗标等于把"要不要静默替换"的裁量权下沉给调用方。

### 2. 时序：`startTask` 之后、读 diff 之前

```
loadConfig → requireApiKey → 参数回显 → MCP 建连 → startTask
  → ★ 前置探测（只在开关打开且 --model 显式传入且两名不同）
  → reportRuntime（用生效模型）→ 读 diff → startProgress → runReview
```

- 在 `startTask` 之后：保持 ADR-0045 的"建连点早于 diff、预检失败也要有始有终"。abort 决策在 `try` 内抛出（先在 try 外记下），保证 `finally` 的 `endTask` 照发。
- 在 `reportRuntime` 之前：否则展示档模型 id 会在替换前固化。
- `runId` 仍取"首次真实模型请求时刻"，探测不参与。

### 3. 判定：只认 `MODEL_NOT_FOUND`，探针只做顾问

先剥前缀（`reviewer.stripModelPrefix`）再比较；`--model` 与 `model.default` 相同则不探测。

| `--model` 探测 | `model.default` 探测 | 行为 |
|---|---|---|
| `ok` | — | 用 `--model`，静默 |
| 非 404（401/429/5xx/不可达/畸形/400） | 不探 | 用 `--model`，照常开跑 |
| 404 | `ok` | 换 `model.default`，stderr 一行 + 留痕 |
| 404 | 非 404 非 ok | **照样换**，stderr 附探测结论，让真实请求裁决 |
| 404 | 404 | **中止**（`exit 1`），一条错误同时点名两个 id |

- **不把 400 放进来**：400 在本仓语义里还覆盖"模型不支持 function calling / 画像不匹配"，替换会把配置错误降级成换模型重跑。
- **探针是顾问不是守门员**：探针请求与真实检视请求不等价（无 tools、无 `reasoning_effort`、`max_tokens:1`），任何非 404 的探测结论都不改变行为，避免让探针成为新的失败源。
- **单向且全 run 生效**：开跑前定死；主回合、Skill 会话、候选修复、tips / 总结一律用生效模型，不再回头试主模型。

### 4. 留痕：三处，无替换时零字节

1. stderr 一行（中文，沿用现有诊断风格；参数回显仍保留用户传的原始 `--model`）；
2. 审计与 `run.json` 的可选键（无替换整键缺席）：
   ```json
   "modelFallback": { "requested": "ep-xxxx", "used": "deepseek-v4-flash", "reason": "model-not-found" }
   ```
   分片审计不重复该键（每片的 `model` 已是生效值），只在聚合审计记一次；
3. MCP `saveReviewSummary`：真发生替换时在**模型生成的**总结末尾追加一行说明；固定模板总结（无意见 / 无上报 / diff 超大）不追加——那些场景没用到模型。

stdout JSON 键集不变（它目前不含 `model`，加键是独立决定）。

### 5. 记账与预算

- 探测请求**不计入**任务总 LLM usage（ADR-0066）：它是环境检查而非检视工作，`smoke` 的两条探针同样不计账。
- 超时复用 `limits.timeouts.probeModelMs`，不新增配置面；重试沿用 `smokeAttempts`（缺省 1 = 不重试，诊断要快）。

## Options（为什么不是别的）

- **首次调用失败后再换（mid-run fallback）**：否。失败分类在 Agent 路径只剩 pi-ai 折叠后的字符串；分片会"第 1 片用主模型、第 2 片换默认"；一次 run 的 `model` 字段只能记一个值，中途换就让审计失真。
- **探针当守门员（探测失败即中止）**：否。探针与真实请求不等价，会把一次网络抖动 / 一次 `max_tokens:1` 被拒变成致命错误。
- **默认开启**：否。平台读的是 stdout / MCP，看不到替换；默认开会让"这次检视是 `ep-xxxx` 做的"在平台侧永久失真。
- **退化为只给错误提示（不自动换）**：否作为主方案。它解决了可读性，但没解决"平台传错 id 就跑不出结果"的原始诉求；可作为 fallback 关闭时的现状保留。
- **补齐 400 / 429 也换**：否。见 §3 的两条理由（400 语义、换模型治不了限流/配额）。
- **把 `model.default` 缺失再回落到内置 `deepseek-v4-flash`**：否。本 ADR 只做一条边；`model.default` 是用户声明的默认，写错应原样报错。

## Consequences

- **好**：平台传了一个已下线的接入点时，run 仍能产出结论；坏消息以一行 stderr + 审计键 + 平台总结三处可见；默认关闭保证现有部署、现有测试与现有字节契约零变化。
- **代价 / 风险**：
  - 开启后每次 run 多一次计费探测请求（`max_tokens:1`，成本可忽略）与一个 RTT；
  - 探针可能与真实请求结论不一致（假阴性 / 假阳性）；本 ADR 选择"假阴性也不换"（顾问原则），代价是这类环境的失败仍沿用今天的报错；
  - `model.not-found` 之外的失败（例如模型不支持工具）不会触发替换——这是有意为之，需要在排障文档里说清。
- **测试面**：`provider/model-fallback.test.ts` 锁判定表与探测编排（注入 probe，零网络）；`shared/config.test.ts` 锁缺省 / 枚举 / fail fast；`bin.process.test.ts` 锁进程面五件事——替换成功（stderr + audit + `run.json` + wire 全用生效模型）、两边 404 中止（exit 1、stdout 干净、只发两条探针、无审计）、缺省 off 零探针、顾问原则（主模型探针 429 不替换）、MCP 总结追加说明。
