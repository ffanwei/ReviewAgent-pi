# R-11 讨论归档

## 2026-11-25 · repo 参数对齐 review

- 用户要求 repo 复用 review 的 `--tasks-dir` 与 `--model` 策略，并明确 taskId 必填、产物落 `<tasks>/<taskId>`。
- 同表列出的 `--include` / `--exclude` 一并复用：作用于仓库相对 POSIX 路径，白名单先选、黑名单后剔，非法正则忽略并提示。
- `--out` 不做删除：保留为实验 / CI 的显式覆盖；缺省改为任务目录。
- `--model` 与 review 同策略：接受但忽略，模型一律取配置 `model.default`。
