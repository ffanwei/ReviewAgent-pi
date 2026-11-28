# 0104. 收尾总结的输出面守门：结构与内容校验、截断降级与思考 token 观测

**状态**：已接受（2026-11-19，用户决策）
**关联**：[ADR-0097](0097-summary-fixed-structure-and-stars.md)（固定四节结构与星级）、[ADR-0100](0100-unified-summary-shape-except-diff-too-large.md)（四节模板与统一零路径）、[ADR-0103](0103-honest-zero-summaries-and-count-only-star-criteria.md)（零路径正文口径；本 ADR 不改其结论）、[ADR-0057](0057-summary-covers-only-reported-findings.md)（总结只覆盖已上报意见，是校验的输入边界）、[ADR-0045](0045-mcp-business-task-tools.md)（收尾总结走核外一次性调用）、[ADR-0051](0051-llm-call-retry-and-timeout.md)（一次性调用的重试分类）、[ADR-0066](0066-task-total-llm-usage-line.md)（观测面的边界：不改审计 / run.json）
**范围**：本仓 pi 线 0104。只动收尾总结的**输出面**（模型回包裁剪与合法性判定）与一次性调用的回包解析；检视请求字节、thinking 字段、审计 / `run.json` / stdout 键集 / 退出码不变。总结系统提示词与 user 消息只追加「逐字复制权威表格单元格」的锚点（见决策 4），不改四节契约。
**后续修订（2026-11-20）**：`sanitizeSummaryMarkdown` 先剥掉最后一个 `</think>` 及其之前的全部内容（思考草稿里可能自带 `## 检视总览`，不能按第一个标题定位），再走原有围栏与结构校验；修复 `</think>## 检视总览` 同行以及思考草稿带完整标题导致守门失效的形态。其余决策不变。


**后续修订（2026-11-28）**：闭合标签匹配放宽为 `<\s*\/\s*think\s*>`（兼容 `</ think>`、`< /think  >` 等网关/模型标记变体）；根因排查确认 v0.6.1 / main 发布线不含本 ADR 的剥离逻辑（平台实测泄漏来自旧发布构建，非本线回归），随本修订补用户实测形态（思考 + 闭合标签 + 标题同行）的回归测试。

## Context

一次真实运行里，平台通过 `saveReviewSummary` 收到的总结正文是模型的思考过程：

```text
我们根据指令撰写中文 Markdown 总结报告。需要严格按结构输出，不增删小节、不改表格顺序。
权威数据来自用户消息。

首先，检视总览表格三行：变更规模 / 预算使用 / 资源加载。数据：changedFiles=12, changedHunks=54,
```

链路事实（本 ADR 前的形态）：

1. 收尾总结走 `completeOneShot` 的核外裸 fetch（`provider/one-shot-llm.ts`），只读 `choices[0].message.content`；`readContentText` 明确**忽略** `reasoning_content`。因此这段文字只能来自 `content`——要么网关把 reasoning 内联进 `content`，要么模型本身把计划写成了可见回答。
2. `buildReviewSummary` 拿到 `completion.text` 后**只做 `.trim()`**，不校验起始小节、不校验章节是否齐全、不校验星级是否被改判。
3. 回包解析不看 `choices[0].finish_reason`；而 deepseek 系的 `max_tokens` 含思考 token（`provider/pi-client.ts` 注释实测 reasoning 峰值 5,600），预算被吃光时半截文档会被当成合法总结外发。

为什么这次不靠「禁用思考」解决：

- 关闭思考的 wire 形态按 provider 方言分裂（`thinking:{type:"disabled"}` / `enable_thinking:false` / `chat_template_kwargs` / `reasoning:{effort:"none"}` …），one-shot 目前是 OpenAI 兼容裸调用，没有 pi-ai 那套 compat 矩阵；
- 企业网关可能**静默忽略**未知字段，"以为关了其实没关"无法从请求侧确认；
- 即使思考真的关闭，模型仍可能把「列计划 / 复述指令」写进 `content`。

结论：输出面守门无论请求面是否改 thinking 都是必要条件；本 ADR 先做这一层，请求面（thinking 方言适配）另立决策。

## Decision

### 1. 模型回包必须通过结构与内容校验，不合格则回落确定性模板

新增 `sanitizeSummaryMarkdown(text, findings, metrics)`（`cli/review-summary.ts`）：

- **从后往前**找 `## 检视总览` 起点，取最后一份「章节齐全 + 星级正确 + 内容一致」的文档；思考里的草稿被自然跳过；
- 小节逐行匹配且必须有序：`## 检视总览` → `### 意见分布` → `### 高优先级意见速览`（有已上报意见时必含）→ `### 星级评价`；
- 星级行按**星数**与 `severityStars(findings)` 比对（容忍 `- ⭐⭐ …` / `**⭐⭐ …**` 列表符与加粗）；星级判据文案允许改写，星数不得改判；
- 总览表恰好三行（变更规模 / 预算使用 / 资源加载），值与 `overviewRows(metrics)` 逐字一致；
- 意见分布表恰好四行（fatal / major / minor / suggestion），数量与文件清单与 `distributionRows(findings)` 逐项一致；
- 高优先级速览的条数、编号、严重级、`file:line` 与顺序必须与 `highPriorityEntries(findings)` 一致（一句话描述允许改写）；没有 fatal/major 时必须恰好一行「无。」；
- 除四个规定标题外不得出现其它 Markdown 标题（多出的 `##` / `###` 直接拒绝）；
- 只保留到星级行为止：起始小节之前的前言与星级行之后的客套话一律丢弃；
- 整篇被代码围栏（三反引号）包住时先剥一层围栏。

校验失败 ⇒ 不重试、不二次调用模型，直接回落 `renderTemplateSummary`，`degradedReason` 记 `model summary rejected: …`（内容类拒绝会带具体原因，如 `unexpected heading` 或 `overview row 2 value mismatch`）。模板与模型路径共用同一套四节结构与指标，平台侧结构不变。

> 渲染与校验共用 `overviewRows` / `distributionRows` / `highPriorityEntries` 单源：模板本身回灌必然通过（有专门用例锁定），避免两套格式串漂移。

### 2. `finish_reason=length` 视为截断，不得外发

`OneShotLlmResult` / `OneShotCompletion` 透传 `choices[0].finish_reason`。收尾总结在结构校验**之前**判定：`length` ⇒ 回落模板，`degradedReason` 记 `model summary truncated (finish_reason=length)`。理由：截断的文档可能恰好包含全部小节标题与合法数字，仅靠结构与内容校验不足以识别。

`content_filter` 不在本 ADR 的降级触发条件内（含部分内容的合法回包语义未定），交由结构与内容校验兜底。

### 3. 思考 token 只作观测

`shared/wire-usage.ts` 解析 `usage.completion_tokens_details.reasoning_tokens`（兼容顶层 `reasoning_tokens`），经 `OneShotLlmResult.reasoningTokens` 透传到 `ReviewSummaryResult`。

- **不**并入 `LlmUsage`：它是 outputTokens 的子集，合并会重复计数；
- **不**进审计 / `run.json`（沿 ADR-0066 的数据边界）；
- `reasoning_tokens > 0` 时 stderr 打一行 `检视总结回包含思考 token N（仅观测，正文已按结构裁剪）`，让"思考是否仍开"从猜测变为可观测；
- 不参与任何内容判定。

### 4. 提示词与 user 消息：只补"逐字复制"的锚点

为了让上述逐字校验**可达成**，一次性总结调用的输入做两处最小增补（不改数据源、不改四节契约）：

- 系统提示词追加两条：表格单元格逐字复制用户消息里的 `overviewRows` / `distributionRows`；高优先级速览保留 `N. [severity] file:line —` 前缀、编号与顺序，无 fatal/major 时该节只写「无。」；
- user 消息的权威数据块新增 `overviewRows` 与 `distributionRows` 两组**已渲染好的字符串**（与校验器、模板共用同一套 `overviewRows` / `distributionRows` 单源）。

### 5. 保持不变

- 检视请求字节（本 ADR 只改核外一次性总结调用，且其中不含任何 thinking 字段）；
- 四节输出契约与星级规则；
- 零路径：无已上报意见时不调用模型，直接结构化模板（ADR-0103）；
- `saveReviewSummary` 的调用时机、沉降与失败容忍；
- stdout / 审计 / 退出码。

## Options（为什么不是别的）

- **请求侧禁用思考**：方言不统一、网关可能静默忽略，且无法保证 `content` 干净；可作为后续独立决策，但不能替代输出面守门。否（本次）。
- **只硬化提示词**（「第一行必须是 `## 检视总览`、不要输出分析过程」）：成本低但不可保证，对 `content` 内联思考经常无效。否（不作修复，只可作补丁）。
- **整篇由代码渲染，模型只生成少量散文**：结构最稳，但需要改提示词、改 JSON 契约与单测，属于更大的形态变更；留作后续选项。
- **正则删除"思考痕迹"**：模型措辞无穷，规则必然腐坏。否。
- **校验失败后重试模型**：多一次调用与成本，且模板与规范结构等价，降级已足够。否。
- **只做结构校验、不校验表格与速览内容**：结构合规但数字 / 文件清单 / 速览条目错误仍会外发，等于替错误数据背书。否。
- **只砍第一段前言，不校验章节/星级**：半截文档与改判星级仍会外发。否。

## Consequences

- **好**：思考过程、草稿、客套话不会再进入平台总结；截断、星级改判、数字 / 清单 / 速览与权威数据不一致被确定性拦截；检视请求字节不变、零额外模型调用；`degradedReason`（含具体拒绝原因）与思考 token 行让降级原因可查；模型拿到逐字复制锚点后，正常回包的通过率不因严格校验而显著下降。
- **代价 / 风险**：小节标题按逐行精确匹配，模型若改写标题（如追加冒号、换层级）会被判不合格并降级模板；表格单元格也按逐字比对，模型重新格式化数字（如去掉千分位）同样降级。这是有意选择的保守方向——失败模式是"结构正确的模板"而非"错误的外发内容"；若真实拒绝率偏高，应先放宽格式容忍度（空白 / 千分位 / 标题标点），而不是放宽数字与星级校验。
- **测试面**：`review-summary.test.ts`（前言 + 草稿取最后完整文档、围栏、尾随客套话、缺节、改判星级、`finish_reason=length`、思考 token 透传、星级行列表符/加粗；内容层：模板回灌幂等、总览数字不一致、总览多一行、分布数量 / 文件清单不一致、速览漏项、速览位置改写、无 major 时「无。」追加说明、规定外小节）；`one-shot-llm.test.ts`（`finish_reason` / `reasoning_tokens` 透传与不虚增字段）；`bin.process.test.ts`（MCP 总结桩为规范四节文档，端到端仍按原顺序上报）。
