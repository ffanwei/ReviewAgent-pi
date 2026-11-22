# 0115. 一次性调用的空回包 / 截断重试（F-17）

**状态**：已接受（2026-11-22，F-17 实施完成）
**关联**：[ADR-0045](0045-mcp-business-task-tools.md)（one-shot 缝）、[ADR-0051](0051-oneshot-retry-classification.md)（重试分类）、[ADR-0076](0076-request-timeline-observability.md)（请求时间线）
**范围**：只改 `provider/one-shot-llm.ts` 的逻辑重试；不改传输重试分类、不改流式检视会话。

## Context

F-05 回放：推理模型在 1536 token 预算下 13/103 条回包 content 为空或截断，
`parseFindingVerdict` 无法解析；把预算提到 4096 并允许一次重发后降为 0。
同类风险存在于片级报文、总结、候选修复等 one-shot 调用。

## Decision

`completeOneShot` 在以下条件满足时**再发一次逻辑请求**（最多一次）：

- 首次结果 `ok=true`，且 `text.trim() === ""` 或 `finish_reason === "length"`；
- 调用方未显式传 `retryOnTruncation: false`。

重试请求的 `maxTokens` 取首次的两倍（首次未设时取 4096，上限 65536）；两次 usage 相加；
仍失败则返回第二次的结果。

独立证伪模块（`gate/independent-verifier.ts`）传 `retryOnTruncation: false`，
由它自己的“解析失败重发一次”负责，避免叠加成最多 4 次。

## Consequences

- 空回包/截断从“调用方解析失败”变为“一次预算翻倍重试”，对推理模型更稳；
- 只有异常回包才会多一次请求，正常回包行为不变；
- 时间线会看到两次逻辑尝试；usage 记账包含两次；
- 回滚：调用方传 `retryOnTruncation: false`，或恢复该段逻辑。
