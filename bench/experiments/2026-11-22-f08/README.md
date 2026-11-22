# F-08b / F-09a / F-18 / F-17 / F-20 收官批次

日期：2026-11-22；分支：`exp-flow`；模型：网关 `deepseek-v4.1-flash`；judge：`deepseek-v4-pro`（1 轮，输出确定）。

## 批次内容

- **F-08b 检索预算**：`limits.retrieval`（每文件读取上限、连续空搜索上限、每 run 读取字符上限），工具层跳过 + `audit.retrievalBudget`；**不做区间切片**。
- **F-09a**：`limits.confidence.min` 默认 0.5 → 0.3。
- **F-17**：one-shot 空 content / `finish_reason=length` 自动翻倍预算重试一次。
- **F-20**：`limits.evidence.mode` 默认 `warn`（只计数不拒绝）。
- **F-19**：replay trace 维护，large-mr 真网关重录；`test:replay` 6/6。

## S20 验证（20 条 / 73 GT，c=5）

| 臂 | P | R | B | findings | 请求 | 工具调用 | token | 平均墙钟 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| baseline（预算关闭 0/0/0；运行期默认） | 35.4% | 23.3% | 28.1% | 48 | 270 | 375 | 6.75M | 141.8s |
| budget（预算 3/4/40 万） | 33.3% | 23.3% | 27.4% | 48 | 254 | 356 | 5.95M | 144.5s |
| repair（coverage.repair enabled） | 37.7% | 30.1% | 33.5% | 53 | 263（+51 补漏） | 347 | 6.07M | 185.0s |

> 注：baseline 跑在预算默认仍为 0/0/0 的 dist 上；budget 显式配 3/4/40 万。两臂是单次复本，
> 预算累计 3 次跳过、15 次空搜索；差异方向（请求 −6%、token −12%、B −0.7pp）在噪声内，不能
> 宣称因果，只能确认“没有明显质量伤害”。

bootstrap（按实例重采样 2 万次）：

- budget − baseline：ΔB = −1.65pp，95% CI [−9.3, +7.1]（不显著）；
- repair − baseline：ΔB = +3.65pp，95% CI [−5.5, +12.5]（不显著）。

## 决策

- **F-08b**：默认取 `3 / 4 / 400000`；证据不足以宣称请求下降（同配置复本），保留为护栏默认值，后续基准继续观察。
- **F-09a**：默认 0.3。v3 离线复算：0.5 会砍 26 条（含 6 条 TP），0.3 保留全部 320 条。
- **F-18**：`coverage.repair` **保持默认关闭**：B +3.65pp 不显著，墙钟 +30%，补漏 51 请求。
- **F-17 / F-20**：纳入默认行为（只 fail-open / 观测）。
- **F-19**：`test:replay` 6/6；large-mr 期望按新 trace 更新（42 findings / 7 个 tips 文件）。

## 文件

- `s20-baseline/`、`s20-budget/`、`s20-repair/`：归档结果 + 精简审计 + manifest
- `baseline-metrics.json`、`budget-metrics.json`、`repair-metrics.json`：judge 汇总
- `metrics_claude_*.json`：每轮 judge 原始输出
- `budget-comparison.json`、`repair-comparison.json`：`compare_arms.py` 输出
- `replay-record.log`：large-mr 真网关重录日志
- 复现：`bench/experiments/compare_arms.py`、`bench/experiments/2026-11-22-f07/eval_arm.py`
