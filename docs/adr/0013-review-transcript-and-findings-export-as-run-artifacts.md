# 0013. 检视转录与检视意见导出为落盘产物

**状态**：已接受（2026-10-26，用户经 grill-with-docs 五轮逐项决策 Q1–Q9 + 阶段划分）；**部分被 [ADR-0014](0014-rule-skill-review-pass-after-candidates-phase.md) 扩展（2026-10-27）**——决策 1 的文件名契约新增 `-skill-<name>-r<round>` 后缀族（config F 的每个 skill 会话各落一份独立转录，主转录契约不变）
**关联**：ADR-0009（「Agent 状态与事件模型／会话·审计投影」属内核变量面）、ADR-0010（检视输出恒英文 + 核外翻译投影——本 ADR **只引用、不改写** 它）、CONTEXT.md（「检视转录」「检视意见导出」）、`.scratch/transcript-reviews-export/spec.md`

## Context

- 今天一次 run 只落两件：**审计** `audit/.../rep-<N>/audit/<runId>.json`（全量、含 `requests[].wireBody` 可重放字节与 `toolCallLog`，但工具记录**无时间戳**）与**运行记录** `runs/.../<configId>/rep-<N>.json`（指标 + `auditPath` 指针）。
- 完整转录其实**已在内存**：C/D/E/F 走内核 `Agent` 类，`agent.state.messages` 就是 pi-ai `Message[]`（user／assistant{`thinking`,`text`,`toolCall`,`usage`,`responseId`,`stopReason`}／toolResult{`content`,`details`,`isError`}）；但 `AgentReviewLoopOutcome`（`packages/review-pi/src/loop/agent-review-loop.ts:76-84`）只回摘要，转录**从未被返回或落盘**。核外与核内都搜不到任何 `session`/`transcript` 落盘（pi 内核自带的 `Session` 子系统 `packages/agent/src/harness/session/**` 未被 review-pi 使用）。
- 需求：把「**进入 pi Agent 的全部交互**」留档，格式参考 OpenCode 的 `{ info, messages }` 会话导出；并在 run 结束产出可对外消费的检视意见文件。
- 由此产生两个张力：**(a)** 落一份**中文**文件与 ADR-0010「检视输出恒英文、语言只是呈现配置」的关系；**(b)** 转录与审计 `wireBody` 大面积重叠，有造「第二份真源」的风险。

## Decision

1. **新增两个产物族**：
   - **检视转录** `session-<首次模型调用时刻紧凑>-<configId>-<caseId>.json`，与 `rep-<N>.json` **平铺**在同一目录（`<runsRoot>/<experimentId>/runs/<source>/<caseId>/<configId>/`）。**每次 run 独立留档、不覆盖**。
   - **检视意见导出** `reviews_en.json` + `reviews_zh.json`，落在 `.../<configId>/rep-<N>/`（与审计树同名 `rep-<N>` 目录约定呼应）。**按 rep 覆盖重写**。
2. **转录源 = 进入 Agent 的全部交互**：`agent.state.messages` **原样**（不截断、不改字段名），并在 `messages[0]` **合成一条 `role:"system"`** 承载 Zone A 系统提示词（它不在 `state.messages` 里，而在 `state.systemPrompt`）。
3. **文件骨架三分 `{ info, messages, view }`**：`messages` 是**省键真源**（逐字对应 pi 原生结构）；`view` 是 **OpenCode 风格定形投影**（`null` 占位保证形状固定：工具调用与结果**合并**为 `tool` part、同批 toolCall 拆多个 part、`isError → state.status:"error"`、无结果 → `"pending"` + `content:null`）。`info` 为两份表示共用，只出现一次。
4. **命名时间 = `firstRequestAt`**（loop **首次模型请求**时刻），**不是** `runReview` 入口的 `startedAt`（后者早于取仓库上下文／装载规则 skill／建工具集）。`info.id` = 文件名 stem；**`info.runId` = 审计 `runId`**（本仓扩展键，作为与审计／`rep-N.json` 的**配对键**）。
5. **usage 口径：原生保留 pi-ai `Usage` 全量**（含 `cost`、`reasoning`、`cacheWrite1h`）；`view` 映成 OpenCode 的 `tokens{input,output,reasoning,cache{read,write}}` + `cost{...}`；`info.tokens`/`info.cost` 由**逐条 assistant 求和**得出。**有意与审计／运行记录的内核口径 `LlmUsage`（无 cost、无 reasoning）不同**。
6. **分工线**：`view` 投影与**三份落盘**（session / `reviews_en` / 落盘路径布局）**全部在内核**（「会话投影」本是内核变量面，ADR-0009）；**只有 `reviews_zh.json` 在核外**（CLI 在投影成功后写；根侧 runner 无投影缝，**不产 zh**）。
7. **失败语义（有意不对称）**：en／session **写失败抛错**（产物即契约）；zh **「应产而写失败」抛错**；但**引擎未配置**或**投影降级** ⇒ zh **缺席且不算失败**（run 照常 exit 0，stderr 一行原因）——与 ADR-0010 的呈现降级纪律一致。**不产 zh 时主动删除同目录已存在的陈旧 `reviews_zh.json`**。
8. **覆盖面**：转录仅 **C/D/E/F**（A/B 走非 Agent 的 `review-loop`，无完整转录——其等价信息即 `requests[].messages`，不另造）；`reviews_*` **全配置**（A/B 有 `reviews_en.json`、无 session 文件）。
9. **不加产物版本键**（`kind`/`version` 一律不做），向既有产物（审计／`rep-N.json` 均无版本键）看齐；JSON 纪律沿用 2 空格缩进 + 尾换行；findings **保序不排序**。
10. **不新增耗时仪器**：不记录 `tool.time{created,ran,completed}` 一类逐工具耗时（`view` 里按第 3 条 `null` 占位）；transcript 只带全局 `time{created: firstRequestAt, completed: finishedAt}`。

## Options（为什么不是别的）

- **只复用审计 `requests[].wireBody` 当转录**：省一次投影，但它 (a) 是**每请求重复的发送面**、不是交互面（丢 `thinking` 与工具结果语义）；(b) 会造第二份真源、且无法表达「Agent 侧」的 toolResult/`isError`。
- **转录只写 `view`（OpenCode 单表示）**：可读性最好，但 `view` 是**不可逆投影**（工具合并后 callId 与同批归属需回推），一旦要取证就再无可对账的真源。故采「原生 + view 双写」。
- **让核外（CLI／runner）组装 `view` 并落盘**：两个消费端会各写一份路径布局与投影实现；且「会话投影」按 ADR-0009 归内核变量面。
- **把 `reviews_zh.json` 也交给内核**：内核禁依赖核外引擎与密钥（ADR-0010 边界），不可行。
- **不产 zh 时保留旧 zh**：下游会读到**上一次**的中文，与本次英文记录不一致——静默的错误比缺席更糟。
- **给产物加 `version` 键**：既有产物（审计、`rep-N.json`、`plan.json`…）都没有版本键，一致性优先；演进靠字段名。
- **命名沿用 `runId`（`startedAt` 版）**：与审计文件名天然同名。但需求明确要「**Agent 启动 = 第一次调用模型开始**」，故命名用 `firstRequestAt`、另以 `info.runId` 补配对键。
- **顺手加逐工具耗时**：那是**内核行为面**（ADR-0009 的内核变量面）的新仪器，须单独立项过门，不能搭这次的车。

## Consequences

- **正**：转录（Agent 侧现场）与审计（发送侧字节）**分工明确、互为对照**；`view` 让这份产物能与你手上的 OpenCode 会话导出**并排阅读**；命名与配对键让「session ↔ reviews ↔ 审计 ↔ `rep-N.json`」四者可机械对账；`reviews_*` 给外部消费一条稳定入口。
- **负 / 需要显式认识的刻意偏离**（防止后人「修复」）：
  - **转录文件里会有 Zone A 系统提示词全文、宿主绝对路径、`.review-rules/<name>/SKILL.md` 伪路径、工具结果的仓库文件正文**——这是**有意**的「完整现场」，不是泄漏事故；`runs/**` 已在 `.gitignore` 内（唯一例外 `runs/**/REPORT.md`）。**不要**顺手加脱敏或截断。
  - **`session-*.json` 的 token / cost 与审计、`rep-N.json` 的 `usage` 数字不会逐字相等**（第 5 条口径不同）；要指标请读运行记录，要现场才读转录。
  - **同名 zh 的缺席是正常状态**（未配引擎／降级）；下游必须把「文件不存在」当合法结果，不得当错误。
  - **重跑不会覆盖 session**（文件名含 `firstRequestAt`），`rep-<N>/` 却会被覆盖——于是同一 `rep-<N>/` 目录里的 `reviews_*` 只代表**最近一次** run，而 session 文件会累积多份；需要「哪次 run 对应哪些 reviews」时以 `info.runId` ↔ `reviews_*.runId` 配对。
- **中性**：本次不触碰请求字节（测量常量面零漂移），不进字节门／语义等价门／上线门；`firstRequestAt` 是 loop 内新增的**一个时间点**（非耗时仪器），须以「审计与 `RunRecord` 形状零漂移」断言把守。

跨仓限定语纪律：本 ADR 为本仓 pi 线序列 0013；引用 DSH 兄弟仓决策须写全限定语「DSH 线 ADR-XXXX」。
