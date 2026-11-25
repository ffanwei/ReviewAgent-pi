# R-05b 讨论归档

## 2026-11-25 · 为什么单独拆 R-05b

- R-05 的 `DONE` 只覆盖 findings / tips schema 与行锚点语义；R-01 D7 要求的「文件 × 区域三态」没有实现。
- spike 的合成 diff 让所有行都是 `+` 行，MR coverage 账本必然显示全覆盖，不能直接复用。
- 决策：v1 做文件级三态，区域级留后续；失败组和预算未派发组统一记 `not-reached`，保证「没看到」可查询。
- 保留 R-05 的 `DONE` 作为历史证据；新增 R-05b 表示覆盖契约补齐。

## 2026-11-25 · 实现落地（DONE）

- 采用独立 `repo-spike/coverage.ts` 纯函数，按 selected 顺序构建三态；不碰 MR 的 `coverage-ledger.ts`。
- 失败组 / 跳过组 / 分组与合成跳过分别归因；`too-large(N>M)` 归一化为 `too-large`；`budget-exhausted` 预留给 R-09。
- 结果顶层 `coverage` 从 MR hunk 账本切换为 repo 文件级账本；组内 `run.json` 仍保留 MR coverage。
- 验证：单测覆盖三态、归因、顺序、重复路径、确定性；真实 2 文件 smoke 得到 selected=2 / candidate=2。
- 后续：区域级覆盖（类/方法）与 R-09 预算停止的 `budget-exhausted` 归因。
