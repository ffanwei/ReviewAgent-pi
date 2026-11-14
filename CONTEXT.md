# Review Agent

低 Token、高质量代码检视 Agent：用最小充分上下文与缓存稳定循环，以 20~30% 的 Token 成本获得接近全量上下文的检视质量。终点是落地到企业内部代码托管平台的 MR 检视。（内核基座：pi 代码仓 fork，Review Runtime 从 0 重写，ADR-0009；DSH 线历史见 ADR-0005/0006。）

**范围（ADR-0024）**：本仓只有一种检视形态（工具驱动 + Context Ledger + 规则 Skill），是 Review CLI 产品仓。配置矩阵（A–E）、`configId` 身份维度与评测仪器层（数据集构造、判定链、指标聚合、实验运行器、字节门）已删除；本词汇表中与之绑定的条目同步移除，历史报告见 `docs/report/`（`runs/**` 运行留痕自 ADR-0033 起不入库，旧目录已清理）。

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
签名级符号索引（不含函数体），按变更文件所在包/模块圈定范围，静态确定性生成；模型语言无关，具体提取由每语言 extractor 提供（ADR-0041）。

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

**Diff 检视技能（Diff Review Skill）**:
仓内 `.agents/skills/` 下**开发态验证技能**（OpenCode / Codex / Claude Code 可加载），既不是产品运行时的一部分，也不是被检视项目携带的规则 Skill。职责固定为「已知真值 → 构造缺陷 diff → 真跑一次 Review CLI → 判定并归档」；共享执行层 `.agents/skills/_shared/review-eval.mjs` 负责构造 diff、调用 `review-pi`、读取 findings、按真值判定与写归档。
_代码面_: `real-defect-url-injection`（真实修复回滚）与 `synthetic-defect-resource-leak`（按规则注入）。
_Avoid_: 规则 Skill（那是被检视项目的规则包，经 `--rule-skill*` 显式装载）、检视形态（技能不改变单次检视的唯一形态）

**真实缺陷回放（Real-Defect Replay）**:
Diff 检视技能的一种：以真实漏洞的**修复补丁**为真值，复制修复后快照并 `git apply -R` 回滚修复，得到「缺陷重新引入」的 diff，交给 Review CLI 真跑；默认案例 VUL4J-38 / CVE-2014-4172。底座是 `.cache/datasets/vul4j-repos/` 的已物化快照（不联网、不改快照），真值位置来自 `data/vul4j/materialized-cases.json`。
_Avoid_: 缺陷注入（那是合成侧）、评测仪器（本仓评测层已按 ADR-0024 删除；回放只作单案验证）

**合成缺陷注入（Synthetic Defect Injection）**:
Diff 检视技能的另一种：在 testdata 夹具仓的临时副本里写入一个已知缺陷（默认 GEN-RES-001：`os.Open` 后不关闭文件句柄），生成新增文件形态的 diff，再交给 Review CLI 真跑；用于完全可控、可重复的回归，并验证规则包是否被装载。
_Avoid_: 真实缺陷回放（真值来自历史修复，不是注入）、篡改夹具（临时副本用完即删，不改仓内夹具）

**检视归档（Review Archive）**:
Diff 检视技能每次真跑的固定产物目录：仓根 `repo-diff-skill-result/<skill>/<YYYYMMDD-HHmmss>/`，含 `defect.diff`、`ground-truth.json`、`meta.json`、`stdout.json`、`stderr.log`、`result/runs/*`、`result/audit/*`、`verdict.json` 与 `verdict.md`。归档是**本机验证证据**，按运行留痕纪律（ADR-0033）不入库（`.gitignore`）。
_Avoid_: 运行落盘根（那是产品 `review` 的任务目录）、评测报告（归档不产出召回率等指标）

### 运行时边界

**核内（Review Runtime）**:
检视会话运行时的全部行为：loop 策略、`review.*` 工具、C0–C3 上下文决策、缓存纪律、检视政策与 Evidence Gate；在 pi 内核上从 0 重写（`packages/review-pi`，ADR-0009）。
_Avoid_: 通用 Coding Runtime 复用、把核内当插件树挂接点（DSH 线历史形态，已随内核移除）

**策略驱动器（Review Driver）**:
核内 Review Runtime 中代码级强制六阶段骨架的组件：只有它能推进阶段（一阶段 = 一回合），回合边界执行 Evidence Gate 与轮次调度。
_Avoid_: 自定义 Loop（替换内核 loop 的机制，DSH 线已否；pi 线以 agent-loop 钩子实现同等骨架）、提示词纪律（骨架不是提示词约定）

**核外（呈现工具链，legacy）**:
服务于呈现而非检视会话的层：中文翻译投影、分组意见映射与真引擎装配（`src/presentation/`）；普通库被 CLI 调用，不进内核。ADR-0065 起 CLI 不再调用这一层（控制台恒英文、中文 tips 由片级语义生成提供），代码与发行产物保留供外部消费方使用。
_Avoid_: 实验插件、核内呈现（语言参数化缝不存在，ADR-0010）、把 legacy 模块当成现行运行时路径

**交付（Delivery）**:
`review` 命令在 `runReview` 返回或抛出之后、进程退出之前的唯一收尾阶段：变更文件覆盖补报、中文 tips 组装与落盘、总结上报、session 索引、收尾产物（mcp.json / lifecycle / trace）与 MCP flush/close。一个 CLI 级 module（`cli/delivery.ts` 的 `deliverReviewRun`）拥有这条链的**顺序不变量**；`main` 只保留组装、stdout 写出、两套运行账本与退出码。两条「跳过检视」路径（diff 超界 / 无可检视文件）不属它。ADR-0081。
_代码面_: `cli/delivery.ts`、`cli/delivery.test.ts`。
_Avoid_: 编排器（暗示可配置流程）、核内收尾（交付不进内核）、把两套运行账本算进交付（账本是整次进程运行的投影）

**翻译投影（Translation Projection，legacy）**:
核外呈现工具：消费检视产出的英文文档做中文呈现，仅译自然语言字段（findings 叙述、resultSummary），结构化字段字节直通；投影自带留痕（呈现语言、术语表版本、源 finding 关联）。检视输出恒英文——测量面冻结，语言是呈现配置而非实验自变量（ADR-0010）。**ADR-0065 起 CLI 不再调用它**：控制台 stdout 恒英文、没有 `presentation` 键；`presentation.engine` 仅保留为兼容配置键（动态 import 核外引擎的路径解析与校验行为不变）。需要中文时看 `reviews_tips_zh.json` 或 MCP 报文。legacy 行为：引擎加载/协议/超时失败时整次呈现降级英文源；ADR-0059 的单字段降级（`presentation.degradedFields` / `degradedReason`）也只存在于该模块。
_Avoid_: 输出语言配置（暗示内核参数化缝）、双语内核（检视链整体留在已验证英文域）、把呈现引擎当作中文 tips 的生产者

**运行进度投影（Run Progress Projection）**:
检视执行期的实时人读投影：把内核既有留痕（阶段推进、模型请求首尾、工具调用首尾、规则 Skill 会话首尾）写成 `stderr` 的追加事件行，TTY 下另有一行 `\r` 重画的状态行与收尾摘要行。**只投影不决策**：不改 wire 字节、不新增审计键、不改退出码，`stdout` 单 JSON 文档逐字节不变；工具参数摘要截断 80 字符、结果全文永不落地（只报行数/字符数）。开关 = **缺省打印** / `--no-progress` 关（ADR-0055，取代 ADR-0016 的 TTY 自动档；`--progress` 已移除）。**收尾总结行恒定打印**（与进度开关解耦，ADR-0030）：中文一行报耗时、token 三段（未命中输入 / 输出 / 缓存命中）、模型调用数、工具调用（主会话 + 规则 Skill 分列）、Context Ledger 命中数（重复读取返回引用、原文未重读）与成本；token / 工具数与审计同源，Ledger 命中与模型调用数只经返回值透传、不进审计字节。
_代码面_: 事件契约 `contracts/progress.ts`（`RunProgressEvent` 四类 kind）、呈现层 `cli/progress-render.ts`。
_Avoid_: 进度条（不是百分比口径——「步数」= 模型请求序号）、日志（日志是核外运行器产物）、遥测（不回传任何指标）

**请求时间线（Request Timeline）**:
一次 run 中每次模型调用的时间戳留痕，随 pass 落盘为 `<runs 根>/request-timeline.jsonl`（分片为 `shards/attempt-<ts>/sNN/request-timeline.jsonl`；收尾的一次性调用续写顶层文件）。一行一个 JSON 对象，两种 `kind`：**尝试**（一次 HTTP 请求的发出 / 响应头 / 状态 / 异常归因）与**请求**（一次逻辑调用，含首 / 末增量时刻、停因、增量条数 / 字符数、真实 `bytes`、usage）。同一次逻辑调用的所有行共享 `requestId`，靠 `replay` 区分重放序号（ADR-0077）。**只观测**：不改 wire 字节、不改退出码、不进审计 / `run.json` / 转录 / `export`，也不经 MCP 事件通道出站；本文件是唯一允许把时钟写进产物的内核产物（ADR-0076 对 ADR-0013 决策 10 的局部豁免，不外溢）。失败时 `review-pass` 在 rethrow 前打一行人读摘要（前缀 `request-timeline:`），随 stderr 进 `review-pi.log`。
_代码面_: `observability/request-timeline.ts`（sink / writer / 脱敏）、`provider/pi-client.ts`（fetch 包裹 + 流 `push` 覆盖）、`shared/one-shot-llm.ts`（一次性调用）。
_Avoid_: 日志（那是 `review-pi.log`）、审计（那是 `audit/*.json`）、轨迹（那是离线回放 trace）、诊断（那是 smoke 双探针）、把时间线当成本/指标真源

**尝试（Attempt）**:
请求时间线里的最小单位：一次 HTTP 请求的发出到响应头（或异常）。一次**请求**可含多次尝试——pi-ai 的重试对上层不可见（`onPayload` 在重试循环外只调一次），所以尝试序号只有包 `fetch` 才拿得到。同一次尝试里的失败若有响应头，`status` 与响应头白名单投影仍在场。
_Avoid_: 回合（那是 agent 的一轮消息 + 工具）、轮次（那是六阶段循环的 round）

**增量（Delta）**:
流式响应里的分片事件（`text_delta` / `thinking_delta` / `toolcall_delta`）。请求时间线只记**首 / 末增量时刻**与条数 / 字符数，不记内容、不记字节（真字节要 tee body，ADR-0076 决策 2 拒绝）。三段时长——首字延迟（`firstDeltaAt - sentAt`）、流持续（`lastDeltaAt - firstDeltaAt`）、断流前空档（`endedAt - lastDeltaAt`）——是区分「空闲超时」与「总时长上限」的唯一依据。
_Avoid_: 字节数（记的是增量字符数）、token（增量 ≠ token）

**MCP 上报（MCP Reporting）**:
检视进程向外部 MCP 服务（HTTP + JSON-RPC，`mcp.servers` / `mcp.report` 配置）的外发能力，**两层语义**共用同一连接与握手：(1) **事件上报**（ADR-0037）——进度事件批量塞进单个 tool 的 `events` 数组，`(streamId, seq)` 幂等、可重试、背压丢最旧，字段白名单（正文/路径/秘密永不出进程）；(2) **业务调用**（ADR-0045）——`startTask` / `endTask` / `saveReviewSummary` / `mrReviewResult` 四个 tool 的任务生命周期与结果上报：片级 `mrReviewResult` 每片 findings 定型后就发（报文与 `reviews_tips_zh.json` **同源复用**——同一份统一生成的两个投影：报文 = 片级即发、结构字段从严；tips = 聚合落盘、12 键），总结在统一 tips 落盘后发；总结的输入口径 = `mrReviewResult` **实际成功上报**的意见集合（ADR-0057——未上报条目不进总结，零上报时发固定「未向平台上报任何检视意见」而不是「未发现缺陷」）；片级报文生成全量一次失败（超时 / 截断 / 非法 JSON）时按条数**二分重试**，最多两层、拆分批次单次尝试且串行（ADR-0058——成功批次照常上报，仍失败条目逐条留痕；正常路径零额外调用、提示词与报文字节不变）；`saveReviewSummary` 之前 diff 的**每个变更文件**都必须有一条 `mrReviewResult`（ADR-0061——无意见或报文生成失败的文件都发空 `reviewTips`；空包不登记 finding，总结仍按 ADR-0057 统计）。**变更文件全集取过滤前 diff**（ADR-0068）：被 `limits.testFiles.skip` / `limits.mrFilter.excludeGlobs` / lockfile / 生成物 / minified / binary 预过滤剔除的文件同样在收尾补报一条空 tips（stderr 一行 `已补报 N 个变更文件 / 0 条意见`），只有整个 diff 解析不出任何文件路径时才只打一行 stderr 不调用。两层共用的纪律：**旁路**（任何失败只落 stderr 一行、永不改退出码）；业务调用最多 3 次尝试（仅传输 / 超时 / HTTP 5xx 瞬时失败重试，ADR-0050），另受 `mcp.report.task`（缺省 `true`）开关。业务调用的**序列化**仍是严格串行（每个调用都 await）；为应对服务端异步处理导致前端回调乱序，`mrReviewResult` 全部结束后与 `saveReviewSummary` 结束后各加一段**固定 5 秒沉降**（ADR-0053；临时措施，不是顺序契约，服务端支持序号后删除，见 `docs/待优化维护清单.md`）。
_Avoid_: 遥测（不上传指标）、把业务调用塞进事件批量通道（业务调用不可丢、要立刻知道结果）、双向 MCP（我们只是 client，不做 resources/prompts）

**LLM 调用重试（LLM Call Retry）**:
模型网关调用的瞬时失败重试能力（ADR-0051）。**分层实现**：Agent 内会话（主检视回合 / 规则 Skill 会话）透传 pi-ai 的 `maxRetries` / `maxRetryDelayMs` / `timeoutMs`，只重试**请求建立阶段**；核外一次性调用（片级报文 / 收尾总结 / 内置呈现引擎 / smoke 探针）走本仓 `shared/llm-retry.ts` 的统一原语。次数口径恒为**总尝试次数（含首次）**；缺省 3 次，smoke 缺省 1 次（诊断命令不重试）。只有传输失败 / 超时 / 408 / 409 / 429 / 5xx / `x-should-retry: true` 可重试；确定性 4xx、配额类 429、超 `maxRetryAfterMs` 的 `Retry-After`、非 JSON / 空 completion 不重试。**流已开始后断开不再直接失败**：由 [流中断重放]（ADR-0077）在本仓 `streamFn` 层缓冲重发，仍不做整回合重放。配置面 `limits.retry` 与 `limits.timeouts.reviewTurnMs` / `oneShotMs`；离线回放 lane 固定单次尝试。一次性调用缺省超时 300 s（ADR-0062：大 MR 报文单次可输出 1.6 万 tokens）。
_Avoid_: 全局重试开关（分层各有边界）、断线续传（流中断不重试）、把「重试次数」当配置口径（一律写总尝试次数）

**流中断重放（Stream Replay）**:
流已开始后响应体断开（`TypeError: terminated` 这类）时的恢复能力（ADR-0077）。做法是**缓冲本次响应的全部事件、不交付给消费者**；失败则丢弃缓冲并重发同一请求，只有成功那次的事件才交给 agent——因此失败响应里的 `toolCall` 从未执行，**重放按构造无副作用**（这正是它与 ADR-0051 拒绝的「整回合重放」的分界）。触发条件只看结构化信号：终止于 `error`、非 `aborted`、且响应体**确实读失败**（`content_filter` 这类 body 正常读完的确定性拦截不重放）。两个闸门：`limits.retry.streamAttempts`（总尝试次数含首次，缺省 13 = 1 + 12 次重放）与 `limits.retry.streamReplayBudgetMs`（总墙钟预算，缺省 120 s、含退避、0 = 不设上限），**先到者生效**；预算到点只停止「再发起一次」，已发出的尝试不被打断，故上界 = 预算 + 单次尝试时长。`onPayload` / `onResponse` 只在首次尝试触发，审计 `requests[]` 与进度计数不因重放而重复。代价：失去 token 级增量分发（当前无消费者）、响应事件全量进内存、失败尝试的 token 不计入 `usage`。
_代码面_: `provider/pi-client.ts`（`driveWithReplay` / `observeResponseBody` / `withoutProviderCallbacks`）。
_Avoid_: 回合重放（修剪消息历史后重发 prompt——会重跑已执行的工具）、断线续传（不续读，是整条重发）、对确定性拦截重放（`content_filter` 不重试）

**测量常量面（Measurement-Constant Face）**:
内核跨版本 / 跨语言呈现改动时必须 byte / 行为一致的半边：Zone A 提示词、六阶段 Loop 语义、Finding/Evidence 契约；这些面由**结构性质 + 端到端能力断言**把守（ADR-0038 于 2026-11-04 退役了「对照 DSH 历史审计真源逐字节相等」的 golden 常量门；此前的一致性属历史记录，不再由测试机器验证）。
运行期常量面（ADR-0025 收窄口径，ADR-0046 后）= **4 项死钉**：`maxToolCalls=100` / `toolResultBudgetChars=8000` / 呈现 `temperature=0` / `reasoningEffort=high`。检视轮次上限已移入配置面（`limits.loop.maxRounds`，缺省 3；最后一轮强制 complete，ADR-0046）。其余文本截断与资源上限（包头部字节、检索回显、调用链跳数、工具名/摘要截断、超时、并发、归档、MR 边界）是**可配项**，不再是本面的一部分——换一份 `~/.PiAgent/PiAgent.jsonc` 即可能改变请求体。
_Avoid_: 不变层（过泛）、冻结面（与「仪器冻结」混淆）、「配置文件无关」（ADR-0025 后不成立）

**内核变量面（Kernel-Variable Face）**:
内核可演进的半边：Agent 状态与事件模型、工具调用协议与 wire 序列化、LLM 客户端、会话/审计投影——在 pi 原语上从 0 重写（ADR-0009）。
_Avoid_: 可变层（过泛）

**MR 输入形态（MR Input Form）**:
单次检视的变更集来源，恰好一种：`--mr-diff <file>`（标准 unified diff 文本）或 `--mr-json <file>`（GitCode/GitLab `/pulls/:number/files` 的原样 JSON：数组或 `{diffs:[…]}`；路径取 `new_path` / `filename` / `file_path` / `path`、正文取 `diff` / `patch`，`diff` 为对象时取内层 `diff.diff`，装载期补文件头；ADR-0029）。`caseId` 恒由文件名去最后一个扩展名派生，与形态无关。二者不可混用，也不做内容嗅探。
_Avoid_: MR 文件（不区分形态）、patch（只指 hunk 正文）

**MR 边界护栏（Boundary Guard）**:
内核入口处的 MR 输入边界检查（缺省 ≤10 文件 / diff ≤2K 变更行；`limits.boundary` 可改，单维 `null` = 该维不设界）：界内路径零字节漂移（缺席省键）；超界或不可度量走显式降级——`domainWarning` 标注（文案按配置值派生）+ 审计 `mrBoundary` 留痕 + 照常执行，不拒检。
_Avoid_: 输入校验（过泛）、分片（那是「分片检视」的另一机制）、静默截断（违背零静默纪律）

**MR 输入预过滤（Input Prefilter）**:
内核入口在边界护栏之前对 diff 做的整块预处理：按 `diff --git` 文件块剔除 lockfile / 生成物 / minified / 二进制（绝不切 hunk）；另有**四类规则驱动**的跳过/限范围——`limits.testFiles.skip`（测试文件）、`limits.mrFilter.excludeGlobs`（glob 列表，如 `**/*.md`，ADR-0069），以及检视范围正则 `--include` / `--exclude`（CLI）与 `limits.mrFilter.includeRegex` / `excludeRegex`（配置，ADR-0078）：include 先选白名单、exclude 再从候选剔除（exclude 优先），命中 include 的块越过全部启发式，`binary` 恒剔；同类多条 = OR，CLI 出现即整体替换配置对应维度，传空值 = 清空该维度。过滤后的 diff 才进入模型、工具与边界度量。剔除清单写审计尾键 `mrFilter`（无剔除且未配范围规则时省键，`reasons` 恒含八类键，配置了范围规则时另记 `filters` 原文）并在 stderr 报一行——剔了必有账；被剔除文件仍在收尾补报空 `mrReviewResult`（ADR-0068）。过滤后一个文件块都不剩时跳过检视（不调模型，仍上报一次空意见 + 固定总结，exit 0）。同一入口还有**输入体积门** `limits.boundary.maxDiffChars`（缺省 100 万字符，`null` = 关闭；ADR-0071）：过滤后仍超限直接报人话错误，不把注定失败的请求发给模型。
_Avoid_: 截断（预过滤是整块剔除，不是截行）、静默丢弃（无审计即违规）、把 range regex 说成 glob（两种方言并存，接口文案必须写明）

**分片检视（Sharded Review）**:
过滤后 diff 超过 `limits.split.maxShardChars`（缺省 12 万字符，ADR-0071）时，按 `diff --git` 文件块**贪心装箱**拆成 N 片（只切文件块、绝不切 hunk；每块恰好出现一次、顺序 = diff 顺序），每片串行跑一次完整六阶段 + 规则 Skill 会话，最后按 `(file, line, title)` 确定性合并 findings 并重编号 `F001…`。单片路径（`limits.split.enabled=false` 或 diff ≤ 预算且无截取）与旧实现**逐字节相同**。**单个文件块**超过 `maxShardChars` 时不报错，而是按整 hunk 截取（保留文件头 + 前缀若干个完整 hunk，尾部整 hunk 丢弃；ADR-0070），留痕写审计尾键 `shardTruncation` 并在 stderr 报一行；唯一一片是截取片时也走分片路径。每片的输入 = 本片 diff + 其他文件的路径/增删摘要（不是证据源）；聚合 `runId` = 第 1 片 `runId`；任何一片失败都无聚合产物（不输出部分结果），已成功片的产物保留在 `runs/shards/attempt-<ts>/sNN/`（ADR-0039）。
_Avoid_: 切 hunk（破坏行号与证据链）、静默截断（截取必须留痕 `shardTruncation`）、并行分片（v1 串行）

**代码智能语言（Code Intelligence Languages）**:
符号 / 引用 / 调用链工具扫描的语言集合，由 `codeintel.languages` 决定（缺省 `"auto"` = 跟随本版本已实现的解析器，当前 `java` / `typescript` / `python` / `go` / `cpp`；数组 = 只启用列出语言；空数组 = 显式关闭）。注册表在 `codeintel/language-support.ts`（id / displayName / 语法变体 / 注释前缀 / extractor / 签名渲染 / 懒加载 `createParser`），未实现的条目**装载期告警并丢弃**。符号模型语言无关（`CodeSymbol` + `isCallableKind` + `owner`），每语言提取在 `zoneb/extractors/<lang>.ts`；`codeintel.excludeGlobs` 排除依赖与生成物（`--no-ignore` 的确定性要求）。检视本体不限语言——该开关只影响符号级工具；0 源文件时工具返回 `no supported source files detected …`（ADR-0040、ADR-0041、ADR-0042）。
_Avoid_: 多语言检视（检视本来就全语言）、语言包（实际是解析器注册表）

### 产物

**检视转录（Review Transcript）**:
一次检视中**进入 Review Runtime 的全部交互**（系统提示词、每轮消息、工具调用与结果）的完整留档，随 run 落盘为 `<tasks 根>/<taskId>/runs/session-<ts>.json`（规则 Skill 会话为 `session-<ts>-skill-<name>-r<N>.json`；`<ts>` = 首次模型请求时刻，UTC 形 `20261031_101010_123`，即 `runId`；含 `{ info, messages, view }`：`messages` 为 pi 原生真源、`view` 为 OpenCode 风格定形投影）；是 debug 与取证用的现场，**不是指标源**（成本与行为核对取自运行记录与审计）。**每次 run 独立留档、不覆盖**（文件名含首次模型调用时刻，ADR-0032）。
_Avoid_: session、会话记录（都与 pi 内核的 `Session` 子系统撞名）、日志（过泛）

**检视意见导出（Review Findings Export）**:
一次检视的 Finding 清单落盘成的对外消费产物：`reviews_en.json` 是英文真源口径（恒产），中文侧只有按文件分组的中文意见 `reviews_tips_zh.json`（有 finding 且有覆盖时**必产**）—两份都落在 `<tasks 根>/<taskId>/runs/`，同一次 run 覆盖重写，**不是**测量的第四个真源。`reviews_zh.json` 已停产（ADR-0022）；控制台 stdout 恒英文、无 `presentation` 键（ADR-0065）。进程 cwd 只放一份下游约定名副本 `review-result.json`（与真源逐字节相同，ADR-0027；另有隐藏的 session 索引，见「Session 索引」）。tips **只有一个生产者**（ADR-0065）：**片级语义生成**（与 `mrReviewResult` 同一份语义输出，12 键 = 10 键 + `id` + `level`，只增不删）。业务上报开启时由片级回调生成；业务上报关闭时收尾对过滤后的 findings 补一次同源生成（只登记语义、不发报文）。生成全灭时**不回落任何引擎**：有 finding 但零覆盖则不产文件并清陈旧；零 finding 或全被过滤则产 `[]`。字段口径（ADR-0052）：`severity` 四档（P0→Fatal / P1→Major / P2→Minor / P3→Suggestion，与 `level` 同值）；`confidence` 三档（≥0.7 High / ≥0.5 Medium / 其余 Low）；配置 `limits.confidence.min`（0–1，缺省 0.5）在生成前丢弃 `confidence < min` 的意见，**只作用于中文 tips**（`reviews_tips_zh.json` 与 `mrReviewResult.reviewTips`），`reviews_en.json` / stdout 恒全量；丢弃条数与阈值记入审计 / `run.json` 的 `tipsFilter`。另配 `limits.severity.min`（`P0`–`P3`，缺省 `P3` = 不过滤）按严重级过滤同一组产物（中文 tips + MCP 上报），英文真源恒全量，留痕键为 `severityFilter`。测试文件由 `limits.testFiles.skip`（缺省 `true`）在**检视输入阶段**按文件块整块剔除（不进 diff，因而不产 findings / tips / MCP 上报），留痕走 `mrFilter` 的 `test` 原因；同样在输入阶段生效的还有 `limits.mrFilter.excludeGlobs`（ADR-0069，glob 列表，留痕 `mrFilter` 的 `exclude` 原因）；它们与上述输出侧过滤不同，改变的是被检视的输入集合。检视意见的位置范围由 `limits.findingScope`（ADR-0064，缺省开启，默认 hunk ±10 行）在**候选拦截链**判定：文件不在本遍 diff 或落在变更 hunk 之外的意见按 `OUT_OF_SCOPE` 丢弃，只留审计 `rejections` / `rejectionCounts`，findings / tips / MCP 三处口径一致；关闭后不再构建位置范围。
_Avoid_: reviews.json（单数形已废）、评论列表、检视报告（REPORT.md 是另一物）

**运行落盘根（Runs Root）**:
`--taskId` 决定的任务目录 `<tasks 根>/<taskId>/`（tasks 根缺省 `~/.PiAgent/tasks`，`--tasks-dir` 可覆盖），本次检视的全部留痕都在其下：`runs/`（`run.json` 记录 / `session-*.json` 转录 / `reviews_*.json` 意见导出 / `review-pi.log` CLI 运行日志）与 `audit/<ts>.json`（审计），规则包解压缓存在 `.cache/rule-skills/`。分片检视时每片的转录/审计/片内 `reviews_en.json` 落在 `runs/shards/attempt-<ts>/sNN/` 与 `audit/shards/attempt-<ts>/sNN/`，顶层只留聚合产物。一个任务目录就是一次 run 的输出根：没有 case / rep / source 目录层，`caseId` 只作为数据字段（ADR-0032、ADR-0033、ADR-0039）。
_Avoid_: 输出目录（泛指；本仓改称任务目录，旧 `--out` 已随 ADR-0033 移除）、runs 根（与历史 `runs/phase2-*` 实验目录混淆）

**任务（taskId）**:
一次 `--taskId` = 一次检视任务的**身份**：它同时是本地任务目录名（ADR-0033）与远端 MCP 任务的标识（ADR-0045 的 `startTask` / `endTask` / `saveReviewSummary` / `mrReviewResult` 同值直传）。两者同源不是巧合，而是「一次 `--taskId` = 一次任务」这条语义的延伸；本地校验（单段目录名、不含路径语义）因此同时是远端 id 的事实约束。若将来远端要求别的 id 形态（如 UUID），那是本地目录名与远端 id **分离**的新决策，需另立 ADR。
_Avoid_: runId（那是首次模型请求时刻的产物 id，迟到且只属本地）、远程任务 id（暗示另有一个 id 要传）

**Session 索引（Session Index）**:
`review` 成功后写在**进程 cwd** 的隐藏文件 `.review-pi-session.json`：只含本次 run 的寻址信息（`taskId` / 绝对 `tasksDir` / `runId` / 主与 skill 转录的绝对路径），不含检视内容与秘密；每次成功 run 整份覆盖，失败 run 不写（ADR-0036）。**version 2**：主转录是数组 `mains[]`（分片时按 `s01 → s02 → …`，单遍长度为 1），读取端兼容 v1 的单个 `main`。由 `review-pi export` 消费：缺省读它并在**一行**内打印路径（逗号 + 空格分隔；分片按 `s01 主 → s01 skill → s02 主 → …` 顺序），`--taskId` 改为从 `<tasks 根>/<id>` 的 `run.json` 反推（分片读 `shards[].transcriptFile`），`--path <dir>` 平铺复制到目标目录。该命令不加载配置、不需要 key、不调模型。ADR-0027 的「cwd 只留 `review-result.json`」由此局部修订。ADR-0072 后 `export` **缺省返回 OpenCode 兼容版**（同 run 的 `<runs>/opencode/session-*.json`），`--native` 切回 pi 原生转录。
_Avoid_: 会话记录（那是转录本身）、配置文件（索引只存路径）、缓存（它不加速任何东西）

### 离线回放

**回放轨迹（Trace）**:
一次运行的请求指纹 → 响应原文配对集合；工具面按 digest 去重（schema v2 的 `toolsVariants`，v1 为共享一份）；与录制时的夹具仓强绑定，改夹具必须重录。`large-mr` 是唯一走**真网关录制**的轨迹（大 MR + MCP 业务上报），其余五条由 canned 语料生成。
_代码面_: `packages/review-pi/testdata/traces/*.json`（ADR-0048 / ADR-0049）。
_Avoid_: 录制文件（暗示原始流量）、语料（那是 `testdata/golden/` 的纯文本回复）

**离线回放（Offline Replay）**:
用本机 HTTP 服务替代模型网关，让真实 `review-pi` 进程在不调模型的情况下走完检视路径；按请求体 SHA-256 严格命中（仅对 trace 显式声明的 lane 路径占位做归一化），未命中即失败。
_Avoid_: mock 模型（mock 指代码内打桩，回放走真 HTTP）、夹具（那是被检视的输入）

**夹具仓（Fixture Repo）**:
被检视的仓库快照与 diff 输入，随 trace 一同版本化；trace 的请求指纹与它逐字节绑定（缺文件或在回放前被改动都会导致未命中）。
_Avoid_: 数据集（那是评测语料，ADR-0024 已废止）、样例（过泛）

**回放通道（Lane）**:
一个并发 worker 独占的回放上下文：独立 cwd + 独立任务目录 + 固定 `taskId`，共享同一个 hash-keyed 回放服务。
_Avoid_: 分片（那是产品内的大 MR 切片）、通道（泛化）

**并发阶梯（Concurrency Ramp）**:
按配置档位逐级增加 worker 数的测量流程：每档 1 次 warmup + 固定次数测量，按「失败 / p95 超基线 2× / RSS 告警 / 到达上限」收敛出该机器在给定延迟档位下的并发上限。
_Avoid_: 压测（未定义成功判据）、基准（那是评测指标，ADR-0024 已废止）

**模拟延迟（Latency Profile）**:
回放时按 interaction 注入的等待时间（`mode` + `ms` + `jitter` + `seed`），语义是单次模型调用的总耗时而非逐帧 TTFT；不同延迟档位下的并发上限不可直接比较。
_Avoid_: 真实耗时（归档没有逐帧时间）、超时（那是产品配置）

**大 MR 端到端验证（Large-MR E2E）**:
用真模型 + 真 HTTP MCP server（带浏览器展示页）跑一次 >1000 行 diff 的完整检视，按 ADR-0061 断言 `startTask → mrReviewResult × 每个改动文件 → saveReviewSummary → endTask`；这次真实调用随后冻结为 `large-mr` 回放轨迹。录制期用场景 `timeouts.oneShotMs` 放大一次性调用超时，避免客户端中断导致录制走二分重试、回放走全量而分叉。
_代码面_: `scripts/e2e-mcp/`（harness / server / dashboard）、`packages/review-pi/testdata/e2e/large-mr/`（改动前骨架与 diff）、`packages/review-pi/testdata/repos/large-mr/`（最终态夹具）。
_Avoid_: 离线回放（那是不调模型的冻结复跑）、评测（ADR-0024 已废止）

### 发行

**发行形态（Distribution Shape）**:
产品以 **单个 npm 包**交付：`@baize/review-pi`（唯一 `bin` 名为 `review-pi`）。内核四包 `@earendil-works/{pi-telemetry,chord,pi-ai,pi-agent-core}` 是它的**普通 npm 依赖**（四包同版本成套、精确锁 `0.85.1`，不带 `^`），随 `pnpm install` / `npm i -g` 自动拉取，本仓不 vendor、不打包、不发布它们（ADR-0035）。源码 specifier 就是上游名，不用 npm alias。
_Avoid_: 六包自发布（ADR-0028 已废止）、单包 bundle（丢 `source` 条件与可调试性）、源码继续 vendor 但依赖声明上游名（开发与生产静默跑不同代码）

**发布面（Publish Surface）**:
一个包 tarball 里**应当**存在的东西：`dist`、类型声明、`bin`（`review-pi`）、`presentation` 制品、`THIRD-PARTY-NOTICES.md`、`README.md`；**不应**存在 `src/**/*.ts`。`review-pi` 的 `prepack` 从仓根复制履约文本并断言发布物在位——打包确定、离线，缺产物即人话报错。
_Avoid_: 构建产物（包含 `src` 的仓内状态）、打包脚本（那是手段）

**版本面（Version Surface）**:
`review-pi version`（等价 `--version` / `-v`）在配置装载前返回：stdout 人读恒一行 `review-pi <version>`，`--json` 输出 `{ name, version, node, kernel }`，`kernel` 是四个内核包**实际解析到**的版本（解析失败记 `null`，不改变退出码）。产品版本单源 = `packages/review-pi/src/shared/version.ts`（与 `package.json` 同源测试守护），运行时**不读**本包清单；`bin/review-pi.js` 的产物门禁对版本命令不分叉（dist 缺失 / 过期照常拒跑）。同一版本值写入 `review-pi.log` 头与 `config show` 人读首行（ADR-0079）。
_Avoid_: 运行时读 `package.json` 当版本真源、bin 特判 `--version` 绕过产物门、把人读版本行塞成多段（破坏 shell 单 token 消费）

**安装布局冒烟（Install-Layout Smoke）**:
`pnpm verify:pack`：把 tarball 解到临时 `node_modules/`（模拟 npm 安装布局），再把仓内已安装的依赖（含内核四包这批正常 npm 依赖）逐个 junction 过去，断言内容面、bin 腿表、`config init/show`、`version`（四包版本都能解析，ADR-0079）、`"builtin"` 引擎与 tree-sitter wasm / ripgrep 在安装形态下可用。脚本自身不发网络请求（依赖来自 `pnpm install` 已落位的 `node_modules`），不发布；包名从 `package.json` 派生，不写死 scope。
_Avoid_: 发布门（发布需人确认 registry 与凭据）、端到端检视（冒烟不调真实网关）

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
规则 Skill 只从**显式输入**装载（`--rule-skill-zip` / `--rule-skill <dir>` / `--skill <dir>`，一次可传多个：逗号列表或重复旗标；`--skill` 当前是 `--rule-skill` 的同义输入）——不扫描被检视仓库的 `.review-rules/`，没有显式输入就没有规则包。**一个包就是一个 skill**（ADR-0034：包内 ≥2 个 skill 一律降级，没有包内消歧旗标）；**同名 skill 后装载者胜出**（装载序 zip → `--rule-skill` → `--skill`，故 `--skill` 覆盖同名版本）；值位置的空串 / 纯空白按未传处理（ADR-0044 后续修订）。理由：规则包会指挥 skill 会话的 `bash` 工具执行进程，默认信任「被检视仓库自带的包」等于允许任意仓库在检视方机器上执行代码（ADR-0027）。
_Avoid_: 规则包自动发现、约定目录（历史 ADR-0012/0014 的旧口径）、沙箱（当前没有沙箱，这是显式授权而非隔离）

### 模型接入

**检视模型（reviewer）**:
执行检视的 LLM：model id 走请求参数（CLI `--model <id>`；pi 内核线接缝见 ADR-0009），无 model 环境变量；url / key 来自用户级配置文件 `~/.PiAgent/PiAgent.jsonc`（`reviewer.baseUrl` / `reviewer.apiKey`；`--config` 可换文件，env 层已不再读取，ADR-0025）；进审计留痕（model + baseUrl，绝不记 key，ADR-0008），并在审计 `config` 快照里留全量生效值与 `digest`。自定义网关换端点/模型先跑 `review-pi smoke` 双探针自证。
_Avoid_: 被测模型（实验自变量语义已随评测层废止）、白名单模型（准入白名单已由画像表取代）、model 走环境变量（model 走请求参数、秘密走配置文件）

**模型降级（model fallback）**:
`--model` 被网关明确判为 model not found 时，按部署开关改用配置文件 `model.default` 继续检视的**一次性决策**（ADR-0080）。决策发生在任何检视请求之前，事后整次 run 只有一个生效模型；替换痕迹在 stderr、审计与平台总结可见。默认关闭——它改变的是「这次检视是谁做的」这一事实，不是路由优化。
_Avoid_: 重试（重试是同一模型再试，降级是换模型）、自动选模型（不做模型选择，只在两个已声明 id 之间二选一）

**参数画像（Provider Profile）**:
模型 id → wire 序列化策略（thinking 字段 / completion 信封）+ usage 能力声明的查表面。pi 线**当前不按 id 分派**：恒 `deepseek` provider、恒发 `thinking{type:"enabled"}` + `reasoning_effort:"high"`（`provider/pi-client.ts` 的 `LOCKED_REASONING_EFFORT`），自由 id 只换字符串、借用 `deepseek-v4-flash` 的模型元数据；模型元数据（contextWindow / maxTokens / cost / compat）来自内核四包自带的模型目录（ADR-0035）。ADR-0008 的「按 id pattern 查画像表」在 pi 线从未接线，若要恢复多模型分派，按新功能另立项。
_Avoid_: 画像当 endpoint 配置（「怎么说话」与「连到哪」两轴正交）、把 review-llm 的 `profileOf` 当既有实现（ADR-0035 已删该包）

### 基准

**逆补丁法（Inverse-Patch）**:
以修复补丁的逆 diff 构造"引入缺陷的 MR"的基准构造方法：base 为修复后版本，合入后即历史真实 buggy 版本，真值为最小修复补丁的行位与性质。历史数据集沿用此法构造（本仓不再自带评测仪器层的构造脚本，ADR-0024）；`real-defect-url-injection` 技能复用同一手法做单案回放，只作验证、不进评测指标。
_Avoid_: 缺陷注入（暗示合成篡改）、SZZ 挖掘（是被否的替代路径）
