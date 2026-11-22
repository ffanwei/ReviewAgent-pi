# F-18 覆盖补漏默认化评估

- Status: `DONE`
- 分支：`exp-flow`
- 讨论归档：[discussion.md](discussion.md)

## 结论

保持默认关闭：B +3.65pp 不显著、墙钟 +30%。

## 验收证据

`bench/experiments/2026-11-22-f08/README.md`

## 结果（2026-11-22）

- S20 repair on vs baseline：B 33.5% vs 28.1%（ΔB +3.65pp，95% CI 跨 0）、
  墙钟 185s vs 142s（+30%）、补漏 51 请求。
- 决策：`coverage.repair.enabled` 保持默认 false。
