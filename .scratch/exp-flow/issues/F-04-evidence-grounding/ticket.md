# F-04 证据接地（确定性硬门）

- Status: `done`
- 优先级：P0
- 分支：`exp-flow`
- 对应问题：P0-4、V3
- 讨论归档：[discussion.md](discussion.md)

## 目标

把 evidence 从「非空数组」升级为**可机器核对**：文件在本遍 diff、行号在变更 hunk、至少一条 evidence 能在 head 侧完整文件里定位到代码片段。零模型、零额外请求、不改提示词/工具 schema。

## 范围（v1）

- 新增 `gate/evidence-grounding.ts`：解析 `path:line — code`，按行/分号/省略号拆分，做归一化后的精确命中或 `minMatchChars` 窗口命中。
- 新增 `limits.evidence.mode`：`off`（默认）/ `warn` / `drop`；`minMatchChars` 默认 30（8–200）。
- 候选门新增阶段 `EVIDENCE_UNGROUNDED`（仅 `drop` 模式拒绝）；`warn` 只计数不丢候选。
- 文件不存在、删除文件、side 非 head、读不到内容 → `unverifiable`，**fail-open**。
- 审计新增 `evidenceGrounding`（checked/grounded/unverified/unverifiable/dropped），分片聚合求和。

## 不做

- 不做 LLM 独立证伪（F-05）。
- 不做引文反推行号修正（P1-12，后续）。
- 不按“整段逐字命中”硬拒；历史数据显示只有约 2.5% 能整段命中。
- 不改 wire 请求、工具 schema、findings 合并规则。

## 验收证据（v1）

- 单测：`evidence-grounding` 7 例、候选门 warn/drop/fail-open 3 例、`sharded-review` 审计投影 1 例通过；全包 **109 文件 / 1234 passed / 1 skipped**。
- 历史回放（零模型）：v3 320 findings → grounded 217 / unverified 103 / unverifiable 0；旧版 1489 → 1022 / 463 / 4。归档见 `bench/experiments/2026-11-22-f04/`。
- 结论：默认 `off`；`warn` 只计数；`drop` 历史回放会排除约 32%，不作为默认。

## 验收

- 单测：真证据（含多行/省略号/中文追加）通过；纯描述、编造引文在 `drop` 下拒绝；`warn` 只计数；文件不可读 fail-open。
- 历史回放（零模型）：320 条 v3 findings 的 grounded/unverified 分布与人工抽查；拒绝率、误杀率有结论。
- 全包测试 + `tsc` build；默认 `off` 时零行为变化。
- 小规模 live A/B（后续）：P/R/B、噪声率、R 损失 ≤2pp。
