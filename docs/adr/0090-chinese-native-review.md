# 0090. 中文原生检视：流程与产物直接使用中文，移除英文门与二次语义生成

**状态**：已接受（2026-11-14，用户决策：候选直接产出中文 + `tips` 语义块；删除 NON_ENGLISH 拦截；`reviews_en.json` 更名 `reviews_all.json`；重录全部回放轨迹）
**关联**：[ADR-0010](0010-inspection-language-pinned-english-with-out-of-kernel-translation.md)（检视输出恒英文——本 ADR 取代其核心决策）、[ADR-0017](0017-grouped-review-tips-export.md)（分组意见导出）、[ADR-0022](0022-stop-reviews-zh.md)（`reviews_zh.json` 停产）、[ADR-0045](0045-mcp-business-task-tools.md)（统一 tips 语义生成——本 ADR 将其并入候选）、[ADR-0052](0052-tips-four-tier-severity-and-confidence-filter.md)（tips 过滤口径不变）、[ADR-0058](0058-shard-report-splits-and-retries-on-failure.md)（报文分批重试——随生成调用一并退役）、[ADR-0065](0065-console-english-and-unified-tips.md)（控制台恒英文——本 ADR 取代）、[ADR-0077](0077-buffered-stream-replay.md)（轨迹重录）、[ADR-0083](0083-admission-as-data-and-deliver-skip.md)（`runReviewOutcome`）
**范围**：本仓 pi 线 0090。检视流程与最终产物改为**中文原生**：提示词、候选 schema、Finding 自然语言字段、审计人话、stderr 诊断全部中文；删除英文输出门（NON_ENGLISH）与片级语义生成的第二次模型调用；`reviews_en.json` 更名 `reviews_all.json`。结构化字段（id / severity / file / line / evidence 代码摘录 / rule / 工具名 / 配置键 / CLI 旗标）与代码标识符保持英文。CLI 参数、退出码、产物键集、12 键 tips 形状不变。

## Context

ADR-0010 时代的取舍：语言作为实验自变量需要冻结，故「英文产出 + 核外翻译」；ADR-0065 收窄为「片级语义生成产中文 tips」——但检视链本体仍是英文：Zone A 提示词要求英文输出、`NON_ENGLISH` 门拦截含 CJK 的候选、`reviews_en.json` 是英文真源、tips 需要一次**第二次模型调用**（按 finding id 生成 `review` / `suggestion` / `category` / `subcategory`）。评测仪器层已于 ADR-0024 废止，双语对照的历史理由不复存在；保留英文链意味着每次检视多一次串行模型调用、每条意见两次生成、以及「英文门拦截中文候选」的自相矛盾。

## Decision

### 1. 候选 schema 直接携带中文与 `tips` 语义块

Finding 在原十字段外增加 `tips?: { review, suggestion, subcategory }`（13 字段契约）；`title` / `description` / `tips` 各字段为中文，`category` 统一为中文七类（`REVIEW_CATEGORIES` 单源：可维护 / 安全 / 可靠性 / 可测试性 / 性能 / 可移植 / 可读性）。

- 提示词（Zone A 系统提示、六阶段指令、候选修复、skill 会话输出契约）全部中文化，十三字段 schema 与完整示例随附；
- 七检视工具的 `description` 与参数描述中文化；工具 wire 名 / 参数键 / JSON 键保持英文（wire 契约）；
- 归一化（`candidate-normalize`）：英文类别按确定性映射表归一到中文七类，未命中回落「可维护」并留痕；`tips` 缺失按宽容规则兜底（`review ← description`、`suggestion ← ""`、`subcategory ← ""`），不丢候选；
- 合并（`findings-merge`）：`tips` 取最高 confidence 条目，并列取 `review` 更长者；重编号后原样保留。

### 2. 删除英文输出门

- `RejectionStage` 移除 `NON_ENGLISH`；候选拦截链变为 SCHEMA_INVALID → NO_EVIDENCE → VERIFICATION_FAILED → OUT_OF_SCOPE → DUPLICATE_ID；
- 审计 `rejectionCounts` 不再有该键（接受字节变化）；
- 中文候选（title / description / evidence 含 CJK）不再被拦截。

### 3. tips 与 MCP 报文改为确定性投影（零模型调用）

- `cli/report-payload.ts` 的 LLM 调用路径（`buildShardReportResilient` 及 ADR-0058 分批重试）整体退役：报文组装变为纯函数——语义字段来自 `Finding.tips`，结构字段（code / filePath / lineNum / level / ruleId）按既有纪律组装；
- `reviews_tips_zh.json`（12 键）与 `mrReviewResult` 报文与候选产出**同一份语义**，不再是「第二次生成」的两个投影；
- delivery 的 `oneShot` port 只剩收尾总结一项；业务关闭时不再有「兜底语义生成」调用；
- `SemanticTipEntry` / `semanticByMergeKey` 登记流保留（片级捕获 `source` / `ruleId` 更准），聚合侧以 `Finding.tips` 兜底。

### 4. `reviews_en.json` → `reviews_all.json`

全部 merged findings（中文自然语言 + 结构化英文）的真源口径；`review-result.json` 下游约定名不变、内容与之逐字节相同；`reviewsPath` 字段名保留。旧 `reviews_en.json` 不再产出。

### 5. 审计 / 诊断人话中文化

`phaseLog.note`、候选拦截 reason、解析失败诊断、`检视回合失败` 等运行时人话改为中文；截断原因枚举（`TOOL_BUDGET_EXHAUSTED` 等）与 `Error: ` 工具失败前缀保持英文（wire / 契约面）。

### 6. 回放轨迹全量重录

六个场景（core-no-finding / core-single-finding / reporting-single-finding / rule-skill-single-finding / shard-two-file / large-mr）用**真实网关**（`REPLAY_UPSTREAM_*`）重录：中文提示词字节 + 真实模型回复冻结进 trace；场景期望从真实产物提取（`scripts/offline-replay/expect-from-run.mjs` + `re-record.sh`）；`once` 自检 6/6。canned 语料（`corpora.mjs`）同步改为中文候选 + `tips`，作为无网关重录的兜底。

## Options（为什么不是别的）

- **保留英文链 + 更强的翻译层**：否。每次检视多一次串行调用、每条意见两次生成，且「最终产物中文」与「流程英文」的结构性矛盾无法靠翻译消除。
- **候选产出英文 + 聚合时一次批量生成 tips**（即 ADR-0065 现状）：否。生成调用仍是第二次模型往返，且生成失败会整片丢 tips（本 ADR 前的「全灭」路径）。
- **`category` 保持英文枚举、tips 侧映射**：否。七类同时是 MCP 平台契约与 tips 字段，双轨映射表正是被本 ADR 删除的复杂度。
- **`reviews_en.json` 文件名保留、内容改中文**：否。名称撒谎；改名 `reviews_all.json` 并在 ADR 里写明迁移。
- **审计 reason / note 保持英文**：否。排障面是「流程中使用中文」的一部分；但截断原因与工具错误前缀是契约值，保留。

## Consequences

- **好**：流程单一语言，无翻译 / 无二次生成 / 无语言门；每次启用 tips 的检视**省一整次模型调用**（业务开 / 关同口径）；中文候选不再被拦截；报文组装确定性可测（纯函数）。
- **代价 / 风险**：候选 schema 十三个字段（tips 必填，靠归一化兜底）；`category` 七类约束模型输出（未命中回落留痕）；审计 `rejectionCounts` 少 `NON_ENGLISH` 键、`reviews_en.json` 改名——下游消费方需跟随（`review-result.json` 约定名不变）；全部回放轨迹重录（旧 trace 与新提示词字节不兼容）。
- **测试面**：1053 用例全绿（语料中文化 + tips 断言改从候选取值 + NON_ENGLISH 用例反转）；`pnpm test:replay` 6/6（真实网关重录）；`verify:pack` 全绿；`pnpm smoke` 真网关双探针通过。
