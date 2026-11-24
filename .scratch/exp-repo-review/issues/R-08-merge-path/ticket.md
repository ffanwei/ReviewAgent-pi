# R-08 · 与多文件实验及主线的合并路径

- Status: BLOCKED
- Branch: `exp-repo-review`
- Created: 2026-11-24

## 问题

`exp-flow`、`exp-multifile-recall`、`main` 三条线共享 `review-run.ts`、`config-limits.ts`、`config.ts` 等文件；本分支再叠加后，长期分叉会放大合并冲突。

## 目标

- 明确本分支与 `exp-flow` / `exp-multifile-recall` / `main` 的集成顺序；
- 列出共享文件改动面与冲突点；
- 定义合并前回归范围。

## 约束

- 不把本分支合进 `exp-multifile-recall`；
- 共享文件改动最小化，优先新模块 + 薄适配层；
- `group-planner` 只经评审后 cherry-pick / 重构引入；
- `exp-flow → main` 的合并顺序另行确认。

## 验收

- 集成顺序与冲突面清单；
- 共享文件改动清单；
- 合并前回归范围（测试、评测、回放）。

## 依赖

等 `exp-flow → main` 与 multifile 结论。
