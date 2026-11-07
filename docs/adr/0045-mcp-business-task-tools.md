# 0045. MCP 业务 tool：任务生命周期、片级结果与总结上报

**状态**：已接受（2026-11-06，用户经 grilling 逐轮决策）
**关联**：ADR-0037（MCP 上报：进度事件流——本 ADR 在其上加**业务调用**层，不改事件面）、ADR-0039（分片检视——片级回调的执行缝）、ADR-0017（分组意见 tips——「同源不同译」边界）、ADR-0010（呈现投影——总结调用的模型档）、ADR-0033（`--taskId` 任务目录）
**范围**：本仓 pi 线 0045。只加 MCP 业务调用与 CLI 编排；六阶段骨架、检视请求字节、审计与 stdout 契约不动。

**后续修订**（2026-11-07）：`mrReviewResult` 改为**覆盖每一片 diff 触及的全部文件**——有意见的文件照旧带 tips，没有意见的文件也发一条 `reviewTips: []`（平台据此知道该文件已检视过、无问题）。`ReviewShardFindingsHook` 因此新增第三个参数 `files`（该片 diff 文件清单；单片路径 = 整份 diff 的文件）。空 tips 上报只在**该片报文生成成功**时发生——生成失败（模型 / 校验 / 源码行取不到）整片跳过并留痕，避免把「不知道」误报成「没有问题」。`reviews_tips_zh.json` 仍只含有意见的文件（空 tips 只是上报面语义，不进中文产物）。

**后续修订**（2026-11-07，四）：[ADR-0056](0056-mr-review-result-covers-files-without-tips.md) 改了「空 tips 上报只在该片报文生成成功时发生」这一条——**无意见的文件不再受同片报文生成失败牵连**，仍逐文件发 `reviewTips: []`；有意见但生成失败 / 校验跳过的文件继续不发空包。另：全被置信度过滤的文件也从「不发空包」改为「补发空包」（取代 ADR-0052 的同名子决策）。

**后续修订**（2026-11-07，二）：**零检视意见时 `saveReviewSummary` 发固定文案**——逐字节 `# 检视总结\n\n本次检视未发现缺陷。`，**不调用总结模型**（「没有意见」是确定事实，不需要模型再概括，省一次调用且内容稳定）。有意见时仍按决策 2 生成：模型 → 失败降级确定性模板。`buildReviewSummary` 在 `findings.length === 0` 时直接返回该常量。

**后续修订**（2026-11-07，三）：**中文产物落盘失败不再吞掉业务上报**。此前 `removeStaleReviewsZh` / `writeReviewsTipsZh` / `removeStaleReviewsTipsZh` 的 IO 失败（Windows 上常见：旧 `reviews_zh.json` 被占用、目标路径不可写）会直接抛出，位置恰在 `mrReviewResult` 之后、`saveReviewSummary` 之前——平台于是收到 startTask / mrReviewResult / endTask 却**收不到总结**（「有始无终」）。现在这一段失败只**记下**，`saveReviewSummary` 与 `endTask` 照常发完，随后才把这次运行判失败（exit 1）——顺序契约与「产物即契约」都不变，只是业务上报不再被产物 IO 连累。

**后续修订**（2026-11-07，四）：**`saveReviewSummary` 的正文参数改名为 `markdownContent`**（原 `description`）。这是服务端契约的字段名校正：报文即 `{ taskId, markdownContent }`，正文语义（Markdown 总结报告）不变。仅改参数字段名，不涉及调用时机、顺序与降级语义。

**后续修订**（2026-11-07，五）：[ADR-0057](0057-summary-covers-only-reported-findings.md) 改了决策 2 的**总结输入口径**——不再是本地 findings 全量，而是 `mrReviewResult` 实际成功上报的意见集合（合并键登记；片级生成失败 / 校验跳过 / 上报失败 / 置信度过滤的条目一律不计入）。有已上报意见时仍「模型 → 失败降级确定性模板」；零已上报意见且本地有 findings 时发固定文案「本次检视未向平台上报任何检视意见。」，**不谎报「未发现缺陷」**。裁剪发生时报一行 stderr 差额。

**后续修订**（2026-11-07，五）：**决策 3 的「单次尝试，不重试」被 [ADR-0050](0050-mcp-business-tool-retry-and-timeout.md) 取代**——四个业务 tool 改为共 3 次尝试（2 次重试，退避 100 / 400 ms），且**仅传输 / 超时 / HTTP 5xx 类瞬时失败重试**；`server-error`、`isError: true`、4xx 等确定性失败仍不重试。同时 `mcp.servers.*.timeoutMs` 缺省值由 10 s 改为 60 s。旁路纪律（不抛错、只落 stderr 一行、不改退出码）与其余决策不变。

**后续修订**（2026-11-07，六）：**顺序契约之外再加两段固定 5 秒沉降**（[ADR-0053](0053-mcp-task-tool-fixed-settle-gap.md)）：最后一条 `mrReviewResult` 结束后等 5 s 再发 `saveReviewSummary`，`saveReviewSummary` 结束后再等 5 s 才发 `endTask`。这是应对服务端异步处理导致前端回调乱序的**临时时间赌注**，不是新的顺序保证；业务关闭、`startTask` 未成功发出、或未走到总结的失败路径不等待。服务端提供序号 / 完成标记后应删除。

**后续修订**（2026-11-07，七）：[ADR-0058](0058-shard-report-splits-and-retries-on-failure.md) 收窄了「片级报文生成失败即整片跳过」：全量一次失败（超时 / 截断 / 非法 JSON）后按条数**二分重发**，最多两层，拆分批次单次尝试且串行。成功批次照常按文件上报，仍失败的 finding 逐条登记 `uncoveredByKey`（有意见的文件仍**绝不发空包**，ADR-0056）。正常路径（全量一次成功）零额外调用、提示词与报文字节不变；上报顺序、总结口径（ADR-0057）与旁路纪律不变。

## Context

ADR-0037 定义的 MCP 上报只有一种形态：把进度事件**批量**塞进单个 tool（`mcp.report.tool`）的 `events` 数组。接入企业检视平台还需要**业务语义**的调用——平台要的不是事件流，而是：

1. 任务生命周期：知道「一次检视任务开始了 / 结束了」；
2. 检视结果：按文件收到结构化意见（平台有自己的 `AgentReviewTips` 报文契约）；
3. 总结报告：一份 Markdown 格式的检视总结。

平台方给出的工具契约（`mrReviewResult`）要求的字段与我们的 Finding / tips 形状**不重合**：`category` 是 7 个中文枚举（我们的 `finding.category` 是模型自由英文文本）、`subcategory` 必填（我们的 tips 恒空串）、`review` 必须含 `[缺陷类型]+描述+影响评估`、`suggestion` 必须含 `[重构思路]+代码示例`、`level` 是 Suggestion/Minor/Major/Fatal（我们的 tips severity 只有 Fatal/Major/Minor）。**直接透传会被服务端 schema 拒收**，报文字段需要一次模型调用来生成。

## Decision

### 1. 四个业务 tool，名字硬编码，参数平铺

`startTask(taskId)` / `endTask(taskId)` / `saveReviewSummary(taskId, description)` / `mrReviewResult(taskId, filePath, reviewTips[])`。名字来自服务端契约（常量 `mcp/task-tools.ts`），**不开配置面**；`mcp.report.tool` 继续只管批量进度事件，两层语义分开。`taskId` 同值直传 `--taskId`（本地任务目录名与远端任务标识同源，见 CONTEXT.md「任务（taskId）」）。

### 2. 调用时点与顺序

```text
startTask（建连握手后、读 diff 之前）
  → 每片 pass 结束、该片 findings 定型后：报文调用 → 逐文件 mrReviewResult
  → 全部片结束 + 呈现投影（引擎只做 stdout 呈现档）+ 统一 tips 落盘
  → 总结调用（输入 = 统一 tips）→ saveReviewSummary
  → endTask（finally 里、flush 之前；仅在 startTask 成功发出过时）
```

- **建连前移到「参数回显之后、读 diff 之前」**：`startTask` 的价值就是「远端先知道任务存在」；预检失败（路径错 / JSON 坏 / 超体积门）也要有始有终。
- **片级上报**：大 diff 分片时，每片跑完自己的六阶段就立刻上报该片文件，不等全部片结束（平台增量收结果）。落点是 `ReviewRunInput.onShardFindings` 回调（片间 **await**，串行），由 CLI 实现为「统一生成调用 + 逐文件发送」；**六阶段骨架一字不动**，`mcp/` 仍不被 `run/` import（回调是注入缝，`no-core-coupling.test.ts` 纪律保持）。
- **两类模型调用**：每片一次「统一生成调用」（该片英文 findings + 源码行 → 按 finding id 的语义字段，严格校验）+ 收尾一次「总结调用」（统一 tips + findings 结构化字段 → Markdown）。单片 run = 2 次，分片 run = N+1 次。模型档用 `model.presentation ?? modelId` + `limits.timeouts.presentationRequestMs`（呈现性质的工作）。**只在 MCP 已配置且 `mcp.report.task` 开时才发**——纯本地 run 零额外 token。
- **总结输入降级**：统一 tips 全灭且无回落时，总结调用改吃英文 findings；模型调用失败再降级为**确定性模板** Markdown——`saveReviewSummary` 一定会被调用（除非 MCP 未配置）。

### 3. 旁路纪律（与进度事件同档，更严）

- **单次尝试，不重试**：业务调用是请求-响应、串在关键路径上，3 次退避 × `server.timeoutMs` 会让收尾多挂十几秒；送达保证是消费方的事。
- **永不改变退出码**：四个 tool 任何失败只打一行 stderr（`review-pi: MCP startTask 失败（…），继续检视`），不进审计、不改 stdout。
- **失败判定**：HTTP 非 2xx（抛 `ProtocolError`）或 `tools/call` 返回 `isError: true` 都算失败。
- **`onShardFindings` hook 抛错 = 实现方 bug，run 层吞掉继续**（CLI 实现自身保证不抛）。

### 4. 报文生成：结构字段确定性组装，模型只出语义字段

模型「不遵守提示词」是常态，约束不能靠提示词保证。报文八个字段里**五个半**的出生地本来就是代码，让模型转抄只会引入漂移：

- **确定性组装（按构造合法，不经模型）**：`filePath` ← `finding.file` 规范化（反斜杠→正斜杠、拒绝对路径 / `..`）；`code` ← CLI 按 `--repo` + 行号抽的**真源行**（单行按构造成立；读不到就跳过该条，**绝不编**——与 `readCodeLines` 同纪律）；`lineNum` ← `String(finding.line)`；`ruleId` ← 规则会话产出（候选 id 带 `RULE-CHECK@` 前缀）取 `finding.rule`，否则 `null`（结构性判定）；`level` ← severity 四档映射；**按文件分组** ← `finding.file`（模型不分组，不存在漏文件 / 重复文件）。
- **`level` 四档映射（用户决策 Q18）**：`P0→Fatal / P1→Major / P2→Minor / P3→Suggestion`——按工具契约用满四档（P3 是建议级）。注意与本地 tips 的三档折叠（ADR-0017：P3→Minor「不丢条」）是**两个呈现面**：同一条 P3 在平台叫 Suggestion、在 tips 叫 Minor，属「同源不同译」在结构字段上的已知分叉，消费方按各自面读。
- **模型只出四个语义字段**（按 finding id 对齐，不分组）：`category`（归一到 7 个中文枚举）、`subcategory`（必填细分）、`review`（`[缺陷类型]`+描述+影响评估）、`suggestion`（`[重构思路]`+代码示例）——这四个只有模型能写。
- **`category` 兜底映射表（用户决策 Q19）**：模型给的枚举外值时，对 `finding.category`（英文自由文本）按大写精确匹配查表（SECURITY→安全、CORRECTNESS/BUG→可靠性、PERFORMANCE→性能、…）；表未命中才跳过该条。**宁缺毋假**：映射表只兜底不首选（模型看得到上下文，归一更准），也不把未知类别硬压成某个枚举。
- **校验与留痕**：模型漏某 finding 的 id / 编造未知 id / 语义字段空值，逐条跳过 + stderr；组装完成的 tip 仍过一道 `agentReviewTipFromUnknown` 终检（防实现 bug）。服务端的失败反馈是**整批粒度**的，一条坏数据连累整个文件的 `reviewTips` 数组，宁可在客户端拦。
- **`filePath` 规范化**与进度事件字段白名单同源纪律：**本地绝对路径不出进程**。

**明确否决**：把这套约束推给 Phase 5 的检视模型（中文枚举污染英文测量面、Finding 冻结契约 / 六阶段骨架 / 规则 Skill 候选简报全要漂、`code` 会变成模型复述而非文件真源）——外部工具的 schema 不渗进检视内核。

### 5. 配置开关：`mcp.report.task`（布尔，缺省 `true`）

老 server 只有批量事件 tool 时，升级不该把日志变成一片红字——一行关闭的出口。缺省必须真调（否则新部署忘配就静默不报，违背零静默）。非破坏性变更（可选键 + 缺省），`version` 仍为 1。

### 6. 统一 tips：mrReviewResult 与 `reviews_tips_zh.json` 同源复用（用户决策 Q20–Q26）

动机是效率：中文生成只跑**一遍**。现状里 tips 的唯一真源是呈现引擎（`presentation.engine`）——不配引擎就完全没有这份产物，配了则与片级报文调用**中文跑两遍**。统一后：**片级统一生成调用是 tips 的唯一真源**（业务上报开启时），`mrReviewResult` 与 `reviews_tips_zh.json` 是同一份生成的两个投影。

- **硬约束（Q20）**：不改 CLI 旗标与配置键面；无 MCP / `task:false` 的 run **逐字节现状**（tips 仍走引擎）；六阶段循环、Finding 契约、审计、stdout 契约不动。
- **复用机制**：每片的语义字段按**合并键** `(file, line, title)` 登记（`source` / `ruleId` 必须片级捕获——聚合重编号后无法重推）；聚合后按同一合并键 join 回 merged findings，确定性组装 tips：`severity`（三档，ADR-0017 单源）、`level`（四档，与报文同口径）、`confidence`、`code`（重读源码行，允许空串）、`lineNum`、`id`（聚合 finding id）+ 语义四字段。`(file,line)` 去重沿用 ADR-0023。
- **只增不删（Q21）**：tips 每条从 10 键变 **12 键**（+`id`、+`level`），10 键全保留、值域兼容；引擎路径维持 10 键不动（Q20 逐字节现状）。
- **引擎角色收窄（Q22:a）**：业务开启时引擎退回 ADR-0010 本职——stdout 呈现档（title/description 翻译），新增 `skipTips` 缝跳过 suggestion 并发生成；CLI 无视引擎 tips（第三方引擎不认识该键也无害）。
- **尽力而为（Q26:b）**：部分片的生成失败 → 成功片的文件组照常进 tips、失败片的缺席（逐条 stderr 留痕）——半份文档的缺口是**生成失败**不是「没问题」，必须可见；mrReviewResult 不受影响（成功片照发）。
- **全灭回落（Q24:a）**：有 findings 但统一 tips 零覆盖 → 引擎按**全量模式**（不带 `skipTips`）调用，其 tips 作回落源并注入 `id`/`level`（12 键形状一致）；没配引擎则本次不产 tips（清陈旧）。
- **零 findings**：空 tips 文档 `[]` 照产（「没发现问题」本身是结论，与引擎路径口径一致）。

## Options（为什么不是别的）

- **把报文生成放进六阶段骨架（真 Phase 7）**：否。骨架是 ADR 把守的测量常量面（`Phase N of 6` 断言、审计、MCP `phase` 事件消费方全要漂）；且续会话生成报文要多背一整轮上下文输入，一次性小请求（findings + 源码行，几 KB）便宜得多。
- **把工具 schema 的约束推给 Phase 5 的检视模型**（category 中文枚举 / 单行 code / 相对路径直接进 Finding）：否。Finding 契约是冻结的测量常量面（英文、自由 category、P0–P3），规则 Skill 候选走同一契约，`code` 在那个时刻只能靠模型复述（真源在文件里）——外部工具的 schema 渗进检视内核，改的是最不该动的那层。
- **报文全确定性映射（不调模型）**：否。`[缺陷类型]` / `[重构思路]` / `subcategory` / category 语义归一是 LLM 的活，代码拼不出真实细分；产出「字段齐全但内容是假」的报文比失败更糟。保留为**总结调用的降级模板**（产物必须有、内容允许降级）。
- **收尾一次性发全部文件（不分片流式）**：否（用户决策）。平台要增量收结果；且收尾才发会让「投影数十秒 + 全部文件发送」都挂在最后。
- **一次调用同时出总结和报文（Q9 原案 A）**：被片级时点推翻——报文每片尽早发、总结要等全部片 + 投影，两者时点不同，只能拆成两类调用。
- **业务调用也走批量通道（入队、重试、可丢最旧）**：否。业务调用要立刻知道结果且不可丢；队列背压丢最旧对进度事件合理，对「这个文件的检视意见」是事故。
- **tips 仍走引擎、报文另调（维持 Q16 的「两条中文管线」）**：否（用户决策 Q21 推翻）。中文生成跑两遍是纯浪费；统一后「同源同译文」——`mrReviewResult` 与 `reviews_tips_zh.json` 是同一份生成的两个投影，仅结构字段口径不同（`level` 四档 vs `severity` 三档、`code` 必填 vs 允空）。
- **统一生成移进六阶段骨架（真 Phase 7 / run 内）**：否（Q23）。「六阶段内部就处理好」的实质是**时点**（每片定型即生成、后面只复用），不是字面住进 loop；续会话生成要动冻结骨架且污染英文测量转录，一次性小请求输入本来就只有几 KB。
- **部分失败时全或无（半份 tips 不落盘）**：否（Q26 用户选 b）。全或无让一个片的网络抖动毁掉全部成功片的结果；尽力而为 + 逐条留痕把缺口如实暴露。

## Consequences

- **好**：平台拿到完整任务生命周期 + 增量文件结果 + 总结报告；预检失败也有 `startTask`/`endTask` 有始有终；纯本地 run（无 `mcp` 配置 / `task: false`）零行为变化（不建连、零额外模型调用、stdout/审计/退出码不变）；业务开启的 run **中文只生成一遍**——tips 首次无需呈现引擎即可产出（`N+1` 次统一生成 + 总结，替代「N 报文 + 全量投影 + 总结」）。
- **代价**：MCP 开启的 run 每片多一次统一生成调用 + 收尾一次总结调用（呈现档）；tips 的**值形态**随路径变化（统一路径 = `[缺陷类型]` 结构 review、中文枚举 category、填实 subcategory、12 键；引擎路径 = `title。description`、英文自由 category、空 subcategory、10 键）——消费方按 `id`/`level` 在场与否即可判别；`severity` 三档与 `level` 四档并存（对账线，P3 在两边分别叫 Minor / Suggestion）；`run/` 多一个可选回调缝；引擎多一个 `skipTips` 可选缝（第三方引擎无害）。
- **测试面**：`mcp/task-tools.test.ts`（校验 / 规范化）、`mcp/report.test.ts`（业务调用单次尝试 / isError / closed）、`run/review-run.test.ts`（hook 每片触发 / 串行 / 抛错吞掉）、`shared/config`（`task` 键）、`cli/report-payload.test.ts` + `cli/review-summary.test.ts`（假网关）、`cli/unified-tips.test.ts`（12 键 / 合并键 join / 去重 / 未覆盖 / 回落对齐）、`cli/bin.process.test.ts`（MCP stub 端到端：四 tool 顺序 + tips 落盘 + `task:false` 零调用 + 尽力而为 + 全灭回落/不产）、根仓 `tests/presentation/engine-zh.test.ts`（`skipTips` 缝）。
- **与 ADR-0037 的关系**：事件上报面（schemaVersion / streamId / seq / include / findings 档位）原样不动；本 ADR 只加「业务调用」这层语义，二者共用同一 server 连接与握手。
- **与 ADR-0017 的关系**：tips 的 10 键形状与引擎路径全部保留；统一路径是 tips 的**第二生产者**（12 键、值来自统一生成），见 ADR-0017 顶部后续修订注记。
