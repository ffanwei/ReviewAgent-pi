# R-12 讨论归档

## 2026-11-25 · repo 缺省进配置

- 用户希望 `config init` 生成 repo 参数的默认值，避免每次手传。
- 决定新增 `limits.repoScan`，只承载分组 / 上限 / 并发 / 预算 / 路径过滤；`taskId` 是单次身份，`tasks-dir` 是环境路径，`out` 是一次性覆盖，`model` 已废弃，均不进配置。
- 优先级按 review 的 `--include/--exclude` 惯例：CLI 显式值 > 配置 > 内置；为此参数层改为「只记显式值」，合并放到 `resolveRepoScanSettings`。
