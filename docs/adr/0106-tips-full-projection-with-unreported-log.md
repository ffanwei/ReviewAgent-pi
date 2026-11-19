# 0106. `reviews_tips_zh` 改为全量投影：取消同行去重，平台未收到的逐条留痕

**状态**：已接受（2026-11-19，用户决策）
**关联**：[ADR-0023](0023-dedupe-tips-by-file-and-line.md)（本 ADR 取消其同行去重）、[ADR-0017](0017-out-of-kernel-grouped-review-tips-export.md)（tips 12 键与文件分组）、[ADR-0045](0045-mcp-business-task-tools.md)（MCP 报文与 tips 同源）、[ADR-0052](0052-tips-four-tier-severity-and-confidence-filter.md)（置信度 / 严重级过滤）、[ADR-0057](0057-summary-covers-only-reported-findings.md)（收尾总结只覆盖已上报意见）
**范围**：只改 `reviews_tips_zh.json` 的取数与去重口径，以及 stderr 留痕。MCP 报文契约、候选门、合并层、`reviews_all.json`、收尾总结口径均不变。

## Context

ADR-0023 为“按行改代码”的可读性，在 tips 层按 `(file, line)` 去重、只留 finding 源序第一条。实际运行暴露了一个不能接受的副作用：

- 用户显式传入规则 Skill 后，规则会话产出的意见与主会话意见落在同一行；
- 单遍路径的 finding 顺序是「主候选在前、skill 候选追加在后」（`candidate-merge.ts`、`agent-review-loop.ts`），因此同行的规则意见**稳定地被主意见挤掉**；分片路径则只在规则意见严重级更高时才可能留下；
- 但 MCP `mrReviewResult` 是逐 finding 上报、不做同行去重，平台实际收到了这条规则意见；
- 结果是 `reviews_tips_zh.json`（人类主要交付物）与平台明细不一致，且丢失的是用户通过 `--rule-skill` 显式要求检视的规则意见。

候选门与合并层已经把“同 `(file,line,title)`”和“同 category ±5 行同根因”的重复拦掉；能活到 tips 的同文件同行意见，按定义是不同 category/title 的另一个缺陷。tips 再按行吞掉属于过度去重。

用户决策：**tips 作为本地全量投影，不因同行、code 不可读或上报失败而少条；MCP 可以是它的子集，但差集必须在 stderr 逐条标记“平台未收到”。**

## Decision

### 1. 取消 tips 的同行去重

`assembleUnifiedTips`（`cli/unified-tips.ts`）删除 `(file, line)` 的 `seenLines` 去重。通过置信度 / 严重级过滤的每条 finding 都生成一条 tip；同一行可以有多条。

- 上层去重边界保留：候选门 `(file,line,title)` + 同根因 ±5 行（`gate/candidate-gate.ts`）、跨 skill `(file,line,category)`（`gate/candidate-merge.ts`）、分片合并 `(file,line,title)`（`run/findings-merge.ts`）。
- 本 ADR 不引入 embedding / LLM 模糊聚类；同义改写是否重复由上述确定性键负责。

### 2. code 不可读的意见仍进 tips

MCP 报文要求 `code` 非空单行（平台契约），读不到源码行的 finding 会被 `buildShardReport` 跳过；tips 侧不受此限，继续以 `code: ""` 保留该条（ADR-0017 老契约允许）。

### 3. 不按“已上报集合”裁剪 tips；改为差集留痕

tips 不再用 `submittedFindingKeys` 过滤。MCP 开启时，组装完成后计算：

```text
unreported = tips 中 merge key 不在 submittedFindingKeys 的条目
```

对每条打印一行：

```text
review-pi: 平台未收到（tips 仍保留）：<file>:<line> (<id>)
```

并先打一条汇总：`平台未收到 N 条中文意见（tips 仍保留，逐条见下）`。MCP 关闭时不计算该差集（没有“平台收到”这回事）。

### 4. 其他口径不变

- 置信度 / 严重级过滤仍在生成前执行（ADR-0052），只影响中文 tips 与 MCP 上报；
- `reviews_all.json` 仍是全量 finding 真源；
- 收尾总结仍只覆盖已上报意见（ADR-0057）——因此 tips 可以是总结/MCP 的超集，差集由上述 stderr 行解释；
- MCP 报文形状、文件覆盖、`mrReviewResult` 调用次数与顺序不变。

## Options（为什么不是别的）

- **严格对齐 MCP（tips 只保留成功上报且 code 可读的意见）**：用户明确选择保留 tips 可见性；且会让 code 不可读的本地意见完全消失，放弃。
- **只豁免规则意见**：能解决本次案例，但普通意见在同行仍会被静默吞掉，且需要可靠的 `source` 贯穿合并层；本 ADR 选择更简单、无特例的全量投影。
- **保留 ADR-0023，只加日志**：规则意见仍从主交付物消失；日志不能替代可见性，放弃。
- **同行多条合并成一条（拼 review / 加 related 字段）**：破坏 12 键单值语义或新增契约；下游兼容成本高于收益，放弃。
- **在 candidate-merge 层按 `(file,line)` 去重**：那是测量面，会改变 findings 数量与评测口径，放弃。

## Consequences

- **正**：规则 Skill 的意见、code 不可读的本地意见、上报失败的意见都不会从 tips 静默消失；tips 与 MCP 的差集可逐条解释。
- **负/风险**：同一行可能出现多条 tip；下游若按行生成工单/评论，需要自行聚合（ADR-0023 当初正是为此去重）。`source` / `category` / `severity` 仍在，足以让下游选择保留策略。
- **中性**：12 键字段、文件分组、置信度 / 严重级阈值、MCP 契约、总结口径均不变；单遍与分片路径的行为一致（都只保留 eligible findings，不再按行丢）。

## 验收标准

1. **同行多条**：同一 `(file,line)` 两条 eligible finding ⇒ tips 两条，id 各自保留。
2. **规则意见**：主意见在前、规则意见在后且同行 ⇒ tips 两条（不再只留主意见）。
3. **code 空**：源码行读不到 ⇒ tips 仍保留该条（`code: ""`）。
4. **上报失败**：该 finding 不在 `submittedFindingKeys` ⇒ tips 仍保留，stderr 有汇总行 + 逐条“平台未收到（tips 仍保留）”行。
5. **MCP 关闭**：不计算/不打印“平台未收到”差集；tips 仍产全量 eligible 投影。
6. **过滤不变**：低于 `limits.confidence.min` / `limits.severity.min` 的意见仍被丢弃，计数留痕不变。
7. **测试**：`pnpm --filter @baize/review-pi test`、`pnpm --filter @baize/review-pi typecheck` 全绿。
