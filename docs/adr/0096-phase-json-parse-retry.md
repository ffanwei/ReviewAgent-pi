# 0096. Phase 5/6 JSON 解析失败：离线 salvage + 同会话重试 + 短窗口修复

**状态**：已接受（2026-11-16，用户决策：先修 JSON 问题再继续测评）
**关联**：[ADR-0016](0016-progress-events.md)（phaseLog 审计）、[ADR-0094](0094-review-grouping-and-bounded-concurrent-passes.md)（分组/分片、partial success）、[ADR-0095](0095-rule-catalog-and-heterogeneous-skill-overlay.md)（规则目录）
**范围**：本仓 pi 线 0096。只改 Phase 5 候选 / Phase 6 裁决的回复解析失败处理与审计；不改 Finding schema、不改阶段指令、不改工具面。

## Context

AACR-Bench v2 test12 实测暴露：模型偶尔输出畸形 JSON（例如候选数组分隔符处多一个引号），当前 `parseCandidatesReply` 记 `parseFailure` 后直接按空候选推进，整条样本 0 findings。

实测影响：

- 主跑 11 条中 3 条 Phase 5 `missing-key` → 0 findings；
- FreeCAD 大 diff 分组 16 片中 5 片同样失败，且正好是全部 0-finding 片；
- 失败样本重跑后全部恢复（5/4/5 findings），说明是**输出稳定性**问题，不是模型判断能力问题。

OCR（open-code-review）的处理值得借鉴：

- 评论通过 `code_comment` 工具提交，不要求整段自由文本 JSON；
- `internal/tool/comment_args_repair.go` 做确定性修复，并用条目数/已知字段/截断检查严格验收；
- 修复失败时把 parse error 作为 tool result 回灌，模型在同一会话里重发。

本地实验：把 OCR 的引号修复算法套到本次畸形回复上，能 parse 但 7 个候选只恢复 1 个；在“不丢候选”的验收下会被拒绝。因此纯本地修复不能作为唯一手段。

### 历史失败归因（9 条真实回复）

用本次 test12 的 3 条主失败 + FreeCAD 的 6 个失败 shard 做了离线复盘：

- 全部 9 条的 `stopReason` 都是 `stop`，不是 `max_tokens` 截断——是模型把 JSON 写坏了，不是输出被砍断；
- 5 条是中段引号/结构错位（多余引号、缺 `{`、对象/数组括号不匹配）；
- 4 条是末尾对象未闭合（缺最后一个 `}` 或 `]` 前的 `}`）。

按当前严格验收跑本地 salvage：

- **3/9 可以不丢候选地修复**（缺末尾 `}`、缺 `]` 前的 `}`、正文裸引号 + 良性扩展字段 `tips_placeholder`/`confidence_note`）；
- **6/9 必须依赖 LLM**：本地修复要么无法解析，要么只能恢复 1/N 条候选（例如 three.js 只恢复 1/8），按“条目数不少于原文 `"id":` 数”会被拒绝。

结论：本地修复是有效的零成本快路径，但只能覆盖约三分之一；同会话重试和短窗口 LLM 修复仍是必需的。

## Decision

1. **第 1 层：离线 salvage（0 token）**：用 OCR 式引号/控制字符/非法反斜杠修复整段回复，再按严格验收（条目数不少于原文 `"id":` 出现次数、字段齐全、无未知字段）决定是否接受；有损恢复直接拒绝。
2. **第 2 层：同会话重试一次**：离线 salvage 失败且失败类型不是 `truncated` 时，向当前会话追加一条**短 user 提示**（不重发阶段指令、不重跑工具检索），要求模型只重新输出本阶段 JSON；最多 1 次。
3. **第 3 层：短窗口 LLM 修复一次**：重试仍失败时，只把畸形回复（上限 32K 字符）+ schema 发给模型做语法修复，不带会话/diff/工具证据；run 级最多 2 次（Phase 5/6 各一次）。
4. **失败有界**：三层都失败后按原行为推进（Phase 5 空候选、Phase 6 `complete=false`），不无限重试。
5. **截断不重试也不修复**：`truncated` 说明输出被 `max_tokens` 截断，缺失内容无法靠修复补出；保持现状并留痕。
6. **不重跑六阶段**：离线 salvage 不调用模型；同会话重试复用现有会话缓存；短窗口修复是独立小请求，不重新检索文件。
7. **审计可机读**：`PhaseRecord` 新增可选 `parseRetries`、`parseRecovered`、`parseRecovery`（`offline` / `retry` / `short-llm`），能区分恢复来源。
8. **Skill pass 顺序不变**：恢复发生在 `runRoundSkillPasses` 之前；只有 Phase 5 解析成功后才跑规则 Skill 增量。

## Options（为什么不是别的）

- **纯本地修复作为唯一手段**：本次真实畸形只恢复 1/7 条候选，且可能“解析成功但内容被改坏”；因此只作为第 1 层快路径，必须带条目数/字段/未知字段验收。
- **独立短修复模型**：只发畸形回复 + schema，成本约 5–6K input；现在作为第 3 层兜底，只在离线与同会话重试都失败后使用，且有 run 级次数上限。
- **重跑整个 Phase 5（含工具检索）**：会重新发 ~28K 上下文并可能重新检索文件，成本高；同会话重试已能看到上次输出，不需要重跑。
- **改成工具调用输出候选**：最彻底，但涉及阶段消息、流式解析、provider 工具支持，留作后续架构项。

## Consequences

- **好**：偶发 JSON 畸形不再整条/整片归零；审计能区分“模型没找到问题”和“解析失败后恢复”。
- **代价/风险**：解析失败时最多多一次同会话生成 + 一次短窗口修复；模型可能重复同样错误，但有次数上限且保持原有有界推进。离线 salvage 命中时零额外调用。
- **测试面**：离线 salvage 的成功/有损拒绝/未知字段拒绝、Phase 5 重试成功/仍失败、Phase 6 重试成功、短窗口修复成功/失败、`truncated` 不修复、审计字段、进程级 stderr/退出码不变。
