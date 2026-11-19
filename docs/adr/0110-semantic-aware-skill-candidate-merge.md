# 0110. 规则 Skill 候选预合并改为同根因语义判定

**状态**：已接受（2026-11-19，用户决策）
**关联**：[ADR-0014](0014-rule-skill-review-pass-after-candidates-phase.md)（决策 9：候选门之前跨 skill 合并）、[ADR-0057](0057-summary-covers-only-reported-findings.md)（上报口径）、[ADR-0106](0106-tips-full-projection-with-unreported-log.md)（tips 取消同行去重）
**范围**：只改 `gate/candidate-merge.ts` 的预合并条件，以及把同根因键抽到 `finding/finding-key.ts` 供候选门复用。主候选、Phase 6 指令、工具面、审计形状不变；`mergedCount` 的数值语义随匹配条件变化。

## Context

`mergeSkillCandidates` 原先的去重键只有：

```text
normalize(file) + line + normalizeCategory(category)
```

因此同一文件、同一行、同一 category 的候选，即使 `title` / `description` / `rule` 完全不同，也会在 **Phase 6 之前**被合并：

- 主候选与 skill 候选冲突时主候选胜出；
- 多个 skill 之间按 CLI 顺序先到者胜出；
- 同一 skill 批次内先出现者胜出。

但 `candidate-merge.ts` 文件头注释与 ADR-0014 决策 9 都写着「语义冲突的两条都保留」；只有 file / line / category 不同才会保留。同 category 的不同主张实际上会被静默合并，Phase 6 根本看不到被合并者。

与此同时，候选门（`gate/candidate-gate.ts`）的跨轮去重已经有一套语义感知的同根因判定：

```text
同文件 + 同 category + 行号 ±5
且（rule 相同 或 标题字符二元组 Jaccard ≥ 0.5）
```

两处对「同一缺陷」的定义不一致：预合并按 category 一刀切，候选门按 rule/标题语义判定。

## Decision

### 1. 预合并复用候选门的同根因判定

`mergeSkillCandidates` 的合并条件改为：

```text
同文件 + 同 category + 行号相差不超过 ±5
且（rule 相同 或 标题相似度 ≥ 0.5）
```

- 同位置、同 category、同 rule → 视为同一缺陷，合并；
- 同位置、同 category、标题高度相似 → 视为同一缺陷，合并；
- 同位置、同 category，但 rule 不同且标题明显不同 → **两条都保留**，交给 Phase 6 分别核验；
- file / category 不同，或行号相差超过 5 行 → 不合并。

### 2. 同根因键单源

把 `ROOT_CAUSE_WINDOW_LINES` / `ROOT_CAUSE_TITLE_SIMILARITY`、`addRootCauseKey` /
`hasRootCauseKey` 从 `candidate-gate.ts` 移到 `finding/finding-key.ts`：

- 候选门跨轮去重与 skill 预合并使用**同一实现**；
- 行为不变的纯搬移：候选门的判定、顺序、拒绝原因都不改；
- `finding-key.ts` 仍只依赖 `Finding` 类型，不引入 gate 层依赖。

### 3. 归一化与占键规则

- `category` 在比较前走 `normalizeCategoryValue`，大小写 / 连字符 / 语义桶写法不同仍按同一类别处理；
- 主候选仍**永不被丢弃**，但其同根因键会占键；skill 候选命中即合并，计入 `mergedCount`；
- 同一 skill 批次内同样按先到者胜出；
- schema 非法候选仍不参与去重、不占键，交给 `SCHEMA_INVALID`；
- 存活候选登记自己的同根因键，后续批次/后续条目可命中它。

## Options（为什么不是别的）

- **保留激进合并、只修注释/ADR**：等于承认同 category 的不同意见会被静默丢弃；与「同根因」语义和 ADR-0106 的完整 tips 方向相反，放弃。
- **把 rule / title 直接加入精确键**：会把同一缺陷的不同措辞/不同规则写成两条，重复率更高，且没有利用相似度；放弃。
- **删除预合并，全部交给 Phase 6 + 候选门**：Phase 6 要为明显重复的候选逐条出裁决，成本和候选清单体积上升；放弃。
- **在预合并里用 LLM 判重**：引入额外模型调用与不确定性；放弃。
- **复用候选门的同根因判定**：两处口径一致、纯确定性、零额外调用；采用。

## Consequences

- **正**：同一行不同语义的意见不再在 Phase 6 之前被吞掉；`candidate-merge` 与 `candidate-gate` 对「同根因」只有一个定义；主路径与无 skill 路径不变。
- **负/风险**：
  - 更多候选进入 Phase 6，skill 候选清单和裁决输出可能变大；
  - 同一缺陷若 rule 不同且标题相似度低于 0.5，会被当成两条保留（召回优先，接受少量重复）；
  - `mergedCount` 数值会下降，历史审计之间不可直接按该字段做同比。
- **中性**：Phase 6 指令、工具面、Finding schema、审计键形状不变；正常候选的请求字节不变，只有「同位置不同语义」的场景会多一条候选进 Phase 6。

## 验收标准

1. 同文件 / 同 category / 行号 ±5 / rule 相同 → 合并，无论标题是否相同。
2. 同文件 / 同 category / 行号 ±5 / rule 不同但标题相似度 ≥ 0.5 → 合并。
3. 同文件 / 同 category / 行号 ±5 / rule 不同且标题相似度 < 0.5 → 两条都保留。
4. 同文件 / 同 category / 行号相差超过 5 行 → 两条都保留。
5. 不同 file 或不同 category → 两条都保留。
6. `NULL-SAFETY` / `null_safety` / `correctness` 等 category 写法归一后仍按同一类别比较。
7. schema 非法候选不参与去重、不占键。
8. `pnpm --filter @baize/review-pi test`、`pnpm --filter @baize/review-pi typecheck` 全绿。
