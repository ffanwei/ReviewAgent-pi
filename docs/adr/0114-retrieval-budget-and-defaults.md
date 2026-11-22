# 0114. 检索预算与输出默认校准（F-08b / F-09a / F-20）

**状态**：已接受（2026-11-22，F-08b/F-09a/F-20 实施完成）；检索预算默认值经 [ADR-0116](0116-revert-compact-and-budget-defaults.md) 回退为 0
**关联**：[ADR-0052](0052-tips-confidence-filter.md)（confidence 过滤）、[ADR-0064](0064-finding-scope.md)（范围门）、[ADR-0066](0066-usage-accounting.md)（usage 口径）、[ADR-0113](0113-stage-compression.md)（compact 后 Phase 4 占比上升）
**范围**：工具执行护栏 + 两个默认值；不改 findings 语义、不改工具输出格式。

## Context

- compact 默认后，Phase 4 仍占 S20 请求的 60%+；v3 归档中 `get_file` 1202 次 / 740 文件，单文件最多 13 次；`search_code` 零命中约 25%。
- 区间重叠测量（v3）：116/740 文件有重叠，重叠行仅 3.7% → “只返回未覆盖片段”会切碎上下文，收益不成比例。
- VUL4J 10 例：`confidence≥0.5` 相对 `≥0` 丢失 2/19 真值且精准度下降；范围外 11 条中 8 条真实。
- F-04 证据接地默认 `off`，产品拿不到 unverified 比例。

## Decision

### 1. `limits.retrieval`（F-08b）

- `maxReadsPerFile`：默认 **3**；同一路径超限不执行，回有界跳过文本；
- `maxConsecutiveEmptySearches`：默认 **4**；连续空 `search_code` 达上限后停止搜索；
- `maxReadCharsPerRun`：默认 **400000**；`get_file` 结果字符总量上限。
- 计数进 `audit.retrievalBudget`（配置了上限才出现）。
- **不做区间切片/区间账本**；`get_file`/`search_code` 输出格式不变。

### 2. `limits.confidence.min`（F-09a）

默认 0.5 → **0.3**。v3 离线复算：0.3 保留全部 320 条；0.5 会砍 26 条（含 6 条 TP）。
`scope: "outside-diff"` 标注仍留待后续，不在本 ADR。

### 3. `limits.evidence.mode`（F-20）

默认 `off` → **`warn`**：只计数、不拒绝候选；`audit.evidenceGrounding` 默认可见。
`drop` 仍不启用。

## Consequences

- S20 单次复本：预算臂请求 270→254（−6%）、token 6.75M→5.95M（−12%）、B 28.1%→27.4%
  （ΔB 95% CI [−9.3, +7.1]，不显著）；预算只触发 3 次跳过，不能宣称因果，只确认无明显伤害。
- confidence 0.3 会让 tips 多保留低置信长尾，precision 可能略降；换回真值不丢。
- evidence warn 增加 head 文件读取与审计计数，不改变 findings。
- 回滚：三项都可按配置改回旧值（`retrieval` 全 0、`confidence.min: 0.5`、`evidence.mode: "off"`）。
