# 0052. 检视意见四档严重级与置信度过滤

**状态**：已接受（2026-11-07，用户决策）
**关联**：[ADR-0017](0017-out-of-kernel-grouped-review-tips-export.md)（分组式检视意见的 10 键字段映射单源）、[ADR-0045](0045-mcp-business-task-tools.md)（统一 tips 的 12 键形态与片级报文生成）、[ADR-0023](0023-dedupe-tips-by-file-and-line.md)（同文件同行去重）、[ADR-0039](0039-sharded-review-for-large-mrs.md)（分片 findings 合并口径）、[ADR-0025](0025-user-config-file.md)（用户级配置单源）
**范围**：本仓 pi 线 0052。改的是**中文 tips 的字段映射与取数口径**：`severity` 三档 → 四档、`confidence` 高/中分界 0.8 → 0.7、新增可配置的置信度过滤。检视提示词、英文 findings、`reviews_en.json`、stdout 全量输出、`mrReviewResult` 的 `level` 服务端契约、审计既有键序全部不动。

## Context

ADR-0017 给 `reviews_tips_zh.json` 定的 `severity` 是三档：P0→Fatal、P1→Major、P2/P3→Minor。这条映射是为了「不丢条」（P3 也产出一条中文意见），但它与平台 `mrReviewResult` 的 `level` 四档（Fatal / Major / Minor / Suggestion）**对不上账**：统一 tips 同时携带 `severity`（三档）与 `level`（四档），同一个 P3 在两列里显示不同档位，下游做统计时只能猜哪一列才算数。

同时，`confidence` 的三档阈值（≥0.8 High / ≥0.5 Medium / 其余 Low）把大量 0.7–0.79 的意见钉在 Medium；而 findings 侧实际存在一条长尾的低置信意见（P3 + Low，或 LLM 自评 0.3–0.49），它们进入中文 tips 后对评审人是纯噪声——但英文真源必须保留（测量面冻结，ADR-0010/0038）。

因此需要：**把 `severity` 四档归一**，并给中文 tips 一条**可配置的置信度下限**，缺省把 Low 档挡在门外，同时保证英文真源与上报契约零漂移。

## Decision

### 1. `severity` 四档，与 `level` 同值

| finding severity | tips `severity` | 平台 `level` |
|---|---|---|
| P0 | Fatal | Fatal |
| P1 | Major | Major |
| P2 | Minor | Minor |
| P3 | Suggestion | Suggestion |

统一 tips 仍是 12 键（`id` + 10 键 + `level`），`severity` 与 `level` 现在**同值**；引擎路径的 10 键 tips 仍按同一映射产出四档。**回落路径**（统一生成全灭、改用引擎 tips）由 `withUnifiedKeys` 注入 `id` / `level` 时一并把 `severity` 归一为同一套四档映射——第三方引擎若仍按旧三档产 `P3→Minor`，也不会在本地 tips 里与 `level` 分叉。`mrReviewResult` 的 `level` 服务端契约本来已是四档，不变。

### 2. `confidence` 高/中分界改为 0.7

`≥0.7` High、`≥0.5` Medium、`<0.5` Low（非有限数仍按 Low，不编高置信）。这是纯展示分档，与第 3 条的过滤阈值（数字 `confidence`）相互独立：过滤看原始数字，不看展示档。

### 3. 配置面：`limits.confidence.min`

```jsonc
"limits": {
  "confidence": {
    "min": 0.5   // 0–1；缺省 0.5 = 过滤 Low 档；0 = 不过滤；1 = 只保留满置信
  }
}
```

判定口径恒为 `confidence < min ⇒ 丢弃`，`>= min` 保留（边界值保留）。类型 / 越界在装载期 fail fast（字符串 `"0.5"` 不隐式转数字）。

### 4. 过滤只作用于中文 tips

- **受影响**：`reviews_tips_zh.json`（统一 tips 与引擎回落路径）与 `mrReviewResult.reviewTips`；
- **不受影响**：`reviews_en.json`、stdout 的英文 findings、审计里的 findings 全量、`saveReviewSummary` 的统计口径。

这是 ADR-0010「英文产出 + 核外中文投影」的延续：中文 tips 是**给人看的降噪视图**，英文真源是**测量面**，两者取数口径本来就允许不同。

### 5. 过滤时机：语义生成之前，落盘之前再兜一次

- **片级 `mrReviewResult`**：先按片内 finding `confidence` 过滤，再发起语义生成（省掉注定被丢弃条目的模型调用）。全被过滤的文件不报 `reviewTips: []`（避免声称「无问题」），其余无意见文件照常报空。
- **统一 tips 聚合**：用合并后的 finding `confidence` 过滤；分片 findings 合并时 `confidence` 取最高（ADR-0039），因此 `merged ≥ min ⇒ 至少一片生成过该条语义`，聚合过滤与片级过滤口径一致。
- **引擎路径 / 回落路径**：内置引擎在生成建议前先过滤；CLI 落盘前再用 `filterTipsDocumentByConfidence` 兜一次（第三方引擎可能不读该阈值）。未 join 到 finding 的 tip 按展示档上界保守判断（Low 上界 0.5、Medium 0.7、High 无上界），不因无法判断而误删。
- **与去重的关系**：过滤在同行去重**之前**——低置信首条不占行位，同行更高置信条目仍可见。

### 6. 留痕（零静默）

- **stderr**：仅在真的丢弃条数 > 0 时打一行汇总（条数 + 阈值 + 「仅影响中文 tips」）；
- **审计 / `run.json`**：新增可选尾键 `tipsFilter: { minConfidence, droppedTips }`（`droppedTips` = 过滤前 merged findings 中低于阈值的条数）。阈值缺席（内核直调 / 单测形态）时整键省略，既有审计键集与键序不变。

## Options（为什么不是别的）

- **只改 `severity`，不做过滤**：否。用户要的是「少给噪声」，四档只是把档位对齐；低置信长尾仍在。
- **过滤同时作用英文 findings**：否。英文真源是测量面（ADR-0010/0038），过滤会让 `reviews_en.json` 与模型原始产出不一致，破坏可复跑性。
- **用展示档（High/Medium/Low）做过滤**：否。展示档会随分界调整漂移，且丢掉原始数字的精度；过滤直接看 `confidence` 数字，边界语义单一。
- **在语义生成之后才过滤**：否。会为注定被丢弃的意见白花一次模型调用；片级 / 引擎侧都在生成前过滤。
- **把 `min` 做成整数百分比或 `nullable`**：否。0–1 是 confidence 的原生量纲，`0` 已足够表达「关闭过滤」，再引入 `null` 只会多一种状态。
- **保留 `severity` 三档、只让 `level` 四档**：否。两列长期同值不同名只会制造对账成本；统一为一套映射后下游无须选择。

## Consequences

- **好**：`severity` / `level` 不再分叉，下游统计只有一个真值；缺省过滤掉 Low 档噪声；英文真源与上报契约零漂移；过滤条数与阈值可在审计 / run.json 复核；片级调用不再为将被丢弃的意见付费。
- **代价 / 风险**：默认 `0.5` 会让「P3 + confidence 0.3」这类意见从中文 tips 消失（英文 findings 仍在）；需要全量中文意见的用户须显式设 `limits.confidence.min: 0`。分片场景依赖「合并取最高」，若未来改变合并口径，需重新论证聚合过滤与片级过滤的一致性。
- **测试面**：`cli/unified-tips.test.ts` 覆盖四档、边界值、过滤先于去重、`filterTipsDocumentByConfidence` 的 join / 档位上界 / 幂等、`droppedByConfidence` 计数；`tests/presentation/tips.test.ts` 覆盖引擎路径四档与 0.7 边界；`cli/presentation-projection.test.ts` 锁定 `Suggestion` 合法与新的错误文案；`shared/config.test.ts` 覆盖 `limits.confidence.min` 的缺省 / 边界 / 非法值与 digest。
- **与 ADR-0017 的关系**：本 ADR 修订其「severity/confidence 分档」两项子决策；10 键封闭、`source` / `ruleId` 判定、去重、降级口径继续有效。ADR-0017 顶部已加「后续修订」注记指向本 ADR。
