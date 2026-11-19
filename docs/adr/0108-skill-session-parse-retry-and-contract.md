# 0108. Skill 会话解析失败：同会话重试一次 + 输出外壳契约强化

**状态**：已接受（2026-11-19，用户决策）
**关联**：[ADR-0096](0096-phase-json-parse-retry.md)（主 loop 的三层解析恢复；本 ADR 把同会话重试扩展到规则 Skill 会话）、[ADR-0014](0014-rule-skill-review-pass-after-candidates-phase.md)（独立 skill 会话）、[ADR-0107](0107-skill-get-file-pack-fallback.md)（skill 包内文件读取）
**范围**：只改规则 Skill 会话的解析失败处理与首条 user 消息的输出契约。主 loop 的阶段解析、候选门、Finding schema、工具面、MCP / tips 均不变。

## Context

生产日志：

```text
skill nine-code-review-rules FAILED · 6 req · 5 tools · 244.6s · 深度推理回复没有 candidates 数组
```

事实：

- Skill 会话正常跑了 6 次模型请求、5 次工具调用，耗时 244.6s，远低于 `limits.timeouts.skillPassMs`（缺省 1200s）：不是超时、不是网络错误；
- `failureStage: "parse"`；`parseCandidatesReply` 返回 `missing-key`——最后一条 assistant 文本里有可解析的 JSON 对象，但 `candidates` 缺失或不是数组；
- `runSkillPass` 对解析失败**没有任何恢复**：一次 `parsed.note !== undefined` 就直接 `failure(..., "parse")`，该 skill 本轮的全部候选丢失；
- 主 loop 的 Phase 5/6 已有 ADR-0096 的三层恢复（离线 salvage → 同会话短提示重试 → 短窗口 LLM 修复），但规则 Skill 会话没有接过这套恢复。

最常见的触发形态：

1. SKILL.md 自带输出格式（`findings` / `issues` / `violations` / 报告表格），模型照它输出；
2. 最后一条是总结/状态 JSON，不是候选清单；
3. `candidates` 存在但不是数组（对象 / 字符串 / null）；
4. 模型先输出中间说明文本，会话在第一个无 toolCall 的文本回合结束。

## Decision

### 1. 解析失败后在同一会话内重试一次

`runSkillPass` 在 `shouldStopAfterTurn` 结束、provider 错误检查通过后解析最后一条 assistant 文本。若 `parseCandidatesReply` 返回 note：

- 计算 `remainingMs = skillPassMs - 已用时间`；**剩余预算为 0 则不重试**，直接 `failed/parse`；
- 否则在同一 `Agent` 追加一条 user 消息（`skillParseRetryMessage`），要求只输出候选 JSON 外壳；不重发 skill 内容、不重跑工具检索；
- 再次解析：
  - 成功 ⇒ 正常返回（`ok` / `empty`），`requestCount` / `usage` 包含重试；
  - 仍失败 ⇒ `failed/parse`，`degradedReason` 带「已重试 1 次」；
  - 重试超时 ⇒ `failed/session`，原因带「(format retry)」；
  - 重试 provider 错误 ⇒ `failed/session`。

总时长仍以 `limits.timeouts.skillPassMs` 为硬上限；重试只发生一次。

### 2. 输出外壳契约强化

`skill-pass-brief.ts` 的首条 user 消息新增：

- **输出格式以宿主契约为准**；SKILL.md 只覆盖规则、证据与严重级，不得改变 JSON 外壳；
- 即使没有候选，也必须输出 `{"candidates": []}`；
- 不要使用 `findings` / `issues` / `violations` 等其它键，也不要在 JSON 前后添加解释或总结。

### 3. 不去猜语义

不在宿主侧静默把 `findings` / `issues` 映射成 `candidates`：不同 skill 的同名键语义未必等价，错误映射会把非候选对象送进候选门。重试提示只要求模型自己改写外壳。

## Options（为什么不是别的）

- **只加强提示词**：模型仍会漂移；生产已经出现一次写歪就整段失败，放弃。
- **离线 salvage 优先**：`extractModelJson` 已做围栏/前后白话/多对象提取；`salvageCandidatesReply` 只修 JSON 语法，治不了“外壳键不对”。保留为后续增强，不作为本 ADR 的前置。
- **短窗口 LLM 修复**（主 loop 第 3 层）：能修，但多一次独立模型调用与超时/成本面；同会话重试更便宜且模型能看到自己的错误回复。放弃作为 P0。
- **静默归一化 `findings` → `candidates`**：语义风险高；放弃。
- **重试多次 / 不限次**：成本不可控；一次足够覆盖输出漂移。

## Consequences

- **正**：输出格式漂移不再直接丢掉整个 skill 的候选；失败原因明确区分「重试后仍失败」与「预算不足未重试」。
- **负/风险**：最坏情况每个失败 skill 多一次模型请求；skill 会话的请求字节（首条 user 消息）变化，规则 Skill 相关回放 trace 需要重新录制。
- **中性**：`RuleSkillPassRecord` 形状、`skill`/`round`/`requestCount`/`toolCallCount` 口径不变；重试请求计入同一会话的计数与 usage；转录包含重试消息。

## 验收标准

1. 首轮回复 `{"findings":[]}`、重试回复 `{"candidates":[...]}` ⇒ `status: ok`、`requestCount: 2`、候选正常返回。
2. 两轮都不含 `candidates` 数组 ⇒ `status: failed`、`failureStage: parse`、原因含「已重试 1 次」。
3. 重试提示只追加一条 user 消息，不重发 skill 内容、不重跑之前的工具调用。
4. 重试超时 / provider 错误 ⇒ `failed/session`，不透传成成功。
5. 首轮解析成功 ⇒ 不重试（请求数与既有行为一致）。
6. 首条 user 消息包含：输出外壳以宿主契约为准、无候选必须 `{"candidates": []}`、禁止 `findings/issues/violations`。
7. **测试**：`pnpm --filter @baize/review-pi test`、`pnpm --filter @baize/review-pi typecheck` 全绿。
