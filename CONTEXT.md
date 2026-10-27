# Review Agent

低 Token、高质量代码检视 Agent：用最小充分上下文与缓存稳定循环，以 20~30% 的 Token 成本获得接近全量上下文的检视质量。终点是落地到企业内部代码托管平台的 MR 检视。（内核基座：pi 代码仓 fork，Review Runtime 从 0 重写，ADR-0009；DSH 线历史见 ADR-0005/0006。）

## Language

### 上下文

**Minimal Sufficient Context**:
能支撑正确 Review 判断的最小上下文集，介于 Diff-only 与全仓之间。
_Avoid_: 精简上下文、恰好够用的上下文

**Diff-first**:
以 Diff 为检视入口、按需向符号层与影响层扩展的取上下文方式；明确区别于只看 Diff。
_Avoid_: Diff-only

**C0–C3**:
四级上下文分级：C0 Diff、C1 Symbol、C2 Impact、C3 Knowledge；按风险逐级加载。

**Context Ledger**:
本次检视会话已加载上下文（文件/区间/符号/证据）的登记账；重复请求返回引用而非原文。
_Avoid_: 上下文缓存（与前缀缓存混淆）

**Stable Prefix（Zone A）**:
一次模型请求中字节级稳定不变的头部：检视角色、政策、工具与输出 Schema。
_Avoid_: 系统提示词（过窄，仅指角色描述）、Immutable Prefix

**Zone B**:
同一仓库的多次检视之间字节稳定的中层上下文：repo 身份、Repo Map、Symbol Index、项目规则。
_Avoid_: 半稳定上下文（语义模糊）

**Repo Map**:
Zone B 中的仓库结构视图（目录树与包/模块结构），静态确定性生成，不经过 LLM。
_Avoid_: 仓库摘要（暗示 LLM 生成）

**Symbol Index**:
签名级符号索引（不含函数体），按变更文件所在包/模块圈定范围，静态确定性生成。

**Append-only Context（Zone C）**:
动态上下文只追加、不重排、不改写的构造纪律。

**Cache-Stable Review Loop**:
消息构造始终维持前缀稳定的检视循环。

### 检视

**Review Runtime**:
运行检视循环的专用执行环境（检视提示词、工具策略、状态、事件），区别于通用 Coding Runtime。
_Avoid_: Coding Runtime 复用

**Finding**:
一条结构化检视结论，含严重级、类别、文件/行位置、描述、证据、规则与置信度。
_Avoid_: 评论、告警、issue（泛化）

**Evidence**:
支撑一条 Finding 的可验证材料：具体符号、行号与代码摘录。

**Evidence Gate**:
"No Evidence, No Finding"——没有证据的候选结论不得作为 Finding 产出。

**Risk Class**:
变更的风险分级（Low / Medium / High），决定 C 级上下文加载深度与证据等级。

**处置（Disposition）**:
人工对单条 Finding 的判定（accept / reject / false-positive），经 review-pi CLI 落库（append-only；回溯锚 = source/caseId/configId/rep/model + findingId，与 RunRecord 对齐）；同一 finding 重复处置按 notedAt latest-wins。
_Avoid_: 判级（judge 属评测链；处置是人工生产面）

**人工接受率（Acceptance Rate）**:
生产 KPI：accepted / totalDispositioned，绝对口径直接从处置库算出（total=0 → null，空集不冒充 0）——与评测判级解耦。
_Avoid_: 相对锚口径（不依赖评测结论）、把 reject/false-positive 计入接受

### 运行时边界

**核内（Review Runtime）**:
检视会话运行时的全部行为：loop 策略、`review.*` 工具、C0–C3 上下文决策、缓存纪律、检视政策与 Evidence Gate；在 pi 内核上从 0 重写（`packages/review-pi`，ADR-0009）。
_Avoid_: 通用 Coding Runtime 复用、把核内当插件树挂接点（DSH 线历史形态，已随内核移除）

**策略驱动器（Review Driver）**:
核内 Review Runtime 中代码级强制六阶段骨架的组件：只有它能推进阶段（一阶段 = 一回合），回合边界执行 Evidence Gate 与轮次调度。
_Avoid_: 自定义 Loop（替换内核 loop 的机制，DSH 线已否；pi 线以 agent-loop 钩子实现同等骨架）、提示词纪律（骨架不是提示词约定）

**核外（研究工具链）**:
服务于实验而非检视会话的层：数据集构造、判定链、指标聚合、实验运行器、外部参照；普通库被 CLI 调用，不进内核。
_Avoid_: 实验插件

**翻译投影（Translation Projection）**:
核外呈现工具：消费检视产出的英文文档做中文呈现，仅译自然语言字段（findings 叙述、resultSummary），结构化字段字节直通；投影自带留痕（呈现语言、术语表版本、源 finding 关联）。检视输出恒英文——测量面冻结，语言是呈现配置而非实验自变量（ADR-0010）。消费端接线 = CLI 环境变量注入缝（`REVIEW_PI_PRESENTATION_ENGINE` 动态 import 核外引擎，未配置恒等直通、stdout 逐字节同现状）；引擎任何失败呈现降级英文源——检视产物绝不因呈现层失败丢失，退出码不受影响。
_Avoid_: 输出语言配置（暗示内核参数化缝）、双语内核（检视链整体留在已验证英文域，S 级结论零迁移）

**测量常量面（Measurement-Constant Face）**:
内核对照实验中必须 byte / 行为一致的半边：Zone A 提示词、Zone B 组装、六阶段 Loop 语义、Finding/Evidence 契约、判定链、指标公式、数据集；A/B 配置要求请求字节一致（ADR-0009）。
_Avoid_: 不变层（过泛）、冻结面（与「仪器冻结」混淆——仪器指核外判定/指标代码）

**内核变量面（Kernel-Variable Face）**:
内核对照实验的被比较量半边：Agent 状态与事件模型、工具调用协议与 wire 序列化、LLM 客户端、会话/审计投影——在 pi 原语上从 0 重写（ADR-0009）。
_Avoid_: 可变层（过泛）

**字节纪律门（Byte Gate）**:
测量常量面零漂移的形式化证明门：pi 侧 A/B 请求体与 DSH 审计真源（`requests[].wireBody` 序列化点原文）逐字节对照；内核身份差异按登记类别归一化（白名单收口），**计算差异 = 登记差异强制相等**——白名单外零容忍、登记项停弹同样红门（结构性类别每请求必触发，按记录检查；数据条件类别——如空回复——由单测与全量语料双向把守）。
_Avoid_: 快照测试（无真源对照）、宽容 diff（语义近似放行）

**语义等价门（Semantic Gate）**:
C/D/E（工具驱动 agentLoop）的对照口径门：pi 侧请求体与 DSH 审计真源做 JSON 值域深相等（键序天然无关），继承面传输方言 + 工具面方言（`tool-dialect.ts` 单列：strict 旗标 / tool_choice 缺席 / arguments 重序列化 / 参数校验——按内核效应分类 wire-structural / wire-data-conditional / behavioral）各自归一化后对照；同一零容忍纪律——未登记差异红门、结构性类别死登记红门。循环驱动面（phaseLog / toolCallLog / findings / rejections / rounds / E ledger）全量逐条对照。工具输出字节面另由 tool-outputs 门把守（重放注入 resultSummary，不混流）。
_Avoid_: 与字节门混流（A/B 逐字节、C/D/E 语义——两档口径各自单列）、语义近似放行（未登记差异零容忍）

**MR 边界护栏（Boundary Guard）**:
内核入口处的 MR 输入边界检查（≤10 文件 / diff ≤2K 变更行，与数据集过滤口径同构、配置无关、config 分派之前）：界内路径零字节漂移（缺席省键）；超界或不可度量走显式降级——`domainWarning` 标注 + 审计 `mrBoundary` 留痕 + 照常执行，不拒检。
_Avoid_: 输入校验（过泛）、大 MR 切分（v2 另立项）、静默截断（违背零静默纪律）

### 产物

**检视转录（Review Transcript）**:
一次检视中**进入 Review Runtime 的全部交互**（系统提示词、每轮消息、工具调用与结果）的完整留档，随 run 落盘为 `session-<首次模型调用时刻>-<configId>-<caseId>.json`（含 `{ info, messages, view }`：`messages` 为 pi 原生真源、`view` 为 OpenCode 风格定形投影）；是 debug 与取证用的现场，**不是指标源**（指标取自运行记录与审计）。**每次 run 独立留档、不覆盖**（文件名含首次模型调用时刻）。
_Avoid_: session、会话记录（都与 pi 内核的 `Session` 子系统撞名）、日志（过泛）

**检视意见导出（Review Findings Export）**:
一次检视的 Finding 清单落盘成的对外消费产物：`reviews_en.json` 是英文真源口径，`reviews_zh.json` 是核外翻译投影（随呈现引擎配置**存在或缺席**，可删可重建）——两者按 rep 覆盖重写，**不是**测量的第四个真源。
_Avoid_: reviews.json（单数形已废——现为 `_en`/`_zh` 两份）、评论列表、检视报告（REPORT.md 是另一物）

### 知识

**CWD**:
从历史缺陷挖掘出的本项目常见缺陷模式库（项目私有版缺陷模式规则，知识 L2 层）。
_Avoid_: CWE（那是通用公共分类）

**DTS**:
缺陷跟踪系统（Jira/Bugzilla 类），Knowledge Engine 的缺陷数据源之一。

**规则 Skill（Rule Skill）**:
被检视项目自带的规则技能包，随项目投放并随项目版本化，为该项目提供"按项目规则怎么检视"的指引。
_Avoid_: 项目规则（Zone B 稳定中层内的规则槽位，另一落点）、C3 Knowledge（规则 Skill 不进入检索语料）、skill（裸称会与开发态技能包及内核 skill 混淆）

**规则检索（Rule Retrieval）**:
依据规则 Skill 的 SKILL.md 指引，把该 skill 的规则库收敛为「本次变更适用的规则集」的过程；其产物是适用规则集，findings 是它的下游。
_Avoid_: 规则执行（暗示「跑脚本」这一实现手段）、规则装载（只指 zip 的装载动作）

**规则合并（Rule Merge）**:
多个规则 Skill 的产出汇入同一条候选流、共用同一套证据纪律的合并语义；按传入先后执行，合并只做并置、不做语义裁决。
_代码面_: `mergeSkillCandidates`（`gate/candidate-merge.ts`），去重键 = `(file, line, category)`。
_Avoid_: 结果聚合、取并集（都太泛）、规则裁决（合并不判定谁对）

**规则技能执行器（Rule Skill Executor）**:
执行规则检索的运行时实体：以检视会话在候选阶段结束时的上下文为种子，按传入顺序逐个 skill 独立运行，把每个规则 Skill 收敛为适用规则集并产出候选 findings，再交回检视会话裁定。
_代码面_: 一次执行称 **skill pass**（`knowledge/skill-pass.ts`；审计留痕 `skillPassLog[]`）；单个执行器的运行期依赖收在 `tools/skill-bash.ts`。
_Avoid_: skill 运行（与内核 Session / run 撞名）、脚本运行器（窄化为「只跑脚本」，丢掉「按 SKILL.md 执行」）

### 度量

**RIE**:
Review Intelligence Efficiency：Recall × Precision / Total Tokens，核心质量-成本效率指标。

**CARC**:
Cache-adjusted Review Cost：非缓存输入 Token + 输出 Token + 工具成本的真实成本口径；provider 无缓存计量字段时按全输入未命中计价的**保守上界**（真命中率越高，真实成本只会更低，ADR-0008）。
_Avoid_: 把上界当真实成本混比（无计量侧方向已知偏高）

### 模型接入

**被测模型（reviewer）**:
实验的自变量侧 LLM：model id 走请求参数（实验 CLI `--model`，`flash`/`pro` 别名保留；pi 内核线接缝见 ADR-0009），无 model 环境变量；url / key 经角色命名环境变量（`REVIEWER_*` > 旧 `DEEPSEEK_*`，`.env.local` 自动装载——已有环境变量优先，#46）；进 manifest / 审计留痕（model + baseUrl，绝不记 key，ADR-0008）。自定义网关换端点/模型先过模型迁移门自证再放行。
_Avoid_: 检视模型（与 judge 混淆）、白名单模型（准入白名单已由画像表取代）、model 走环境变量（实验数据走请求，秘密才走环境）

**模型迁移门（Migration Gate）**:
换模型 / 换网关的安全前置自证（迁移 runbook 的机器化，`pnpm migration-gate`）：双探针（网关健康 + **目标**模型可达）→ 单案生产入口 config E 真跑，全绿才放行（exit 0）；每类失败路径一条人话诊断。flash→pro 同族高险升级不默认放行——须 `--confirm-high-risk-upgrade` 显式确认，标记为消融验证项（§7.7 保守路线）。
_Avoid_: 冒烟测试（过泛——探针只是门的第一步）、自动拦截（门是显式 runbook，不挂实验 CLI 启动路径）、A 分层探针当必做（裁量项）

**上线门（Launch Gate）**:
投产放行判定（ADR-0011，2026-10-20 决策）：四必做全绿 + **质量门主判**（锚活判级 ≥ B + 生产入口选型证据——E recall 冠五配置 0.5962 + token 最低档）；对齐门转**形态记录**职责——漂移检测照跑、结论进对照报告，不作上线判据（门方向盲，FAIL = 形态分歧记录非劣化）；cacheHitRate 跨侧对比恒带时段限定（跑前网关前缀门探针留痕；P4b 单内核收口后基线侧无运行时，同窗口复跑不可行）。切流 = CLI 缺省 config E（程序化接口 configId 必填显式）。
_Avoid_: 把对齐门 FAIL 读作劣化（方向盲门）、跨时段裸比缓存列、双层缺省（缺省只在 CLI 用户面单义存在）

**参数画像（Provider Profile）**:
模型 id pattern → wire 序列化策略（thinking 字段 / completion 信封）+ usage 能力声明（有无缓存计量）的单源查表（review-llm）；未知模型回落保守默认档（ADR-0008）。
_Avoid_: 画像当 endpoint 配置（「怎么说话」与「连到哪」两轴正交）

**指标分口径（capability-scoped metrics）**:
指标按画像 usage 能力声明分派：无缓存计量的 provider 记 Cache-Hit-Rate 为 N/A、CARC 为保守上界（ADR-0008）。
_Avoid_: N/A 当 0（未知 ≠ 无命中）

**异构（Heterogeneity）**:
判定链要求 judge 与被测模型不同源：精确同 id 或同已知 provider 家族即视为同源；同源 + 双侧官方端点拒绝，任一侧自定义接入点在场降级 warning（实验者自证责任）。
_Avoid_: 只看 provider 名是否相同（家族按 id 前缀判定）

### 基准

**逆补丁法（Inverse-Patch）**:
以修复补丁的逆 diff 构造"引入缺陷的 MR"的基准构造方法：base 为修复后版本，合入后即历史真实 buggy 版本，真值为最小修复补丁的行位与性质。
_Avoid_: 缺陷注入（暗示合成篡改）、SZZ 挖掘（是被否的替代路径）
