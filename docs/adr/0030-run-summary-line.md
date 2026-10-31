# 0030. 收尾总结行：恒定打印 + 中文人读口径（耗时 / token 三段 / 模型调用 / 工具分列 / Ledger 命中）

**状态**：已接受（2026-10-31）
**关联**：ADR-0016（运行进度投影；本 ADR 修订其收尾摘要段——决策 5 / 8 / 9）、ADR-0014（`skillPassLog[]` 是 skill 会话的唯一计数源）、ADR-0010（呈现投影是核外消费端，会另发模型请求）
**跨仓**：本 ADR 为本仓 pi 线序列 0030；DSH 兄弟仓决策须引用全限定语「DSH 线 ADR-XXXX」。

## Context

实际使用里最常见的命令**不带 `--progress`**：

```bash
review-pi review --repo <dir> --mr-diff <diff> --out <dir>
```

按 ADR-0016 的缺省语义（`stderr` 非 TTY 即关），这条命令跑完 stderr 什么都不说：花了多少钱、用了多少 token、调了几次模型、工具跑了几次、Ledger 省了多少重复读取——全部只能事后翻 `rep-1.json` 与审计文件。

而 ADR-0016 的 done 行本身也只服务「看得见进度」的场合，且字段是早期的四段口径：

```text
✓ done · req 17 · tools 18 · bash 12 · 358.2s · cache 48.0% · $0.0312
```

- **token 不拆段**：只有缓存命中率，看不出输入 / 输出各多少；
- **工具不含 skill**：`tools` 只数 review 工具，规则 Skill 会话的调用单列为 `bash`（且指标口径 ADR-0014 本就不含 bash）；
- **Ledger 去重不可见**：Context Ledger 的职责就是「重复读取返回引用、不把原文再读一遍」，但这个效果从来没有露出来过；
- **模型调用数靠 `req` 报**，与「工具 / token」不在同一句语义里。

因此本 ADR 的诉求是：**每个 run 结束都恒定报一行账**，字段按运营对账的实际需要定。

## Decision

### 1. 恒定打印，与 `--progress` 解耦

`runReview` 返回后立刻向 `stderr` 写这一行。开关语义随之收窄：

| 旗标 / 形态 | 事件行 + 状态行 | 收尾总结行 |
|---|---|---|
| `--progress` | 打 | 打 |
| `--no-progress` | 不打 | **打** |
| 缺省（TTY） | 打 | 打 |
| 缺省（非 TTY） | 不打 | **打** |

`--no-progress` 从此只表示「不要逐条事件流」，不再表示「零输出」。要彻底静音由调用方在管道侧丢弃 `stderr`。

### 2. 打印点在呈现投影之前

呈现投影（ADR-0010）会**另发模型请求**，那部分 token 与耗时**不进** `record.baseline.usage` / 主会话计时。若把总结行放在投影之后：

- 「耗时」含投影（数十秒），「token」不含投影 —— 两个数在同一行里对不上账。

所以顺序固定为：`runReview` 返回 → **总结行** → （可选）投影 → stdout。上一行还能顺带充当投影开始前的完成信号，避免「检视完成 → 长静默」被误读为挂死。

### 3. 字段与口径（单一定义，全在 `cli/progress-render.ts` 的 `doneLine`）

| 段 | 口径 | 数据来源 |
|---|---|---|
| 耗时 | 检视本体墙钟（不含投影） | CLI 自身 `startedAt` 差值 |
| token 输入 | **未命中**输入（已减缓读/缓写） | `record.baseline.usage.inputTokens` |
| token 输出 | 含思考 token | `usage.outputTokens` |
| 缓存命中 | `cacheReadTokens` + 命中率 | `usage.cacheReadTokens`（命中率分母 = 未命中输入 + 缓读 + 缓写） |
| 模型调用 | 主会话请求 + 规则 Skill 请求 | `runReview` 返回的 `modelCalls` = `audit.requests.length + Σ skillPassLog[].requestCount` |
| 工具调用 | 主会话 + 规则 Skill 的检视工具（含 skill 内调用；指标口径，ADR-0014 **不含** `bash`） | `record.baseline.toolCalls` |
| 主会话工具 | 总数 − Σ skill 会话工具 | 由上两行相减（`skillPassLog[].toolCallCount` 是 skill 的逐项记账） |
| skill bash | 规则 Skill 会话内 `bash` 实际执行次数（>0 才单列） | `runReview` 返回的 `skillBashCalls` |
| Ledger 命中 | `Already loaded: ctx#NNN` 返回的次数 | `runReview` 返回的 `ledgerHitCount`（主 toolkit + 各 skill 分叉账本合计） |
| 成本 | `calculateCost(同一模型画像, llmUsageToPiUsage(usage))` | 与转录同一公式，不另立汇率 |

形态：

```text
✓ 完成 · 耗时 358.2s · 模型调用 17 次 · token 输入 179,527（未命中） · 输出 20,854 · 缓存命中 165,888（48.0%） · 工具 30 次（主会话 18 + 规则 Skill 12） · skill bash 5 次 · Ledger 命中 4 次（未重复读取原文） · $0.0312
```

`skill bash 5 次` 段只在规则 Skill 真跑过 `bash` 时出现（它是独立工具、独立安全边界；指标 `toolCalls` 按 ADR-0014 不含它，所以单列而不是并入合计数）。

### 4. 「命中」= Context Ledger 命中，不是 prompt cache

两个概念在同一行里各占一段，语义不混：

- **Ledger 命中**：同一规范化读取请求再次出现时，工具结果层返回引用而非原文——**原文没有第二次进上下文**。这是去重，不是省钱；观测值进 `ContextLedger.hitCount()`，**不进审计字节**（审计 `ledger[]` 仍只记登记条目）。
- **缓存命中**：provider 侧的前缀缓存（`cacheReadTokens`），是**成本**口径，与「有没有重复读原文」无关——重复读取即使命中缓存，上下文里照样多一份全文。

### 5. 语言：总结行中文，事件行保持英文紧凑

ADR-0016 决策 9 把「英文事件行 + 中文说明文案」登记为一笔双语债，并声明要收口需先立决策。本 ADR 收口**收尾这一行**：

- 事件行（`▶ phase 1/6 …` / `req 1 8.1s · in …` / `tool review.get_diff ok …`）继续英文紧凑形态——阶段名、工具名、`ok`/`FAIL` 都是技术标识，翻译只会制造两个名字指一件事；
- 总结行是**整句人读结论**，中文更贴合使用手册与运营对账的口语；数字与百分比保持千分位/一位小数，便于逐次比对。

### 6. 计数不进审计

`ledgerHitCount` / `modelCalls` 只经 `runReview` 返回值 → CLI 呈现层，**不写审计、不写 RunRecord、不改 wire 字节**；`ContextLedger.hitCount()` 是 run 私有观测，重放审计不会得到这个数。这与 ADR-0016 决策 8「显示行不是审计真源」同族：对账仍回到记录与审计。

## Options（为什么不是别的）

- **仍绑在 `--progress` 里**：用户最常见的命令不带这个旗标，等于没有——诉求本身就是「跑完说一句」。否。
- **放在呈现投影之后**：耗时/token 口径错位（见决策 2）。否。
- **写 `stdout`**：破单 JSON 文档契约（ADR-0016 硬约束 1）。否。
- **把 prompt cache 命中当作「命中」报**：那是成本概念，不能回答「有没有重复读原文」（见决策 4）。否——两段都报。
- **把 Ledger 命中写进审计，做成可重放的测量量**：会给测量真源加一份只为人看的观测键，字节门/语义等价门对照面被迫扩大；且它是 run 私有状态，重放无意义。否。
- **英文 done 行只加字段**：字段能加，但「整句报文用哪种语言」正是 ADR-0016 留给后续决策的口子；既然要改这一行，顺手按人读面收口。否。

## Consequences

- **好**：一次 run 的成本/工作量不必翻文件；规则 Skill 的真实开销第一次与主会话并列展示；Ledger 去重效果可观察（能直接看出「省了几次全文重读」）；投影前有一行明确的完成信号。
- **坏 / 需要显式认识的刻意偏离**：
  - **非 TTY 批跑 stderr 多一行**：日志消费方要按「一行固定前缀 `✓ 完成 ·`」筛掉；`--no-progress` 不再等于零输出，要静音只能在管道侧丢弃 stderr。
  - **主/次工具分列依赖 `skillPassLog` 记账**：skill 会话失败时，已发生的调用仍计入总数与 skill 侧（`toolCallCount` 在失败路径也填），所以相减不会为负；若将来出现「工具调用不记 `skillPassLog`」的路径，这一行要跟着改判据。
  - **`hitCount` 不继承种子**：分叉账本从 0 起计数，skill 会话命中只算本会话的重复读取（种子条目命中仍会 +1——那是「本会话没有重读主会话已读的原文」，正符合语义）。
  - **成本永远按当前模型画像算**：换配置回放旧 run 不会得到旧成本（与 ADR-0016 决策 8 同既有行为）。
- **测试面**：`cli/progress-render.test.ts`（`doneLine` 全文逐字、缓存率单一分母）、`tools/toolkit.test.ts`（`hitCount` 累加 / 惰性态恒 0 / 分叉不继承种子）、`cli/bin.process.test.ts`（`--progress` 下总结行形状；缺省与 `--no-progress` 事件行静默但总结行仍在）。
