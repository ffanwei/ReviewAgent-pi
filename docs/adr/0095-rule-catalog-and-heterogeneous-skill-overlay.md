# 0095. 规则目录与异构技能叠加（declarative vs opaque）

**状态**：已接受（2026-11-16，用户决策：声明式规则统一目录、黑盒技能 union-scope/delta、内置 12 条先行、OCR pack opt-in）
**关联**：[ADR-0014](0014-rule-skill-review-pass-after-candidates-phase.md)（规则 Skill 在 Phase 5 后独立会话）、[ADR-0027](0027-runs-layout-and-rule-skill-trust.md)（不自动扫描）、[ADR-0034](0034-rule-skill-multi-input-and-name-removal.md)（一个包一个 skill）、[ADR-0067](0067-rename-rule-flag-to-skill.md)（`--skill`）、[ADR-0094](0094-review-grouping-and-bounded-concurrent-passes.md)（分组与并发）
**范围**：本仓 pi 线 0095。新增声明式规则目录、Rule Resolver、黑盒技能包执行语义、内置规则包出厂与 opt-in OCR pack；不改 Finding 公开 schema、不改 `--rule-skill*` 显式装载纪律。

## Context

现状事实：

- **没有出厂规则目录**：`packages/review-pi/package.json files` 只有 dist/bin/README/THIRD-PARTY-NOTICES；唯一规则集是 `testdata/rule-skills/general-code-review`（12 条规则），是 testdata 夹具，不出厂、不默认加载；
- 系统提示（`zonea/system-prompt.ts`）只有六阶段流程、证据纪律、Finding schema、severity 定义，不是按语言/缺陷类型的规则目录；
- **每个 `--rule-skill`/`--skill` = 一个独立 Agent session**，在主 pass Phase 5 之后、Phase 6 之前按 round × shard × skill 串行执行；
- 每个 skill session 注入**完整 SKILL.md**；repo 读取**不共享**（各自 `RepoContext/sourceCache`）；
- 没有 skill 数上限、没有 per-skill 请求/tool 预算；候选只在 `(file, line, category)` 层合并，primary 永不丢、first skill batch wins。

如果直接叠加到分组（ADR-0094）：`groups × rounds × skills` 个 skill session 会带来大量重复检视与重复读文件。用户传入的 skill 还可能格式完全不同，甚至自带脚本/执行步骤，不能强制改写成我们的规则 schema。

## Decision

1. **两类技能包，运行时确定性分类**：
   - **声明式规则包（declarative rule pack）**：可确定性解析出规则（`rules/*.md` 带 `id/languages/globs/tags`、包根 `rules.json|yaml`、`SKILL.md` frontmatter）；
   - **黑盒技能包（opaque skill pack）**：无法确定性拆成规则条目，可能自带 prompt / 脚本 / 执行步骤。
   - **运行时不做 AI 规则提取**；AI 只允许出现在离线 `skill import` 工具里生成 manifest，不进 review 热路径。
2. **规则目录（Rule Catalog）**：内置规则与用户声明式规则进入同一目录；条目字段 `id / title / severity / category / languages / globs / tags / text / source`；按 `id`（缺失时规范化语义哈希）去重；**用户规则覆盖内置规则**（`userOverrideBuiltin=true`），冲突写入审计。
3. **Rule Resolver 按 Review Group 选规则**：group 内混合语言先按语言拆子组；只注入命中的规则子集；上限 `maxRuleContextChars=6000`；超出按「用户规则 → 内置规则 → 其他」优先级截断；**没有命中规则的 group 不跑规则增强**。
4. **每组一次 rule-augmented review**：不再 per-skill / per-round 全量重审；main pass 的 Phase 5 候选作为 seed，规则侧只报**增量候选**；合并仍用现有 content key 去重。
5. **黑盒技能包执行语义**：
   - **union-scope**：按可用元数据（`globs/languages/tags`）匹配文件并集；没有元数据则每样本最多一次；
   - 每个 skill 每样本默认最多 1 次（`maxOpaqueSessionsPerSkill=1`），每样本最多 3 次（`maxOpaqueSessionsPerSample=3`）；不随 group 数复制；
   - 输入带 main 已产出候选，只要求增量；共享 group 内只读 `RepoContext/sourceCache`；
   - **统一候选契约**：输出必须走候选 JSON 或 MCP `report`；无法解析 → 0 候选 + degraded 留痕，不判 failed；脚本 stdout 不直接当 findings。
6. **共享只读上下文**：同一 group 内 main + rule/opaque pass 共享只读 `RepoContext/sourceCache`；跨 group 不共享可变状态；缓存 key 含 repo snapshot / diff digest。
7. **来源标注**：候选/审计记录 `source`（`builtin` / `rule:<id>` / `skill:<name>` / `opaque:<name>`）；Finding 公开 schema 不改。
8. **内置规则包 MVP**：把 `testdata/rule-skills/general-code-review/rules/*.md` **移动**到 `packages/review-pi/rules/general/`，加入 `package.json files`；加载时计算 pack digest 进审计；testdata 不再保留第二份副本，避免规则漂移。
9. **OCR 规则包 opt-in**：从 OCR 的 `rule_docs/*.md` 适配一个可选 pack（Apache-2.0，`THIRD-PARTY-NOTICES` 归属），放入 `limits.rules.optionalPacks` 才加载，**不默认加载**。
10. **治理**：内置 pack 独立版本号；每条规则稳定 `id`；新增/修改走 review；第三方规则归属与许可证记录在 `THIRD-PARTY-NOTICES`。
11. **Partial success**：声明的 group/skill 失败只写 `degradedSkills` / `degradedGroups`，交付已有候选；全部失败才判 failed（与 ADR-0094 一致）。
12. **配置面**（新增 `limits.rules` 与 `limits.skills`；v1 用 `enabled=false` 保持零漂移）：

| 参数 | 缺省 | 中文说明 |
|---|---:|---|
| `limits.rules.enabled` | `false` | 是否启用规则目录注入；v1 默认 false = 保持现有行为（零漂移）。 |
| `limits.rules.builtinPack` | `"general"` | 出厂内置规则包名，解析到 `rules/general/`。 |
| `limits.rules.optionalPacks` | `[]` | 可选规则包名（如 `["ocr"]`）；空数组 = 不加载。 |
| `limits.rules.maxRuleContextChars` | `6000` | 每个检视组注入的规则文本上限；超出按用户 > 内置 > 其他优先级截断。 |
| `limits.rules.userOverrideBuiltin` | `true` | 同 `id` 规则冲突时，用户规则覆盖内置规则。 |
| `limits.skills.maxOpaqueSessionsPerSkill` | `1` | 每个黑盒技能包每样本最多执行次数。 |
| `limits.skills.maxOpaqueSessionsPerSample` | `3` | 每样本黑盒技能会话总数上限。 |
| `limits.skills.maxSkillsPerRun` | `8` | 一次 run 最多装载的技能包数。 |

## Options（为什么不是别的）

- **强制所有 skill 改成我们的规则 schema**：否。用户现有 skill 可能是 Claude/Codex/OCR 格式，甚至带脚本；强制迁移不可行。
- **运行时用 LLM 提取规则**：否。每次检视多一次不可复现的解析，且规则提取错误会污染检视；只允许离线 import。
- **继续 per-skill / per-round 全量重审**：否。会话数乘性增长，重复读文件与重复检视无法接受。
- **黑盒技能按 group 各跑一次**：否。会随 group 数线性放大；改为 union-scope + 每样本上限。
- **把 OCR 规则包默认加载**：否。规则量大、风格与内置重叠，先 opt-in，用数据决定是否默认。
- **把用户 skill 的脚本输出直接当 findings**：否。无法保证结构与证据纪律；必须走统一候选契约。

## Consequences

- **好**：声明式规则可去重/按组选/用户覆盖内置，规则上下文从“整包 72KB”降到“2–6KB 子集”；黑盒技能不再 per-group 复制；规则 Skill 会话从 `groups × rounds × skills` 降到 `groups × 1`（规则增强）+ 每样本少量 opaque 会话。
- **代价/风险**：规则分类依赖包格式；opaque 技能无法做规则级去重，只能靠候选 content key；用户规则覆盖内置需要审计与测试；OCR pack 适配需要许可证与规则质量评审。
- **测试面**：声明式/opaque 分类、规则目录解析与去重、用户覆盖内置、按组选规则与截断、opaque union-scope/上限/delta、候选契约解析失败降级、来源标注、内置 pack digest 审计。
- **未完成**：OCR pack 适配、离线 `skill import` 工具、规则目录的完整治理流程；v1 只交付内置 12 条 + 可选 pack 机制。
