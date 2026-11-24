# R-01 讨论归档

## 2026-11-24 · 分支基点与隔离方式

- 需求语义确认为 **A：无 diff 全仓扫描**（不是超大变更集，也不是 diff + 仓级上下文）。
- 基点比较：
  - `main`（release 0.6.1）：干净，但缺 `exp-flow` 的 121 个 commit / 57 个 runtime commit，与产品现状脱节；不选。
  - `exp-multifile-recall`：有分组原型，但 M-03/M-04 仍在 DOING、源码未提交，接口不稳定；不选。
  - `exp-flow@09870c7`：有当前全部 runtime 能力，且不继承未提交原型；**选它**。
- 隔离：`.claude/worktrees/exp-repo-review`；不 checkout、不 stash 主工作区。
- 对另一会话（`exp-multifile-recall`）的影响：
  - 工作区、HEAD、index 完全独立；
  - 共享 `.git` 对象库 / refs、pnpm store、机器 CPU / 内存 / 磁盘、`~/.PiAgent/PiAgent.jsonc`；
  - 建分支本身无影响；避免并发跑大 benchmark，避免 `git clean -xdf`、`git gc --prune=now`。
- `git fetch origin` 本次因网络重置失败，基点使用本地 `exp-flow` 引用（`09870c7`）。
