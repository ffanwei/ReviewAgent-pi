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

## 2026-11-24 · 契约定稿

- 结论：输入是仓库快照，不是 diff；文件是不可拆单元；finding 锚真实文件行号；新增 `repo-review-result.json`，不伪造 MR 字段。
- CLI：产品名 `repo-review`；`repo-spike` 保留为探针，R-04 后别名或删除。
- 评测：全仓 GT 独立构造，禁止把 iterF91 / AACR 的 MR 指标换算成全仓成绩。
- 依赖：R-02 / R-03 零模型先行；R-04 才发模型请求；R-05 与 R-04 并行；R-06 可提前准备 GT。
- 文档：`docs/design/全仓扫描-方案与契约.md`（D1–D8 决策表、§10 依赖、§11 未决问题）。
