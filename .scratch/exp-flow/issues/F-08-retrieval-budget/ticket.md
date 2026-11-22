# F-08 检索预算与空结果停止

- Status: `DONE`
- 优先级：P1
- 分支：`exp-flow`
- 对应问题：P1-8/9（D.2 #8/#9）
- 讨论归档：[discussion.md](discussion.md)

## 目标

在工具层给检索加确定性护栏，降低 Phase 4 的重复/投机读取；不改 findings 语义。

## 范围

- `limits.retrieval.maxReadsPerFile`：同文件 `get_file` 次数上限（0 = 不限，默认）；
- `limits.retrieval.maxConsecutiveEmptySearches`：连续空 `search_code` 上限（0 = 不限）；
- `limits.retrieval.maxReadCharsPerRun`：一次检视 `get_file` 结果字符总量上限（0 = 不限）；
- 超限不执行工具，返回有界提示；计数进 `audit.retrievalBudget`；
- **不做区间切片输出**：v3 测量显示行重叠仅 3.7%，切碎输出会伤上下文。

## 不做

- 不做区间账本（测量后降级）；
- 不改 `get_file` / `search_code` 的输出格式；
- 不默认开启（默认全 0）。

## 验收

- 单测：读次数超限、连续空搜索超限都有跳过文本与审计计数；
- 全包测试 + build；
- S20 A/B（budget on/off）：工具调用、零命中、P/R/B、token/墙钟；P/R/B 回退 >2pp 或工具调用不降 → 默认保持关闭。

## 结果（2026-11-22）

- 默认 `maxReadsPerFile=3`、`maxConsecutiveEmptySearches=4`、`maxReadCharsPerRun=400000`；
  审计 `retrievalBudget` 默认出现。
- S20 复本：预算关闭 270 请求 / 6.75M token / B 28.1%；预算开启 254 / 5.95M / 27.4%；
  预算只触发 3 次跳过；ΔB 95% CI 跨 0，不能宣称因果。
- 结论：默认保留护栏值，后续基准观察；不做区间切片。
