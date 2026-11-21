# 检视流程合理性评估：OCR 对照、历史 Session 证据与改进建议

> 日期：2026-11-20
> 对象：`packages/review-pi` 的六阶段检视流程
> 参照：OpenCodeReview（`D:/Project/open-code-review` @ `d77d70b`）
> 数据：本仓归档 session、test12 / VUL4J / exp-group 评测报告
> 性质：评估与方案，不改运行时代码；本文不 push

---

## 0. 结论先行

| # | 结论 | 依据 |
|---|---|---|
| 1 | **六阶段的方向合理，但它现在是一套「推理脚手架」，不是一条「数据管线」。** Phase 1–4 的 JSON 全部被解析层丢弃，只有 Phase 5 的候选与 Phase 6 的裁决进入机器消费面。 | `loop/agent-review-loop.ts:755-787` |
| 2 | **当前质量瓶颈不在 Phase 6 拦截，而在「生成」和「覆盖」。** 小 diff 漏掉的 31 条 GT 中，71% 是「Phase 1 已经读到改动、但没有转成候选」；只有 1 条被 Gate 拦掉。 | `test12-small10-v2-missed-gt-analysis` §3.1/§3.2 |
| 3 | **文件级覆盖是最大的结构性缺口。** 历史大样本里，我们漏掉的 GT 中 56.8% 所在文件没有任何一条我们的意见（OCR 为 31.5%）；大 diff 上 98.5% 的意见落在没有 GT 的文件。 | `exp-group-missed-gt-classification` §7；`test12-large2-data` §3 |
| 4 | **大 MR 是流程最不合理的一段。** 体积门先于分片，超 1M 字符的整条 MR 直接跳过（FreeCAD 13 条 GT 全丢）；分片串行执行；每片重跑完整六阶段；片间没有全局上下文；2 条大 diff 用 8.7M token 只覆盖 1/19 GT，OCR 用 1.04M 覆盖 12/19。 | `run/review-run.ts:334-353`；`run/pass-runner.ts:208-211`；`test12-large2-data` §2/§4/§6 |
| 5 | **OCR 值得借的不是「阶段」，而是四件工程能力**：确定性输入收敛、覆盖 manifest、条件化 Plan、组级并发与多层预算；再加一个「只证伪、fail-open」的 Review Filter。 | OCR `internal/agent/*`，见 §2.4 |
| 6 | **我们已经有一条被数据验证过、但默认关闭的补漏通道**：B2 独立补漏扫描把 recall 从 0.340 提到 0.440、Balanced 从 0.428 提到 0.489，超过 OCR 的 0.471，token 还低于 v2。 | `test12-small10-b2-sweep-experiment` §1 |
| 7 | **判断：当前流程「可以生产，但还没到合理形态的终点」。** 小 diff 与 OCR 基本打平（B 0.454 vs 0.471；B2 0.489 > 0.471），大 diff 落后 51pp。先修覆盖与大 MR，再谈阶段压缩。 | 见 §4 |

一句话：**我们不该再用「六阶段」解释质量；应该用「每个变更文件/ hunk 是否被审到、每条意见是否有接地证据」来解释质量。** 阶段数是形式，覆盖与核验才是内容。

---

## 1. 评估方法与数据口径

### 1.1 证据来源

| 类别 | 来源 | 用途 |
|---|---|---|
| OCR 代码 | `D:/Project/open-code-review` @ `d77d70b`：`internal/agent`、`internal/llmloop`、`internal/diff`、`internal/tool`、`internal/config/template/prompts/*` | 流程解剖、机制对照 |
| 本仓实现 | `packages/review-pi/src/loop/`、`run/`、`gate/`、`tools/`、`shared/config-limits.ts`、ADR-0038/0039/0046/0070/0071/0090/0102/0105/0109/0110/0111 | 机制事实 |
| 归档 session | `repo-diff-skill-result/**`（6 个 run）与 `C:/Users/Li/.PiAgent/tasks/*`（6 个历史任务） | 逐 run 成本/阶段/工具行为 |
| 小 diff 评测 | `docs/report/test12-small10-*.md/csv`（10 条 / 47 GT） | P/R/B、token、工具、补漏实验 |
| 大 diff 评测 | `docs/report/test12-large2-*.md/csv`（2 条 / 19 GT） | 分片、跳过、成本 |
| 漏报归因 | `test12-small10-v2-missed-gt-analysis`、`exp-group-missed-gt-classification` | 漏报类型与文件级覆盖 |
| 安全集 | `VUL4J-10例评测报告-20261109.md` | 安全召回、噪声、阈值 |
| 设计历史 | `docs/report/POC1、Phase1、Phase2 阶段事实与教训摘要.md`、`生产化可行性事实调查.md` | 六阶段来源与已知成本项 |

### 1.2 口径限制（先说不确定）

1. **样本小**：归档 session 只有 6 个 run；test12 小 diff 10 条、大 diff 2 条；VUL4J 10 例。方向性结论可信，绝对数值不可外推。
2. **单轮 judge 噪声**：test12 的 P/R/B 来自 `deepseek-v4-pro` 单轮判定；报告本身记录了 judge 空响应与 1.7pp 级别的抖动（`test12-small10-versions-comparison` §7）。
3. **exp-group 是旧版本**（review-pi 0.6.1，`arm2`），只能用于「问题类型/覆盖形状」的定位，不能当作当前版本的绝对指标（报告 §2 已声明）。
4. **OCR 的数字是厂商口径**：AACR-Bench 的 P/R/F1 与 1/9 token 均来自 OCR README/博客，本仓库内不可复现；本文只在「同一 test12 数据集上的本地 OCR 运行」范围内做横比。
5. **ADR-0038 已退役字节门**：阶段提示词可以演进，但任何提示词/工具 schema 改动后，离线回放 trace 需要重录（否则 replay 全 miss 是预期现象，不是逻辑回归）。

---

## 2. 什么才算「合理的检视流程」

### 2.1 目标函数不是一个，而是六个

一个代码检视流程同时被六个量约束：

| 目标 | 定义 | 失败形态 |
|---|---|---|
| Precision | 报出的意见里真问题占比 | 噪声淹没评审者信任 |
| Recall | 变更引入的真问题里被报出的占比 | 「没审到」比「审错」更伤 |
| Coverage | 被真正审视过的变更文件 / hunk 占比 | 大 MR 里静默漏审 |
| Cost | token / 每条有效意见 | 大 MR 成本失控 |
| Latency | 端到端时间 | CI 阻塞、开发者不用 |
| Auditability | 能解释「为什么审了/没审/为什么信」 | 事故复盘与合规失败 |

**Precision 与 Recall 不是同一根旋钮。** 提高生成多样性会加 recall、加噪声；收紧验证会加 precision、丢真问题。合理流程必须显式选择取舍，并让取舍可测量——而不是用一段「请只报真问题」的提示词同时许愿两者。

### 2.2 合理流程的七个必备环节

从「输入 → 产出」的第一性原理拆，一个检视系统至少需要七件事：

1. **准入与净化**：确定 diff 的真实范围（base/head、merge-base、工作区），剔除二进制/密钥/generated/lockfile，记录剔除了什么、为什么。
2. **单元规划与覆盖分母**：把变更切成可执行的单元（文件/文件组/分片），并冻结一个**覆盖分母**：哪些文件、哪些 hunk 必须被审视。没有分母，就没有 coverage，只有「模型说审完了」。
3. **上下文获取**：按需读取 diff 之外的符号、引用、调用链、配置；每一次读取都要可记账、可复用、可预算。
4. **候选生成**：在「最小充分上下文」上生成候选。单一 prompt 的注意力会被同一 hunk 里更显眼的问题吸走（B1 实验已证实），所以高风险场景需要**独立的第二视角**，而不是在同一轮里加一句「再检查六项」。
5. **核验与接地**：先做确定性接地（文件/行号存在、引文能在 diff 或读取内容里找到），再做语义证伪（只有能指出具体反证才驳回）。
6. **仲裁与输出**：同根因去重、严重级/置信度排序、范围标注、确定性投影成 tips / 评论 / 报文。
7. **反馈与成本控制**：分阶段预算、提前停止、增量/断点续跑、acceptance feedback。

### 2.3 三条设计原则

| 原则 | 含义 | 反例 |
|---|---|---|
| **确定性放在不能错的地方** | 输入选择、覆盖分母、行号定位、去重、输出投影用代码；模型只负责「需要判断」的部分 | 让模型决定审哪些文件、让模型给行号且不做接地 |
| **每个阶段必须有机器可读产出或明确消费者** | 否则它就是成本，不是阶段 | 我们的 Phase 2 `riskClass` 没有消费者 |
| **覆盖是一等公民** | 「审过没有」必须和「报了没有」一样可审计 | 只统计 findings，不统计 reviewed files/hunks |

### 2.4 OCR 的骨架（代码事实）

OCR `ocr review` 的真实流水线：

```text
git diff 获取/解析（workspace / commit / range；固定 3 行上下文）
  → 确定性文件筛选（binary / secret / user rule / extension / default path / deleted / too_large）
  → 覆盖集冻结 + resume 指纹复用
  → LLM 语义分组（只看文件元数据；≥4 文件触发；每组 ≤10 文件）
  → 组间并发（默认 8）
       → 可选 Plan（churn 达阈值；每组一次；只读；第二轮起丢弃）
       → Main 工具循环（effort = 1/2/3 轮；每轮 ≤100 次 LLM 请求）
       → 每轮 Review Filter（只证伪；fail-open；保护性主题否决）
  → 行号确定性锚定（hunk 滑窗 → 跨文件唯一匹配 → LLM 重定位 → 输出前再解析）
  → text / json / sarif + manifest（决定退出码）
```

关键事实（均为代码可查）：

| 能力 | OCR 的做法 | 证据 |
|---|---|---|
| 文件选择 | 确定性 `selectFiles`，一次完成 7 类判断；密钥路径优先于任何 include | `internal/agent/selection.go:43-102` |
| 覆盖 | `manifest` 是一等公民：completed / reused / failed / waived，决定退出码 | `internal/session/manifest.go:247-304` |
| 分组 | 文件数 ≥4 时，用**只有文件元数据、没有 diff 内容**的 LLM 分组；≤10 文件/组；超 token 拆单文件 | `internal/agent/grouping.go:68-108`、`:323-367` |
| Plan | 条件触发（churn 阈值）；只读；工具不可实际调用；第二轮起清空，避免计划成为覆盖天花板 | `internal/agent/agent.go:1444-1471`、`:1508-1512` |
| 主循环 | 每轮重发完整增长对话；每轮最多 100 次工具请求；连续 3 轮无有效结果停止 | `internal/llmloop/loop.go:293-458` |
| 工具 | 仅 6 个文本工具（`task_done` / `code_comment` / `file_read` / `file_read_diff` / `file_find` / `code_search`），无 AST/符号/向量 | `internal/tool/definitions.go:17-25` |
| 上下文 | 默认注入「组内 diff」，不注入整文件；组外文件只给路径 + 增删行数 | `internal/agent/agent.go:1436-1442`、`:1689-1711` |
| 二次核验 | Review Filter：只删除「Ground A 位置不在 diff」或「Ground B diff 字面反驳」的评论；保护内存安全/并发/链接/行为变化；任何失败都保留 | `internal/config/template/prompts/review_filter_task_user.md:9-68`；`agent.go:1839-1964` |
| 定位 | 行号不由模型最终决定；滑窗匹配 → 跨文件唯一命中 → LLM 重定位 → 输出前再解析 | `internal/diff/resolver.go:16-59`、`:155-194` |
| 大文件 | 单文件 diff > 80% MaxTokens → `too_large`，整文件不审（**放弃而非切块**） | `internal/agent/selection.go:44-58` |
| 长会话 | 三区记忆压缩：冻结前 2 条、压缩中间、保留最近完整轮次；60% 异步 / 80% 同步 | `internal/llmloop/compression.go:18-30` |
| 成本 | 单文件 80% / 组 token / 轮前 80% / 聚合预算 / grace round / 提前停止 / prompt cache affinity | `selection.go`、`agent.go:691-719`、`loop.go:326-329`、`sessionkey.go:49-81` |
| 缺口 | 无 confidence、无独立 verifier、无全局风险分级；severity 在 Main 侧没有 rubric | `internal/model/review.go:7-21`；`tools.json:65-74` |

**OCR 的本质取舍**：用「确定性缩小输入空间 + 覆盖审计 + 保守证伪」换 precision 和成本；主动放弃单文件超大 diff 与一部分 recall（README 明说 Recall 较低）。它没有试图用一套固定阶段同时解决所有问题。

### 2.5 七环节对照：OCR vs 我们

| 环节 | OCR | 我们 | 差距判断 |
|---|---|---|---|
| 准入/净化 | 确定性筛选 + 单文件体积门 + preview | `mrFilter` + `boundary` 体积门 + `--repo` 侧别提示 | 我们少 `--preview`；体积门与分片不一致（见 §5） |
| 单元规划/覆盖 | 语义分组 + manifest + resume | `diff --git` 贪心装箱；无 manifest；无 resume | **最大差距：覆盖分母缺失** |
| 上下文 | 6 个文本工具；组内共享 diff；长会话压缩 | 8 个工具（含 AST 符号/引用/调用链）；Ledger；8K/结果；100 次/run；无压缩 | 工具更强；预算更粗；无长会话压缩 |
| 候选生成 | 1/2/3 轮主循环；confirmed findings 注入防重复 | 固定 6 阶段单轮；可选的独立六项补漏扫描（默认关） | 我们的「第二次独立视角」已验证有效但默认关 |
| 核验 | Review Filter：只证伪、fail-open、保护性主题 | Phase 6 自审 + 候选拦截链；evidence 只验「非空数组」 | **缺少确定性接地与独立核验** |
| 仲裁/输出 | 行号确定性锚定；无语义去重；manifest | 同根因去重；行号由模型给；scope 门；tips 确定性投影 | 定位不如 OCR 稳；去重比 OCR 强 |
| 反馈/成本 | 多层预算、grace round、resume、manifest | 分片、上下文窗口收窄、超时重试；无 resume/preview | 我们缺少「中断可恢复」与「先看会审什么」 |

---

## 3. 我们当前六阶段的机制解剖

### 3.1 端到端

```text
mr diff
  → filterDiffForReview（testFiles / excludeGlobs / include/exclude）
  → no-reviewable-files → skipped
  → maxDiffChars 体积门 → diff-too-large → skipped
  → guardMrBoundary（度量，不阻断）
  → planReviewShards（> maxShardChars 才分片；单文件块按整 hunk 截取）
  → 单遍或逐片（串行）：
       initial user message = caseId + issueDescription + diff（+ repo side note）
       → Phase 1..6（一阶段一回合；工具可随时调用）
       → Phase 5 之后：可选的独立补漏扫描；然后规则 Skill 会话
       → Phase 6：候选拦截链 → 本轮 findings
       → complete=false 且未到 maxRounds → 下一轮 Phase 1
  → mergeShardFindings（按 file,line,title）
  → tips / MCP / 总结（确定性投影，零额外模型调用）
```

证据：`run/review-run.ts:299-366`、`run/pass-runner.ts:305-391`、`loop/agent-review-loop.ts:418-597`、`run/findings-merge.ts:1-80`。

### 3.2 每个阶段的真实产出与消费者

| 阶段 | 指令要求 | 代码实际怎么处理 | 机器消费者 | 评价 |
|---|---|---|---|---|
| Phase 1 Change Understanding | `{"summary":"..."}` | `parsePhaseReply` 对 index 0–3 直接返回 `{}` | **无** | 只作为对话上下文影响后续阶段；摘要写错无人校验 |
| Phase 2 Risk Classification | `{"riskClass":"Low\|Medium\|High","reason":"..."}` | 同上，整个 JSON 丢弃 | **无**（连审计都没有） | 六阶段里最薄的一环；唯一「消费者」是模型自己 |
| Phase 3 Context Decision | `{"neededContext":[...]}` | 同上 | **无** | 计划只存在于会话里；Phase 4 是否执行无法被代码检查 |
| Phase 4 Context Retrieval | `{"notes":"..."}` | 同上 | **无**（但工具结果进入消息历史） | 唯一真正「增产」的 1–4 阶段；无工具时是纯空转请求 |
| Phase 5 Deep Reasoning | `{"candidates":[...]}` | `parseCandidatesReply` → 归一化/修复 → 候选门 | **有**：拦截链、findings、tips、MCP | 核心生产阶段 |
| Phase 6 Evidence Verification | `{"verdicts":[...],"complete":bool}` | `parseVerificationReply` → `applyCandidateGate`；`complete` 只在显式 `false` 时续轮 | **有**：`VERIFICATION_FAILED`、轮次调度 | 方向正确，但自审 + 无接地 |

关键代码：

- `parsePhaseReply` 只为 index 4/5 解析，其余返回 `{}`：`loop/agent-review-loop.ts:755-787`。
- Phase 5 sweep 是 Phase 5 之后的**独立请求**，不新增 PhaseRecord，按同根因语义（同文件 + 同 category + 行号 ±5，且 rule 相同或标题相似）与主候选合并：`loop/agent-review-loop.ts:228-231`、`:904-930`；`gate/candidate-merge.ts`。
- 规则 Skill 会话在 Phase 5 之后、Phase 6 之前，每个 skill 独立会话，种子是 Phase 5 末的 messages 快照：`loop/agent-review-loop.ts:537-546`。
- `complete` 缺省/非布尔一律按 `true`：`shared/parse.ts:106-110`；最后一轮强制 complete：`loop/agent-review-loop.ts:575-584`。

### 3.3 三道关键机制

#### 3.3.1 工具、Ledger 与预算

- 单次工具结果 8,000 字符（≈2K tokens），行边界截断并留提示：`tools/result-budget.ts:11`；`tools/get-file.ts:204-209`。
- Context Ledger 只对**完全相同的规范化请求**去重（路径 + 请求区间），不同区间会重新读：`tools/get-file.ts:75-87`。
- 全局工具预算 100 次/run，跨轮、失败也计：`loop/constants.ts:4`。
- 上下文窗口：估算输入 + 32K 输出超窗时本地 fail fast 或降预算重试；ADR-0102 明确**不做输入侧压缩**。

#### 3.3.2 候选拦截链

顺序：`SCHEMA_INVALID → NO_EVIDENCE → VERIFICATION_FAILED → OUT_OF_SCOPE → DUPLICATE_ID`，每候选只留首个失败阶段（`gate/candidate-gate.ts:122-175`）。

- `NO_EVIDENCE` 只检查 `evidence` 是「非空字符串数组」：`candidate-gate.ts:177-182`；schema 也只验类型：`finding/finding-schema.ts:55-63`。
- `OUT_OF_SCOPE` 由 `findingScope` 控制，缺省开启、hunk ±10 行：`shared/config-limits.ts:218`。
- 行号由模型给出，Gate 只判断是否落在 hunk 范围，不做「引文是否真的存在」的核对。

#### 3.3.3 分片

- 只切 `diff --git` 文件块，绝不切 hunk；单块超预算按整 hunk 截取并留痕：`run/shard-planner.ts:1-30`。
- 分片串行执行：`run/pass-runner.ts:199-212`。
- 片间只给「其他文件路径 + 增删行数」，不是证据源：`run/shard-planner.ts:32-38`。
- 合并键是精确的 `(normalize(file), line, normalize(title))`：`run/findings-merge.ts:1-20`。

### 3.4 设计意图与历史包袱

六阶段骨架来自 POC1/DSH 线，曾被当作「测量常量面」：阶段结构、Zone A 提示词、Finding/Evidence 契约进入字节门与 A–E 配置矩阵。ADR-0024 废止配置矩阵，ADR-0038 退役字节门，**现在阶段本身可以演进**（ADR-0038 明确指出阶段内容需要可演进，新能力不必再为旧字节门绕行）。

这意味着：我们不是「不能改六阶段」，而是「一直没有为了质量去改它」。本文的建议都以 ADR-0038 之后的自由度为前提。

---

## 4. 历史 Session 与评测证据

### 4.1 归档 session 的微观指标

6 个归档 run（小仓库/合成缺陷）全部单轮完成：

| run | 总请求 | 各阶段 requestCount（P1/P2/P3/P4/P5/P6） | 工具调用 | findings | 拒绝 | token 输入/输出/缓存 | 耗时 |
|---|---:|---|---:|---:|---:|---|---:|
| mcp-mock 065124 | 8 | 1/1/1/**3**/1/1 | 9 | 2 | 0 | 12.4K / 5.6K / 68.0K | 52.2s |
| mcp-mock 065257 | 11 | **2**/1/**2**/**4**/1/1 | 13 | 3 | 0 | 14.4K / 6.3K / 86.4K | 57.6s |
| mcp-mock 074148 | 7 | 1/1/1/**2**/1/1 | 10 | 3 | 0 | 14.6K / 5.5K / 65.0K | 46.8s |
| synthetic 173417 | 9 | 1/1/1/**4**/1/1 | 9 | 2 | `VERIFICATION_FAILED`×1 | 16.4K / 5.8K / 54.0K | 53.2s |
| synthetic 173620 | 9 | 1/1/1/**4**/1/1 | 13 | 3 | 0 | 13.8K / 7.4K / 63.4K | 58.9s |
| synthetic 142618 | 9 | 1/1/1/**4**/1/1 | 13 | 3 | 0 | 17.5K / 5.9K / 59.9K | 52.7s |

来源：`repo-diff-skill-result/**/audit/*.json` 的 `phaseLog` / `toolCallLog` / `usage` / `durationMs`。

读法：

1. **Phase 4 是请求大头**：7–11 个请求里占 2–4 个；其余阶段通常各 1 个。工具调用全部发生在 Phase 4（个别 run 在 Phase 1/3 有 1–2 次）。
2. **Phase 2 从未产生可观测价值**：每个 run 固定 1 个请求，产出被丢弃。
3. **单轮完成**：所有 run `rounds=1`；多轮机制在这批数据里没有发生。
4. **拒绝极少**：6 个 run 合计只有 1 条 `VERIFICATION_FAILED`。Phase 6 不是主要的降噪器。
5. **工具以读文件与搜索为主**：小仓库 run 的 `get_file` 为 1–2 次，`search_code` 4–6 次；大仓库分片里 `get_file` 占 54.5%（见 §4.3）。

再看 6 个历史任务（较大仓库、含规则 Skill；均为单遍、单轮）：

| task | 总请求 | 阶段 requestCount（P1/P2/P3/P4/P5/P6） | 工具调用 | findings | 拒绝 | token 输入/输出/缓存 | 耗时 |
|---|---:|---|---:|---:|---:|---|---:|
| e2e-change-001 | 9 | 1/1/1/**4**/1/1 | 15 | 4 | 0 | 8.4K / 5.3K / 26.0K | 39.9s |
| f-demo-session-skill-2 | 13 | 1/1/1/**8**/1/1 | 19 | 9 | 0 | 64.9K / 17.6K / 363.0K | 143.0s |
| f-s5-regression | 14 | 1/1/1/**8**/**2**/1 | 17 | 5 | 0 | 46.9K / 11.0K / 261.8K | 98.6s |
| f-s5-regression2 | 14 | 1/1/1/**9**/1/1 | 27 | 11 | 0 | 59.0K / 17.8K / 355.5K | 154.7s |
| large-mr-lifecycle-probe | 12 | 1/1/1/**7**/1/1 | 22 | **51** | 1 | 84.3K / 36.9K / 425.2K | 265.3s |
| large-mr-oc-probe | 9 | 1/1/1/**4**/1/1 | 22 | **56** | 1 | 101.9K / 35.5K / 362.1K | 255.1s |

来源：`C:/Users/Li/.PiAgent/tasks/*/audit/*.json`。

这组数据补充了五点：

1. **Phase 4 的占比随工具使用上升**：在 14 个请求的 run 里，Phase 4 占 8–9 个（约 60%）。归档小仓库 run 是 2–4 个；工具越有用，Phase 4 越像真正的主战场。
2. **Phase 1/2/3/6 几乎恒定各 1 个请求**：六阶段里有一半是「固定开销」。
3. **大仓库 run 的 findings 数量（51/56）与拒绝数（1）**：说明 Phase 6 在真实噪声面前几乎不筛；这与 VUL4J 的 24.2% 噪声互相印证。`large-mr-*` 两个 run 的工具分布是 `get_file` 8–9 次、`find_references` 5–6 次、`search_rule`/`search_history` 各 2–5 次（后两者是 knowledge 语料工具，见 §3.3）。
4. **Ledger 只认「完全相同的请求」，不认「已覆盖的行区间」**：`f-demo-session-skill-2` 先整读 `AbstractUrlBasedTicketValidator.java`，随后又读 `192-251`；`large-mr-lifecycle-probe` 先整读 `OrderService.java`，随后又读 `175-271`——同一文件被重复读盘。全部 12 个 run（6 个小仓库归档 + 6 个历史任务）的 Ledger 命中合计只有 0–1 次，`tools` 与 `ledger` 条目数几乎相等。这是 §7 P1-8 的直接证据。
5. **Phase 6 在归档数据里接近全通过**：`pass=false` 每个 run 只有 0–1 条，`complete=true` 全部；f-demo 的 9 条 pass 包含主会话 6 条 + 规则 Skill 3 条，large-mr 的 51 条 pass 对应 33 条主候选 + skill 候选。也就是说，当前证据门主要在**生成时**约束模型，而不是在**核验时**筛掉噪声；VUL4J 的 24.2% 噪声与 large-mr 的 51/56 条产出指向同一结论。

### 4.2 小 diff：10 条 / 47 GT

| 版本 | Precision | Recall | Balanced | 生成 | 覆盖 GT | 总 token | 耗时 | 工具调用 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| OCR v1.13.10 | 0.528 | 0.426 | 0.471 | 36 | 20/47 | 9.09M | 2449s | 380 |
| 旧 baseline | 0.388 | 0.426 | 0.406 | 49 | 20/47 | 2.45M | 1530s | — |
| v1 粗去重 | **0.682** | 0.340 | 0.454 | 22 | 16/47 | 3.44M | 1399s | 198 |
| v2 收紧去重 | 0.577 | 0.340 | 0.428 | 26 | 16/47 | 3.35M | 1442s | 211 |
| B1 单提示词六项镜头 | 0.581 | 0.355 | 0.441 | 27 | 16.7/47 | 3.10M | 1514s | 218 |
| **B2 独立补漏扫描** | 0.552 | **0.440** | **0.489** | 35 | **20.7/47** | **2.98M** | 1675s | **176** |

来源：`docs/report/test12-small10-versions-comparison-20261117.md` §2/§3；`test12-small10-b2-sweep-experiment-20261118.md` §1。

判读：

1. **小 diff 上我们已经与 OCR 打平甚至略胜**：v1 B 0.454 vs OCR 0.471（差 1.7pp，在 judge 噪声内）；B2 B 0.489 稳定超过 OCR（三轮最低 0.477）。
2. **precision 是我们的强项**：v1 0.682、v2 0.577，远高于 OCR 0.528；v1/v2 做到 0 条意见落在无 GT 文件。
3. **独立性比提示词更强**：同样是「六项镜头」，B1（同一轮加提示）R 0.355；B2（独立请求）R 0.440。**注意力置换是真实存在的**，靠加一句「再检查一下」解决不了。
4. **B2 的成本没有上升**：token 2.98M < v2 3.35M，工具调用 176 < v2 211；只多了 233s 墙钟时间。
5. **去重规则不是主要变量**：v1→v2 的差异被模型/judge 噪声掩盖；收紧去重修复了已证实的误杀，但收益需要多轮平均才能体现。

### 4.3 大 diff：2 条 / 19 GT

| 来源 | Precision | Recall | Balanced | 生成 | 覆盖 GT | 总 token | 耗时 |
|---|---:|---:|---:|---:|---:|---:|---:|
| OCR | **0.462** | **0.632** | **0.533** | 13 | **12/19** | **1.04M** | 242s |
| 旧 baseline | 0.008 | 0.053 | 0.014 | 124 | 1/19 | 15.90M | 2711s |
| current | 0.008 | 0.053 | 0.013 | 130 | 1/19 | 14.44M | 1010s |
| **本次（exp-tools）** | 0.015 | 0.053 | 0.023 | 67 | **1/19** | 8.70M | 1266s |

来源：`docs/report/test12-large2-data-20261117.md` §2。

两个样本的问题不同：

- **`ragflow@7051234`（6 GT）**：本次切 5 片、255 次工具调用、67 条意见；其中 66 条（98.5%）落在没有 GT 的文件。问题不是「文件内判不准」，而是**没往有 GT 的文件上报**。逐片工具分布：`get_file` 139（54.5%）、`search_code` 87（34.1%）、`find_references` 23（9.0%）、`get_symbol` 6（2.4%）。
- **`FreeCAD@699b45c`（13 GT）**：diff 超过 `maxDiffChars=1,000,000`，整条 MR 在准入阶段被 `diff-too-large` 跳过，13 条 GT 全部无法覆盖。OCR 用 114s 覆盖 9/13。

这暴露了三个独立问题：

1. **准入与分片的不一致**：`maxDiffChars` 在分片规划之前判定（`run/review-run.ts:334-353`），而分片容量是 `maxShards × maxShardChars = 12 × 120K = 1.44M`。超过 1M 但小于 1.44M 的 MR 明明能分片，却被整条拒绝；FreeCAD 就是这种情况。
2. **分片串行 + 片内全套六阶段**：5 片串行，每片 6 阶段起步，导致 1266s / 8.7M token；OCR 8 组并发、242s / 1.04M token。
3. **分片后失去全局视野**：片间只给路径与增删行数，模型不知道该去哪个文件找跨文件影响；`search_code` 成为唯一全局手段，于是 `get_file` 被大量调用，意见落点分散。

### 4.4 漏报归因：主要不是「没读到」，而是「读到了没生成」

v2 在 10 条小 diff 上漏掉 31 条 GT，逐条归因（`test12-small10-v2-missed-gt-analysis` §3.1）：

| 类别 | 数量 | 含义 |
|---|---:|---|
| A. 被 Gate 拦截 | 1 | 唯一一条 `VERIFICATION_FAILED` |
| B. 同一根因报在别处 | 2 | 评测按文件匹配的计分问题 |
| C. 同位置报了另一个问题 | 6 | 注意力被同 hunk 更显眼的问题吸走 |
| D. 明确检查后判断安全 / 既有问题 | 3 | 模型主动不报 |
| E. 建议/风格/重构类 | 8 | 产品口径主动压制 |
| F. Phase 1 描述了改动但没生成候选 | **11** | **纯生成缺口** |
| 合计 | **31** | |

关键判读：

- **31 条 GT 全部落在 diff hunk 内**，没有一条因范围门被排除；A 类只有 1 条。所以「Phase 6 太严」不是主因。
- F + E + D = 22 条（71%）是「模型看到了/理解了，但没有转成候选」。补 recall 的主战场在 Phase 5 的生成覆盖，而不是再加一道验证。
- C 类 6 条说明「同一 hunk 只报最显眼的一条」是真实行为；这正是独立二次扫描（B2）能补的。

大样本（exp-group，旧版本，91 条交集 / 588 GT）进一步给出形状：

| 观察 | 数值 | 含义 |
|---|---:|---|
| 我们漏掉的 GT 中，所在文件没有任何我们的意见 | **56.8%**（274/482） | **文件级覆盖是最大问题** |
| 同文件有意见但不在 ±10 行 | 22.0% | 审到了文件，没审到点 |
| ±10 行内有意见但没对上问题 | 21.2% | 写偏了 |
| OCR 漏掉的 GT 中，文件无任何意见 | 31.5% | OCR 的文件级覆盖明显更好 |
| OCR 独有命中（我们漏、OCR 命中） | 143 条 | 融合潜在收益 |
| 其中「类型/解析/序列化/编码」被 OCR 补回 | 52.0% | 我们最明显的镜头缺口 |
| 性能 / 资源 / 边界被 OCR 补回 | 40.6% / 34.8% / 34.5% | 需要专门镜头 |

来源：`docs/report/exp-group-missed-gt-classification-20261118.md` §3/§7/§8。

### 4.5 VUL4J 安全集：召回可用，噪声有固定形状

10 例 / 19 个真值行位（`VUL4J-10例评测报告-20261109.md` §2/§4/§5）：

| 指标 | 数值 |
|---|---:|
| 位置召回 micro | 63.2%（12/19） |
| 案例召回 | 100%（10/10） |
| 位置精准度 | 51.5%（17/33） |
| 人工语义精准度 | 66.7%（22/33） |
| 纯噪声 | 24.2%（8/33） |
| findings 落在测试文件 | 0/33 |

三个可执行的结论：

1. **纯噪声 8 条全部是「质量/文档/性能推测」**；「修复不完整 / 相邻通道未加固」的 7 条是**高价值发现，不应压制**。这支持「按类别约束」而不是「整体降噪」。
2. **severity 阈值维持 P3**：提高到 P2 会丢 1 个真值且精准度不升；命中真值位的 findings 里 P3 占 6 条。
3. **confidence 缺省 0.5 是纯损失**：阈值从 0 提到 0.5，精准度反而从 51.5% 降到 50.0%，同时丢掉 2 个真值；0.3 与 0 结果一致。当前缺省仍是 0.5（`shared/config-limits.ts:210`）。

### 4.6 证据小结

| 命题 | 数据支持 | 结论 |
|---|---|---|
| 六阶段不是召回瓶颈 | 漏报里 Gate 只占 1/31；Phase 1 已理解大部分改动 | 阶段数与召回无直接关系 |
| 生成与覆盖才是瓶颈 | F 类 11 条 + 文件级无意见 56.8% | 需要覆盖分母与第二视角 |
| 独立补漏有效 | B2 R +10.0pp、B +6.1pp，成本不升 | 应默认开启或做成覆盖驱动 |
| 大 MR 结构性失败 | 1/19 覆盖、8.7M token、FreeCAD 整条跳过 | 先修准入与分片架构 |
| 自审不足以降噪 | 仅 1 条拒绝；VUL4J 噪声 24.2% | 需要接地 + 独立核验 |
| 成本集中在 Phase 4 与大 MR | Phase 4 占 2–4/7–11 请求；大 MR 8.7M token | 检索预算与分片并行 |

### 4.7 成本模型：阶段、工具、分片如何相乘

把一次检视的请求数拆开，可以看到成本是怎么长出来的：

```text
每单元请求数 ≈ 6（六阶段文本回合）
             + Phase 4 工具批次（每批一次请求；归档 run 为 2–4）
             + 少量阶段内工具/解析重试（Phase 1/3 偶发）
             + 独立补漏扫描（若开启，+1）
             + 规则 Skill 会话（每个 skill 至少 +1，且继承主会话上下文）
```

由此：

| 杠杆 | 影响 | 当前状态 |
|---|---|---|
| 六阶段 | 每单元固定 6 次起步 | 1–4 阶段无机器消费者，但单次请求成本真实 |
| 工具批次 | Phase 4 每批工具结果都触发下一次请求 | 全局 100 次工具调用，单结果 8K 字符 |
| 分片 | 请求数 × 片数；串行时延迟也 × 片数 | 串行；`maxShards=12` |
| 规则 Skill | 每个 skill 一个完整会话，种子继承 Phase 5 上下文 | 顺序执行；每个 skill 独立 Ledger |
| 补漏扫描 | +1 请求，但可能减少后续无效工具调用 | 默认关闭 |

token 侧的量级可用 ADR-0071 的实测模型估算：

```text
峰值 tokens ≈ (shard 字符数 + 9,600) / 3.85 + 45,500
```

120K 字符的片，峰值约 79K tokens（62% of 128K）。也就是说，**单片的上下文预算是可控的；真正失控的是片数与串行**，以及「每片都重跑完整六阶段 + 规则 Skill」的乘法。

---

## 5. 判断：哪里合理、哪里不合理

| # | 机制 | 设计意图 | 证据 | 判断 | 改进方向 |
|---|---|---|---|---|---|
| 1 | 六阶段固定骨架 | 用回合边界强制「理解→分级→取上下文→推理→验证」 | Phase 1–4 的 JSON 产出不消费；Phase 2 完全空转；Phase 4 无工具时空转 | **方向合理，实现偏重** | 合并/条件化；让每阶段有机器产出或消费者 |
| 2 | Phase 1 变更理解 | 防止直接下结论 | 漏报中 Phase 1 已描述改动（F 类 11 条） | **合理，但无校验** | 产出结构化 change inventory；与覆盖分母绑定 |
| 3 | Phase 2 风险分级 | 用风险驱动深度 | `riskClass` 无任何消费者 | **不合理（当前形态）** | 消费它（深度/轮数/扫描）或删除 |
| 4 | Phase 3 上下文决策 | 先列缺口再检索 | `neededContext` 丢弃；Phase 4 不受约束 | **部分合理** | 把计划变成可核对的 retrieval checklist |
| 5 | Phase 4 上下文检索 | 按需取最小充分证据 | 唯一增产的 1–4 阶段；大分片 get_file 54.5%；无工具时空转 | **合理但无预算/无覆盖** | per-file/ per-hunk 检索预算；重叠区间账本 |
| 6 | Phase 5 深度推理 | 产出候选 | 核心；71% 漏报是生成缺口；B2 证明独立视角有效 | **合理，但单一视角** | 多镜头独立 pass；覆盖驱动补漏 |
| 7 | Phase 6 证据核验 | No Evidence, No Finding | 只验非空数组；自审；每 run 仅 0–1 条拒绝；VUL4J 噪声 24.2% | **方向合理，执行不足** | 确定性接地 + 独立证伪核验 |
| 8 | 多轮（maxRounds=3） | 模型自评后补审 | 所有归档 run rounds=1；complete 缺省 true | **机制几乎失效** | 改为边际收益停止（无新增即停）+ 硬上界 |
| 9 | 分片 | 让大 MR 能跑 | 串行；片间无全局上下文；准入门与容量不一致 | **确定性好，架构不足** | 并行；模块分组；跨片上下文；准入一致 |
| 10 | 候选拦截链 | 统一降噪 | 顺序清晰；无接地；scope 丢弃而非标注 | **合理但偏「形式校验」** | 加 evidence grounding；scope 标注 |
| 11 | 规则 Skill | 可执行项目知识 | 独立会话、Phase 6 统一裁定 | **合理且是差异化优势** | 量化增量价值；避免每 skill 全量重读 |
| 12 | 输出过滤 | 控制 tips 噪声 | confidence 0.5 是纯损失；severity P3 正确 | **部分需校准** | confidence 缺省 0.3；范围标注 |
| 13 | 可审计/可回放 | 事故复盘 | 审计/转录/时间线齐全 | **合理且是优势** | 补 coverage manifest |

### 5.1 最不合理的五件事（按影响排序）

1. **没有覆盖账本**：流程可以「完成」而没有任何地方记录「哪些文件/hunk 没被审视」。这是 56.8% 文件级漏报的土壤，也是大 MR 失控的根源。
2. **大 MR 准入与分片自相矛盾**：能分片的 MR 被体积门整条拒绝；分片又串行执行，成本与延迟同时失控。
3. **核验没有接地**：`evidence` 只要非空就算有证据；行号由模型给，Gate 不核对引文是否存在。所谓「No Evidence, No Finding」目前只落实了「No empty array, No Finding」。
4. **已验证有效的补漏通道默认关闭**：`phase5Sweep` 缺省 `false`（`shared/config-limits.ts:188`），而 B2 是当前唯一在 Balanced 上三轮均超过 OCR 的机制（0.477 / 0.477 / 0.514 vs 0.471）。
5. **风险分级是死代码**：Phase 2 花一个请求产出一个从未被读取的字段。要么让它驱动预算，要么删掉。

### 5.2 哪些「不合理」其实是产品取舍

需要区分「流程缺陷」与「产品口径」：

- **主动不报建议/风格/测试缺失**：这是产品选择（只报缺陷），不是缺陷；代价是 benchmark recall 低。不要为了追 GT 把 P3 噪声放回来。
- **hunk ±10 范围门**：默认丢弃范围外意见，是 precision 取舍；VUL4J 中范围外 11 条有 8 条真实。更合理的形态是**标注而不是丢弃**（`scope: outside-diff`），由下游决定是否展示。
- **单轮为主**：如果数据证明多轮边际收益低，保留机制但不要假装它在工作；把「独立第二视角」做成显式机制，比「让模型自己说要不要再来一轮」可靠。

---

## 6. 目标流程（to-be）

### 6.1 总体形态

```text
[0] 准入与覆盖分母
    diff 获取/解析 → 确定性过滤 → 覆盖清单（文件 × hunk）
    → 体积规划：能分片就分片，不因总量超限整条跳过
    → manifest：selected / excluded(reason) / truncated / planned units

[1] 单元规划（确定性优先）
    小 MR：文件块或小 bundle
    大 MR：按目录/模块确定性分组（可选 LLM 只做合并建议，不决定审不审）
    → 每组一个独立会话；组间并行（可配并发）

[2] 每单元检视
    a. 确定性预取：changed symbols / direct references / diff 上下文
    b. 覆盖驱动的候选生成：逐 hunk 过镜头清单
       （空值、边界、类型/编码、错误路径、资源、并发/幂等、API 契约、性能）
    c. 覆盖账本：每个 hunk 记录 candidate / no-issue(reason) / not-reached
    d. 未覆盖 hunk → 定向补漏（独立请求，不再是泛化的「六项再扫一遍」）

[3] 核验
    a. 确定性接地：schema、位置在 diff、引文能在 diff/读取内容中找到
    b. 独立证伪：新会话，只带候选 + 证据 + 相关 diff；只有具体反证才驳回
    c. 保护性主题：内存安全/并发/契约变化默认保留（参考 OCR）
    d. 同根因去重

[4] 仲裁与输出
    排序 → scope 标注（in-diff / same-file-out / other-file）→
    severity/confidence 过滤 → tips / MCP / manifest

[5] 反馈与成本
    每阶段 token/耗时；acceptance rate；resume/incremental；预算闸门
```

### 6.2 与现有六阶段的映射

| 现有 | 目标 | 处理 |
|---|---|---|
| Phase 1 Change Understanding | 并入「准入与覆盖分母」 | 产出结构化 change inventory（文件、hunk、符号、意图），作为覆盖分母，而不是自由文本摘要 |
| Phase 2 Risk Classification | 并入 Phase 1 | 风险只作为**预算参数**（深度/轮数/是否补漏），不再单独占一个请求 |
| Phase 3 Context Decision | 并入「检索计划」 | 计划变成可核对的 checklist；空计划合法 |
| Phase 4 Context Retrieval | 保留为「按需检索」 | 有工具时执行；无工具/无缺口时跳过，不再空转 |
| Phase 5 Deep Reasoning | 拆成「多镜头独立生成」 | 主 pass + 未覆盖 hunk 定向补漏；高风险可加第二镜头 |
| Phase 6 Evidence Verification | 拆成「接地 + 独立证伪」 | 确定性检查在前，独立会话在后；fail-open 保护高价值主题 |

**保留**：回合边界、Finding/Evidence 契约、八个工具、Ledger、审计/转录、规则 Skill、确定性 tips 投影。这些是优势，不要为了「像 OCR」而拆掉。

### 6.3 覆盖账本（最关键的增量）

建议把「覆盖」做成与 findings 并列的一等产物：

```jsonc
{
  "unit": "src/foo/Bar.java",
  "hunks": [
    { "index": 1, "lines": "40-52", "status": "candidate", "findingIds": ["F001"] },
    { "index": 2, "lines": "70-78", "status": "no-issue", "reason": "仅格式化" },
    { "index": 3, "lines": "101-120", "status": "not-reached" }
  ],
  "reads": ["ctx#001", "ctx#004"],
  "truncated": false
}
```

写入时机：

- 单元开始时由确定性 planner 生成 hunk 清单（分母）；
- Phase 5 产出候选后，按 `file + line` 回填；
- 未回填的 hunk 进入 targeted repair pass；
- 仍为 `not-reached` 的 hunk 进 manifest，作为「诚实未覆盖」，而不是静默成功。

验收口径：

- 每个 changed file 至少有一个 hunk 状态；
- `not-reached` 比例可监控、可按配置上界失败；
- 覆盖补漏只对未覆盖 hunk 发请求，避免全量重扫。

### 6.4 大 MR 设计

| 问题 | 目标设计 |
|---|---|
| 准入与分片不一致 | `maxDiffChars` 只作为「单遍输入」上限；启用 split 时，准入改为「片数 ≤ maxShards」或「单块截取可接受」；不再整条 MR 跳过 |
| 串行慢 | 组间并发（默认 3–8，可配）；保留每片独立审计/转录；聚合 `runId` 与失败语义不变 |
| 片间无上下文 | 每片注入确定性 repo map（目录树 + 变更符号索引 + 跨片引用提示），仍不作为证据源；跨片调用链用全局 symbol index 解析 |
| 分组不语义 | 先做确定性目录/模块分组（可复现），再允许可选的 LLM 合并建议；**不让模型决定「审不审」** |
| 成本 | 每片风险/预算：低风险片降轮数、关补漏；高风险片才跑第二镜头 |
| 中断 | 片级 checkpoint + 文件指纹；resume 只重跑未完成片 |

### 6.5 核验设计

分两层，顺序不能反：

1. **确定性接地（硬门，零模型）**
   - 文件在 diff 或读取集合中；
   - 行号在 diff hunk 内（或按配置的 scope）；
   - `evidence` 里的引文能在 diff / 读取内容中匹配（允许归一化空白）；
   - 引用工具结果的证据必须能在 Ledger 中找到对应条目。
2. **独立语义证伪（软门，模型）**
   - 新会话，不带生成者的完整推理历史，只带候选 + 证据 + 相关 diff；
   - 只有「具体反证」才判 fail；证据不足默认 pass（fail-open，参考 OCR）；
   - 保护性主题（内存安全、并发、契约变化）先于对错判断保留。

这样可以避免当前的两个极端：同一会话自审（容易自我确认）与「形式校验通过就放行」（噪声 24.2%）。

### 6.6 成本与延迟

| 杠杆 | 当前 | 建议 |
|---|---|---|
| Phase 4 空转 | 无工具时仍发一次请求 | 无工具/无缺口时跳过；或把 Phase 3+4 合并 |
| 检索预算 | 全局 100 次、单结果 8K | per-file / per-hunk 读取预算；重叠区间 Ledger；`search_code` 命中上限与去重 |
| 大 MR | 串行分片 | 并行 + 风险自适应深度 |
| 长会话 | 无压缩（ADR-0102 明确不做） | 保留为逃生口：只在接近窗口时压缩，压缩后必须保留证据锚点 |
| 轮次 | 模型自评 + 3 轮上界 | 边际收益停止：无新增候选即停；确认数上限；硬上界保留 |

### 6.7 非代码变更（doc / skill-doc）

`.scratch/design-review-flow.html` 提出的「确定性分类 + per-kind brief + per-kind scope」方向合理，但要补三点：

1. **Phase 1–2 不注入 brief 是对的**：这两阶段没有机器可见的决策；注入只会改变叙事，破坏全代码 MR 零漂移。
2. **Phase 4 的引用核对要有预算**：文档引用越多，`get_file` 越多；会话 append-only，读进来的 8K 片段不会消失。建议只核对可机器判定的引用（路径存在、命令、配置键），命中即停。
3. **`whole-file` 是位置门，不是读取策略**：`get_file` 仍按 8K 截断，模型可能对没读到的行段下结论；doc brief 必须要求「只对已读片段下结论」，或对超长文档强制分段读取。

---

## 7. 改进清单

按「证据强度 × 预期收益 ÷ 风险」排序。

### P0（先做，直接改变质量/成本曲线）

| ID | 改进 | 证据 | 预期收益 | 风险 / 验收 |
|---|---|---|---|---|
| **P0-1** | **覆盖账本 + 未覆盖 hunk 定向补漏** | 56.8% 文件级无意见；F 类 11/31；B2 R +10pp | 把「没审到」变成可见、可补；预计 recall 提升与 B2 同量级 | 新增产物与请求；验收：not-reached 比例下降、P/R 不回退 |
| **P0-2** | **准入与分片一致**：split 启用时不再按 `maxDiffChars` 整条跳过 | FreeCAD 13 GT 全丢；容量 1.44M 而门槛 1M | 恢复大 MR 覆盖；预计大 diff recall 显著上升 | 需处理 `maxShards` 超限与截取语义；验收：FreeCAD 类样本不再 skipped |
| **P0-3** | **分片并行**（可配并发 3–8） | 5 片串行 1266s；OCR 8 组并发 242s | 延迟降为 1/N；token 不变 | 网关限流/429；验收：并发下错误率与结果一致性 |
| **P0-4** | **证据接地 + 独立核验** | evidence 只验非空；仅 1 条拒绝；VUL4J 噪声 24.2% | 降噪、提高信任；可能误杀，需要保护性主题 | 先做确定性接地（低风险），再做独立证伪 A/B |
| **P0-5** | **默认开启/标准化独立补漏** | B2：R 0.340→0.440、B 0.428→0.489，token 更低 | 小 diff recall 超过 OCR；大 diff 可只在高风险片启用 | 墙钟 +233s；验收：三轮均值、judge 噪声带 |

### P1（结构优化，需要 A/B）

| ID | 改进 | 说明 |
|---|---|---|
| P1-6 | **阶段压缩 A/B** | 合并 1+2、3+4；无工具时跳过检索阶段。目标是 6 请求 → 4–5，不牺牲 P/R/B |
| P1-7 | **风险驱动预算** | 让 `riskClass` 决定轮数、补漏、检索深度；否则删除 Phase 2 |
| P1-8 | **检索预算与重叠区间 Ledger** | 同文件不同区间不重复读；per-file 读取上限；`search_code` 结果去重 |
| P1-9 | **输出过滤校准** | `limits.confidence.min` 0.5 → 0.3；范围外意见改为 `scope` 标注；severity 保持 P3 |
| P1-10 | **轮次语义** | `complete` 改为「无新增即停」；确认数上限；保留硬上界 |
| P1-11 | **doc/skill-doc 策略** | 按 §6.7 落地；补检索预算与覆盖账本 |
| P1-12 | **确定性行号锚定** | 用 evidence 引文在 diff 中定位行号，模型行号仅作提示；对齐 OCR 的 resolver |

### P2（平台化，不阻塞流程正确性）

| ID | 改进 | 说明 |
|---|---|---|
| P2-13 | `--preview` | 零模型确认文件选择与分片计划 |
| P2-14 | `--resume` | 文件指纹 + 片级 checkpoint |
| P2-15 | 覆盖 manifest / SARIF | 与 §6.3 同源；接 CI/代码扫描 |
| P2-16 | 确定性模块分组 + 跨片 repo map | 大 MR 的语义单元；不做 LLM 决定审不审 |
| P2-17 | 长会话压缩逃生口 | 仅接近窗口时启用；保留证据锚点 |
| P2-18 | linter/SAST 证据融合 | 把外部工具结果转成 evidence/候选，走同一核验 |

---

## 8. 实验与验收计划

### 8.1 实验设计（按依赖顺序）

| 实验 | 变量 | 对照 | 样本 | 主指标 | 次指标 |
|---|---|---|---|---|---|
| E1 覆盖账本 | 无 / 通用 B2 / 覆盖驱动补漏 | v2、B2 | small10 + large2 | R、B、not-reached 比例 | token、墙钟、新增请求数 |
| E2 准入修正 | 当前体积门 / 分片优先 | 当前 | FreeCAD + 1 条合成 1.2M MR | 是否 skipped、覆盖 GT | 片数、token、截取条数 |
| E3 分片并行 | 串行 / 并发 3 / 并发 8 | 串行 | ragflow 5 片 | 墙钟 | 429/重试、结果一致性 |
| E4 证据接地 | 无 / 确定性接地 / 接地 + 独立证伪 | 当前 | small10 + VUL4J | P、噪声率、误杀率 | token、额外请求 |
| E5 阶段压缩 | 6 阶段 / 4 阶段 / 2 阶段 | 当前 | small10 | P/R/B | 请求数、token、墙钟 |
| E6 输出校准 | confidence 0.5 / 0.3；scope 丢弃 / 标注 | 当前 | VUL4J + small10 | tips 噪声、真值损失 | 范围外有效发现数 |

### 8.2 统计纪律

- 评审 3 轮 × judge 3 轮取均值；单轮 judge 的 1–3pp 波动不足以判定优劣（`versions-comparison` §7）。
- 报告必须同时给 P/R/B、token、墙钟、工具调用；只报 recall 会掩盖成本。
- 对大 MR 单独列表，不与小 diff 聚合。
- 任何提示词/工具 schema 改动后重录 replay trace；否则 `test:replay` 全 miss 是预期现象。

### 8.3 产品指标

benchmark 的 P/R/B 是研究口径，不是产品口径。建议并行采集：

- **acceptance rate**（评审者接受/驳回/延后）；
- **每 1k 有效意见的 token**；
- **覆盖缺口**（not-reached hunk / 文件比例）；
- **每条 finding 的处置时间**（是否可操作）。

---

## 9. 结论

1. **我们的流程不是「不合理」，而是「合理性放错了地方」。** 我们把确定性放在阶段骨架与证据契约上，OCR 把确定性放在输入收敛、覆盖与定位上。前者保证了纪律，后者保证了覆盖与成本。
2. **六阶段可以保留其精髓，但不应继续以「六个请求」的形态存在。** 真正需要保留的是：先理解、先取证、再下结论、最后证伪的回合边界；不需要保留的是没有消费者的 Phase 2 和无工具时的 Phase 4。
3. **第一优先级不是改阶段，而是补覆盖。** 覆盖账本 + 未覆盖 hunk 定向补漏，是把 56.8% 文件级漏报变成可测量、可修复的第一步。
4. **第二优先级是大 MR 的准入与并行。** 先让 FreeCAD 这类 MR 能进流程，再让 5 片并行跑；这两件事不改提示词，收益直接。
5. **第三优先级是核验接地。** 把「No Evidence, No Finding」从「非空数组」升级为「引文可核对、行号可定位、反证可陈述」。
6. **不要把 OCR 当成模板照搬。** 它的 LLM 分组、无置信度、单文件超限直接放弃、文本规则，都不适合我们的定位；值得借的是覆盖 manifest、条件化 Plan、组级并发、多层预算、fail-open 证伪过滤器、确定性定位。

**最终判断**：当前流程「可以生产」，但离「合理形态」还差三步：**覆盖可见、大 MR 可跑、证据可核**。这三步做完，六阶段是否为六，反而不是最重要的问题。

---

## 附录 A：关键文件与行号

| 主题 | 位置 |
|---|---|
| 六阶段指令 | `packages/review-pi/src/loop/phases.ts:10-98` |
| 阶段回复解析（1–4 丢弃） | `packages/review-pi/src/loop/agent-review-loop.ts:755-787` |
| 轮次与 Phase 6 收尾 | `packages/review-pi/src/loop/agent-review-loop.ts:548-597` |
| 独立补漏扫描 | `packages/review-pi/src/loop/agent-review-loop.ts:899-930` |
| 候选拦截链 | `packages/review-pi/src/gate/candidate-gate.ts:122-182` |
| Finding schema | `packages/review-pi/src/finding/finding-schema.ts:9-70` |
| 上下文窗口预算 | `docs/adr/0102-context-window-budget-and-overflow-retry.md` |
| 分片规划 | `packages/review-pi/src/run/shard-planner.ts:1-120` |
| 分片串行 | `packages/review-pi/src/run/pass-runner.ts:199-212` |
| 准入与体积门 | `packages/review-pi/src/run/review-run.ts:299-366` |
| 默认限制 | `packages/review-pi/src/shared/config-limits.ts:186-224` |
| 工具结果预算 | `packages/review-pi/src/tools/result-budget.ts:11` |
| 工具预算 | `packages/review-pi/src/loop/constants.ts:4` |
| OCR 主流程 | `D:/Project/open-code-review/internal/agent/agent.go:1420-1600` |
| OCR Review Filter | `D:/Project/open-code-review/internal/agent/agent.go:1839-1964` |
| OCR 选择器 | `D:/Project/open-code-review/internal/agent/selection.go:43-102` |
| OCR 分组 | `D:/Project/open-code-review/internal/agent/grouping.go:68-108` |
| OCR 定位 | `D:/Project/open-code-review/internal/diff/resolver.go:16-59` |

## 附录 B：数据源

- `docs/report/test12-small10-versions-comparison-20261117.md`
- `docs/report/test12-small10-b2-sweep-experiment-20261118.md`
- `docs/report/test12-small10-v2-missed-gt-analysis-20261117.md`
- `docs/report/test12-large2-data-20261117.md`
- `docs/report/exp-group-missed-gt-classification-20261118.md`
- `docs/report/VUL4J-10例评测报告-20261109.md`
- `docs/report/POC1、Phase1、Phase2 阶段事实与教训摘要.md`
- `docs/report/生产化可行性事实调查.md`
- `repo-diff-skill-result/**/audit/*.json` 与 `runs/session-*.json`
- `C:/Users/Li/.PiAgent/tasks/*/audit/*.json` 与 `runs/session-*.json`

## 附录 C：术语

| 术语 | 含义 |
|---|---|
| 覆盖分母 | 本次变更中「必须被审视」的文件 / hunk 清单 |
| 覆盖账本 | 每个文件 / hunk 的审视状态（candidate / no-issue / not-reached） |
| 接地 | 用确定性数据核对 finding 的文件、行号、引文是否真实存在 |
| 证伪核验 | 只接受具体反证的验证方式；证据不足默认保留 |
| fail-open | 核验失败/不可用时保留候选，而不是丢弃 |
| 独立补漏扫描 | Phase 5 之后用新请求做第二视角，而不是在原请求里加提示 |
| manifest | 覆盖与终态的机器可读账本 |

## 附录 D：确证问题清单（会话汇总）

> 本附录把本次评估里被代码或数据**直接证实**的问题收敛成一张可执行清单；与 §5 / §7 重复之处，以本节作为摘要。C 类是待实验项，D 类不是缺陷。

### D.1 已确证（P0）

| # | 问题 | 证据 | 建议 |
|---|---|---|---|
| 1 | **没有审视覆盖账本**：流程可以「完成」，但没有任何地方记录哪些文件 / hunk 没被看 | 漏掉的 GT 中 56.8% 所在文件没有任何意见（§4.4）；OCR 有 manifest，我们只有上报覆盖 | 文件 × hunk 覆盖账本；未覆盖 hunk 定向补漏 |
| 2 | **大 MR 准入与分片自相矛盾**：`maxDiffChars=1M` 在分片前判定，而分片容量是 12×120K=1.44M | FreeCAD 13 条 GT 因超 1M 整条跳过（§4.3）；`run/review-run.ts:334-353` | 启用 split 时按片数 / 截取判定，不再整条跳过 |
| 3 | **分片串行**：每片全套六阶段顺序跑 | 5 片 1266s / 8.7M token；OCR 8 组并发 242s / 1.04M（§4.3） | 组间并发（3–8），保留片级审计与失败语义 |
| 4 | **证据没有接地**：`evidence` 只验「非空字符串数组」，不验文件 / 行号 / 引文是否真实存在 | `gate/candidate-gate.ts:177-182`；`finding/finding-schema.ts:55-63` | 确定性接地：文件在 diff / 读取集合、行号在 hunk、引文可匹配 |
| 5 | **Phase 6 自审接近全通过**：同一会话、同一模型核验自己的候选 | 每个 run `pass=false` 仅 0–1 条（§4.1）；VUL4J 噪声仍 24.2%（§4.5） | 确定性接地 + 独立证伪会话；保护性主题 fail-open |
| 6 | **已验证的补漏通道默认关闭** | B2：R 0.340→0.440、B 0.428→0.489，token 更低（§4.2）；`phase5Sweep` 缺省 `false` | 默认开启，或改为「未覆盖 hunk 定向补漏」 |

### D.2 已确证（P1）

| # | 问题 | 证据 | 建议 |
|---|---|---|---|
| 7 | **Phase 2 是死阶段、Phase 4 是成本中心** | Phase 1–4 的 JSON 被 `parsePhaseReply` 丢弃（§3.2）；Phase 2 每 run 1 请求、零消费者；Phase 4 占 152/157 次工具调用（§4.1） | 合并 1+2；Phase 4 条件化（无缺口则跳过）；风险值驱动预算或删除 |
| 8 | **检索存在投机性浪费** | `search_code` 21 次中 15 次零命中（71%）；48 个去重读取文件中 22 个未被 finding / evidence 引用（46%，部分可能支撑「检查后不报」）；8 次 get_file 路径错误（§4.1） | 确定性预取 + 检索预算 + 空结果即停 |
| 9 | **Ledger 只认完全相同的请求，不认已覆盖区间** | 先整读 `AbstractUrlBasedTicketValidator.java` 再读 `192-251`；12 个 run 命中仅 0–1 次（§4.1） | 按文件的已覆盖行区间记账；重叠区间不重读 |
| 10 | **输出过滤校准错误** | VUL4J：confidence 0.5 相比 0 精准度反而下降、丢 2 个真值；范围外 11 条中 8 条真实（§4.5） | confidence 缺省 0.3；范围外改为 `scope` 标注而不是删除 |
| 11 | **没有逐文件 / 逐 hunk 的审视要求** | 我们的 system / phase 提示词没有「review every file」；规则 Skill 只说「检查本次变更文件」（§3.2） | Phase 5 外壳增加 `reviewedFiles` / hunk 状态，并由解析层消费；只加提示词无效 |
| 12 | **多轮机制实际失效** | 12 个 run 全部 `rounds=1`、`complete=true`（§4.1）；`complete` 缺省 true，只有显式 false 才续轮 | 改为边际收益停止（无新增即停）+ 硬上界；独立第二视角做成显式机制 |
| 13 | **Phase 5/6 几乎不按需读文件** | 157 次工具调用中 Phase 5 仅 1 次、Phase 6 为 0（§4.1） | 允许并提示「先形成假设、再针对假设取证」；Phase 6 核验时读引用行 |

### D.3 待实验确认（不宜直接下结论）

| 假设 | 为什么还不能定论 | 验证方式 |
|---|---|---|
| 六阶段可压缩到 4 或 2 阶段 | 「1–4 无机器消费者」不等于「1–4 无价值」；它们仍在对话上下文里影响后续阶段 | 6 / 4 / 2 阶段三臂 A/B，3 轮评审 × 3 轮 judge |
| 把读取全部推迟到 Phase 5 更好 | 更 targeted，但确认偏误可能增强；现有数据只说明 Phase 4 有投机性读取 | 现状 / 条件 Phase 4 / 合并 3+4 三臂 |
| 确定性预取有净收益 | 基础件已有，但 `resolveChangedFileSymbols` 没有运行时调用方，且用旧侧区间；head 侧需补 `newSpansOf` | 按 head / base / mixed 分层测工具调用、prefetch hit rate、P/R/B |
| 大 diff 上 P0–P3 区分度弱 | 来自既有实验记忆与对比文档，本轮没有复跑 | 大 diff 样本上重跑 severity 分布 |
| `search_rule` / `search_history` 应暴露 | 历史 run 调用 24 次、每次约 111 字符；是否低价值取决于 knowledge 语料配置 | 按当前版本复核工具可见性与命中率 |

### D.4 不是问题（产品取舍，不要误改）

- **主动不报建议 / 风格 / 测试缺失**：这是产品口径，不是缺陷；不要为追 benchmark recall 把 P3 噪声放回来。
- **单轮为主**：如果独立补漏能提供第二视角，单轮本身可以接受。
- **hunk ±10 范围门**：precision 取舍；问题在「丢弃而不是标注」，不在「有范围门」。
- **规则 Skill 独立会话、证据 schema、审计 / 回放**：这是优势，不应为了「像 OCR」而拆掉。

### D.5 建议的动手顺序

1. 覆盖账本 + 未覆盖 hunk 定向补漏（P0-1，直接对应 56.8% 文件级漏报）。
2. 大 MR 准入修正 + 分片并行（P0-2/3，不改提示词，收益直接）。
3. 证据接地 + 独立核验（P0-4/5，把「No Evidence」从非空数组升级为可核对）。
4. 默认开启 / 标准化独立补漏（P0-6）。
5. 再做阶段压缩、检索预算、输出过滤校准（P1）。
