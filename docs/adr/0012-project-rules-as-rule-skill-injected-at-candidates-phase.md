# 0012. 项目规则以「规则 Skill」承载，作为 config F 在候选阶段注入

**状态**：已接受（2026-10-26，用户经 grill 逐项决策 Q1–Q16）；**部分被 [ADR-0014](0014-rule-skill-review-pass-after-candidates-phase.md) 取代（2026-10-27）**——决策 3（注入点 = Phase 5 消息尾部）整条、决策 2 中的「单一 zip」限定，以及配套设计文档 §6 验收 2（审计单对象）；其余决策（F 的配置身份、不进 `search_rule`、降级不阻断、伪配置位）继续有效
**其后的身份变更**：F 的配置身份已被 [ADR-0024](0024-drop-config-matrix-and-config-identity.md) 取代（2026-10-31）——A–E 与 `configId` 一并删除，规则 Skill 成为唯一形态，不再以 config F 命名；本 ADR 其余决策（skill 包来源、Phase 5 注入点、降级不阻断、`--strict-rule-skill`）继续有效
**其后的输入面收窄**：[ADR-0027](0027-runs-layout-and-rule-skill-trust.md)（2026-10-31）——skill 包来源只剩**显式输入**（`--rule-skill-zip` / `--rule-skill <dir>`），本 ADR「从被检视仓库 `<repo>/.review-rules/` 自动捡包」的缺省口径作废（理由：规则包会指挥 `bash` 工具执行进程，不能让被检视仓库默认触发代码执行）；其余决策（不进 `search_rule`、降级不阻断、`--strict-rule-skill`）继续有效
**关联**：ADR-0009（pi 内核从 0 重写）、ADR-0011（切流 config E——F 是 E 基线上的消融位）、CONTEXT.md（Zone B「项目规则」槽位 / C3 Knowledge / 规则 Skill 术语）、`docs/design/规则 Skill 与 config F 方案——项目规则检视落地.md`

## Context

- 项目规则在 CONTEXT.md 被登记为 **Zone B（稳定中层）** 的一个元素，但 `packages/review-pi/src/zoneb/zone-b-builder.ts:230-236` 的 `## Project rules` 至今是 **POC1 占位段**（"No project-specific rules are configured … out of scope for this phase"）——即**已登记能力、尚未实装**。
- Zone B 仅存在于 **config B**：`packages/review-pi/src/run/review-run.ts:113` 只在 `prefetch !== undefined`（= B）时注入 zoneB 消息；E 与工具驱动线（C/D/E）没有 Zone B。故"把规则塞进 Zone B"只能影响 B。
- `docs/项目问答整理.md:635` 已预先记录方向："注入项目规则语料 … 用 **F 配置**做消融并测 Recall/Precision/token"。
- 纪律：`PHASE_INSTRUCTIONS` / `SYSTEM_PROMPT` / 七工具 schema 属**测量常量面**，A–E 逐字节冻结（ADR-0009、ADR-0011）；任何改字节的路必须落在**新配置**。

## Decision

1. **新增 config `F` = E + 规则 skill**（`toolsEnabled / stablePrefix / ledger = true`，`ruleSkill = true`；A–E 各补 `ruleSkill:false`，逐字节不变）。
2. **规则 skill 来源 = 被检视项目自带的约定目录 `<repoPath>/.review-rules/*.zip`**（真 kernel skill 包：`SKILL.md` + 内核 `loadSkills` 装载）。运行前由**宿主 shell** 解压到 `<out>/<experimentId>/.cache/rule-skills/<sha256>/`，**不写回被检视仓库**；网络下载留作后期。
3. **注入点 = 候选阶段（Phase 5）的消息尾部**：`AgentReviewLoopInputs.phaseBrief(phaseIndex)`，仅在 `phaseIndex === CANDIDATES_PHASE_INDEX(=4)` 返回简报；简报 = 内核 `formatSkillInvocation` 的 skill 块 + 英文-only / id 前缀 / 证据必填的约定段。`PHASE_INSTRUCTIONS` / `SYSTEM_PROMPT` / 工具面**零改动**。
4. **不做双路**：规则 skill 不进入 `search_rule` 语料（`KnowledgeCorpus.rules` 保持空）——即**规则 Skill 不是 C3 Knowledge**。
5. **失败降级**：定位/解压/装载任一失败 → 空规则 + 审计 `ruleSkill.degradedReason`，run 照常（`--strict-rule-skill` 才 fail fast）。
6. **度量面**：F 照 `REFERENCE_CONFIG_ID`（"claude-code"）先例作**伪配置位**——可进 `RunResult.configId` 与指标分组，**不进** A–E 主矩阵 / `labels.allowedConfigs` / S-A-B 判定。

## Options（为什么不是别的）

- **把规则填进 Zone B 的 `## Project rules` 槽位**：语义最贴（CONTEXT 本就把它登记在 Zone B），但 (a) Zone B 只服务 config B，F（E 基线）没有 Zone B；(b) 填实它 = 改 Zone B 字节 = 破 A/B 字节门与 `zone-b-vul4j-1.txt` golden。留作 B 线后续。
- **把规则喂 `KnowledgeCorpus.rules`（C3，走 `search_rule`）**：零提示词改动，但模型可能整轮不搜索（`runs/` 实测 65 run 中仅 43% 调过 `search_rule`，且 0 真命中），无法保证"规则检视"发生。
- **改 `systemPrompt` / 加第 8 个工具**：分别破 Zone A golden / 工具面 6 门（`tools/registry.test.ts`）。
- **给 E 挂 flag 而非新增 F**：同 configId 两次 run 字节会不同，破坏"配置 ↔ 仪器"一一对应（ADR-0009/0011 口径）。
- **自己渲染 skill 块**：放弃内核 `formatSkillInvocation` 的 `<skill>` 语义；**但复用时必须净化 `location`**（见 Consequences）。

## Consequences

- **正**：A–E 逐字节不变，六阶段 / 系统提示 / 工具 6 门全绿；F 的字节差**唯一定位**在 Phase-5 消息尾部（可对账、可消融）；规则来源单一（skill 包），投向明确（候选阶段）。
- **负/风险**：
  - **`formatSkillInvocation` 会把宿主绝对路径写进请求字节**——它用 `skill.filePath` 渲染 `location` 与 `References are relative to …`（`packages/agent/src/harness/skills.ts:40`），而 `skill.filePath` 是解压缓存的**绝对路径**（`skills.ts:303`）。直接复用 ⇒ (a) 触碰"请求无绝对路径/环境信息"纪律（Zone B 同纪律 `zone-b-builder.ts:16`；`codeintel/rg.ts:166` 错误字节须跨环境可复现）；(b) F 的字节随 `--out` / `experimentId` 漂移。**必须在 `buildRuleSkillBrief` 里把 `filePath` 净化成稳定伪路径（如 `.review-rules/<name>/SKILL.md`）后再交给 `formatSkillInvocation`**，并以 golden 断言"无绝对路径"。
  - `CANDIDATES_PHASE_INDEX` 在 `packages/review-pi/src/loop/agent-review-loop.ts:80` 是**模块私有 `const`（未导出）**，"复用"不成立；须在简报模块内自带 `RULE_CHECK_PHASE_INDEX = 4` 并以单测对齐，或显式导出。
  - **术语撞车**：CONTEXT.md 的「项目规则」现指 Zone B 槽位，本决策的载体是「规则 Skill」——已在 CONTEXT.md 消歧。
- **中性**：F 暂不入跨内核对齐门（`bytegate/semantic-parity`）与 `scripts/analyze-phase2.ts` 主矩阵。

跨仓限定语纪律：本 ADR 为本仓序列 0012；引用 DSH 兄弟仓决策须写全限定语「DSH 线 ADR-XXXX」。
