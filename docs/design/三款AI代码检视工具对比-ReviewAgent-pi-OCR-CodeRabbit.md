# 三款 AI 代码检视工具对比：ReviewAgent-pi / Open Code Review / CodeRabbit（附 Claude Code /code-review）

> 状态：分析报告（2026-11-18）；2026-11-23 增补第 19 节「Claude Code 内置 `/code-review`」
> 分析对象：
> - **ReviewAgent-pi**：本仓 `D:/Project/ReviewAgent-pi`，分支 `exp-skill`，产品版本 `0.6.1`
> - **Open Code Review（OCR）**：`D:/Project/open-code-review`，`v1.13.9-3-gd77d70b`（2026-11-14）
> - **CodeRabbit**：商业 SaaS / 自托管企业版；本报告基于公开产品资料与社区经验，**未能联网核验 2026-11 的最新价格与功能**，对外引用前请以官网为准
> - **Claude Code 内置 `/code-review`（补充参照）**：本机 Claude Code `2.1.330` 的 bundled skill；结论来自安装包内 skill 文本与命令定义，不是官方文档
>
> 口径说明：
> - 本仓与 OCR 的结论来自源码、README、ADR、设计文档与本地实测；
> - CodeRabbit 的内部实现不公开，本文只对其**产品形态与公开能力**做对比，不臆测其提示词、模型路由或内部流水线；
> - Claude Code 的 `/code-review` 是闭源宿主内置能力，本文只记录能从本机安装包确认的行为；模型路由、计费与内部实现不公开；
> - 四家不在同一评测集上跑过，**所有 token / 质量数字不可直接横比**。

---

## 0. 结论先行

| 结论 | 说明 |
|---|---|
| **三者不是同一类产品** | 我们是「可嵌入、可审计的 Review Runtime + CLI」；OCR 是「开源、确定性工程 × Agent 的 Review CLI + 生态集成」；CodeRabbit 是「开箱即用的 PR 协作 SaaS」 |
| **我们的核心壁垒** | 可执行的项目规则 Skill、AST 级符号/引用/调用链工具、Evidence Gate + 结构化 Finding、最小充分上下文与缓存稳定循环、全量审计/转录/请求时间线、离线可复现回放 |
| **我们最大的产品缺口** | 没有 PR 原生交互层：webhook、inline comment、PR 摘要、增量复审、chat、auto-fix、看板 |
| **OCR 最值得借的** | GitHub Action 的 inline + sticky + incremental 发帖；`--preview`；`--resume`；SARIF；覆盖 manifest；多协议 provider；session viewer |
| **CodeRabbit 最值得借的** | 零配置 PR 原生体验；chat 命令；auto-fix；增量复审；路径级自定义指令；linter/SAST 结果融合；分析看板；企业级自托管/合规包装 |
| **不建议照搬** | 不要为了评论数量牺牲 Evidence Gate；不要在没有评测的情况下做多模型路由；不要先做 SaaS 计费/看板而不做 PR 原生闭环；不要让规则包默认自动发现 |
| **Claude Code `/code-review` 是补充参照** | 宿主内置的多 Agent 本地预检，零配置、有 `--comment`/`--fix`；但无规则执行、无审计/回放、无标准 JSON/中文建议，不能替代 Review Runtime（详见第 19 节） |

---

## 1. 三个产品的一句话定位

| 工具 | 一句话定位 | 形态 | 谁来调模型 | 主要使用者 |
|---|---|---|---|---|
| **ReviewAgent-pi** | 低 Token、强证据、可审计的企业级 Review Runtime | npm CLI / 单包 / 可嵌入 | 我们自己的六阶段 Runtime | 平台团队、内部代码托管、CI、Agent 宿主 |
| **Open Code Review** | 把「确定性工程 + Agent」做成开源 CLI 的 PR 检视器 | Go CLI / npm 包装 / 二进制 | OCR 自己，或宿主 Agent（delegate） | 开源社区、CI、Claude Code/Codex/Cursor 用户 |
| **CodeRabbit** | 面向研发团队的 AI PR 评审 SaaS | GitHub/GitLab/Bitbucket/Azure DevOps App + 看板 + 自托管企业版 | CodeRabbit 托管模型 | 购买 SaaS 的研发团队、企业 |

### 1.1 能力总览矩阵（快速扫读）

> 图例：**有** = 明确支持；**部分** = 支持但有条件/较弱；**无** = 不支持；**不公开** = 闭源产品无法确认。CodeRabbit 列以公开资料为准，具体以官网复核。

| # | 能力 | ReviewAgent-pi | OCR | CodeRabbit |
|---|---|---|---|---|
| 1 | 单 MR / diff 检视 | 有 | 有 | 有 |
| 2 | 工作区变更（staged/unstaged/untracked） | 部分（需先构造 diff；Skill 已补） | 有 | 有 |
| 3 | 分支 range | 部分（外部构造 diff） | 有 | 有 |
| 4 | 单提交 | 部分（外部构造 diff） | 有 | 有 |
| 5 | 全文件扫描（无 diff） | 无 | 有（`ocr scan`） | 不公开 |
| 6 | 自定义规则 | 有（规则 Skill） | 有（文本规则） | 有（YAML/路径指令） |
| 7 | 可执行规则脚本 | **有**（bash） | 无 | 无 |
| 8 | 规则预览（按文件看命中） | 无 | 有（`ocr rules check`） | 不公开 |
| 9 | 多规则包/多层叠加 | 有（多包，顺序执行） | 有（四层合并） | 有（组织/仓库/路径） |
| 10 | 组织级策略 | 部分（配置/规则包） | 部分（global/project 层） | 有 |
| 11 | 符号/引用/调用链工具 | **有**（5 语言 AST） | 无（file/grep） | 不公开 |
| 12 | 跨文件上下文 | 有（工具驱动） | 有（file_read_diff / code_search） | 有（平台索引） |
| 13 | 显式 evidence 数组 | **有** | 无（有 existing_code） | 不公开 |
| 14 | 置信度 | **有**（0–1） | 无 | 不公开 |
| 15 | 多轮检视 | 有（默认 3，可配 1–20） | 有（effort 1/2/3） | 不公开 |
| 16 | 计划阶段 | 有（六阶段固定） | 有（按 churn 可选） | 不公开 |
| 17 | 事实核查/评论过滤 | 有（Evidence Gate + Phase 6） | 有（Review Filter，fail-open） | 不公开 |
| 18 | 行号重定位 | 部分（hunk 范围） | 有（滑窗 + 跨文件 + LLM） | 有（平台侧） |
| 19 | 大 MR 分片/分组 | 有（分片） | 有（分组 + 并发） | 有（托管） |
| 20 | 断点续跑 | 无 | 有（`--resume`） | 有（增量复审） |
| 21 | 零模型预览 | 无 | 有（`--preview`） | 不公开 |
| 22 | 增量复审 | 无 | 有（Action incremental） | 有 |
| 23 | PR inline comment | 无 | 有（GitHub Action） | 有 |
| 24 | PR sticky summary | 部分（MCP 总结） | 有（Action） | 有 |
| 25 | Chat 命令 | 无 | 无 | 有 |
| 26 | Auto-fix | 无 | 部分（suggestion_code） | 有 |
| 27 | SARIF | 无 | 有 | 部分/不公开 |
| 28 | linter/SAST 融合 | 无 | 部分（MCP 动态工具） | 有 |
| 29 | 看板/分析 | 无 | 部分（viewer/session） | 有 |
| 30 | IDE 扩展 | 无 | 有（VS Code/IDEA 等） | 有 |
| 31 | Agent Skill/插件 | 有（`skills/review-pi/`） | 有（5+ 宿主） | 部分（CLI/IDE；Agent 待核实） |
| 32 | MCP | 有（client 上报） | 有（client 动态工具） | 不公开 |
| 33 | 审计/转录 | 有 | 有 | 部分（不公开原始轨迹） |
| 34 | 请求时间线 | **有** | 部分（retry report） | 不公开 |
| 35 | 覆盖 manifest | 部分（审计 + 补报） | **有**（一等公民） | 部分（看板/状态） |
| 36 | 离线可复现回放 | **有**（hash trace） | 部分（session/viewer） | 无 |
| 37 | 多 provider 协议 | 部分（兼容网关为主） | 有（4 协议） | 不公开 |
| 38 | 中文原生 | **有** | 部分（语言可配） | 部分（语言可配） |
| 39 | 自托管/内网 | 有 | 有 | 部分（企业版） |
| 40 | 公开 benchmark | 无 | 有（AACR-Bench） | 无 |
| 41 | 开源许可 | 无（未见 LICENSE） | 有（Apache-2.0） | 无（商业） |
| 42 | 价格透明 | 内部 | 免费 + 自付 token | 按席位（公开档位） |

---

## 2. 架构与检视流水线对比

### 2.1 端到端流水线

| 阶段 | ReviewAgent-pi | OCR | CodeRabbit |
|---|---|---|---|
| **触发** | 手工 CLI / CI / Agent Skill / MCP 上报 | CLI、GitHub Action、GitLab CI、Gerrit、插件 | PR 事件 webhook，自动触发 |
| **输入** | `--mr-diff` 或 `--mr-json` + `--repo` 快照 | workspace / range / commit / scan | PR diff + 平台仓库上下文 |
| **文件选择** | 预过滤（lockfile/生成物/测试/binary/glob/正则）+ 边界护栏 + 分片 | 确定性 `selectFiles`（binary/secret/user rule/extension/default path/deleted/too_large） | 平台接入 + 路径规则 + 排除配置（公开能力） |
| **分组/切片** | 按 `diff --git` 文件块贪心装箱分片；单文件块按 hunk 截取 | 语义分组（LLM 分组，≤10 文件/组）+ 并发 8 组 | 托管侧处理，细节不公开 |
| **计划阶段** | **代码强制六阶段**：Change Understanding → Risk Classification → Context Decision → Context Retrieval → Deep Reasoning → Evidence Verification | 可选 `PLAN_TASK`（按 churn 阈值触发，只读） | 不公开；产品宣传为 context-aware |
| **检视循环** | 一阶段一回合，默认 3 轮（可配 1–20），最后一轮强制 complete | Plan → Main 多轮（low 1 / medium 2 / high 3）→ 每轮 Review Filter | 托管 Agentic 流程，不公开 |
| **工具面** | 8 个 `review.*`：get_diff / get_symbol / get_file / find_references / get_call_chain / search_code / search_rule / search_history；规则 Skill 会话多一个 `bash` | 6 个：task_done / code_comment / file_read / file_read_diff / file_find / code_search（git grep） | 平台上下文 + linter/SAST 等集成（公开能力） |
| **证据/校验** | **Evidence Gate**（No Evidence, No Finding）+ Phase 6 逐条验证 + findingScope（hunk ±10 行） | Review Filter 事实核查（Ground A/B，证据不足默认保留）+ 保护性主题否决 | 不公开；产品宣传为 context-aware / anti-noise |
| **位置定位** | 行号落在 diff hunk；候选越界丢弃（`OUT_OF_SCOPE`） | 滑窗匹配 → 跨文件唯一匹配 → LLM 重定位 → 输出前再解析 | 平台 inline comment 定位，细节不公开 |
| **输出** | stdout 单 JSON、`reviews_all.json`、`reviews_tips_zh.json`、审计、转录、时间线、MCP 报文 | text / JSON / SARIF、session JSONL、manifest、viewer | PR inline comments、summary、chat、status check、看板 |
| **协作** | MCP 四工具上报（startTask / mrReviewResult / saveReviewSummary / endTask） | GitHub Action inline + sticky summary + incremental posting；CI 集成 | 原生 PR 评论、chat、团队看板、通知 |
| **修复** | 不自动改代码；tips.suggestion 供人选做 | suggestion_code 输出；宿主可自行修复 | 支持一键/建议修复（公开能力） |

### 2.2 三种「质量骨架」的差异

| 维度 | ReviewAgent-pi | OCR | CodeRabbit |
|---|---|---|---|
| 骨架是否代码强制 | **是**：策略驱动器只有它能推进阶段 | 部分是：Plan/Main/Filter 由编排器强制 | 未知 |
| 阶段是否可被提示词绕过 | 否（回合边界执行 Evidence Gate / 轮次调度） | Plan 可跳过，Main 多轮 | 未知 |
| 是否有显式证据字段 | **是**：`evidence: string[]` | 评论有 `existing_code` / `content`，无独立 evidence 数组 | 不公开 |
| 是否有置信度 | **是**：0–1，且可按阈值过滤 tips | 无显式 confidence | 不公开 |
| 是否有可执行项目规则 | **是**：规则 Skill 独立会话 + bash | 否：规则是文本 + 路径匹配 | 否：YAML 指令 + linter |
| 是否有覆盖账本 | 审计 + MCP 覆盖补报 | **run manifest** 一等公民（completed/reused/failed） | 看板/状态，细节不公开 |
| 是否可离线复现 | **是**：hash-keyed trace 回放 | 部分：session 回放 / viewer | 否 |

### 2.3 我们的六阶段 vs OCR 的 Plan/Main/Filter

| 对比项 | 我们的六阶段 | OCR 的 Plan/Main/Filter |
|---|---|---|
| 目的 | 把「理解 → 分级 → 取上下文 → 推理 → 验证」做成不可跳过的骨架 | 用 Plan 提升方向性，用 Filter 做事实核查 |
| 计划的作用 | 固定阶段指令，阶段即回合 | Plan 仅在 churn 达阈值时触发，第二轮起清空，避免计划成为覆盖天花板 |
| 验证的作用 | Phase 6 逐条 Evidence Verification，证据不足不进 findings | Review Filter 只删「被 diff 字面证明为错」的评论，默认全部保留 |
| 失败策略 | 阶段失败按轮次/预算收尾，诚实截断 | Plan 失败继续；Filter 失败保留全部；分组失败退化为每文件一组 |
| 代价 | 阶段固定，灵活性较低 | 阈值/模板/过滤多，调参成本高；召回率主动让位于精确率 |

> **判断**：我们和 OCR 都相信「确定性工程 > 纯提示词」，但落点不同。我们把确定性放在**检视骨架与证据纪律**；OCR 把确定性放在**文件选择、分组、规则匹配、评论定位/过滤**。两者可以互补。

---

## 3. 上下文与 Token 策略

### 3.1 策略对照

| 维度 | ReviewAgent-pi | OCR | CodeRabbit |
|---|---|---|---|
| 上下文模型 | C0–C3 分级；Minimal Sufficient Context；Diff-first | 每组隔离上下文；组内最多 10 文件；语义分组 | 托管代码库索引 + PR 上下文，细节不公开 |
| 重复读取 | **Context Ledger**：重复请求返回引用而非原文 | 对话内缓存；prompt cache affinity | 托管缓存，细节不公开 |
| 前缀稳定性 | **Cache-Stable Review Loop**：Zone A 字节稳定 | 每轮完整对话重发，逐轮增长，命中 provider prompt cache | 不公开 |
| 压缩 | 分片 + 预算；不靠对话压缩 | 三区记忆压缩（冻结/压缩/活跃），60% 异步 / 80% 同步 | 不公开 |
| 工具结果预算 | 8000 字符/次；工具调用上限 100 | 每轮 token 预算；`MAX_TOKENS=200000`、`MAX_COMPLETION_TOKENS=16384`；grace round | 套餐/上下文限制，细节不公开 |
| 大变更 | 分片（默认 12 万字符/片）+ 单文件 hunk 截取 + 诚实截断 | 语义分组 + 并发 + 预算 + resume | 托管侧处理 |
| 成本控制 | 配置 `contextWindow`、`maxOutputTokens`、分片、边界门 | `--max-tokens`、`--max-tokens-budget`、`--effort`、`--concurrency` | 订阅制，AI 成本包含在席位费中（公开模式） |
| 官方/公开成本主张 | 以 **20–30%** Token 成本达到接近全量上下文的检视质量（本仓口径） | 相比通用 Agent，约 **1/9 Token**，Precision/F1 更高、Recall 更低（AACR-Bench，厂商口径） | 不公开 token 账本；按席位收费 |

### 3.2 怎么读这些数字

| 事实 | 含义 |
|---|---|
| 我们的 20–30% 与 OCR 的 1/9 不是同一基线 | 我们对比的是「接近全量上下文的检视质量」；OCR 对比的是「通用 Agent（Claude Code）」。**不可横比** |
| 我们的优势在「少而准」 | 符号/引用/调用链工具把上下文收敛到最小充分集；Context Ledger 避免重复读取 |
| OCR 的优势在「大变更稳定」 | 文件分组 + 并发 + 压缩 + 预算 + resume，专门解决大 changeset 的覆盖与成本 |
| CodeRabbit 的优势在「无感」 | 用户不感知 token/上下文；成本内化到订阅费 |

### 3.3 我们可以借鉴的成本能力

| 能力 | OCR 的做法 | 对我们的价值 | 优先级 |
|---|---|---|---|
| `--preview` | 只跑确定性筛选，不调 LLM | Agent/CI 先确认「会审哪些文件」，零成本 | P0 |
| `--effort low/medium/high` | 映射最大评审轮数 | 给用户一个简单的质量/成本旋钮 | P1 |
| `--max-tokens-budget` | 每轮前检查；超预算保留部分结果 | 把「花多少钱」变成可配置契约 | P1 |
| 成本预估 | 运行前估算 token / 成本 | 企业采购/CI 预算前置 | P2 |
| 记忆压缩 | 60/80% 双阈值 | 我们靠分片，暂不需要对话压缩；可作为超长会话备选 | P2 |

---

## 4. 规则与定制化

### 4.1 规则体系对比

| 维度 | ReviewAgent-pi | OCR | CodeRabbit |
|---|---|---|---|
| 规则形态 | **可执行规则 Skill 包**（zip / 目录，一个包 = 一个 skill） | 文本规则文档（64 份）+ `rule.json`，按路径/glob 匹配 | YAML / 路径级自然语言指令 + linter 配置 |
| 规则来源层 | **只认显式输入**（`--rule-skill*` / `--skill`），不扫描仓库 | 四层：custom > project > global > system（自动叠加） | 仓库配置 + 组织配置 + 平台默认 |
| 执行方式 | Phase 5 之后的**独立模型会话**，8 个 review 工具 + `bash`，产出候选并入 Phase 6 | 规则文本注入 Main 的 `{{system_rule}}` | 注入评审上下文 / 调用外部工具 |
| 多规则包 | 支持多个，按顺序执行；同名后装载者胜出；按同根因语义（file/category/±5 行 + rule 或标题相似度）去重 | 支持多层合并；首个匹配生效 | 支持组织/仓库/路径级叠加（公开能力） |
| 可执行脚本 | **是**（bash，cwd=包根，无 shell，env 白名单，120s） | 否（规则是文本） | 否（通过 linter/工具集成） |
| 信任边界 | 显式输入；包可以执行代码，因此不自动发现 | 自动读取项目/全局配置；规则是文本，风险较低 | 平台/组织配置，由管理员控制 |
| 适用场景 | 企业项目私有规则、需要脚本取证据的复杂规则 | 语言/路径级通用规则、开源项目 | 团队级评审偏好、路径规则、工具链统一 |

### 4.2 我们的差异化：规则 Skill 是「可执行的项目知识」

| 能力 | 说明 | 竞品对比 |
|---|---|---|
| 一条规则可以带脚本 | 在 skill 会话里用 `bash` 跑项目自带的选择器/检查器 | OCR 规则是纯文本；CodeRabbit 规则是 YAML |
| 规则可以「取证据」 | 脚本输出可被模型引用为 evidence | OCR 只能靠 `file_read` / `code_search`；CodeRabbit 靠平台工具 |
| 多规则包隔离 | 每个包一个独立会话，互不污染，最后统一验证 | OCR 规则合并进同一 prompt；CodeRabbit 规则合并进平台上下文 |
| 与主检视同源验证 | 规则候选必须过 Phase 6 Evidence Gate | OCR 有 Review Filter，但不是逐条证据数组 |

> **结论**：规则 Skill 是我们最像「企业知识库 + 可执行规则引擎」的部分，也是 OCR 和 CodeRabbit 都不具备的形态。应继续强化，而不是削平。

### 4.3 可以借鉴的规则能力

| 来源 | 能力 | 说明 | 优先级 |
|---|---|---|---|
| OCR | 规则预览 `ocr rules check <file>` | 让用户先看「这个文件命中什么规则」，降低规则调试成本 | P1 |
| OCR | 路径/glob 规则映射 | 我们的规则包偏「整包」，可补一层轻量路径选择器 | P2 |
| CodeRabbit | 路径级自然语言指令（YAML） | 让非工程用户也能加规则，不必写 Skill | P1 |
| CodeRabbit | 组织级/仓库级分层 | 企业统一策略 + 项目覆盖 | P2 |
| 两者 | 规则变更可审计 | 我们已有审计 config digest；可加规则包内容哈希 | P1 |

---

## 5. 输出、协作与集成

### 5.1 输出与协作能力

| 能力 | ReviewAgent-pi | OCR | CodeRabbit |
|---|---|---|---|
| stdout 结构化 JSON | **是**（单 JSON 文档） | **是**（`--format json`） | 不适用（平台 API） |
| 标准 findings 文件 | **是**：`reviews_all.json` | **是**：JSON / session | 平台内 |
| 中文建议 | **是**：`reviews_tips_zh.json`，12 键 | 语言可配（默认 English） | 语言可配（公开能力） |
| SARIF | 否 | **是** | 公开能力/平台集成 |
| PR inline comment | 否（仅 MCP 上报） | **是**（GitHub Action） | **是**（核心能力） |
| PR sticky summary | 否 | **是**（GitHub Action） | **是** |
| Chat 命令 | 否 | 否 | **是**（`@coderabbitai`） |
| Auto-fix | 否 | 输出 suggestion_code，宿主可改 | **是**（公开能力） |
| 增量复审 | 否 | Action 支持 incremental posting；`--resume` 支持断点续跑 | **是**（新提交增量检视） |
| 看板/分析 | 否 | 本地 viewer / session 列表 | **是**（团队看板） |
| IDE 扩展 | 否 | **是**（VS Code / IDEA 等） | **是**（公开能力） |
| Agent Skill / 插件 | **是**（`skills/review-pi/`，刚落地） | **是**（Claude Code / Codex / Cursor / Kimi / OpenCode / QCA） | 有 CLI/IDE，Agent 集成在扩展（待核实） |
| MCP | **是**：作为 client 上报业务结果（4 个 tool） | **是**：作为 client 接入动态工具 | 不公开 |

### 5.2 平台集成矩阵

| 平台/形态 | ReviewAgent-pi | OCR | CodeRabbit |
|---|---|---|---|
| GitHub | 间接（CI 跑 CLI，消费 JSON/退出码） | **GitHub Action**（inline + sticky + incremental） | **原生 App** |
| GitLab | 间接（CI 跑 CLI；`--mr-json` 支持 GitLab 形状） | **GitLab CI** 示例/文档 | **原生 App** |
| GitCode | **直接支持 `--mr-json`** | 未见专门集成 | 未见 |
| Bitbucket | 间接 | 示例/集成（公开） | **原生 App** |
| Azure DevOps | 间接 | 未见专门集成 | **原生 App** |
| Gerrit | 间接 | **示例/集成** | 未见 |
| 本地 CLI | **是**（核心形态） | **是**（核心形态） | **是**（CLI 产品线） |
| CI 通用 | **是**（exit code + JSON + MCP） | **是**（JSON/SARIF/manifest） | **是**（平台 App） |
| 自托管/内网 | **是**（CLI + 自有网关） | **是**（CLI + 本地 provider） | **企业版自托管**（公开能力，需采购） |

### 5.3 语言与代码智能

| 维度 | ReviewAgent-pi | OCR | CodeRabbit |
|---|---|---|---|
| 检视语言 | 不限（diff + 文本） | 不限（allowlist 扩展名） | 广泛（官方宣传支持主流语言；具体以官网为准） |
| 规则覆盖 | 项目自定义 | 64 份内置规则文档，按路径/扩展名 | 路径规则 + linter |
| 符号级工具 | **Java / TypeScript / Python / Go / C++**（tree-sitter；符号/引用/调用链） | 无 AST 工具；`file_find` + `code_search`（git grep） | 平台上下文/索引（不公开，不暴露为工具） |
| 跨文件重定位 | 依赖 diff/符号工具 | **滑窗 + 跨文件唯一匹配 + LLM 重定位** | 平台侧，不公开 |
| 代码扫描（无 diff） | 否（需 diff） | **`ocr scan`** 全文件扫描 | 平台内可全仓上下文 |

> **我们的独特优势**：符号/引用/调用链是**模型可直接调用的检视工具**，不是平台黑盒索引。这让模型能「按需取最小证据」，而不是把整仓上下文塞进 prompt。OCR 的工具面是文本级（读文件、git grep），CodeRabbit 的代码图不暴露给模型。

---

## 6. 可观测性、可审计性、可复现性

| 维度 | ReviewAgent-pi | OCR | CodeRabbit |
|---|---|---|---|
| 审计文件 | **是**：`audit/<runId>.json`（含 config 快照 + digest） | **是**：session JSONL + run manifest + retry report | 看板/日志，原始提示词/轨迹不公开 |
| 会话转录 | **是**：`session-*.json`（pi 原生 + OpenCode 视图） | **是**：JSONL | 不公开 |
| 请求时间线 | **是**：`request-timeline.jsonl`（尝试/请求/首末增量/usage） | retry report + session 记录 | 不公开 |
| 覆盖账本 | 审计 + MCP 覆盖补报 | **run manifest 一等公民**（completed/reused/failed） | 看板/状态 |
| 运行记录 | **是**：`run.json`（成本/usage） | 是 | 看板 |
| 可复现回放 | **是**：hash-keyed trace + 本机 HTTP 回放服务 | 部分：session viewer / 回放 | 否 |
| 配置审计 | **是**：生效值 + 来源 + digest | **是**：config SHA / rule SHA / repository identity | 组织配置，细节不公开 |
| 错误归因 | **是**：stderr 人话 + 审计 + 时间线 | **是**：retry report 分类 + warning | 平台日志/支持 |

> **判断**：在「事后能解释这次检视到底看到了什么、报了什么、为什么停」这件事上，我们和 OCR 都做得比 CodeRabbit 透明。OCR 的 **run manifest** 在「覆盖账本」这一点上比我们更系统；我们的 **request timeline + transcript + offline replay** 在「可复现」上更强。

---

## 7. 可靠性与规模

| 能力 | ReviewAgent-pi | OCR | CodeRabbit |
|---|---|---|---|
| 失败重试 | 分层：传输/超时/429/5xx；一次性调用统一重试 | 分类重试报告；provider 层重试 | 托管，细节不公开 |
| 流中断恢复 | **Stream Replay**：缓冲整条响应，失败重发，无副作用 | 未见等价机制（有 grace round / 重试） | 不公开 |
| 上下文溢出 | **400 溢出降预算重试**（ADR-0102） | token 预算 + 压缩 + grace round | 不公开 |
| 断点续跑 | 否 | **`--resume`**（文件指纹复用） | 增量复审 |
| 大变更 | 分片 + 单文件 hunk 截取 + 诚实截断 | 分组 + 并发 + 压缩 + 预算 | 托管 |
| 并发 | 分片串行；工具调用串行 | **默认 8 组并发** | 托管 |
| 预算/截断 | 边界门 + maxDiffChars + 分片 + `truncated` | `--max-tokens-budget` + failed(budget) + partial | 套餐限制 |
| 单点失败隔离 | 分片失败无聚合产物（保留已成功片） | 组 panic 隔离；组失败按文件归类 | 不公开 |
| 诚实性 | **是**：`truncated` / 零恢复 / 星级只陈述计数（ADR-0103） | **是**：manifest 终态 + failed(class) | 产品文案层面，细节不公开 |

### 7.1 我们的可靠性优势

| 优势 | 说明 | 竞品对比 |
|---|---|---|
| Stream Replay | 流开始后断开可恢复，且失败响应不交付，避免副作用 | OCR 未见等价机制 |
| 上下文溢出降预算 | 网关真实窗口小于画像时自动收窄重试 | OCR 用预算/压缩，不是 400 重试 |
| 请求时间线 | 首字延迟/流持续/断流空档可区分空闲超时与总时长上限 | OCR 有 retry report，但无同粒度时间线 |
| 诚实截断 | `truncated` 是完成态的一部分，不伪装成功 | 两者都有覆盖/预算语义，我们的输出更显式 |

### 7.2 我们的可靠性缺口

| 缺口 | 影响 | 参考对象 | 优先级 |
|---|---|---|---|
| 无 resume | 长检视中断要重跑，成本高 | OCR `--resume` | P0 |
| 无 8 路并发分组 | 大 MR 墙钟时间较长 | OCR 并发 8 | P1 |
| 分片串行 | 大 MR 延迟高 | OCR 组并发 | P1 |
| 无 preview | 无法零成本确认「会审哪些文件」 | OCR `--preview` | P0 |

---

## 8. 安全、隐私、合规

| 维度 | ReviewAgent-pi | OCR | CodeRabbit |
|---|---|---|---|
| 部署形态 | 自托管 CLI / npm；数据只到配置的网关 | 自托管 CLI / 二进制；数据只到配置的 provider | 云 SaaS；企业版可自托管 |
| 凭据 | 用户级 JSONC；不读 env；`config show` 只报 set/missing | 配置文件 / env / Claude Code env；不记录 token | 平台托管/企业密钥管理 |
| 规则执行风险 | 规则 Skill 可执行 `bash`（显式输入、env 白名单、无 shell、120s） | 规则是文本，不执行代码；但自动读取项目/全局规则 | YAML 指令，不执行代码 |
| 密钥文件 | 预过滤 secret path；Skill 对未跟踪凭据文件 warning | **secret path 过滤，优先于所有 include/exclude** | 平台侧，不公开 |
| 数据留存 | 本地任务目录；审计/转录含代码 | 本地 session；OTel 可选 | 平台留存策略，自托管可内网 |
| 合规认证 | 未见公开认证（内部产品） | OpenSSF Best Practices Gold；Apache-2.0 | 公开宣传 SOC 2 / GDPR；企业版支持自托管/隔离 |
| 供应链/许可 | 仓库未见 LICENSE 文件（需确认发行口径） | Apache-2.0；npm/二进制/源码 | 商业许可 |
| 遥测 | 无（本地审计） | OpenTelemetry（可选） | 平台遥测/看板 |

> **我们的优势**：自托管、网关可控、规则执行边界显式、审计不依赖厂商。
> **我们的风险**：规则 Skill 的 `bash` 是代码执行面；未跟踪凭据 warning 不等于阻止；需要继续强化「默认安全」而不是「文档提醒」。

---

## 9. 成本与商业模式

| 维度 | ReviewAgent-pi | OCR | CodeRabbit |
|---|---|---|---|
| 软件费用 | 内部产品（无公开定价） | **免费 / Apache-2.0** | 按席位订阅（免费 OSS 档 + Lite/Pro/Enterprise；具体价格以官网为准） |
| 模型费用 | 自付网关 token | 自付 provider token | 包含在订阅中（公开模式） |
| 基础设施 | 自有 CI/机器 | 自有 CI/机器 | 厂商托管；企业版自托管 |
| 成本可控性 | 高（token 预算、分片、上下文窗口、模型自选） | 高（token 预算、effort、并发、preview） | 中（套餐限制，模型/路由不透明） |
| 规模化成本 | 随 token 线性增长 | 随 token 线性增长 | 随席位数线性增长 |
| 采购摩擦 | 低（内部） | 低（开源） | 中（合同/安全评审/席位） |
| 隐藏成本 | 集成/运维/规则编写 | CI 集成/规则调参/召回漏报 | 误报 triage、供应商锁定、自托管运维 |

### 9.1 粗略 TCO 场景（仅示意）

| 场景 | ReviewAgent-pi | OCR | CodeRabbit |
|---|---|---|---|
| 5 人小组、每月 200 PR | 模型 token + 1 台 CI 机器；无席位费 | 模型 token + CI；无席位费 | 5 × 席位费；AI 成本内含 |
| 50 人团队、每月 2000 PR | token 成本可控（缓存/最小上下文）；需要平台集成 | token 成本可控；需要 CI/规则运维 | 50 × 席位费；看板/协作价值高 |
| 内网/强合规 | 自托管天然满足；需自建平台适配 | 自托管满足；需自建 CI 适配 | 需企业版自托管，采购成本高 |
| 开源项目 | 可用但需自建；无公开 license | **最合适**：免费、开源、CI 集成 | 免费 OSS 档，功能受限 |

> 价格数字刻意不写死：CodeRabbit 的档位与价格会变，且企业折扣/年付差异大。报告只比较**成本结构**。

---

## 10. 成熟度与生态

| 维度 | ReviewAgent-pi | OCR | CodeRabbit |
|---|---|---|---|
| 版本/阶段 | `0.6.1`，内部产品，快速迭代 | `v1.13.9`，开源，阿里内部大规模验证后开源 | 商业产品，持续发布 |
| 生产验证 | 本仓测试 + 内部使用；公开案例少 | 阿里内部数万开发者、数百万缺陷（README 口径） | 大量商业客户/公开案例 |
| 测试 | 包测试 1116 passed / 1 skipped；根测试 12 passed；离线回放 6 场景 | Go 测试 + 基准 + 契约测试 | 不公开 |
| 文档 | 中文为主，ADR/运行手册/设计文档齐全 | 英文为主 + 中/日/韩/俄；文档站 | 完善的产品文档/帮助中心 |
| 社区 | 内部 | GitHub 开源社区、OpenSSF Gold、Trendshift | 商业社区/支持 |
| 生态集成 | CLI、MCP、Agent Skill（新） | 5+ 宿主插件、IDE 扩展、ACP、MCP client、CI 示例 | 4 大平台、IDE/CLI、看板、企业集成 |
| 许可 | 未见 LICENSE（需确认） | Apache-2.0 | 商业许可 |

### 10.1 开发者体验（DX）

| 维度 | ReviewAgent-pi | OCR | CodeRabbit |
|---|---|---|---|
| 上手时间 | 中（装 CLI + 写 JSONC + 准备 diff/快照） | 低–中（装 CLI + provider 配置） | 极低（装 App / OAuth） |
| 配置方式 | 用户级 JSONC，严格校验，未知键告警 | 配置文件 + env + Claude env，provider TUI | 平台 UI/YAML |
| 帮助/发现性 | 无 `--help`（设计行为），靠文档 | `--help` / 文档站 / TUI | 产品引导/文档 |
| 输出消费 | stdout 单 JSON + 文件产物；需自己接平台 | text/JSON/SARIF；Action 直接发 PR | 平台内直接看 |
| 调试体验 | 审计/转录/时间线齐全，但需要熟悉目录 | session/viewer/retry report | 平台日志，黑盒 |
| 错误信息 | 中文人话 + 退出码 1 | 人话 + 分类重试报告 | 平台提示 |
| 扩展成本 | 规则 Skill 强，但需要写包/脚本 | 规则/插件较易，自定义引擎难 | 规则易，深度定制难 |
| 适合用户 | 平台/基础设施团队 | 开源维护者、CI 工程师 | 普通研发团队 |

### 10.2 采用风险登记

| 风险 | ReviewAgent-pi | OCR | CodeRabbit |
|---|---|---|---|
| 供应商锁定 | 低（自托管/可嵌入） | 低（Apache-2.0） | 高（SaaS/数据/工作流） |
| 数据外泄 | 低–中（只到自选网关） | 低–中（只到自选 provider） | 中（云 SaaS；企业版可自托管） |
| 规则执行安全 | 中（bash 规则包，显式输入） | 低（文本规则） | 低（平台配置） |
| 误报 triage 成本 | 中（Evidence Gate 压低误报） | 中（Precision 优先） | 中–高（评论多时） |
| 质量不可复现 | 低（离线回放） | 中（session 可看，非 hash 回放） | 高（闭源） |
| 许可/合规不确定性 | 中（无 LICENSE，需确认） | 低（Apache-2.0） | 低–中（商业合同/SOC2） |
| 生态/集成不足 | 高（PR 原生缺失） | 低 | 低 |
| 维护成本 | 中（自建 CI/平台适配） | 中（自建 CI/规则） | 低（厂商托管） |

---

## 11. 质量证据与评测

| 维度 | ReviewAgent-pi | OCR | CodeRabbit |
|---|---|---|---|
| 公开基准 | 无公开数据集/榜单 | **AACR-Bench**：50 仓库 / 200 PR / 10 语言 / 1505 条人工标注问题；80+ 资深工程师交叉验证 | 厂商宣传 + 第三方评测/案例；无公开可复现数据集 |
| 指标口径 | 内部测试、真实缺陷回放、合成缺陷注入 | Precision / Recall / F1 / 时间 / Token | 不公开细粒度指标 |
| 厂商主张 | 20–30% Token 成本达到接近全量上下文质量 | Precision/F1 高于通用 Agent，Token 约 1/9，Recall 更低（主动取舍） | 更少噪音、上下文感知、团队效率提升（营销口径） |
| 可复现性 | **高**：离线回放 + trace | 中：session/viewer + 开源代码 | 低：闭源 SaaS |
| 我们的内部风险 | P0–P3 在大型 diff 上区分度有限（内部实验：小 diff P1 41% / P2 30% / P3 20%；大 diff 三档均 3–4%） | 召回率主动低于通用 Agent | 误报/噪音依赖客户反馈 |

### 11.1 我们该怎么补评测

| 动作 | 目的 | 优先级 |
|---|---|---|
| 建立内部 MR 基准（固定仓库 + 真值 + 多语言） | 让「质量」可比较、可回归 | P0 |
| 把离线回放扩展到 Skill / 平台发帖路径 | 保证接入层不改变检视字节 | P1 |
| 统计 acceptance rate / 误报率 / 覆盖率 / 成本 | 对齐 CodeRabbit 的团队指标 | P1 |
| 对 P0–P3 做区分度校准 | 避免严重级在小/大 diff 上失真 | P1 |
| 公开或半公开 benchmark（如可） | 建立技术信誉 | P2 |

---

## 12. 我们的核心优势（重点）

| # | 优势 | 具体表现 | 为什么重要 | 竞品对比 |
|---|---|---|---|---|
| 1 | **可执行规则 Skill** | 规则包独立会话，8 个 review 工具 + bash；多包合并、Phase 6 验证 | 企业私有规则可以「带脚本取证据」，不是一段自然语言 | OCR 文本规则；CodeRabbit YAML |
| 2 | **AST 级代码智能工具** | `get_symbol` / `find_references` / `get_call_chain`，5 语言 | 模型按需取最小证据，减少上下文与幻觉 | OCR 只有 file/grep；CodeRabbit 代码图不暴露 |
| 3 | **Evidence Gate + 结构化 Finding** | evidence[] / confidence / rule / severity / category / tips | 「无证据不出结论」可审计、可回归 | OCR 有 Filter 但无独立 evidence；CodeRabbit 不公开 |
| 4 | **最小充分上下文 + Context Ledger** | C0–C3、重复读取返回引用、缓存稳定前缀 | 20–30% Token 成本，长会话不爆上下文 | OCR 靠分组/压缩；CodeRabbit 托管 |
| 5 | **全量可审计** | audit + transcript + request timeline + run.json + config digest | 事故复盘、合规、模型行为分析 | CodeRabbit 不公开原始轨迹 |
| 6 | **离线可复现** | hash-keyed trace + 本机 HTTP 回放 + 并发阶梯 | 零网络零 key 回归，不依赖模型非确定性 | OCR 只有 session/viewer；CodeRabbit 无 |
| 7 | **中文原生** | 提示词、findings、tips 全中文；结构化字段英文 | 中文企业直接可用，无翻译损耗 | OCR 默认英文、可配；CodeRabbit 可配 |
| 8 | **确定性投影** | tips 随候选产出；MCP 报文零额外模型调用 | 成本低、输出稳定、可测试 | OCR 有 Filter/重定位调用；CodeRabbit 不公开 |
| 9 | **可靠性工程** | Stream Replay、400 降预算重试、请求时间线、诚实截断 | 网关抖动/大 MR 下不丢结果、不谎报 | OCR 有重试/预算；CodeRabbit 托管 |
| 10 | **信任边界清晰** | 规则包只认显式输入；不自动扫描仓库；秘密不回显 | 避免「检视一个仓库 = 执行它的代码」 | OCR 自动分层规则；CodeRabbit 平台配置 |
| 11 | **可嵌入、无锁定** | 单 npm 包、CLI + JSON + MCP + Skill；网关自选 | 可接内部平台，不被 SaaS 锁定 | CodeRabbit 强锁定；OCR 也较开放 |
| 12 | **成本结构透明** | 自付 token、预算/分片/上下文可配 | 大规模成本可预测 | CodeRabbit 席位费；OCR 也透明 |

> **一句话**：我们的护城河不是「再做一个 PR 评论机器人」，而是**可执行规则 + 证据纪律 + 可审计/可复现的 Review Runtime**。这三点是 OCR 和 CodeRabbit 都不完整的。

---

## 13. 我们的主要短板（重点）

| # | 短板 | 对比对象 | 影响 | 优先级 |
|---|---|---|---|---|
| 1 | 无 PR 原生交互层 | CodeRabbit / OCR Action | 用户必须在 CI/CLI 外自己消费 JSON；协作体验差 | **P0** |
| 2 | 无 inline comment / sticky summary | OCR / CodeRabbit | 评审意见不能落到代码行，开发者要跳转 | **P0** |
| 3 | 无增量复审 | CodeRabbit | 新提交要全量重跑，成本/延迟高 | **P0** |
| 4 | 无 `--preview` | OCR | 无法零成本确认文件选择 | **P0** |
| 5 | 无 `--resume` | OCR | 长检视中断即重跑 | **P0** |
| 6 | 无 SARIF | OCR | 难接代码扫描平台 | P1 |
| 7 | provider 协议窄 | OCR（4 协议） | Anthropic 原生/Bedrock 适配成本高 | P1 |
| 8 | 无 linter/SAST 融合 | CodeRabbit | 规则证据面窄，安全类检视弱 | P1 |
| 9 | 无 auto-fix / chat | CodeRabbit | 修复闭环与交互体验弱 | P1 |
| 10 | 无看板/分析 | CodeRabbit | 团队无法看趋势、采纳率、成本 | P1 |
| 11 | 无 scan / 全文件模式 | OCR | 无 diff 的历史代码审计做不了 | P2 |
| 12 | 无 IDE/ACP/viewer | OCR / CodeRabbit | 开发者入口少，调试体验弱 | P2 |
| 13 | 无公开 benchmark / license | OCR | 技术信誉与外部采用受限 | P2 |
| 14 | 大 diff 上 P0–P3 区分度弱 | 内部实验 | 严重级信号失真，影响排序/过滤 | P1 |

---

## 14. 可以借鉴什么：从 OCR

| 优先级 | 能力 | OCR 的做法 | 我们怎么接 | 预期收益 |
|---|---|---|---|---|
| **P0** | PR 发帖适配器 | GitHub Action：inline comments + sticky summary + incremental non-destructive posting | 新增 `packages/review-pi/src/delivery/github.ts` / `gitlab.ts`；消费现有 findings + tips | 从「JSON 工具」变成「PR 评审机器人」 |
| **P0** | `--preview` | 只跑确定性筛选，复用同一套 selection 逻辑 | CLI 新增 `preview` 子命令，复用 `mrFilter` / boundary / shard planner | 零成本确认覆盖范围 |
| **P0** | `--resume` | 文件指纹 + checkpoint 复用 | 在 run 记录里加 checkpoint；按文件 diff 指纹跳过已完成片 | 长检视可恢复，省钱 |
| **P0** | 覆盖 manifest | 冻结 completed/reused/failed/skipped + 终态 | 在审计旁增加 `manifest.json`，复用现有 coverage 数据 | CI 可解释「哪些文件没审、为什么」 |
| **P1** | SARIF | `--format sarif` | 在 delivery 加 SARIF 投影（finding → result） | 接 GitHub Code Scanning/Sonar |
| **P1** | 多协议 provider | Anthropic / OpenAI Chat / Responses / Bedrock | 抽象 `provider/protocol`，保留现有 deepseek wire 为一种 | 企业网关/模型选择更自由 |
| **P1** | 位置重定位 | 滑窗 → 跨文件唯一匹配 → LLM 重定位 | 若做 inline comment，必须有可靠行号；复用我们的 findingScope + diff hunk | 评论落点准确 |
| **P1** | `--effort` / token budget | 1/2/3 轮 + 每轮预算 + failed(budget) | 映射 `limits.loop.maxRounds` / 预算；保留诚实截断 | 质量/成本旋钮 |
| **P2** | session viewer | 本地 Web UI 看会话/manifest/评论 | 基于 audit + transcript 做只读 viewer | 调试与演示 |
| **P2** | `scan` 全文件 | 独立流水线，无 diff | 复用工具面 + 分片；新增 scan 输入 | 历史代码审计 |
| **P2** | ACP / IDE | ACP server + VS Code/IDEA | 先做 ACP，再做 IDE | 开发者入口 |
| **P2** | MCP client | 动态工具接入 | 我们是 MCP client（上报）；可扩展为消费外部工具 | 证据面扩展 |

### 14.1 OCR 的「不要照搬」

| OCR 做法 | 为什么不建议直接搬 |
|---|---|
| 语义分组用 LLM 决定 | 增加一次模型调用与不确定性；我们的分片是确定性文件块 |
| 规则自动分层（项目/全局/系统） | 与我们的「规则包只认显式输入」信任边界冲突 |
| Review Filter 默认保留 | 我们已有更硬的 Evidence Gate；再加一层 LLM 过滤会增加成本与不一致 |
| 大量阈值/模板 | 我们已有配置面；再引入一套调参体系会稀释产品焦点 |

---

## 15. 可以借鉴什么：从 CodeRabbit

| 优先级 | 能力 | CodeRabbit 的做法 | 我们怎么接 | 预期收益 |
|---|---|---|---|---|
| **P0** | PR 原生闭环 | App 自动评审、inline、summary、status | 先做 GitHub Action/GitLab CI，再做 App | 最直接的用户价值 |
| **P0** | Chat 命令 | `@coderabbitai review/summary/pause/ignore/fix` | 在 PR 适配器里解析命令；复用 run/resume | 交互式复审，降低误报困扰 |
| **P0** | 增量复审 | 新提交只审增量 | 用 merge-base 更新 + 文件指纹；只跑变更片 | 降成本、降延迟 |
| **P1** | Auto-fix | 建议补丁可一键应用 | 基于 `tips.suggestion` 生成 suggestion block；**必须用户确认** | 缩短修复闭环 |
| **P1** | 路径级 YAML 指令 | 非工程用户可加规则 | 在规则 Skill 之上加一层轻量 declarative rules | 降低规则门槛 |
| **P1** | linter/SAST 融合 | 集成 ESLint/Semgrep 等 | 把工具输出转成 evidence/候选；走 Phase 6 验证 | 安全/质量证据更硬 |
| **P1** | 团队看板 | 评论数、采纳率、趋势 | 消费 audit/run.json 做聚合；先 CSV/HTML | 团队可见价值 |
| **P2** | 组织级策略 | 组织/仓库/路径分层 | 企业配置下发 + 审计 | 大规模治理 |
| **P2** | 自托管企业包装 | SSO/RBAC/air-gap | 我们先做「内网 CLI + 网关」，按客户需要补 | 企业采购 |
| **P2** | Learnings | 从 👍/👎 学习 | 先做反馈采集，不自动改规则 | 长期质量提升 |
| **P2** | 序列图/PR 摘要 | 可视化 | 基于 findings + diff 生成 Markdown/Mermaid | 演示与理解 |

### 15.1 CodeRabbit 的「不要照搬」

| 做法 | 风险 |
|---|---|
| 按席位收费 | 在我们还没有 SaaS/平台闭环前，定价会限制采用 |
| 不透明多模型路由 | 无法复现、无法审计；我们应坚持可解释的模型选择 |
| 追求评论数量 | 会破坏 Evidence Gate 与信噪比 |
| 自动修复直接提交 | 代码所有权/责任风险；必须人工确认 |
| 全量代码索引常驻 | 成本/隐私/工程复杂度高；我们先用最小充分上下文 |

---

## 16. 建议路线图

### 16.1 P0：PR 原生闭环（0–6 周）

| 交付 | 内容 | 验收标准 |
|---|---|---|
| `review-pi preview` | 确定性文件选择 + 分片计划，零模型调用 | 与真实 run 的文件集合一致 |
| GitHub Action / GitLab CI | 跑 CLI → 解析 JSON → inline comment + sticky summary + status | 一个真实 PR 端到端跑通 |
| 覆盖 manifest | completed/reused/failed/skipped + 终态 | 能解释每个文件为什么没审 |
| `--resume` | 文件指纹 + checkpoint | 中断后只重跑未完成文件 |
| 增量复审 | 新提交只审 merge-base 之后的增量 | 二次推送只产生增量评论 |

### 16.2 P1：协作与质量（6–12 周）

| 交付 | 内容 | 验收标准 |
|---|---|---|
| SARIF | findings → SARIF | GitHub Code Scanning 可读 |
| provider 协议抽象 | Anthropic / OpenAI Chat / Responses | 至少两种协议端到端 |
| linter/SAST 适配 | 工具输出 → evidence | 安全类 finding 证据可追溯 |
| auto-fix suggestion | 基于 tips.suggestion 生成 suggestion block | 用户确认后才应用 |
| chat 命令 | review/summary/pause/ignore | PR 评论可触发 |
| 看板 MVP | 采纳率、评论数、成本、覆盖率 | 团队可看趋势 |

### 16.3 P2：平台化（3–6 个月）

| 交付 | 内容 |
|---|---|
| session viewer | 本地/内网只读 Web UI |
| scan 模式 | 无 diff 全文件审计 |
| IDE/ACP | VS Code/IDEA 或 ACP server |
| 企业包装 | SSO/RBAC/审计导出/自托管部署 |
| 多模型路由 | 必须先有内部 benchmark，再上路由 |
| 公开 benchmark | 脱敏内部 MR 集，建立技术信誉 |

### 16.4 建议跟踪的指标

| 指标 | 定义 | 目标方向 |
|---|---|---|
| Precision | 报出的问题中真问题比例 | ↑ |
| Recall | 真问题中被报出的比例 | ↑（但不要牺牲 Precision） |
| Acceptance rate | 开发者接受/修复的比例 | ↑ |
| False-positive rate | 被忽略/点踩的比例 | ↓ |
| Coverage | 变更文件被实际检视的比例 | ↑ |
| Cost per review | token + 基础设施 + 人工 triage | ↓ |
| Time to first comment | PR 打开到首条评论 | ↓ |
| Truncation rate | `truncated: true` 比例 | ↓ |
| Resume success | 中断后续跑成功比例 | ↑ |

### 16.5 参考落点（按本仓模块）

| 借用能力 | 建议落点 | 说明 |
|---|---|---|
| PR 发帖适配器 | 新增 `integrations/github.ts` / `gitlab.ts`，消费 `reviews_all.json` + `reviews_tips_zh.json` | 不要改 Runtime；只做投影 + 平台 API |
| 覆盖 manifest | `cli/delivery.ts` + 现有 coverage / audit 数据 | 新增 `manifest.json`，不改 stdout 契约 |
| `--preview` | `cli/args.ts` + `run/` 的过滤/分片模块 | 复用同一套 selection，禁止第二套逻辑 |
| `--resume` | `run/` + `export/` 的 run 记录；文件指纹复用 | 先做文件级 checkpoint，不做中途对话续跑 |
| SARIF | 新增 `cli/sarif.ts`（finding → result） | 纯投影，零模型 |
| provider 协议 | `provider/pi-client.ts` + `shared/config` | 先抽象，不要改六阶段/工具面 |
| linter/SAST | 新增 `analysis/external-tools.ts`，输出转 candidate/evidence | 外部工具失败必须旁路，不改退出码 |
| auto-fix | `cli/report-payload.ts` / tips → 平台 suggestion block | 必须人工确认，不自动提交 |
| chat 命令 | PR 适配器层解析，复用 run/resume | 不进入 Runtime |
| 看板 | `scripts/` 消费 audit/run.json 做聚合 | 先 CSV/HTML，不做服务 |
| viewer | 新增只读脚本/本地 server | 读 audit + transcript，不写 |
| scan | `cli` 新增子命令，复用工具面 + 分片 | 用 synthetic diff 适配现有 finding 位置 |

---

## 17. 选型建议：什么场景选谁

| 场景 | 推荐 | 理由 |
|---|---|---|
| 中文企业内部平台、强审计/合规、项目私有规则 | **ReviewAgent-pi** | 自托管、中文原生、规则 Skill、Evidence Gate、可审计 |
| 需要低 Token 成本、可嵌入自有平台 | **ReviewAgent-pi** | 最小充分上下文 + JSON/MCP + 单包 |
| 开源项目、想快速接 GitHub PR | **OCR** | Apache-2.0、GitHub Action、inline comments |
| 需要多 provider（Anthropic/OpenAI/Bedrock） | **OCR** | 四协议 + 端点解析 |
| 需要大变更稳定覆盖、resume、SARIF | **OCR** | 分组/并发/预算/manifest/SARIF |
| 团队想零运维、开箱即用、重协作 | **CodeRabbit** | SaaS、PR 原生、chat、看板、auto-fix |
| 企业要 SOC2/SSO/自托管 | **CodeRabbit Enterprise**（或自建） | 合规包装与支持 |
| 需要「可执行规则 + 证据链」而不是评论机器人 | **ReviewAgent-pi** | 差异化能力 |

---

## 18. 最终判断

| 判断 | 说明 |
|---|---|
| **不要把自己做成第二个 CodeRabbit** | 我们的优势是 Runtime 的确定性、证据与可审计；SaaS 协作层应该作为**适配器**，不是重写产品 |
| **OCR 是最接近的参照物** | 同样是「确定性工程 + Agent」，但它的确定性在文件选择/定位，我们的在阶段骨架/证据；两者可互补 |
| **短期最该补的** | PR 原生闭环（inline + summary + incremental + resume + preview + manifest） |
| **中期最该补的** | provider 抽象、SARIF、linter/SAST、auto-fix、chat、看板 |
| **长期护城河** | 可执行规则 Skill + AST 工具 + Evidence Gate + 离线可复现；这四件事不要为了追功能而稀释 |
| **商业上** | 先做内部/私有化部署的「高质量 + 可审计」，再考虑托管/席位；不要在闭环前做 SaaS 计费 |

---

## 19. 补充参照：Claude Code 内置 `/code-review`（2026-11-23）

> 本节不是第四款同台竞品，而是把「宿主内置的本地 diff 预检」作为参照系补进来。它回答的问题是：如果用户已经在 Claude Code 里工作，零配置能拿到什么质量的检视。

### 19.1 定位与形态

| 维度 | 事实 |
|---|---|
| 宿主 | Claude Code CLI（本机 `2.1.330`） |
| 形态 | bundled skill，不是独立 CLI/服务；用法 `/code-review [low\|medium\|high\|xhigh\|max] [--fix] [--comment] [<pr#>\|<branch>\|<path>] [--max-findings <n>\|all]` |
| 模型 | Anthropic 模型，档位内置映射；用户不能选 provider |
| 定位 | 本地/PR 前置的「正确性 bug 预检」，零配置；`/simplify` 只做 cleanup 并直接改，`/security-review` 专看安全，`/verify` 负责跑起来验证 |
| 分发 | 闭源、随 Claude Code 分发；官方 marketplace 另有一个使用 4 个并行 agent 的简化版 `code-review` 插件（README 口径：置信度阈值 80），与当前内置 skill 不是同一实现 |

### 19.2 流水线

| 阶段 | 做法 |
|---|---|
| **Phase 0 取 diff** | 默认 `git diff origin/HEAD...HEAD`；失败退 `git diff main...HEAD`，再退 `git diff HEAD~1`；有未提交变更或 range 为空时追加 `git diff HEAD`；参数可改为 PR 号 / 分支 / 路径 |
| **Phase 1 找问题** | 多角度 finder：A 逐行 diff 扫描、B 删除行为审计（被删的保护/错误路径/测试是否被重新建立）、C 跨文件调用链、D 语言陷阱、E wrapper/proxy 正确性；另有 Reuse、Simplification、Efficiency、Altitude、Conventions（CLAUDE.md）。内置文案标注 medium/high 为「8 个 inline 角度」；xhigh/max 才扇出子代理 |
| **Phase 2 验证** | 先按行/机制去重；每条候选一个 verifier，返回 `CONFIRMED / PLAUSIBLE / REFUTED` 三态，保留前两者。规则是 recall-biased：真实可达的罕见路径默认 `PLAUSIBLE`，只有能从代码构造出反证才 `REFUTED`。medium/high 只去重、不跑 verifier |
| **Phase 3 补漏** | 再跑一个 fresh finder，带着已确认清单只找「还没列出的缺陷」，最多补 8 条，找不到就返回空，不凑数 |
| **输出** | 宿主 `ReportFindings` 结构化列表：`file` / `line` / `summary` / `failure_scenario` / `category` / `severity` / `verdict`；`severity` 只有 `important` / `pre_existing` / `nit`；超出 `--max-findings` 时按严重级截断；summary 要求以 `Fix:` 结尾 |
| **修复** | `--fix` 在审完后直接改工作区，并按 `fixed` / `no_change_needed` / `skipped` 回写 outcome |
| **发帖** | `--comment` 通过 `gh` / inline-comment MCP 发 PR 行内评论；小修复附 committable suggestion；同一问题只发一条 |
| **收尾** | 若 diff 有 runtime surface，建议再跑 `/verify`；纯文档/测试 diff 跳过 |

档位（内置文案与预设）：

| 档位 | 行为 | 成本 |
|---|---|---|
| `low` | 少量高置信 findings | 最低 |
| `medium` | 8 个 inline 角度 + 去重，不验证，偏 surfacing | 低 |
| `high` | 同上，recall 优先 | 中 |
| `xhigh` | 子代理扇出 + 逐条验证 | 高 |
| `max` | 最贵；启动大量 reviewer subagent，必须显式要求才会用 | 最高 |
| `ultra` | 云端深度多 agent 检视，需 claude.ai 账号；GitHub PR 可用 `--post` 发单条评论 | 另计 |

> 未指定档位时沿用上一次选择；显式档位会记住。

### 19.3 与三款的对比

| 维度 | ReviewAgent-pi | OCR | CodeRabbit | Claude Code `/code-review` |
|---|---|---|---|---|
| 形态 | npm CLI / 可嵌入 Runtime | Go CLI + GitHub Action | PR SaaS | 宿主内置 skill |
| 触发 | CLI / CI / Skill / MCP | CLI / Action / CI | PR webhook | 手动 `/code-review` |
| 模型选择 | 自选网关 | 4 协议 | 托管 | Anthropic 内置，不可选 |
| 规则 | **可执行规则 Skill + bash** | 文本规则 | YAML 指令 | CLAUDE.md 文本约定 |
| 代码智能 | **5 语言 AST 符号/引用/调用链** | file / git grep | 平台索引 | Read / Grep / Bash，无 AST 工具 |
| 上下文 | C0–C3 + 最小充分 + Ledger | 分组 / 压缩 / 预算 | 托管 | 宿主上下文；大 diff 无分片/预算机制 |
| 证据 | `evidence[]` + confidence | Review Filter | 不公开 | `failure_scenario` + 三态 verdict |
| 验证 | Evidence Gate + Phase 6 | fail-open Filter | 不公开 | 1 vote / 3 态（xhigh 起） |
| 输出 | JSON + `reviews_tips_zh.json` + 审计 | text / JSON / SARIF | PR 评论 | 宿主 findings 列表，不落标准文件 |
| PR inline | 无（规划中） | Action | 原生 | `--comment`（需 gh） |
| 自动修复 | 无 | suggestion_code | 有 | `--fix` 直接改工作区 |
| 审计 / 回放 | **audit + trace + 离线回放** | session / manifest | 黑盒 | 无 |
| 中文 | **原生（结构化中文建议）** | 可配 | 可配 | 跟随宿主，无结构化中文建议 |
| 成本可控 | token / 分片 / 上下文可配 | 预算 / effort / 并发 | 席位 | 由档位决定，无 token 账本 |
| 自托管 | 有 | 有 | 企业版 | 本地 CLI + Anthropic API |

### 19.4 最值得借鉴

| 能力 | 它的做法 | 我们怎么接 | 优先级 |
|---|---|---|---|
| 角度清单 | A–E + Reuse/Simplification/Efficiency/Altitude/Conventions | 做成内置通用规则 Skill 的角度模板；自定义包可覆盖 | P1 |
| 显式 effort 旋钮 | low→max + 记住上次 | 映射 `limits.loop.maxRounds` 与分片/验证策略 | P1 |
| 三态 verdict | CONFIRMED / PLAUSIBLE / REFUTED | Evidence Gate 从二元改为三态，`PLAUSIBLE` 单独标注 | P1 |
| Phase 3 补漏 | 一个 fresh finder 只找未列项，最多 8 条 | 在最后一轮加「只补漏」回合，禁止重复已确认项 | P1 |
| `--fix` outcome 回写 | fixed / no_change_needed / skipped | 平台适配器回写 finding 状态与采纳率 | P2 |
| 严重级文本前缀 | `Important:` / `Nit:` / `Pre-existing:` | 中文建议里用「重要 / 建议 / 既有问题」前缀，少用 emoji | P2 |
| 单通道降级要声明 | 子代理不可用时明确说「single-pass」 | 与我们「诚实截断」同源，继续坚持 | 已具备 |
| PR inline + suggestion | `--comment` + committable suggestion | 已在 P0 路线图 | P0 |

### 19.5 不要照搬

| 做法 | 为什么不建议 |
|---|---|
| 只认 CLAUDE.md 文本规则 | 不能执行项目检查器、不能把脚本输出变成证据；规则 Skill 是我们的护城河 |
| medium/high 不验证、recall 优先 | 与 Evidence Gate 的信噪比目标相反；会增加 triage 成本 |
| findings 只进宿主 UI | 不可入库、不可审计、不可回放，不能作为团队质量数据源 |
| 无 token 预算/分片 | 大 diff 只能硬吃上下文窗口，成本与截断都不可控 |
| 依赖宿主的闭源多 Agent 编排 | 换宿主即失效，且结论不可复现 |

### 19.6 选型补充

| 场景 | 建议 |
|---|---|
| 个人/小团队已在 Claude Code 里，只想合并前自查 | `/code-review`（零配置） |
| 需要结果入库、审计、接内部平台或 CI 契约 | ReviewAgent-pi |
| 需要可执行项目规则 + 证据链 + 结构化中文建议 | ReviewAgent-pi |
| 只想对当前 diff 求第二意见 | `/code-review` 作对照，不替代 `review-pi`；两者可以先后跑 |

> **判断**：Claude Code 的 `/code-review` 证明「多角度 finder + 三态验证 + effort 旋钮」是有效的通用配方，值得吸收；但它把确定性放在**宿主编排**，我们把确定性放在**证据纪律与可复现产物**。它适合做开发者的第一道自查，不适合做企业的 Review Runtime。

---

## 附录 A：事实与来源

| 主题 | 来源 |
|---|---|
| 本仓产品定位/范围 | `CONTEXT.md`、`README.md`、ADR-0024 / 0035 / 0090 / 0102 / 0103 |
| 本仓六阶段/工具/规则 Skill | `docs/规则Skill编写指南.md`、`packages/review-pi/src/loop/`、`knowledge/skill-pass.ts` |
| 本仓产物/审计/时间线 | `docs/运行手册-单次检视.md`、`docs/使用手册-安装与运行.md` |
| 本仓测试 | `pnpm test` / `pnpm --filter @baize/review-pi test`（1116 passed / 1 skipped） |
| OCR 版本/流水线 | `D:/Project/open-code-review` @ `d77d70b`（v1.13.9-3），`docs/analysis/ocr-architecture-and-review-pipeline.zh-CN.md` |
| OCR benchmark | OCR `README.md`（AACR-Bench：50 仓库 / 200 PR / 10 语言 / 1505 问题；~1/9 token；Recall 更低） |
| OCR 集成 | `action.yml`、`plugins/`、`skills/`、`extensions/`、`acp/`、`internal/viewer` |
| CodeRabbit 产品能力 | 公开产品资料/社区经验；**未联网核验 2026-11 最新状态** |
| CodeRabbit 价格 | 公开资料常见档位（Free/OSS、Lite、Pro、Enterprise）；**以官网为准** |
| Claude Code `/code-review` | 本机 Claude Code `2.1.330` 安装包内置 skill 文本与命令定义（bundled skill，2026-11-23 离线读取）；官方 marketplace 的 `code-review` 插件 README 仅作旧版对照 |

## 附录 B：术语

| 术语 | 含义 |
|---|---|
| Evidence Gate | 没有可验证证据的候选不得成为 finding |
| Rule Skill | 被检视项目的可执行规则包，独立会话运行 |
| Context Ledger | 已加载上下文的登记账，重复请求返回引用 |
| Cache-Stable Loop | 保持请求前缀字节稳定的多轮检视循环 |
| Manifest | 一次运行的覆盖/终态账本（OCR） |
| Delegate | OCR 只做确定性的文件/规则导出，宿主 Agent 自己检视 |
| AACR-Bench | OCR 公开的 200 PR / 1505 问题基准 |

## 附录 C：需要复核的 CodeRabbit 事实

| 项 | 状态 |
|---|---|
| 2026-11 最新价格与档位 | 待官网复核 |
| 是否支持 BYO model / 自选 provider | 待核实 |
| 自托管企业版的完整功能面 | 待核实 |
| 是否已有 Agent Skill/CLI 集成及命令 | 待核实 |
| 最新支持平台（GitHub/GitLab/Bitbucket/Azure DevOps 之外） | 待核实 |
| SOC2/GDPR/数据留存的具体条款 | 待法务/安全复核 |

> 本文用于内部选型与产品规划；对外引用 CodeRabbit 的具体数字前，请先做一次官方资料核对。
