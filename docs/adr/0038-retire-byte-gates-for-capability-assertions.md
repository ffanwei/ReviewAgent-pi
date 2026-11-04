# 0038. 退役字节门：从「对照外部真源」改为「自证行为与形状」

**状态**：已接受（2026-11-04，用户决策；同日随测试改造落地）
**关联**：ADR-0009（pi 内核从 0 重写，P2 以 A/B 请求字节对照为验收入口）、ADR-0010（英文输出与 golden bytes 冻结）、ADR-0014（N=0 时 F 与 E 逐字节相同）、ADR-0016（进度投影不改 wire 字节）、ADR-0024（废止 A–E 矩阵与评测仪器层，已删除 `bytegate/**`）、ADR-0035（单包发行、内核走 npm 依赖）
**局部修订**：ADR-0009 的「A/B 请求体对照 DSH 审计真源逐字节一致」、ADR-0010 的「golden bytes 冻结」、ADR-0014 的「N=0 逐字节相同」三处**把守手段**；这些 ADR 的决策本身（从 0 重写、英文输出、skill 会话形态）不变。
**跨仓**：本 ADR 为本仓 pi 线序列 0038；引用 DSH 兄弟仓决策须写全限定语「DSH 线 ADR-XXXX」。

## Context

自 ADR-0009 起，本仓用一组**逐字节相等**的测试把产物钉到 DSH 线的历史审计记录上（`packages/review-pi/testdata/golden/`）：

| 把守面 | 测试 | 对照真源 |
|---|---|---|
| Zone A 系统提示 | `zonea/system-prompt.test.ts` | `system-prompt.txt` |
| 六阶段指令 | `loop/phases.test.ts` | `phase-1..6.txt` |
| MR 初始消息 | `loop/messages.test.ts` | `mr-message-vul4j-1.txt` |
| 七工具 schema（点分名） | `tools/registry.test.ts` | `review-tools-dsh.json` |
| 七工具 schema（wire 名） | `tools/registry.test.ts` | `review-tools-wire-dsh.json` |

这套纪律在「跨内核对齐」时期是必要的：请求字节是可比性的地基，ADR-0009 的 P2 验收、ADR-0010 的 S 级结论有效域、ADR-0014 的消融基线都依赖它。

现在两个前提变了：

1. **评测仪器层已废止**（ADR-0024）。A–E 矩阵、`configId` 身份维度、`bytegate/**` 与跨内核复跑都不再存在；`runs/**` 自 ADR-0033 起不入库。跨内核逐字节对照已没有消费方。
2. **阶段内容需要可演进**。正在设计的 MCP 上报与「六阶段可自定义 / 自进化」都以「阶段指令可以换」为前提；只要 `phase-1..6.txt` 还要求逐字节相等，任何阶段改造都会先撞一次门。

也就是说：这道门保护的主张已经不再被使用，而它拦的东西正是下一步要改的。

## Decision

### 1. 退役的是「对照外部真源」这一类，不是所有逐字节断言

按性质分三类，只退役 A 类：

| 类 | 定义 | 处置 |
|---|---|---|
| **A. 外部真源对照** | 断言「本仓产物 === DSH 历史记录的字节」 | **退役**（本 ADR） |
| **B. 自洽 / 协议契约** | 断言「本仓产物与自身形状、编解码往返一致」 | 保留 |
| **C. 产品承诺** | 断言「同一内容的两份副本必须相同」 | 保留 |

C 类的例子（**不动**）：cwd `review-result.json` 与 runs 里的真源同字节（ADR-0027/0036）、`PiAgent.example.jsonc` 与 `config init` 模板同源（ADR-0025/0026）、`export --path` 是复制而非重写。这些逐字节相等是功能语义，删掉就是漏 bug。

B 类的例子（**不动**）：`parametersJson` 的 canonical 键序与再序列化往返、点分名↔下划线名双向往返、请求序列的 append-only 前缀（缓存语义）、审计顶层键序（下游解析契约）。

### 2. 删除的测试与黄金文件

| 删除 | 内容 |
|---|---|
| 测试断言 | `system-prompt.test.ts` 的逐字节比对（文件保留，改写为装配性质）、`phases.test.ts` 的六条比对、`messages.test.ts` 的 MR 消息比对、`registry.test.ts` 的全部 DSH 对照 |
| 黄金文件 | `system-prompt.txt`、`phase-1..6.txt`、`mr-message-vul4j-1.txt`、`review-tools-dsh.json`、`review-tools-wire-dsh.json`（共 10 个文件） |

`testdata/golden/` 保留 `vul4j-1.diff` 与 `reply-1..5-vul4j-1.txt`——它们是**输入语料**（fake 模型脚本与 diff 分析样本），不是期望输出。目录 README 同步改写并写明「不要再往里加期望值」。

### 3. 替代断言：只保留独立性质，不写同义反复

| 原断言 | 替代 |
|---|---|
| 六条指令逐字节 | 恰好 6 条；命名序一一对应；每条以 `Phase N of 6 - <name>.` 起头；每条要求单 JSON 对象回复 |
| 系统提示逐字节 | 非空；首尾无游离空白；点名六阶段（提示词与阶段机不能各说各话） |
| 七工具 schema 逐字节 | 恰好 7 个；名字唯一且与 `REVIEW_TOOL_ORDER` 同序；`type === "object"`；`required ⊆ properties`；canonical 键序与序列化往返 |
| MR 消息逐字节 | 三段骨架（标题 / Case ID / diff 围栏）与空白语义（空 issue 回落 `(none)`、原文不 trim） |

**纪律**：替代断言必须能独立判断对错。`expect(X).toEqual(X)` 这类同义反复比没有测试更糟——它会让覆盖率报告说谎。

「检视能力」本身由既有端到端测试承载：`review-run.test.ts` 的离线全链（`fakeFetch` + 六阶段语料 → findings / 审计 / 产物）、`bin.process.test.ts` 的真进程测试（退出码 / 产物布局 / 秘密不回显）。这些不依赖任何对照真源。

### 4. 淘汰的是把守手段，不是历史结论

ADR-0009 / 0010 / 0014 里「曾经与 DSH 线逐字节一致」是**历史事实**，在 2026-11-04 之前成立且已记录。退役后的口径是：

- 该一致性**不再由测试机器验证**，也不能作为未来版本的持续主张；
- 引用这些结论时必须带时间限定（「2026-11-04 之前」），不得表述为「当前仍逐字节一致」。

## Options（为什么不是别的）

- **A. 全删所有逐字节断言（含 B / C 类）**：会把「cwd 副本与真源相同」「example 与模板同源」这类功能语义一起删掉，属于把测量纪律的账算到产品头上。否。
- **B. 只冻结 builtin profile，自定义 profile 只校验形状**：这是阶段可演进的正解方向，但它要求先落 `PhaseProfile` 抽象；在抽象落地前，旧门仍然挡路。可以作为本 ADR 的后续演进（ADR-0037 的扩展缝一节已给出形状），不作为本次替代。推迟。
- **C. 保留黄金文件但改成「变更需显式更新」的软门（skip + 警告）**：本仓测试是硬门文化，警告型断言最终无人看；且它仍要求每次改阶段都动一次黄金文件，没有解决「阶段要能自进化」。否。
- **D. 什么都不删，只承诺「新能力不加新字节门」**：旧门仍在，六阶段自定义仍然做不到。否。

## Consequences

- **正**：
  - 系统提示、阶段指令、MR 消息、七工具 schema 的内容可以演进，不再需要先同步一份历史快照；
  - 新增的 MCP 上报（ADR-0037）与阶段 profile 改造不必再为「不破字节门」设计绕行；
  - 测试里不再有「改了黄金文件就算通过」的隐性放行路径——现在改内容就是改内容，没有伴随的假绿灯。
- **负 / 风险**：
  - **文案漂移无人拦**：删一个词、改一句输出契约，测试仍绿。防线只剩 code review 与版本号；
  - **跨内核可比性主张失效**：与 DSH 兄弟仓的 S 级对照不能再复跑，历史报告的有效域被时间截断；
  - **替代断言可能退化为同义反复**：这是本 ADR 最需要防守的一点，已写成纪律（决策 3）；
  - `testdata/golden/` 的性质从「真源」变成「语料」，后来者若仍按旧 README 理解会误用——README 已重写。
- **中性**：
  - **零运行时变化**：本 ADR 只动测试、黄金文件与文档；`dist` 字节不变，因此不单独触发版本变更（若与 MCP 同期发布，按那条的 minor 记）；
  - `stdout` 键集、退出码、审计键序、七工具面全部不变。

## 验收标准

1. **测试全绿**：`pnpm --filter review-pi test` 通过（本次实测 53 文件 / 502 passed + 1 skipped）；`pnpm -r typecheck` 退出码 0。
2. **零残留引用**：全仓 grep `review-tools-dsh`、`review-tools-wire-dsh`、`system-prompt.txt`、`mr-message-vul4j-1`、`phase-1.txt` 归零（ADR 与历史文档除外）。
3. **替代断言可独立判断**：每条替代断言在「实现改坏」时必须能红（例如把 `required` 写成不在 `properties` 里的键、把阶段前缀写错、把 wire 名映射改成非下划线）。
4. **产品级逐字节仍在**：`reviews-tips-zh.test.ts`（cwd 副本）、`config.test.ts`（example 与模板同源）、`session-export.test.ts`（复制不重写）保持原样并通过。
5. **文档口径**：ADR-0009 / 0010 / 0014 顶部有指向本 ADR 的状态注记；`testdata/golden/README.md` 写明「只放输入，不放期望值」。

## 实施记录

落地于 2026-11-04，改动清单：

| 文件 | 动作 |
|---|---|
| `packages/review-pi/testdata/golden/{system-prompt.txt,phase-1..6.txt,mr-message-vul4j-1.txt,review-tools-dsh.json,review-tools-wire-dsh.json}` | 删除（10 个文件） |
| `packages/review-pi/testdata/golden/README.md` | 重写：目录性质从「真源」改为「输入语料」 |
| `packages/review-pi/src/zonea/system-prompt.test.ts` | 改写为装配性质断言 |
| `packages/review-pi/src/zonea/system-prompt.ts` | 头注释同步（不再声称字节真源） |
| `packages/review-pi/src/loop/phases.test.ts` | 删逐字节比对，保留数量 / 命名序 / 前缀 / JSON 契约 |
| `packages/review-pi/src/loop/phases.ts` | 头注释同步 |
| `packages/review-pi/src/loop/messages.test.ts` | 删 MR 消息逐字节比对，保留空白语义与空值回落 |
| `packages/review-pi/src/tools/registry.test.ts` | 删 DSH 对照；保留数量 / 唯一性 / JSON Schema 自洽 / wire 名双向往返 |
| `docs/adr/{0009,0010,0014}` | 顶部加状态注记指向本 ADR（正文不改） |
| `docs/adr/README.md` | 主要取代链表新增一行 |
| `CONTEXT.md` | 「测量常量面」的把守手段改为结构性质 + 端到端断言 |
| `docs/项目问答整理.md` | 时效说明补字节门注记；Q23 / Q123 两处旧说法就地标注退役 |

验证：`pnpm --filter review-pi test` → 53 files / 502 passed / 1 skipped；`pnpm -r typecheck` → exit 0。
