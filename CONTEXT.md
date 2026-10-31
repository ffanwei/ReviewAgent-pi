# Review Agent

低 Token、高质量代码检视 Agent：用最小充分上下文与缓存稳定循环，以 20~30% 的 Token 成本获得接近全量上下文的检视质量。终点是落地到企业内部代码托管平台的 MR 检视。（内核基座：pi 代码仓 fork，Review Runtime 从 0 重写，ADR-0009；DSH 线历史见 ADR-0005/0006。）

**范围（ADR-0024）**：本仓只有一种检视形态（工具驱动 + Context Ledger + 规则 Skill），是 Review CLI 产品仓。配置矩阵（A–E）、`configId` 身份维度与评测仪器层（数据集构造、判定链、指标聚合、实验运行器、字节门）已删除；本词汇表中与之绑定的条目同步移除，历史报告见 `docs/report/` 与 `runs/**/REPORT.md`。

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

### 运行时边界

**核内（Review Runtime）**:
检视会话运行时的全部行为：loop 策略、`review.*` 工具、C0–C3 上下文决策、缓存纪律、检视政策与 Evidence Gate；在 pi 内核上从 0 重写（`packages/review-pi`，ADR-0009）。
_Avoid_: 通用 Coding Runtime 复用、把核内当插件树挂接点（DSH 线历史形态，已随内核移除）

**策略驱动器（Review Driver）**:
核内 Review Runtime 中代码级强制六阶段骨架的组件：只有它能推进阶段（一阶段 = 一回合），回合边界执行 Evidence Gate 与轮次调度。
_Avoid_: 自定义 Loop（替换内核 loop 的机制，DSH 线已否；pi 线以 agent-loop 钩子实现同等骨架）、提示词纪律（骨架不是提示词约定）

**核外（呈现工具链）**:
服务于呈现而非检视会话的层：中文翻译投影、分组意见映射与真引擎装配（`src/presentation/`）；普通库被 CLI 调用，不进内核。
_Avoid_: 实验插件、核内呈现（语言参数化缝不存在，ADR-0010）

**翻译投影（Translation Projection）**:
核外呈现工具：消费检视产出的英文文档做中文呈现，仅译自然语言字段（findings 叙述、resultSummary），结构化字段字节直通；投影自带留痕（呈现语言、术语表版本、源 finding 关联）。检视输出恒英文——测量面冻结，语言是呈现配置而非实验自变量（ADR-0010）。消费端接线 = 配置项 `presentation.engine`（动态 import 核外引擎，未配置恒等直通、stdout 逐字节同现状；ADR-0025 后不再读 env）；引擎任何失败呈现降级英文源——检视产物绝不因呈现层失败丢失，退出码不受影响。
_Avoid_: 输出语言配置（暗示内核参数化缝）、双语内核（检视链整体留在已验证英文域）

**运行进度投影（Run Progress Projection）**:
检视执行期的实时人读投影：把内核既有留痕（阶段推进、模型请求首尾、工具调用首尾、规则 Skill 会话首尾）写成 `stderr` 的追加事件行，TTY 下另有一行 `\r` 重画的状态行与收尾摘要行。**只投影不决策**：不改 wire 字节、不新增审计键、不改退出码，`stdout` 单 JSON 文档逐字节不变；工具参数摘要截断 80 字符、结果全文永不落地（只报行数/字符数）。开关 = `--progress` 强开 / `--no-progress` 关 / 缺省跟随 `stderr` 是否 TTY（ADR-0016）。
_代码面_: 事件契约 `contracts/progress.ts`（`RunProgressEvent` 四类 kind）、呈现层 `cli/progress-render.ts`。
_Avoid_: 进度条（不是百分比口径——「步数」= 模型请求序号）、日志（日志是核外运行器产物）、遥测（不回传任何指标）

**测量常量面（Measurement-Constant Face）**:
内核跨版本 / 跨语言呈现改动时必须 byte / 行为一致的半边：Zone A 提示词、六阶段 Loop 语义、Finding/Evidence 契约；请求字节与 golden 常量为其形式化把守面。
运行期常量面（ADR-0025 收窄口径）= **5 项死钉**：`maxRounds=5` / `maxToolCalls=100` / `toolResultBudgetChars=8000` / 呈现 `temperature=0` / `reasoningEffort=high`。其余文本截断与资源上限（包头部字节、检索回显、调用链跳数、工具名/摘要截断、超时、并发、归档、MR 边界）是**可配项**，不再是本面的一部分——换一份 `~/.PiAgent/PiAgent.json` 即可能改变请求体。
_Avoid_: 不变层（过泛）、冻结面（与「仪器冻结」混淆）、「配置文件无关」（ADR-0025 后不成立）

**内核变量面（Kernel-Variable Face）**:
内核可演进的半边：Agent 状态与事件模型、工具调用协议与 wire 序列化、LLM 客户端、会话/审计投影——在 pi 原语上从 0 重写（ADR-0009）。
_Avoid_: 可变层（过泛）

**MR 边界护栏（Boundary Guard）**:
内核入口处的 MR 输入边界检查（缺省 ≤10 文件 / diff ≤2K 变更行；`limits.boundary` 可改，单维 `null` = 该维不设界，双维 `null` = 护栏整体停用）：界内路径零字节漂移（缺席省键）；超界或不可度量走显式降级——`domainWarning` 标注（文案按配置值派生）+ 审计 `mrBoundary` 留痕 + 照常执行，不拒检。
_Avoid_: 输入校验（过泛）、大 MR 切分（v2 另立项）、静默截断（违背零静默纪律）

### 产物

**检视转录（Review Transcript）**:
一次检视中**进入 Review Runtime 的全部交互**（系统提示词、每轮消息、工具调用与结果）的完整留档，随 run 落盘为 `session-<runId>.json`（`runId = <时间戳>-<caseId>`；含 `{ info, messages, view }`：`messages` 为 pi 原生真源、`view` 为 OpenCode 风格定形投影）；是 debug 与取证用的现场，**不是指标源**（成本与行为核对取自运行记录与审计）。**每次 run 独立留档、不覆盖**（文件名含首次模型调用时刻）。
_Avoid_: session、会话记录（都与 pi 内核的 `Session` 子系统撞名）、日志（过泛）

**检视意见导出（Review Findings Export）**:
一次检视的 Finding 清单落盘成的对外消费产物：`reviews_en.json` 是英文真源口径（恒产），中文侧只有按文件分组的中文意见 `reviews_tips_zh.json`（核外投影产出，随呈现引擎配置**存在或缺席**）——按 rep 覆盖重写，**不是**测量的第四个真源。`reviews_zh.json` 已停产（ADR-0022），投影留痕改由 stdout 的 `presentation` 键承担。进程 cwd 只放一份下游约定名副本 `review-result.json`（与真源逐字节相同，ADR-0027）。
_Avoid_: reviews.json（单数形已废）、评论列表、检视报告（REPORT.md 是另一物）

**运行落盘根（Runs Root）**:
`--out` 指向的根目录，本次检视的全部留痕都在其下：`runs/mr/<caseId>/`（运行记录 / 会话转录 / 意见导出）与 `audit/mr/<caseId>/rep-<N>/audit/`（审计），规则包解压缓存在 `.cache/rule-skills/`。没有实验标识层（ADR-0027）；`mr` 是输入形态段，不是数据集名。
_Avoid_: 输出目录（只指 `--out` 本身）、runs 根（与历史 `runs/phase2-*` 实验目录混淆）

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
_Avoid_: 规则执行（暗示「跑脚本」这一实现手段）、规则包装载（只指 zip / 已解压目录的装载动作）

**规则合并（Rule Merge）**:
多个规则 Skill 的产出汇入同一条候选流、共用同一套证据纪律的合并语义；按传入先后执行，合并只做并置、不做语义裁决。
_代码面_: `mergeSkillCandidates`（`gate/candidate-merge.ts`），去重键 = `(file, line, category)`。
_Avoid_: 结果聚合、取并集（都太泛）、规则裁决（合并不判定谁对）

**规则技能执行器（Rule Skill Executor）**:
执行规则检索的运行时实体：以检视会话在候选阶段结束时的上下文为种子，按传入顺序逐个 skill 独立运行，把每个规则 Skill 收敛为适用规则集并产出候选 findings，再交回检视会话裁定。
_代码面_: 一次执行称 **skill pass**（`knowledge/skill-pass.ts`；审计留痕 `skillPassLog[]`）；单个执行器的运行期依赖收在 `tools/skill-bash.ts`。
_Avoid_: skill 运行（与内核 Session / run 撞名）、脚本运行器（窄化为「只跑脚本」，丢掉「按 SKILL.md 执行」）

**规则包信任边界（Rule-Skill Trust）**:
规则 Skill 只从**显式输入**装载（`--rule-skill-zip` / `--rule-skill <dir>`）——不扫描被检视仓库的 `.review-rules/`，没有显式输入就没有规则包。理由：规则包会指挥 skill 会话的 `bash` 工具执行进程，默认信任「被检视仓库自带的包」等于允许任意仓库在检视方机器上执行代码（ADR-0027）。
_Avoid_: 规则包自动发现、约定目录（历史 ADR-0012/0014 的旧口径）、沙箱（当前没有沙箱，这是显式授权而非隔离）

### 模型接入

**检视模型（reviewer）**:
执行检视的 LLM：model id 走请求参数（CLI `--model <id>`；pi 内核线接缝见 ADR-0009），无 model 环境变量；url / key 来自用户级配置文件 `~/.PiAgent/PiAgent.json`（`reviewer.baseUrl` / `reviewer.apiKey`；`--config` 可换文件，env 层已不再读取，ADR-0025）；进审计留痕（model + baseUrl，绝不记 key，ADR-0008），并在审计 `config` 快照里留全量生效值与 `digest`。自定义网关换端点/模型先跑 `review-pi smoke` 双探针自证。
_Avoid_: 被测模型（实验自变量语义已随评测层废止）、白名单模型（准入白名单已由画像表取代）、model 走环境变量（model 走请求参数、秘密走配置文件）

**参数画像（Provider Profile）**:
模型 id pattern → wire 序列化策略（thinking 字段 / completion 信封）+ usage 能力声明（有无缓存计量）的单源查表（review-llm）；未知模型回落保守默认档（ADR-0008）。无缓存计量的 provider 在成本口径上按未知 ≠ 0 处理。
_Avoid_: 画像当 endpoint 配置（「怎么说话」与「连到哪」两轴正交）

### 基准

**逆补丁法（Inverse-Patch）**:
以修复补丁的逆 diff 构造"引入缺陷的 MR"的基准构造方法：base 为修复后版本，合入后即历史真实 buggy 版本，真值为最小修复补丁的行位与性质。历史数据集沿用此法构造（本仓已不再自带构造脚本，ADR-0024）。
_Avoid_: 缺陷注入（暗示合成篡改）、SZZ 挖掘（是被否的替代路径）
