# 0113. 阶段压缩：合并 Phase 1+2，默认 compact（F-07）

**状态**：已接受（2026-11-22，F-07 实施完成）；默认值经 [ADR-0116](0116-revert-compact-and-budget-defaults.md) 回退为 `off`
**关联**：[ADR-0046](0046-round-budget-and-forced-complete.md)（轮次/阶段成本线）、[ADR-0090](0090-native-chinese-phase-prompts.md)（阶段提示词中文原生）、[ADR-0038](0038-retire-byte-level-prompt-parity.md)（阶段内容可演进）、[ADR-0043](0043-optional-coverage-repair.md)（独立补漏请求）
**范围**：只改阶段计划与配置面；不改 Phase 5/6 内容、工具 schema、findings 合并、分片规划、wire 协议。

## Context

六阶段骨架每个检视单元固定发 6 个请求，但其中两个阶段没有实际消费者：

- Phase 2 `Risk Classification` 的 `riskClass` 从未被读取（设计文档 §4.1 / P1-7）；
- Phase 3 判定 `neededContext` 后，Phase 4 在无需求时仍会发一个空的检索请求。

F-07 先按「合并 1+2 + Phase 3 无需求时跳过 Phase 4」实现 `limits.loop.stageCompression`，
并在 iterS10 / iterS20 上做了 live A/B（网关 `deepseek-v4.1-flash`，judge `deepseek-v4-pro`）。

关键结果（S20 二十条 / 73 GT，两臂 c=5，judge 1 轮）：

| 臂 | P | R | B | 请求 | token | 平均墙钟 |
|---|---:|---:|---:|---:|---:|---:|
| off（六阶段） | 31.4% | 21.9% | 25.8% | 308 | 6.60M | 129.7s |
| compact（允许 Phase 1 工具） | 39.6% | 27.4% | 32.4% | 306 | 7.70M | 151.2s |
| compact（Phase 1 禁工具） | **42.9%** | **30.1%** | **35.4%** | **271** | **6.27M** | 153.8s |

- 禁工具后 Phase 1 请求 84 → 20（每条恰好 1 次），总请求 −12%、token −5%；
- 质量对 off +11.5 / +8.2 / +9.6pp；逐条 6 好 / 1 差 / 13 平，ΔB 的 bootstrap 95% CI = +1.35 ~ +15.63pp；
- S10 两对复本方向相反（−9.9pp / +14.1pp），说明小样本单次不可判；
- 条件化 Phase 4 在 S10/S20 全部样本中 **0 次触发**（`neededContext` 从未为空）。

## Decision

### 1. 默认值

`limits.loop.stageCompression` 缺省改为 **`"compact"`**，可取 `"off"` 回滚：

- `off`：六阶段各发一次请求，与历史逐请求一致；
- `compact`：Phase 1 一次请求同时产出 `summary` + `riskClass`；Phase 2 不发；
  Phase 3 的 `neededContext` 为空时跳过 Phase 4。

### 2. Phase 1 不调用工具

compact 的 Phase 1 指令明确「本阶段不要调用工具，只基于会话已有 diff 与上下文作答」。
实验显示允许工具时，Phase 1 会重复 Phase 4 的检索（S20 共 84 次请求），把压缩收益吃光。

### 3. 审计口径

阶段名与顺序不变；被跳过的阶段写 `requestCount = 0` + note（Phase 2 的 note 带
riskClass）。下游按 phase 名取数的脚本不需要改。

### 4. 失败语义

Phase 3 的 `neededContext` 解析失败 → **不跳过** Phase 4（fail-open，宁可多一个请求）。

### 5. 条件化 Phase 4 暂保留但不受依赖

当前 20 条样本 0 次触发；保留代码与审计字段，若后续仍无触发，作为独立清理项删除，
不作为本 ADR 的收益来源。

## Consequences

- 正面：固定阶段请求 6 → 4–5；S20 上总请求 −12%、token −5%，质量方向为正；
  分片路径按片生效，片越多省的固定请求越多。
- 代价/风险：S20 墙钟 +18.6%，与 token 下降方向不一致（疑为输出变长或网关抖动）；
  质量证据来自单次运行，S10 复本方向相反；默认开启后需在后续基准中继续观察。
- 回滚：配置 `limits.loop.stageCompression: "off"` 即回到六阶段逐请求形态。
- 不做：不改 Phase 5/6；不做 2 阶段极简臂；不把 `riskClass` 用于预算（留给 P1-7）；
  不删除 `phase5Sweep`（F-06 已 DROPPED，默认仍 false）。
