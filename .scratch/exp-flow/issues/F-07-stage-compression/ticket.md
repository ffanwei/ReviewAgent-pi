# F-07 阶段压缩：合并 1+2、条件化 Phase 4

- Status: `DONE`
- 优先级：P1
- 分支：`exp-flow`
- 对应问题：P1-6、V5（设计文档 E5 阶段压缩；P1-7 风险驱动预算单列）
- 讨论归档：[discussion.md](discussion.md)
- 验收证据：`bench/experiments/2026-11-22-f07/README.md`；ADR-0113

## 目标

把每单元固定六个请求压到 4–5 个，不牺牲 P/R/B：

1. **合并 Phase 1+2**：一次请求同时产出变更理解与风险分级；不再单独发 Phase 2。
2. **条件化 Phase 4**：Phase 3 判定没有额外上下文需求（`neededContext` 为空）时，
   跳过检索请求，直接进入 Phase 5。
3. 审计保留六阶段记录：被压缩/跳过的阶段以 `requestCount = 0` + note 留痕，
   阶段名与顺序不变。

## 范围

- 新配置 `limits.loop.stageCompression: "off" | "compact"`，默认 `"off"`（零漂移）。
- 仅主检视循环；分片路径天然按片生效（每片各省请求）。
- Phase 1 合并后仍要求 `riskClass`，但 v1 不据此改预算（风险驱动预算留给 P1-7）；
  `riskClass` 写入审计 note，先让死字段变得可观测。

## 不做

- 不做 2 阶段极简臂（E5 的第三臂），v1 只到 4–5 个请求。
- 不改 Phase 5/6 的内容、工具 schema、wire 字节。
- 不默认开启；不做 `riskClass` 驱动的轮数/检索深度。
- 不合并 Phase 3+4（留到压缩率不够时再说）。

## 验收

- `compact` 下单轮请求数：无额外上下文时 4 个，有额外上下文时 5 个；
  `phaseLog` 仍为 6 条，跳过项 `requestCount = 0` 且有 note。
- `off` 路径逐字节/逐请求不变（现有测试全绿）。
- 全包测试 + build。
- live A/B（同模型、同样本，6 阶段 vs compact）：P/R/B ±2pp 内，请求数下降可复现；
  大 diff 分片样本确认收益按片放大。

## 实施与验收（2026-11-22）

- 代码：`limits.loop.stageCompression: "off" | "compact"`，默认 `compact`；
  compact = 合并 Phase 1+2（Phase 1 禁工具）+ Phase 3 无需求时跳过 Phase 4；
  审计保留六阶段记录，跳过项 `requestCount = 0` + note。
- 单测：4/5 请求、fail-open、指令契约、配置默认/非法值；全包 1244 passed / 1 skipped；build 通过。
- S20 A/B（compact 禁工具 vs off）：P 42.9% vs 31.4%、R 30.1% vs 21.9%、B 35.4% vs 25.8%；
  请求 271 vs 308（−12%）、token 6.27M vs 6.60M（−5%）；墙钟 +18.6%（未解释）。
  ΔB 的 bootstrap 95% CI = +1.35 ~ +15.63pp；S10 两对复本方向相反，单次证据需在后续基准继续观察。
- 条件化 Phase 4 在 S10/S20 全部样本中 0 次触发，保留代码但不作为收益来源。
