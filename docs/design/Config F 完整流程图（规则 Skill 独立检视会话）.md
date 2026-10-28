# Config F 完整流程图（现行口径：Phase 5 之后追加独立 Skill 检视会话）

> **定位**：`packages/review-pi` 的 config F 端到端流程单页图。F 不在 A–E 冻结矩阵内——它是 E 之上的扩展位（`F = E + ruleSkill`），用于「项目自带规则 Skill 参与检视」。
> **口径来源**：ADR-0014（取代 ADR-0012 的 Phase 5 简报注入形态与单包限定）＋当前源码。图与文字按代码实际行为绘制，不按设计意图。
> **代码锚点**：`contracts/config.ts:33`、`run/review-run.ts:307-343`、`loop/agent-review-loop.ts:295-390`、`knowledge/rule-skill.ts:124-157`、`knowledge/skill-pass.ts:74-223`、`knowledge/skill-pass-brief.ts:89-113`、`gate/candidate-merge.ts:48-82`、`gate/candidate-gate.ts:25-42`、`tools/skill-bash.ts:219-269`。

---

## 1. 端到端总流程

**图 1｜端到端总流程**

![图 1 端到端总流程](assets/config-f-flow/01-e2e-flow.png)

<details>
<summary>Mermaid 源（改动后需重新导出 PNG）</summary>

```mermaid
flowchart TD
    A["CLI: review --config F<br/>--rule-skill-zip a.zip --rule-skill-zip b.zip ..."] --> B["解析旗标 → .env.local 装载 → 凭据 fail fast"]
    B --> C["runReview：读 repo / diff、MR 边界护栏（>10 文件或 >2K 行只告警）"]
    C --> D["装载规则 Skill（new Agent 之前；见 §2）"]
    D -->|"N=0：无 zip 且 .review-rules/ 为空"| E["ruleSkills = []"]
    D -->|"有包但装载失败"| F["降级条目（degradedReason）<br/>strict 模式下抛错退出"]
    D -->|"装载成功"| G["RuleSkill[]：name / SKILL.md / filePath / digest"]
    E --> H
    F --> H
    G --> H["主 Agent（F = E 的形态）：<br/>system prompt + 7 个 review 工具<br/>stablePrefix + Context Ledger"]
    H --> I["Phase 1–5：每阶段文本回合推进（工具子循环见 §3）"]
    I --> J["Phase 5 文本回合结束：<br/>parseCandidatesReply → 主候选"]
    J --> K{"skillPass 已接线<br/>且有非降级 skill？"}
    K -->|"否"| L["直接注入 Phase 6 指令（逐字节 = E）"]
    K -->|"是"| M["快照 = 此刻 messages + ledger（见 §4）"]
    M --> N["按 CLI 顺序逐个 skill 跑独立会话（8 工具）"]
    N --> O["候选净化（pack 路径 → &lt;rule-skill&gt;）<br/>+ 跨 skill 去重（file,line,category）"]
    O --> P["存活候选并入本轮候选流"]
    P --> Q["Phase 6 指令 + 存活 skill 候选清单（§5）"]
    L --> R
    Q --> R["Phase 6 回复 → 候选拦截链（5 级）"]
    R --> S{"complete = true？"}
    S -->|"是"| T["结束并标记完成"]
    S -->|"false 且 round < 5"| U["round+1，重置候选/裁决/skill 批次"] --> I
    S -->|"false 且 round = 5"| V["结束并标记 truncated（MAX_ROUNDS_REACHED）"]
    T --> W["落盘：skill 转录 ×N → 审计 → 主转录 → reviews_en → RunRecord<br/>（CLI 层再产 reviews_zh）"]
    V --> W
```

</details>

**一句话**：F 只改两件事——**在 Phase 5 之后多跑若干独立会话**，以及**在 Phase 6 指令尾部追加存活候选清单**；Phase 1–5 的请求字节、system prompt、七工具 schema 与 E 完全相同。

---

## 2. 装载期：从 zip 到 `RuleSkill`（`new Agent` 之前，不执行包内脚本）

**图 2｜装载期：zip → RuleSkill**

![图 2 装载期：zip → RuleSkill](assets/config-f-flow/02-loading.png)

<details>
<summary>Mermaid 源（改动后需重新导出 PNG）</summary>

```mermaid
flowchart TD
    A["loadRuleSkills"] --> B{"有显式 --rule-skill-zip？"}
    B -->|"是（可多个）"| C["按 CLI 顺序逐包检查存在性"]
    B -->|"否"| D{"&lt;repo&gt;/.review-rules/ 有 *.zip？"}
    D -->|"否"| N0["返回 []<br/>N=0：F 与 E 请求逐字节相同<br/>（--strict-rule-skill 时抛错）"]
    D -->|"是"| E["按文件名序全部装载"]
    C --> F["逐包 loadFromZip"]
    E --> F
    F --> G["stat ≤ 8 MiB → 读字节 → sha256"]
    G --> H["解压前审计（中央目录）"]
    H --> H1{"zip64 / 路径穿越 / 符号链接<br/>条目 &gt; 2000 / 解压 &gt; 64 MiB<br/>压缩比 &gt; 100:1 / 重名？"}
    H1 -->|"命中任一"| DEG["降级条目：degradedReason<br/>（strict → 抛错）"]
    H1 -->|"通过"| I{"缓存有<br/>&lt;cacheRoot&gt;/&lt;sha256&gt;/.rule-skill-ready？"}
    I -->|"否"| J["解压到缓存目录<br/>win32: tar → Expand-Archive 回退<br/>posix: unzip → tar 回退（30s）"]
    J --> K["解压后复核：无符号链接 / 仅普通文件 / 总量上界"]
    K -->|"不通过"| DEG
    K -->|"通过"| L["写 .rule-skill-ready（内容 = sha256）"]
    I -->|"是"| M["直接复用缓存"]
    L --> O
    M --> O["loadSkills(cacheDir) 读 SKILL.md"]
    O --> P{"selectSkill：<br/>--rule-skill-name 精确匹配，否则必须恰好 1 个"}
    P -->|"0 个 / 多于 1 个"| DEG
    P -->|"命中"| Q["RuleSkill{name, description, content, filePath, digest, diagnostics}"]
```

</details>

装载期边界：

| 项 | 值 / 行为 |
|---|---|
| 缓存位置 | `<out>/<experimentId>/.cache/rule-skills/<sha256>/`，**绝不写回被检仓库** |
| 单包上界 | 8 MiB；条目 ≤ 2000；解压总量 ≤ 64 MiB；压缩比 ≤ 100:1 |
| 解压超时 | 30 s（超时即失败 → 降级或 strict 抛错） |
| 多包顺序 | 显式列表 = CLI 顺序；约定目录 = 文件名序；**执行顺序同此** |
| 多 skill 包 | 必须 `--rule-skill-name` 消歧，否则降级 |
| `--strict-rule-skill` | **只作用于装载期**：任一包失败即抛错；skill 会话失败不中止 run |
| N=0 | `ruleSkill: []`、`skillPassLog: []`，无 skill 会话 |

---

## 3. 主循环（每轮六阶段；F 的插入点在 Phase 5 与 Phase 6 之间）

**图 3｜主循环：六阶段与 F 插入点**

![图 3 主循环：六阶段与 F 插入点](assets/config-f-flow/03-main-loop.png)

<details>
<summary>Mermaid 源（改动后需重新导出 PNG）</summary>

```mermaid
flowchart TD
    R["round r（1 ≤ r ≤ MAX_ROUNDS = 5）"] --> A["注入 Phase i 指令<br/>i = 1..6"]
    A --> B{"assistant 回合含 toolCall？"}
    B -->|"是"| C["顺次执行 7 工具（toolExecution = sequential）<br/>全 run 预算 MAX_TOOL_CALLS = 100（跨轮不重置）"]
    C --> B
    B -->|"否（纯文本）"| D["parsePhaseReply + phaseLog 留痕<br/>（i=5 解析 candidates；i=6 解析 verdicts/complete）"]
    D --> E{"i == 5？"}
    E -->|"是"| F["【F】runRoundSkillPasses（§4）<br/>A–E：无此步"]
    E -->|"否"| G
    F --> G{"i &lt; 6？"}
    G -->|"是"| H["i + 1，重置阶段计数"] --> A
    G -->|"否"| I["applyCandidateGate：候选拦截链"]
    I --> J{"complete？"}
    J -->|"true"| K["返回：完成"]
    J -->|"false 且 r &lt; 5"| L["r + 1，重置候选 / 裁决 / skill 批次"] --> A
    J -->|"false 且 r = 5"| M["truncated = true<br/>truncationReasons += MAX_ROUNDS_REACHED"]
```

</details>

要点：

- **阶段推进只由文本回合触发**；工具回合不推进阶段，也不消耗轮次。
- `MAX_TOOL_CALLS = 100` 只约束**主会话**；skill 会话另有 5 min 会话上界，**没有工具预算**。
- 候选解析在 Phase 5；裁决与 `complete` 在 Phase 6，二者都是每轮一次。
- F 的 skill 会话是**每轮都跑**（不是每 run 一次），多轮时成本按轮数放大。

---

## 4. Skill 检视会话（每个 skill 一个独立 Agent）

**图 4｜Skill 检视会话**

![图 4 Skill 检视会话](assets/config-f-flow/04-skill-pass.png)

<details>
<summary>Mermaid 源（改动后需重新导出 PNG）</summary>

```mermaid
flowchart TD
    A["runRoundSkillPasses(seedMessages)"] --> B["ledgerSnapshot = 主账本快照"]
    B --> C{"逐个 skill（CLI 顺序）"}
    C --> D{"degraded 或 name 为空？"}
    D -->|"是"| SKIP["跳过：不跑会话<br/>（装载事实已在 ruleSkill[]）"]
    D -->|"否"| E["new Agent：<br/>systemPrompt 同主会话<br/>messages = Phase 5 快照（含 Phase 5 回复）<br/>tools = 7 review 工具 + bash"]
    E --> F["分叉 toolkit：ledger 种子 = Phase 5 快照<br/>（skill 之间、skill 与主会话互不可见）"]
    F --> G["prompt = &lt;skill name location&gt; 块<br/>+ 输出契约（JSON candidates / 英文 / 必带 evidence）"]
    G --> H{"5 min 内结束？"}
    H -->|"超时"| FAILS["failed，failureStage = session（先 abort）"]
    H -->|"正常"| I{"存在 stopReason = error 的回合？"}
    I -->|"是"| FAILS
    I -->|"否"| J{"回合含 toolCall？"}
    J -->|"是"| K["执行工具：7 review 工具 / bash<br/>bash：仅 python·python3、无 shell 元字符<br/>cwd = pack 根、60s、8K 结果预算"] --> J
    J -->|"否（纯文本）"| L["取最后一条 assistant 文本<br/>parseCandidatesReply"]
    L --> M{"解析失败？"}
    M -->|"是"| FAILP["failed，failureStage = parse"]
    M -->|"否"| N["候选净化：pack 根路径 → &lt;rule-skill&gt;"]
    N --> O["record：status = ok（≥1 候选）/ empty（0 候选，合法）<br/>requestCount / toolCallCount / candidateCount / ruleIds"]
    O --> P["usage 累加；skill 转录原料入列"]
    FAILS --> P
    FAILP --> P
    SKIP --> Q
    P --> Q["合并：mergeSkillCandidates"]
```

</details>

单会话形态：

| 维度 | 值 |
|---|---|
| 种子 | 主会话 Phase 5 结束时的 `messages` 快照（**含 Phase 5 回复**，即主候选对 skill 可见） |
| 首条 user 消息 | `<skill name="…" location="…">` + `References are relative to …` + SKILL.md 正文 + 输出契约 |
| 工具面 | 7 个 review 工具（同一 schema）＋ `bash`（第 8 只，仅 skill 会话有） |
| 模型 | 与主会话同一 model id / baseUrl / reasoning 档 |
| 结束条件 | 首个**纯文本**回合（skill 只跑一趟，无相位推进） |
| 失败语义 | `failed`（`failureStage: session \| parse`）；`empty` 是合法结果，不是失败 |
| 转录 | 每个会话一份，文件名 `session-<ts>-<config>-<case>-skill-<name>-r<round>.json` |

---

## 5. 候选合流与 Phase 6（两批候选一次裁定）

**图 5｜候选合流与候选门**

![图 5 候选合流与候选门](assets/config-f-flow/05-merge-and-gate.png)

<details>
<summary>Mermaid 源（改动后需重新导出 PNG）</summary>

```mermaid
flowchart TD
    M["主候选（Phase 5）"] --> K["键集：file + line + category<br/>（主候选只占键、永不被丢弃）"]
    S1["skill A 候选（净化后）"] --> D1{"键已存在？"}
    S2["skill B 候选（净化后）"] --> D2{"键已存在？"}
    K --> D1
    D1 -->|"是"| X1["mergedCount(A)++<br/>丢弃"]
    D1 -->|"否"| Y1["存活：加入候选流 + 占键"]
    K --> D2
    D2 -->|"是"| X2["mergedCount(B)++<br/>丢弃"]
    D2 -->|"否"| Y2["存活：加入候选流 + 占键"]
    Y1 --> BR["Phase 6 追加存活候选清单<br/>（无存活 = 不追加，字节 = E）"]
    Y2 --> BR
    BR --> G["候选拦截链（每候选只留首个失败阶段）"]
    G --> G1["SCHEMA_INVALID"]
    G1 --> G2["NON_ENGLISH"]
    G2 --> G3["NO_EVIDENCE"]
    G3 --> G4["VERIFICATION_FAILED"]
    G4 --> G5["DUPLICATE_ID"]
    G5 --> F["findings / rejections"]
```

</details>

`Phase 6` 追加段的实际形态（`buildSkillCandidatesBrief`）：

```text
## Rule-skill candidates
Independent rule-skill review passes ran after Phase 5 and produced the candidates below.
Verify them together with your own candidates, applying the same standard.

<skill name="general-code-review">
{"id":"RULE-CHECK@general-code-review@<file>:<line>","severity":…,"category":…,"file":…,"line":…,"title":…,"description":…,"evidence":[…],"rule":"general-code-review","confidence":…}
</skill>

Every candidate id above must appear in your verdicts array. …
```

合流纪律：

| 规则 | 行为 |
|---|---|
| 去重键 | `(file, line, category)`；不同规则/不同主张同键也视为重复，**不合并语义冲突** |
| 主候选优先级 | 主候选先占键，skill 重复项计入该 skill 的 `mergedCount` |
| 跨 skill 顺序 | 先出现的批次胜出（CLI 顺序）；后出现者计入 `mergedCount` |
| schema 非法候选 | **不参与去重**（不查键、不占键），交给候选门以 `SCHEMA_INVALID` 留痕 |
| 账目闭合 | `candidateCount − mergedCount` = 实际并入候选流条数 |
| 候选 id | `RULE-CHECK@<skill>@<file>:<line>`（不含 round，跨轮稳定 → 可被 `DUPLICATE_ID` 拦截） |

---

## 6. 降级与失败矩阵

| 阶段 | 触发 | `--strict-rule-skill` 关（缺省） | `--strict-rule-skill` 开 | 审计留痕 |
|---|---|---|---|---|
| 定位 | zip 缺失 / 目录为空 | 该包降级 / N=0 | 抛错退出 | `ruleSkill[].degradedReason` 或 `ruleSkill: []` |
| 审计 | zip64 / 穿越 / 符号链接 / 超限 / 重名 | 该包降级 | 抛错退出 | 同上 |
| 解压 | 命令失败 / 超时（30s） / 复核不过 | 该包降级 | 抛错退出 | 同上 |
| 装载 | 无 SKILL.md / 0 个或多个 skill 且未消歧 | 该包降级 | 抛错退出 | 同上 |
| 会话 | 异常 / provider error / 超时（5 min） | `status=failed`，run 继续 | **同样不抛**（strict 不覆盖会话） | `skillPassLog[]` + 转录（若发过请求） |
| 解析 | 输出非 JSON / 无 candidates | `status=failed`，`failureStage=parse` | 同上 | 同上 |
| 空产出 | 合法 JSON 但 `candidates: []` | `status=empty`（合法） | 同上 | 同上 |

---

## 7. 审计与产物映射（哪些进账、哪些不进）

| 项 | 主会话 | skill 会话 | 说明 |
|---|---|---|---|
| `audit.requests[]` | ✅ 逐请求 wire | ❌ | skill 属非测量档，F↔E 字节对照只看主链 |
| `audit.toolCallLog[]` | ✅ 逐项 | ❌ | 主会话 7 工具逐条 |
| `audit.phaseLog[]` | ✅ | ❌ | skill 回合不进相位记录（并列而非嵌套） |
| `audit.usage` | ✅ | ✅ | 两者累加（skill 的真实成本不隐藏） |
| `audit.toolCalls` | ✅ | ⚠️ 部分 | 加的是 `skillPassLog[].toolCallCount`，**当前只统计 7 工具、不统计 bash** |
| `audit.ruleSkill[]` | — | — | 每包一条：`source / digest / name / degradedReason / diagnostics` |
| `audit.skillPassLog[]` | — | — | 每条：`round / skill / status / requestCount / toolCallCount / candidateCount / mergedCount / ruleIds / transcriptFile` |
| 转录 | `session-<ts>-<config>-<case>.json` | `session-…-skill-<name>-r<round>.json` | 两者同目录；skill 转录的种子是 Phase 5 快照 |
| `reviews_en.json` | ✅ | — | 导出的是合流后的 findings |
| `reviews_zh.json` | — | — | 仅 CLI 层配置了中文投影引擎时产 |

---

## 8. 与 ADR-0012 旧口径的差异（这张图相对旧图的改动面）

| 维度 | 旧口径（ADR-0012） | 现行口径（ADR-0014 / 本图） |
|---|---|---|
| 注入点 | Phase 5 **消息体内**追加规则简报 | Phase 5 **之后**追加独立会话；Phase 5 消息零修改 |
| skill 的身份 | 规则来源（文本） | 检视者（可调工具、可跑白名单脚本、自出候选） |
| 包数量 | 单包 | 多包，CLI 顺序叠加 |
| 候选合流 | skill 不产候选 | 候选在候选门前跨 skill 去重，Phase 6 一次裁定 |
| 审计 | `ruleSkill` 单对象 | `ruleSkill[]` + `skillPassLog[]` + 独立转录 |
| 脚本执行 | 绝不执行 | 仅 skill 会话内 `bash`：python 白名单、无 shell、cwd=pack 根 |
| F 与 E 的差异 | Phase 5 请求字节不同 | Phase 1–5 相同；仅 Phase 6 在有存活候选时追加清单 |
| N=0 | 需要额外断言 | 天然成立：无包 → 无会话 → 全部请求逐字节相同 |

---

## 9. 一次真实运行的时序（VUL4J-38 / F / general-code-review，2026-10-27）

| 相对时刻 | 事件 | 请求数 |
|---|---|---|
| 0.0 s | CLI 启动 → 装载规则包（缓存命中）→ 主 Agent 开始 | — |
| 0.0–149.5 s | Phase 1–5（Phase 1 占 4 次、Phase 5 占 3 次） | 11 |
| 149.5 s | Phase 5 回复解析出主候选；快照 messages + ledger | — |
| 199.5 s | skill 第 1 次回复（28,291 输入，**cacheRead = 0**） | 1 |
| 199.5–331.9 s | skill 会话余下 4 次请求（其中 2 次命中缓存） | 4 |
| 331.9 s | skill 产出 1 条候选，去重后 `mergedCount = 0`（存活） | — |
| 345.5 s | Phase 6：裁定主候选 + skill 候选 | 1 |
| 358.0 s | 核内完成，转录/审计/RunRecord 落盘 | — |
| ≈466 s | 中文投影完成（8 次翻译请求，**不在审计内**） | 8 |

这次运行的合流结果：4 条 finding，其中 1 条为 skill 产出（`RULE-CHECK@general-code-review@…:167`，P3）。完整成本账见《[运行手册：单次检视](../运行手册-单次检视.md)》与 `runs/f-demo-session-skill2/`。

---

## 10. 已知缺口（读图时的口径提醒，不改变上图语义）

1. **skill 的 bash 调用不进 `toolCallCount`**：`skill-pass.ts` 的计数只挂在 7 工具包装器上，实测 12 次 bash 记成 0。
2. **skill 会话工具面是 8 只、主会话 7 只**：tools 段属稳定前缀，缓存键从 tools 段分叉；实测 skill 前 3 次请求 `cacheRead = 0`（约 8.8 万输入全价）。
3. **对话缓存是 best-effort**：skill 复用主会话 system prompt 与 Phase 1–5 前缀，但命中率受网关前缀门与 tools 面影响，不保证。
4. **`search_rule` / `search_history` 语料恒空**：`runReview` 未给 toolkit 传 `knowledge`，这两个工具在 F/E 下都返回 corpus is empty。
5. **失败路径不落产物**：会话/网关错误时 run 直接抛错，审计与转录都不写（`runs/f-demo-session-skill-2/` 即此形态：只有规则包缓存）。

---

## 11. 相关文档

- `docs/adr/0014-rule-skill-review-pass-after-candidates-phase.md` —— 本图的口径来源（决策 1–15）。
- `docs/adr/0012-project-rules-as-rule-skill-injected-at-candidates-phase.md` —— 被取代的旧注入形态（装载/审计/降级部分仍有效）。
- `docs/design/规则 Skill 与 config F 方案——项目规则检视落地.md` —— zip 定位/审计/解压与降级细节。
- `docs/运行手册-单次检视.md` —— 生产形态命令、产物布局与排障。
- `docs/配置矩阵A-E说明.md` —— A–E 各配置语义（F 是 E 的扩展位）。
