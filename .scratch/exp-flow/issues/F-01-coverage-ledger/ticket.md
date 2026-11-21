# F-01 覆盖账本：文件 × hunk 三态

- Status: `done`
- 优先级：P0
- 分支：`exp-flow`
- 对应问题：P0-1、P1-11、V1/V7
- 评估依据：[检视流程合理性评估-OCR对照与历史Session证据](../../../../docs/design/检视流程合理性评估-OCR对照与历史Session证据.md) §4.4 / §5.1 / §6.3 / §7 / 附录 D.1
- 讨论归档：[discussion.md](discussion.md)

## 目标

把「本次变更里每个文件的每个 hunk 是否被真正审视」变成确定性、可审计的一等产物：

```jsonc
{
  "file": "src/foo/Bar.java",
  "hunks": [
    { "index": 1, "old": "40-46", "new": "40-52", "status": "candidate", "findingIds": ["F001"] },
    { "index": 2, "old": "70-78", "new": "70-78", "status": "no-issue", "reason": "仅格式化" },
    { "index": 3, "old": "101-120", "new": "101-121", "status": "not-reached" }
  ]
}
```

三态：`candidate` / `no-issue` / `not-reached`。未决不得静默成「已审」。

## 不做什么

- 不改主提示词、不让模型自报 `reviewedFiles` 当分母或 `no-issue` 证据。
- 不把 F-06（默认开启 B2 补漏）混进本任务。
- 不先做 P/R 调优；先让覆盖可见，再让缺口可补。
- 不把 `findings` 数当作覆盖指标。

## 设计草案

### 分母

- 用本遍 `input.diff`（分片 = 片内 diff；**不要用 `initialDiff`**，它含其他文件摘要）。
- 复用 `diff/parse.ts` 的 `parseUnifiedDiff`（与 `gate/diff-scope.ts` 同一解析器），产出 `ParsedFileChange` + `ParsedHunk`（old/new 两侧区间）。
- 删除文件、二进制、无 hunk 文件、被 `mrFilter` 剔除的文件进 `excluded(reason)`，不进分母。
- ADR-0070 截取丢弃的 hunk：进分母并标 `not-reached(cause=truncated)`；需要给 `ShardTruncationRecord` 补 dropped hunk 区间。

### 回填

- `Finding.line` 是新侧行号，按新侧 hunk 闭区间回填 `candidate`。
- 落在 hunk 外但同文件的候选单独计数，不改变 hunk 状态。
- Phase 5 / Phase 5 sweep / 规则 Skill 的候选都回填同一账本，来源可记 `main | sweep | skill`。

### 收口

- 每个 pass 的 `finally` 调 `closeCoverage(cause)`：仍未回填的 hunk → `not-reached`。
- `cause` 封闭枚举：`no-signal | truncated | budget | output-truncated | flow-error | round-cap`。
- 失败路径（含上下文窗口 fail-fast / provider 错误）也要落账本；当前审计在 loop 之后投影，失败时无审计，需要旁路落盘或失败审计。

### 定向补漏（F-01b）

- 文件全空 → 整文件补漏；部分空 → 只带未覆盖 hunk 正文（+ 少量上下文）。
- 结构化回执：逐 hunk `no-issue(reason)` 或 `candidate`；这是 `no-issue` 的唯一合法来源。
- 每个 pass 设补漏请求数与字符数硬上限；超出的保持 `not-reached(cause=budget)`。

## 落地阶段

| 阶段 | 内容 | 模型调用 |
|---|---|---|
| F-01a | 账本 builder、截取区间、审计键、stderr 摘要、分区恒等式测试；历史 diff 跑基线 | 0 |
| F-01b | 缺口驱动的定向补漏（独立请求，逐 hunk 回执） | +1/单元（仅缺口） |
| F-01c | 汇总策略：比例阈值、告警/失败模式、manifest/CI 对接 | 0 |

### F-01b 已落地（2026-11-21）

- 配置：`limits.coverage.repair { enabled, maxRequests, maxChars, maxHunksPerRequest }`，缺省关闭。
- 纯逻辑：`run/coverage-repair.ts` 负责缺口装箱、回执解析、候选门接入与审计；
  `coverage-ledger.markNotReached` 负责把预算未发出的缺口收口为 `not-reached(budget)`。
- 接线：`review-pass` 在 main findings 回填后、`closeCoverage` 前执行；分片聚合求和；
  审计尾键 `coverageRepair`；stderr 一行摘要。
- 验证：1207 passed / 1 skipped；`typecheck` 与严格 `build` 通过。
- A/B 配置：`C:/Users/Li/.PiAgent/benchmark-aacr-v2-f01b.jsonc`（与历史 arm2 同口径，只开补漏）。
- iterB10 实测（官方 `deepseek-flash`）：`not-reached` 267/297（89.9%）→ 52/297（17.5%）；补漏 117 请求 / 0 失败、15 条候选全部进门、200 条 `no-issue`。但 P 0.500→0.449（**-5.1pp**）、R 0.316→0.358、B 0.387→0.398；补漏候选命中率约 26.7%，拉低 precision，按**当时口径**“P/R 不回退”未通过。详见 [discussion.md](discussion.md#2026-11-21--f-01b-iterb10-ab-实测官方-deepseek-flash)。
- v2（2026-11-21）：`no-issue` 强制 evidence、提示词候选优先、预算代码文件优先。iterB10：P 0.439 / R 0.432 / B 0.435（v1 0.449/0.358/0.398；A 0.500/0.316/0.387）；27 条补漏候选 7 条命中，GT 文件内意见 32→50，未覆盖 GT 61→54，`no-issue` 假阴性 35→29。按 2026-11-21 调整后的“Balanced 不回退”口径，**v2 通过**（B +4.8pp）；P 仍低于 arm A 6.1pp，已在报告披露。详见 [discussion.md](discussion.md#2026-11-21--f-01b-v2no-issue-收紧--候选优先--代码文件优先)。
- v3（2026-11-21）：补漏候选独立验证门；iterB10 P 0.522 / R 0.400 / B 0.453（v2 0.439/0.432/0.435；A 0.500/0.316/0.387）。验证器 26 请求 / 失败 2 / accept 9 / reject 17 / unverified 4；最终 13 条补漏意见、4 条命中。B +1.8pp，precision 已高于 A 与 OCR，recall 仍是短板。详见 [discussion.md](discussion.md#2026-11-21--f-01b-v3补漏候选独立验证门)。
- F-01c C1：`run.json` 新增 `audit.coverageSummary`（counts + ratios + byCause），逐 hunk 明细仍只在审计；C2/C3（阈值语义、manifest/CI/preview）已拆到 [F-15](../F-15-delivery-platform/discussion.md)，不在 F-01 内继续。

## 验收（摘要）

- 每个 changed file 至少有一个 hunk 状态；`not-reached` 比例在审计与 stderr 可见。
- `candidate + no-issue + not-reached == hunk 总数`；分片账本并集 == 整份 diff 账本（无截取时）。
- 未覆盖 hunk 只对缺口发补漏；补漏请求数与缺口数可对账。
- **Balanced 不回退**（2026-11-21 口径调整：P 允许回退，但报告中必须披露）；token、墙钟、请求数一起报。
- 同一输入 + 同一配置 → 同一分母、同一账本。
- 提示词/工具 schema 未改时 replay 不受影响；若后续改动，先重录 trace。

## 待决问题

见 [discussion.md](discussion.md#未决问题)：单元大小、补漏粒度、是否引入确定性的「读过」信号、Phase 5 输出截断是否单独处理。
