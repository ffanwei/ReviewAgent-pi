# R-11 · 全仓 CLI 与 review 对齐

- Status: DONE
- Branch: `exp-repo-review`
- Created: 2026-11-25

## 需求

1. repo 复用 review 的参数口径：
   - `--taskId` **必填**，产物落到 `<tasks 根>/<taskId>/`；
   - `--tasks-dir <dir>` 只覆盖 tasks 根；
   - `--model <id>` 接受但忽略（ADR-0093 同策略），仅回显告警；
   - `--include` / `--exclude` 按仓库相对 POSIX 路径过滤，黑名单优先。
2. `--out` 保留为显式输出目录覆盖；缺省 = `<tasks 根>/<taskId>`。

## 实现

- `cli/args.ts`：repo 旗标新增 `--tasks-dir` / `--include` / `--exclude`；`--model` 在旗标循环前摘除；`--taskId` 必填并校验单段目录名；`outDir` 改为可选。
- `cli/repo-spike-command.ts`：解析 tasks 根 / 任务目录；`--out` 覆盖；非法正则与 `--model` 逐条提示；编译正则传给运行层。
- `repo-spike/enumerate.ts` / `types.ts` / `run.ts`：枚举阶段应用 include/exclude，跳过原因 `excluded-path`。
- 文档：设计文档 CLI 表、输出路径与过滤层次；ADR-0117 的 `--taskId` 口径。

## 验收

- 参数单测：缺 taskId 报错、tasks-dir/out 覆盖、model 忽略、非法正则登记。
- 枚举单测：include 命中 + exclude 优先，跳过原因 `excluded-path`。
- 进程级：repo-review 缺 taskId fail fast；带 taskId/out 的 MCP 用例保持通过。
- 全包 1309 passed / 1 skipped；typecheck 与 `pnpm build` 通过。
