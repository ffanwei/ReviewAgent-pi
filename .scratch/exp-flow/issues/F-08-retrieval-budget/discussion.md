# F-08 讨论归档

> 票与验收在 [`ticket.md`](ticket.md)；任务总表在 [`../../map.md`](../../map.md)。

## 2026-11-22 · 开工与设计口径

- 历史证据：12 run Ledger 命中 0–1 次；`search_code` 零命中约 25%（v3 837 次中 209 次）；
  v3 `get_file` 1202 次 / 740 文件，单文件最多 13 次，重复请求 0 次。
- 区间重叠测量：116/740 文件有重叠，重叠行仅 3.7% —— **不做“只返回未覆盖片段”**，
  避免模型失去连续上下文；预算与空结果停止才是主收益。
- 实现位置：主 loop 的 `beforeExecute` / `onResult` 钩子，按点分工具名计数；
  分片路径按片独立预算。
- 默认全 0（关闭）；A/B 用 `maxReadsPerFile=3`、`maxConsecutiveEmptySearches=4`、
  `maxReadCharsPerRun=400000`。

## 2026-11-22 · 验证与默认值

- 首次 budget 臂因 `limits.retrieval` 未进 `LIMITS_KEYS`、`retrievalBudget` 未进审计文件而无数据；
  修复后单样本冒烟确认计数，再跑 S20。
- S20 复本（预算关 vs 开）：请求 270→254、token 6.75M→5.95M、B 28.1%→27.4%（CI 跨 0）；
  跳过仅 3 次，差异在噪声内；结论是“无明显伤害”，不宣称请求收益。
- 默认值定为 3 / 4 / 400000；区间账本按 3.7% 重叠测量放弃。
