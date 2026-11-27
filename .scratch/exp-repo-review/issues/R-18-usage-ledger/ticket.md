# R-18 · LLM 用量账本（单一写入点 + 落盘）

- Status: DONE
- Branch: `exp-repo-review`
- Created: 2026-11-27
- Commit: `337889f`

## 问题

`review-pi.log` 的 token 统计由多处各自相加：审计 `usage`、覆盖补漏
`coverageRepair.usage`、CLI 一次性调用收集器、repo 组用量。结果是：

- PR 场景 reply-repair 被审计与一次性收集器各加一次（实测 82 个实例中 4 个超计）；
- repo 场景漏掉覆盖补漏、候选修复与失败 attempt 的用量；
- 新调用点要记得手动加账，漏记不可见。

## 目标

LLM 调用边界是唯一写入点；所有汇总（审计、CLI `[usage]`、repo 结果、job.json、
run.json）只做只读投影。调用次数、attempts、缺 usage 的调用都可见，回放条目
默认不计入真实花费。

## 验收

- `usage-ledger.ts`：`UsageSource` / `UsageScope` / `aggregate` /
  `summarizeUsage` / `mergeUsageSummaries` / `partitionUsage`；8 个单测。
- PR：Agent / Skill / reply-repair / candidate-repair / coverage-repair /
  finding-verification / tips / summary 全部在调用边界记账；`[usage] 任务总计`
  改为账本投影，reply-repair 只进一次性桶。
- repo：每组一个账本，重试 attempt 共用；失败 attempt 用量计入；结果 / job /
  审计 / run.json 携带 `usageLedger`。
- 真实 multilang 仓：`result.usage == result.usageLedger.usage == 各组 usage 之和`，
  4 组审计 `usageLedger` 与组 usage 完全一致。
- 真实 PR 复核：cline@2195a68、gofr@dc0b3e6 的 `[usage] 任务总计` 与
  `audit.usage + coverageRepair.usage` 三个 token 字段完全相等。
- 全包 1360 passed / 1 skipped；typecheck 通过。

## 后续

- replay trace 重录见 R-19；基准数据归档见 `bench/experiments/2026-11-27-s41-ledger/`。
