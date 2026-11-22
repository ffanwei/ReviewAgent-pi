# F-07 阶段压缩 A/B：合并 Phase 1+2 + 条件化 Phase 4

日期：2026-11-22；分支：`exp-flow`；模型：网关 `deepseek-v4.1-flash`；judge：`deepseek-v4-pro`（1 轮；judge 输出确定）。

## 改动

`limits.loop.stageCompression`：

- `off`（默认）：六阶段各发一次请求，行为逐请求不变；
- `compact`：Phase 1 一次请求同时产出 `summary` + `riskClass`，Phase 2 不发；
  Phase 3 的 `neededContext` 为空时跳过 Phase 4。审计保留六阶段记录，
  被跳过的阶段写 `requestCount = 0` + note。

代码：`loop/phases.ts`（压缩指令）、`loop/agent-review-loop.ts`（跳过与留痕）、
`shared/config-limits.ts`（配置）。单测覆盖 4/5 请求、fail-open、指令契约、配置校验。

## 实验

- S10：iterS10 十条，两对独立复本（每对 off + compact，c=2/4 混合），各 judge 1–3 轮
  （judge 输出确定，多轮同值）。
- S20：iterS20 二十条，off 与 compact 各一次，两臂均 c=5，各 judge 1 轮。
- 同一配置只差 `stageCompression`；其余 limits 相同（findingScope off）。

## 结果

### S20（20 条 / 73 GT / 主判据）

| 臂 | P | R | B | findings | 请求 | token | 平均墙钟 |
|---|---:|---:|---:|---:|---:|---:|---:|
| off | 31.4% | 21.9% | 25.8% | 51 | 308 | 6.60M | 129.7s |
| compact | 39.6% | 27.4% | 32.4% | 48 | 306 | 7.70M | 151.2s |
| Δ | +8.2pp | +5.5pp | +6.6pp | −3 | −2 | +16.6% | +16.6% |

逐条：5 条变好 / 3 条变差 / 12 条持平。按实例 bootstrap，ΔB 的 95% CI 为
**−4.3 ~ +15.1pp**（仍跨 0）。

### S10（10 条 / 40 GT，两对复本）

| 运行 | off P/R/B | compact P/R/B | off 请求 | compact 请求 |
|---|---:|---:|---:|---:|
| #1 | 41.9 / 32.5 / 36.6 | 31.1 / 23.3 / 26.7 | 165 | 167 |
| #2 | 32.1 / 22.5 / 26.5 | 48.3 / 35.0 / 40.6 | 147 | 144 |
| 均值 | 37.0 / 27.5 / 31.6 | 39.7 / 29.2 / 33.6 | 156 | 156 |

两对方向相反（−9.9pp / +14.1pp），同臂跨运行波动 10–14pp，单次不可判。

### 请求结构（S20 两臂按阶段求和）

| 阶段 | off | compact | Δ |
|---|---:|---:|---:|
| 1 Change Understanding | 40 | 84 | **+44** |
| 2 Risk Classification | 23 | 0 | −23 |
| 3 Context Decision | 20 | 25 | +5 |
| 4 Context Retrieval | 168 | 144 | −24 |
| 5 Deep Reasoning | 37 | 32 | −5 |
| 6 Evidence Verification | 20 | 21 | +1 |
| **合计** | **308** | **306** | **−2** |

- Phase 2 的请求确实全部省掉（20/20 条为 0）；
- 合并后的 Phase 1 工具调用翻倍，把省下的请求花回去；
- **条件化 Phase 4 在 S20 的 20 条里 0 次触发**：Phase 3 的 `neededContext` 从未为空。

## 判读

1. 阶段压缩没有带来实跑请求下降：固定阶段只占 6/16 个请求，省 1 个阶段被工具循环波动吞掉。
2. S20 的质量方向为正（+6.6pp B），但不显著（CI 跨 0），且 token +16.6%、墙钟 +16.6%；
   增量主要来自 Phase 1 的额外探索，而不是“少一个阶段”。
3. 条件化 Phase 4 是无效杠杆，需要删除或重新定义触发条件。
4. 不满足 F-07 验收（请求 −≥1、token 不高于当前）；不默认开启。
5. 若要继续，应先隔离“Phase 1 探索”与“合并本身”：给 compact 的 Phase 1 加
   “不调用工具、只基于 diff 回答”，再跑一轮 S20；质量若回落到 off 水平，说明收益来自探索。

## 文件

- `s10-{off,compact,off2,compact2}/`：S10 两对复本（结果 / 精简审计 / manifest）
- `s20-{off,compact}/`：S20 两臂
- `off{,2}-metrics.json`、`compact{,2}-metrics.json`、`s20-{off,compact,compact3}-metrics.json`：judge 汇总
- `metrics_claude_*.json`：每轮 judge 原始输出
- `eval_arm.py`：对结果目录跑 N 轮 judge 并汇总
- `s10-*.log`、`s20-*.log`：桥接运行日志

## 追加：隔离变量（Phase 1 禁止工具，`compact3`）

给 compact 的 Phase 1 加“本阶段不要调用工具，只基于会话已有 diff 与上下文作答”，
同 S20、c=5、judge 1 轮：

| 臂 | P | R | B | findings | 请求 | token | 平均墙钟 |
|---|---:|---:|---:|---:|---:|---:|---:|
| off | 31.4% | 21.9% | 25.8% | 51 | 308 | 6.60M | 129.7s |
| compact（允许工具） | 39.6% | 27.4% | 32.4% | 48 | 306 | 7.70M | 151.2s |
| compact3（禁止工具） | **42.9%** | **30.1%** | **35.4%** | 49 | **271** | **6.27M** | 153.8s |
| compact3 − off | +11.5pp | +8.2pp | **+9.6pp** | −2 | **−12.0%** | **−5.0%** | +18.6% |

- 逐条：6 条变好 / 1 条变差 / 13 条持平；按实例 bootstrap，ΔB 95% CI = **+1.35 ~ +15.63pp**（跨出 0）。
- 分阶段请求：Phase 1 20（off 40、compact 84），Phase 2 0，Phase 3 20，Phase 4 173，Phase 5 36，Phase 6 22；合计 271。
- 条件化 Phase 4 仍然 0 次触发。
- 解读：禁止 Phase 1 工具后，压缩的请求/token 收益才出现（−12% / −5%），质量方向仍为正；
  但墙钟 +18.6% 与 token 下降方向不一致，可能是输出变长或网关抖动，需要复本确认。

## 决策（2026-11-22）

按用户决定，`stageCompression` 默认改为 **`compact`**（Phase 1 禁工具）；`off` 保留回滚。
依据 = 本页 S20 隔离实验（请求 −12%、token −5%、B +9.6pp，CI +1.35 ~ +15.63pp）；
风险 = 单次运行、S10 复本方向相反、墙钟 +18.6% 未解释。ADR-0113 记录完整判读。
条件化 Phase 4 在全部样本中 0 次触发，保留代码但不计入收益。
