# R-18 讨论归档

## 2026-11-27 · 为什么要把统计放进 LLM 调用边界

**问题**：`review-pi.log` 的 token 统计完整吗？有没有 LLM 调用没被记录？

**审计结论**：

- PR 场景 82 个实例中 78 个完全相等；4 个 reply-repair 超计（审计已含，一次性
  收集器又加一次）。覆盖补漏与验证调用均已计入。
- repo 场景漏记覆盖补漏、候选修复与失败 attempt；组级汇总只看成功结果。
- 计数逻辑分散在各调用方，新增调用点容易漏。

**决定**：引入 `UsageLedger`，只在 Agent 每轮结束 / `completeOneShot` 成功回包
写入；审计、CLI、repo 组、job、run.json 全部改为只读投影。`scope` 隔离并发
片 / 组，`source` 是唯一归属维度；`partitionUsage` 保证 Agent 桶 + 一次性桶 =
全量，reply-repair 不再双计。

**验证**：真实 multilang 仓 4 组一致；cline / gofr 两个真实 PR 的日志总账与
`audit.usage + coverageRepair.usage` 完全相等；全包 1360 passed / 1 skipped。
