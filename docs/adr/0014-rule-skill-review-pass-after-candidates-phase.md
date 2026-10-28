# 0014. 规则 Skill 改为「Phase 5 之后追加独立 skill 检视会话」，Phase 5 消息不再被修改

**状态**：已接受（2026-10-27，用户经 grill 逐项决策 Q1–Q46）；**部分修订（2026-10-28）**——决策 11 的资源上限由「单条命令 60s、单会话 5 min」上调为「单条命令 120s、单会话 10 min」（实测 skill 会话 158s 已贴近原 5 min 上界，bash 60s 对 pack 脚本偏紧）；**同日补充**——bash 的 shell 元字符拒绝改为只查**引号外**：`python -c "import os; print(os.getcwd())"` 合法（`shell: false` 下引号内字符不交给任何解释器，决策 7 的边界不变）
**关联**：ADR-0012（本 ADR 取代其决策第 3 条与第 2 条中的「单一 zip」限定）、ADR-0013（转录产物契约——skill 会话转录需对齐）、ADR-0009（pi 内核从 0 重写）、ADR-0011（切流 config E——F 是 E 基线上的消融位）、CONTEXT.md（规则检索 / 规则合并 / 规则技能执行器）、`docs/design/规则 Skill 与 config F 方案——项目规则检视落地.md`（其 §6 验收 2 与 §4 第 7 条被本 ADR 取代）

## Context

- ADR-0012 把 config F 定义为「E + 在候选阶段（Phase 5）消息尾部注入规则 Skill 简报」。落地后暴露出三处结构性摩擦：
  1. **F 的字节差落在 Phase 5 消息体内**——而 Phase 5 指令属测量常量面（`loop/phases.ts`）。「F = E + 尾部一段」使 F 与 E 的差异侵入相位消息本身，逐字节对照只能说清「少了/多了一段文本」，说不清「多做了一趟检视」。
  2. **skill 被当成「规则来源」而不是「检视者」**。需求是「在阶段五检视结束后**调用 skill 进行检视**，复用阶段五及之前的上下文」，而简报注入只能提供规则文本，skill 的 SKILL.md 指引与脚本都不参与执行。
  3. **单 skill**。`--rule-skill-zip` 只接受一个包，无法按 CLI 顺序叠加多个规则域。
- 纪律（ADR-0009/0011）：`PHASE_INSTRUCTIONS` / `SYSTEM_PROMPT` / 七工具 schema 属**测量常量面**，A–E 逐字节冻结；消息序列 append-only（`loop/agent-review-loop.ts:43-44`，`loop/cache-break.ts:15-16`）。
- 内核事实：整个 run 只有**一个** `Agent` 实例（`loop/agent-review-loop.ts:173-198`），Phase 1 用 `prompt()`（`:203`），其余相位走 `followUp`；驱动是**回调状态机**而非 `for`——任何「无 toolCall 的文本回合」都会进 `advancePhase`，按当前 `phaseIndex` 无条件记一条 `PhaseRecord` 并使相位 +1（`:246-267`），在 Phase 5 处会覆盖 `roundCandidates`（`:299-303`），在 Phase 6 处会直接触发候选门（`:269-278`）。
- `shouldStopAfterTurn` 的签名是 `boolean | Promise<boolean>`（`packages/agent/src/types.ts:223`），调用处 `await`（`packages/agent/src/agent-loop.ts:252`）⇒ 可在 Phase 5 之后**原地 await** 异步工作后继续 `followUp`，**不需要改内核**。
- `followUpMode` 缺省 `one-at-a-time`（`packages/agent/src/agent.ts:141-154`、`:231-232`）⇒ 连发两条只排最旧一条；若后续回合返回 `complete: true`，滞留消息**永不注入**。

## Decision

1. **目标面 = config F 扩展，不新开 G**（E ⊂ F 保持不变）；**多 skill 单位 = 多个 zip**，`--rule-skill-zip` 可重复，执行顺序 = **CLI 传入顺序**。
2. **插入点 = Phase 5 之后、Phase 6 之前**。Phase 5 的消息**不再被修改**：N≥1 时 Phase 1–5 的请求与 config E **逐字节相同**，F 的字节差唯一定位在 Phase 5 之后新增的 skill 会话与 Phase 6 的候选清单段。
3. **驱动方式 = 裸 `Agent` 上追加一条 `formatSkillInvocation(skill)` user 消息**（等价于 harness `lane.skill()` 的唯一行为，`packages/agent/src/harness/runtime/lane.ts:529-542`），**不迁移 `AgentHarness`**。顺序性由 `advancePhase` 的**新增 skill pass 子状态**保证，不依赖连发 follow-up。
4. **每个 skill 一个独立会话**，互不可见：种子 = 主 Agent 在 Phase 5 结束时的 `messages` 快照；合并完全在核内完成。
5. **skill 会话的 system prompt 复用检视的 `SYSTEM_PROMPT`**（同一 Zone A）——使 skill 会话与主会话 Phase 6 的首请求共享超长前缀，跨会话缓存全额命中。
6. **工具面**：检视 run 仍为**七工具**（ADR-0012 的「工具面零改动」在被测量侧继续成立）；**skill 会话 = 七检视工具 + `bash`**（八只）。bash 只存在于非测量档的 skill 会话。
7. **bash 边界 = 核内常量白名单**（仅 `python` / `python3`）+ env 白名单 + `cwd` = pack 根（SKILL.md 用相对路径；仅跨目录时才透传真实绝对路径，且只在 skill 会话内）。**白名单不接受 pack 声明**——被检视项目自带内容不得扩大安全边界。解释器由核内按 `PATH` 的**绝对目录**解析成绝对路径再启动（只认裸名 `python`/`python3`，不认 `.cmd`/`.bat`）——不把「搜哪个 python」交给平台的当前目录搜索顺序。
8. **ledger = 主 ledger 在 Phase 5 结束时的快照分叉**（不是主会话 + 全部 skill 共享一个可变实例，否则 skill-2 会拿到 skill-1 加载过的引用却无对应历史）。为此 `buildReviewToolkit` 需新增 `ledger?` 注入缝（现为内部创建，`packages/review-pi/src/tools/toolkit.ts:86`）。
9. **合并**：主候选 + 各 skill 候选，在候选门之前按 `(file, line, category)` **跨 skill 去重**，保留 CLI 顺序最先者，被合并者计入 `mergedCount`；主候选永不被丢弃、但其去重键**占键**（skill 侧与之重复的那条同样计入 `mergedCount`——同一缺陷不该以两条 id 进候选门）；**schema 非法的候选不参与去重**（直接交给 `SCHEMA_INVALID`）；语义冲突的两条都保留。
10. **验证 = 主 Phase 6 统一裁定两批候选**：skill 候选清单由 loop 在拼装 Phase 6 指令消息时追加（`buildSkillCandidatesBrief`——数据在 loop 侧），`applyCandidateGate` 仍**只调用一次**。ADR-0012 的 `phaseBrief` 注入缝随之**整体删除**：它唯一的使用者（候选阶段简报）已退役，留着就是一个签名还在、没人传的假缝。独立消息在 `one-at-a-time` 下会变成两个 run，写系统提示词会破 Zone A。
11. **失败语义与资源上限**：会话/解析失败 = `failed`（`failureStage` = `session` | `parse`）；跑通 0 候选 = `empty`（合法）；bash 白名单拒绝**不算**失败；装载降级只进 `ruleSkill[]`——降级包根本不跑会话，故不产生 `skillPassLog` 行。单条命令显式 120s、单 skill 会话 10 min、输出走既有结果预算层（`tools/result-budget.ts` 的 `applyLineBudget`）。
12. **审计**：`ruleSkill[]`（装载事实，每 run 一条）与 `skillPassLog[]`（执行事实，round × skill）**并列**。`skillPassLog` 元素 = `{round, skill, status: "ok"|"empty"|"failed", requestCount, toolCallCount, candidateCount, mergedCount, ruleIds?, transcriptFile?, degradedReason?, failureStage?}`。**计数口径**：`usage` 与 `toolCalls`（RunResult/审计数字）**含** skill 会话——skill 的真实成本不隐藏；`toolCallLog` 只记主会话的逐项记录（skill 属非测量档），skill 的调用数按会话计在 `skillPassLog[].toolCallCount`。
13. **转录**：每个 skill 会话**独立落盘**一份转录，主转录/审计引用它（`CONTEXT.md` 的「检视转录」定义为进入 Review Runtime 的全部交互，不能缺这一段）。
14. **每轮都跑 skill pass**；重复候选由 `emittedIds` 跨轮 id 去重兜住（skill 候选 id **不含 round**，沿用 `RULE-CHECK@<skill>@<file>:<line>` 形态）。
15. **N=0 断言**：未传 `--rule-skill-zip` 且 `.review-rules/` 为空 ⇒ 无 skill 会话，F 与 E **全部请求逐字节相同**；审计 `ruleSkill: []`、`skillPassLog: []`；`--strict-rule-skill` 才抛错。

### Supersede 清单（ADR-0012 与设计文档）

| 被取代 | 新口径 |
|---|---|
| ADR-0012 决策 3「注入点 = Phase 5 消息尾部」 | Phase 5 之后追加独立 skill 会话；Phase 5 消息不再修改 |
| ADR-0012 决策 3「简报 = skill 块注入主会话」 | skill 块注入 **skill 会话** |
| ADR-0012 决策 2「单一 zip」 | 多 zip、可重复、CLI 顺序 |
| ADR-0012 决策 3「工具面零改动」的驱动面含义 | 检视 run 仍七工具；**loop 驱动面新增 skill pass 状态** |
| 设计文档 §6 验收 2（`ruleSkill: {source, digest, name}` 单对象） | `ruleSkill[]` + `skillPassLog[]` 并列 |
| 设计文档 §4 第 7 条硬纪律「绝不执行 zip 内任何脚本」 | **superseded**：允许在「白名单（python）+ env 白名单 + pack cwd」下执行 |

**保留 ADR-0012**：路径净化（仅主会话）· 模块内自带相位下标 · 降级不阻断 run、`strict` 才抛 · digest 幂等缓存 · 「规则不进 `search_rule` 语料」· 伪配置位不进 A–E 主矩阵。

## Options（为什么不是别的）

- **保持 ADR-0012 的简报注入**：不满足「调用 skill 进行检视」；且规则集注入使 F 的字节差落在 Phase-5 消息体，逐字节对照的可解释性最差。
- **skill 回合放在全部六阶段之后**：需要**第二套 verification + 第二套 gate**，复杂度陡增；放在 Phase 5 与 6 之间可让 Phase 6 一次裁定两批候选。
- **迁移到 `AgentHarness` 用 `lane.skill()`**：与选项 3 的追加消息**字节与语义等价**（harness 的 skill 处理器唯一行为就是拼 `formatSkillInvocation` 的 user 消息），但代价是整个驱动面（相位驱动 / 缓存纪律 / 审计投影）重写；而且相位记账在 `review-pi` 侧，换框架解决不了本问题。留作后续独立立项。
- **连发 follow-up 实现「Phase 6 + skill + Phase 6」**：`one-at-a-time` 只排最旧一条；若 Phase 6 回 `complete: true`，滞留消息永不注入 ⇒ 不可行。
- **N 个 skill 在同一会话顺序追加**：后面的 skill 会读到前面的 findings，产生跟风/微调，且技术上无法低成本屏蔽（append-only）。
- **主 ledger 与 skill 会话单实例共享**：`referenceIfLoaded` 返回的是**引用字符串**（`tools/ledger.ts:23-45`），skill-2 会拿到它没经历过的加载指针 ⇒ 核内必须回填内容，等于放弃省 token 设计。
- **候选门之后再去重**：被合并者已先产生 `rejection`，留下噪声；且 `DUPLICATE_ID` 只按 id 字符串比对（`gate/candidate-gate.ts:82-88`），id 编了 skill 名后必然逃逸。
- **白名单由 pack 声明**：等于执行被检视项目自带的任意脚本，正是要否掉的硬纪律。

## Consequences

- **正**：Phase 1–5 与 E 逐字节相同（比 ADR-0012 形态更干净的消融基线）；「F 无 skill = E 逐字节」成为可判定断言；多规则域可按 CLI 顺序叠加；skill 能真正做检视（七工具）而不仅是提供规则文本；`phaseLog` 形状不变，按 `phaseLog` 写的对照门全部保留。
- **负/风险**：
  - **Token**：N × 轮数 次 skill 会话。缓解靠「同一 `SYSTEM_PROMPT` + 同一 Phase 1–5 前缀」的跨会话缓存，但输入侧仍按 N 份计。
  - **F 不再整链字节可复现**：Phase 6 之后的选择性字节取决于 skill 产出；可断言的只有「Phase 1–5 与 E 逐字节相同」与「N=0 ⇒ 全链相同」。
  - **治理变更**：推翻「绝不执行 zip 内脚本」。缓解 = 核内常量白名单 + env 白名单 + 只读 pack + 绝不写回被检视仓库 + 每次扩面过 ADR 审查。
  - **产出改形**：`SKILL.md` 必须撤销内联规则索引、回归「怎么跑脚本 + 怎么检视」的指引形态；`build_skill_md.py` 退役；`rules/` 与 `filter_rules.py` 升为主路径。
  - **待建缝**：`buildReviewToolkit` 的 `ledger?` 注入；`advancePhase` 的 skill pass 子状态；每个 skill 会话独立的 `onPayload` 捕获与转录落盘。
- **中性**：F 仍不进 A–E 主矩阵 / `pi-seam-matrix.e2e.ts`；skill 会话属于**非测量档**，其请求字节不参与 F↔E 对照。

## 验收标准

1. `pnpm --filter review-pi test` 全绿；`loop/phases.ts` / `zonea/system-prompt.ts` / `tools/registry.ts` **零改动**。
2. **N=0 ⇒ F 与 E 全部请求逐字节相同**（审计 `ruleSkill: []`、`skillPassLog: []`）。
3. N≥1 ⇒ **Phase 1–5 请求与 E 逐字节相同**；Phase 6 消息含 skill 候选清单（动态区）。
4. 审计出现 `ruleSkill[]` + `skillPassLog[]`；`status` 三态正确；`mergedCount` 与「candidateCount − 实际并入数」对得上账。
5. 每个 skill 会话**独立转录落盘**，主转录/审计引用它。
6. **主会话**请求无绝对路径；skill 会话可含真实 pack 路径。
7. 主会话的请求序列 **append-only，零 cache break**；skill 会话的 append-only 由结构保证——种子是 Phase 5 末的 `messages` 快照，之后只单向追加（`runSkillPass` 不改写种子）。**skill 会话属非测量档**，其 wire 不进主审计 `requests[]`（`classifyCacheBreaks` 只覆盖主链），现场只在该会话的独立转录里。
8. 恶意包（Zip Slip / 解压炸弹 / 越过白名单的命令）→ 拒绝且 run 照常；`--strict-rule-skill` 抛错。
9. 同一 zip 跑两次 → digest 相同、第二次不解压。

跨仓限定语纪律：本 ADR 为本仓序列 0014；引用 DSH 兄弟仓决策须写全限定语「DSH 线 ADR-XXXX」。
