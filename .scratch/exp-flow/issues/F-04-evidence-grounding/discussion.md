# F-04 讨论归档

> 票与验收在 [`ticket.md`](ticket.md)；任务总表在 [`../../map.md`](../../map.md)。

## 2026-11-22 · 历史证据核对与设计约束

- 当前 candidate gate 只检查 evidence 为非空字符串数组（`candidate-gate.ts`），不核对内容。
- 历史审计核对（v3 iterF91 320 findings；旧 0.6.1 arm2 1539 findings）：
  - v3：文件不在 diff 0、行号不在 hunk 0、evidence 为空 0；
  - 旧 0.6.1：文件不在 diff 6、行号不在 hunk 87（5.7%）、evidence 为空 0。
- evidence 文本（v3，与 head 完整文件比对）：
  - 1061 条 evidence 中，整段逐字命中仅 26（2.5%），30 字符窗口命中 481（45.3%），无重叠 554（52.2%）；
  - 按 finding 聚合：68/320（21.3%）没有任何一条 evidence 能命中 30 字符窗口，其中 48 条 evidence 不含可解析代码。
- 结论：真实问题常在改写/拼接/省略/中文追加后仍有效；**整段硬匹配会大量误杀**。v1 必须：
  - 用 head 完整文件（不是只看 diff hunk）作为接地基准；
  - 容忍多行、分号、省略号、中文追加；
  - 默认 `off`；`warn` 只计数；`drop` 才拒绝；
  - 文件不可读 / side 非 head → fail-open。
- 默认 `off` 的原因：先用历史回放与人工抽查校准误杀率，再谈默认 `drop`。

## 2026-11-22 · v1 实现与历史回放

- 模块：`gate/evidence-grounding.ts`；配置 `limits.evidence.mode`（off/warn/drop）+ `minMatchChars`（默认 30）；候选门新增 `EVIDENCE_UNGROUNDED`（仅 drop）；审计 `evidenceGrounding` 计 checked/grounded/unverified/unverifiable/dropped。
- 读取器只读本遍 diff 内路径、限制 2MB、拒绝越界路径；side=base/mixed 时统一 `unverifiable` fail-open。
- 历史回放（编译后模块，minMatchChars=30）：
  - v3 320 findings：grounded **217（67.8%）**、unverified **103（32.2%）**、unverifiable 0；
  - 旧版 1489 findings：grounded 1022（68.6%）、unverified 463（31.1%）、unverifiable 4。
- 说明：unverified 含大量“引用其他文件/纯中文描述/改写”，不等于编造；drop 在历史数据上会排除约 32%，风险过高。
- 决策：默认 `off`；A/B 先 `warn`；`drop` 保留但需人工抽查 103 条后再启用。文件/行号硬违规仍走 `findingScope`。
- 归档：`bench/experiments/2026-11-22-f04/`（README + v3.json + old-arm2.json + eval_grounding.mjs）。

## 2026-11-22 · warn 与 drop 的离线效果

- warn：只计数、不改 findings；输出与 baseline 相同。
- drop（假设）：用已有 judge 标签重算 v3：
  - baseline/warn：320 条，P 0.3812 / R 0.2449 / B 0.2982；
  - drop unverified：217 条，P 0.4286 / R 0.1820 / B 0.2555；
  - 被移除 103 条中含 29 条 precision 命中、37 个 GT 覆盖丢失。
- 结论：warn 零输出损失；drop 当前 balanced −4.3pp，不应作为默认或近期策略。未接地更适合作为降置信 / F-05 输入。
- 归档：`bench/experiments/2026-11-22-f04/drop-impact.json`、`drop_impact.mjs`。
