# 0016. 运行进度投影（Run Progress Projection）：把既有留痕实时投影到 stderr，stdout 契约零改动

**状态**：已接受（2026-10-28，用户经逐项决策 Q1–Q18）
**关联**：ADR-0009（会话/事件属内核变量面）、ADR-0010（呈现投影是核外消费端，stdout 形状由呈现缝把守）、ADR-0013（转录与导出的落盘产物）、ADR-0014（skill pass 的留痕 `skillPassLog[]`）、`CONTEXT.md`（「运行进度投影」）

## Context

生产配置 F 的 `review-pi review` 在跑完之前**完全没有输出**：一次真跑要几十秒到几分钟（17 请求 / 30 工具 / 358 秒的样本见 `runs/f-demo-session-skill2`），期间终端静默。这造成两个具体问题：

1. **无法区分「在跑」与「挂死」**：skill pass 里一条 `bash` 可能跑满 120s 上界，模型长回复也可能数十秒无输出。
2. **无法现场判断卡在哪一层**：是网关慢（请求未回）、工具慢（bash 卡住）、还是阶段调度出问题？事后只能翻审计与转录。

同时有两条已核实、不可动的边界：

| 事实 | 结论 | 证据 |
|---|---|---|
| CLI `stdout` = 单个 JSON 文档（机器可读契约） | 进度**不能**写 stdout | `cli/render.ts:38`（`renderJsonDocument`）、`cli/bin.process.test.ts` 断言 `JSON.parse(stdout)` |
| 审计与转录是测量的真源（`requests[]` / `toolCallLog` / `phaseLog` / `skillPassLog`） | 进度**不能**改留痕 | 字节门/语义等价门以 `wireBody` 与 `toolCallLog[].resultSummary` 对照 |

因此本 ADR 的诉求是：**在不新增内核仪器、不改任何已冻结产物的前提下，把「已经发生并被记下的事实」实时投影给操作者**。

## Decision

### 1. 形态 = 投影，不是新仪器

内核只新增一个可选的**事件出口** `RunProgressSink`（`contracts/progress.ts`），由既有留痕的写入点就地发射：

| 事件 | 发射点 | 取材的既有留痕 |
|---|---|---|
| `phase` | `phaseLog.push` 之前的推进点（`advancePhase` / 初始 `prompt` 之前） | `round` / `phaseNameOf(index)` / `PHASE_COUNT` |
| `request` start | `onPayload`（请求真正发出时） | —（序号由发射点按作用域自增） |
| `request` end | `shouldStopAfterTurn` 的 `addUsage` 同一处 | 该回合 `usage`（`piUsageToLlmUsage`） |
| `tool` start/end | `tools/tool-progress.ts` 包装层（主会话与 skill 会话共用） | start 只带工具名；end 带入参摘要与结果文本尺寸（`resultChars` / `resultLines`） |
| `skill` start/end | `runRoundSkillPasses` 的 `await runSkillPass(...)` 两侧 | `RuleSkillPassRecord`（status / requestCount / toolCallCount / degradedReason） |

`onProgress` 缺省不注入 ⇒ 内核行为与投影缝落地前**逐字节一致**（空函数 sink，三处共用同一个 `NO_OP_PROGRESS_SINK`）。

`request` 的「序号 + 计时」收在 `loop/request-progress.ts` 一处（`createRequestProgress`），主会话 / 零工具路径 / skill 会话各自一个实例——既避免三份 `Date.now()` 差值，也天然给出「每个 `Agent` 会话从 1 开始」的作用域语义。

### 2. 三条硬约束（不可协商）

1. **只写 `stderr`**：`stdout` 仍是单个 JSON 文档，键集不变（`ok/caseId/configId/runId/truncated/rounds/toolCalls/findings/auditPath`）。
2. **不改任何冻结产物**：wire 字节、审计键集（含 `requests[] / toolCallLog / phaseLog / skillPassLog`）、`RunRecord`、转录 `{info, messages, view}`、退出码契约（成功含诚实截断 = 0，其余中止或错误 = 1）全部零改动。测试断言 `JSON.stringify(record)` 与审计文件均不含 `"progress"`。
3. **脱敏是单点**：入参摘要截断 **80 字符（省略号计入总长）**（`summarizeToolArguments` / `clampLine`），失败摘要只取首行并剥掉 `Error: ` 前缀、截断 120 字符（`summarizeDetailLine`）；**工具结果全文永不进 `stderr`**，只报 `resultChars` / `resultLines`。呈现层没有任何路径能拿到 `resultSummary`。
4. **关闭即零成本**：缺省 sink 是同一个 `NO_OP_PROGRESS_SINK` 常量，工具包装层见到它就原样返回工具对象——连「结果文本长度」都不统计（不是「照算完再丢弃」）。

> 唯一新增的量是 `durationMs`（请求/工具/skill 的墙钟耗时）：由发射点用 `Date.now()` 差值算出，**只进显示、不落盘、不进指标**——与 ADR-0013 决策 10 拒绝的「逐消息耗时仪器」不同（那会把时钟写进产物）。它不是测量面的一部分，删掉它不会让任何审计/指标字段变化。

### 3. 事件只有 4 类，显示行有 6 种（另加状态行与表头）

内核事件 = `phase` / `request` / `tool` / `skill`。显示的**追加行**有 6 种：阶段推进、请求完成、工具完成、skill 开始、skill 结束、收尾摘要（done）。另外两行由 CLI 侧产生，**不是内核事件**：

- **状态行**（`\r` 原位重画，仅 TTY）：`… req <n> <elapsed>s · phase <k>/<total> · round <r> · tools <m> · skill <name>`——字段按有无出现，空集时整行不画；**请求一落地就撤下 `req` 字段**（否则等工具的时间会被误读成「网关慢」）；
- **一次性表头**（`review-pi: <config> · <caseId> · <model> · progress on`）：开跑时写一次，用来给日志里的这一 run 定身份。

**收尾摘要（done 行）**：CLI 汇总自身计数 + `record.baseline.usage` + `calculateCost(...)` 产出 `✓ done · req N · tools N · bash M · <duration>s · cache <hit>% · $<cost>`；`bash` 段只在真跑过 bash 时出现，`tools` 只数 review 工具（= `record.baseline.toolCalls` 口径，见决策 8）。

这样分层的理由：状态行的刷新节奏与「一行写多宽」是终端关注点（不同终端/日志系统要求不同），不应逼内核知道「TTY」「1 秒」这些词。

### 4. 刷新形态 = 混合（状态行 `\r` 重画 + 事件行追加）

- **事件行永远追加**：一行一件事，日志重定向后可直接 `grep`，不含 `\r`；
- **状态行只在 TTY 绘制**：`\r` 原位重画，用空格补白（不用 ANSI 清行——老 ConHost / 重定向管道都安全）；任何事件行开写前先擦状态行；
- **收尾与异常都擦状态行**：`finish` 先擦再写 done 行；`runReview` 抛错时 `dispose()` 只擦不写摘要——残影会把错误消息顶成半行。

### 5. 开关：TTY 自动，旗标显式覆盖

- 缺省：`process.stderr.isTTY === true` 才开（人手敲看得见，重定向收日志时闭嘴）；
- `--progress` 强开、`--no-progress` 强关；两者同给 = 用法错误（fail fast，不静默取其一），重复给同旗标同样是用法错误；`smoke` / `disposition` 面不认这两个旗标。

### 6. 序号口径：「步数」= 模型请求序号，不做百分比

不发明分母（一次 run 的请求数事前不可知，轮次还可能因 `complete:false` 重开）。因此：

- `request.requestId` **按作用域自增**：主会话全局递增，skill 会话按该会话自增（独立 `Agent`，第 1 次请求就是 1）；呈现层给**会话内**的请求/工具行加 `[skill:<name>]` 前缀分栏（起止行本身已点名 skill，不再重复加前缀），收尾才报 `N req` 汇总；
- `phase.index` 是 1-based 阶段序号（1..`total`），与 `phaseLog` 的写入顺序一致；
- **阶段只在开始发一次事件**：结束不单独成行（`phaseLog` 也是阶段结束时才落一条记录，成对发射会让显示行数翻倍而无新信息）。

### 7. 失败判据单点沿用既有约定

工具返回文本以 `Error: ` 开头即失败（预算耗尽 `Error: tool call budget exhausted`、`review.get_file` 不可读、`skill-bash` 白名单拒绝皆走这条）；抛出的异常同样算失败并原样上抛（投影不吞异常）。判据只写在 `tool-progress.ts` 一处，主会话与 skill 会话共用，避免同一行进度在两个会话里写出两种结论。

### 8. 计数与成本口径

- **request / tool 计数**：呈现层自行累计（`request` start 计一次；`tool` end 按名字分 `review` / `bash` 两栏，仅用于显示）；
- **token**：`record.baseline.usage`（与审计同源，已含 skill 会话折算）；
- **成本**：`calculateCost(reviewModelOf(modelId, baseUrl), llmUsageToPiUsage(usage))`——与转录同一份模型画像、同一个公式，不另立汇率；
- 指标口径 `toolCalls` **不含** skill 的 `bash` 调用（ADR-0014 既有口径），skill 会话留痕的 `toolCallCount` 也只数七检视工具；因此 done 行的 `tools` 只报 review 工具（与 `record.baseline.toolCalls` 同口径），bash 用独立段 `· bash M` 单列——两个数各归各的口径，不合成一个无法对账的合计。

### 9. 文案形态（草案 A：英文紧凑）

事件行与 done 行用英文紧凑形态，阶段名沿用 `PHASE_ORDER` 的英文原文：

- 阶段：`▶ phase 1/6 Change Understanding (round 1)`
- 请求：`  req 1 8.1s · in 700 (cache 2,048, 74.5%) · out 678`
- 工具：`  tool review.get_diff ok 3.1s · path=src/a.ts · 1,204 chars / 40 lines`
- skill 内层：`  [skill:sample-rule] tool bash ok 0.0s · command=echo hi · 12 chars / 1 lines`
- 收尾：`✓ done · req 17 · tools 18 · bash 12 · 358.2s · cache 48.0% · $0.0312`

**这是一笔显式记录的双语债**：

- 阶段名、工具名、状态词（`ok` / `FAIL`）与 JSON 键同属英文技术面，翻译只会制造「两个名字指一件事」；
- 但「进度」是给人看的面，说明性文案（`review-pi: <config> · <case> · <model> · progress on`、失败/降级的 `detail`）仍是中文或模型原文——**中英混排是当前形态，不是疏忽**。要收口需先立一条「CLI 人读面语言」决策（与 ADR-0010 的呈现投影同族但不同面），本 ADR 不擅自扩权。

## Options（为什么不是别的）

- **进度写 `stdout`**：直接破 `stdout` 单 JSON 文档契约，任何机器消费方（含现有进程烟测与生产调用）立刻坏掉。否。
- **把进度做成审计字段（`progressLog[]`）**：会给测量真源加一份只为人看的键，字节门/语义等价门的对照面被迫扩大；进度是**消费端关注点**，不该进内核留痕。否。
- **引第三方进度库（ora / cli-progress 等）**：它们的默认行为是 ANSI 清行 + spinner 帧，非 TTY 时还要额外降级；本仓只需要「一行状态 + 追加事件」，自带 40 行实现即可，且能在测试里逐字节断言。否。
- **`async_hooks` / `Agent.subscribe` 采更细的事件时序**：那才是「新仪器」，且 ADR-0013 决策 10 与 ADR-0015 已明确不采逐消息耗时。否。
- **百分比进度（`xx%`）**：分母不可知（轮次可重开、工具回合数由模型决定），任何百分比都是编的。否——用「请求序号 + 阶段序号」代替。
- **非 TTY 也默认开**：批跑把 `stderr` 收进日志时，每次 run 多出数十行噪声；且结构化日志消费方会把它们当错误线索。否（需要时显式 `--progress`）。

## Consequences

- **好**：执行期可见「第几阶段 / 第几次请求 / 哪只工具 / 哪个 skill 在跑」；卡住时能一眼区分网关慢、工具慢与调度问题；`stdout` 与全部落盘产物零改动，测量面不受污染；开关与 TTY 判定让「人看」与「机器收」各得其所。
- **坏 / 需要显式认识的刻意偏离**：
  - **中英混排**见决策 9：这是登记的双语债，不是遗漏。
  - **显示行不是审计真源**：done 行的 `req` / `tools` / `bash` 数是呈现层累计值（`tools` 与 `record.baseline.toolCalls` 同口径，但它仍是自累计而非读记录）；对账必须回到记录与审计。
  - **skill 会话的请求序号会「回到 1」**：这是作用域语义（独立 `Agent`），呈现层靠 `[skill:<name>]` 前缀消歧；若将来要多 skill 并行，需要重新设计分栏（当前是 CLI 顺序执行）。
  - **状态行是尽力而为**：极窄终端下会被折行（不查询 `terminal width`），不做宽度感知；重定向时按设计不出状态行。
  - **阶段事件在 `await agent.prompt(...)` 之前发射**：放在 `await` 之后会晚一整阶段——这是「事件表示开始」的必然要求，也是与 `phaseLog`（记录阶段结束）顺序不同的一处刻意差异。
- **测试面**：`run/progress.test.ts`（事件序列、usage 对账、失败 detail、零工具路径、skill 内 bash 不进指标 `toolCalls`、产物无 `progress` 键）、`cli/progress-render.test.ts`（非 TTY 无 `\r`、TTY 擦行、done 行分栏、缓存率单一分母）、`tools/tool-arguments.test.ts` + `tools/tool-progress.test.ts`（80/120 截断口径、失败判据、关闭时零包装）、`cli/args.test.ts`（旗标三态、互斥/重复、smoke 与 disposition 不认）、`cli/bin.process.test.ts`（进程面：`--progress` 下 stdout 键集不变、缺省与 `--no-progress` 静默、冲突用法错误）。

跨仓限定语纪律：本 ADR 为本仓 pi 线序号 0016；引用 DSH 兄弟仓决策须写全限定语「DSH 线 ADR-XXXX」。
