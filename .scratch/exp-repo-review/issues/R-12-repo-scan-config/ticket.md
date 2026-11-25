# R-12 · `limits.repoScan` 配置块

- Status: DONE
- Branch: `exp-repo-review`
- Created: 2026-11-25

## 需求

`config init` 生成全仓扫描缺省值，让 repo 的分组 / 上限 / 并发 / 预算 / 路径过滤可一次性配置，而不是每次传 CLI。

## 契约

- 新配置块 `limits.repoScan`：
  - `groupBy` / `maxFilesPerGroup` / `maxGroupChars` / `maxGroups` / `maxFiles` / `maxFileChars` / `maxRounds` / `groupConcurrency` / `maxTotalTokens` / `groupAttempts` / `includeTests` / `includeRegex` / `excludeRegex`。
- 优先级：**CLI 显式旗标 > `limits.repoScan` > 内置缺省**。
- `--include` / `--exclude` 出现时整体替换 `includeRegex` / `excludeRegex`；空值 = 本次清空。
- `--taskId` / `--tasks-dir` / `--out` / `--model` 不进配置。
- 取值范围与 CLI 一致；非法值装载期 fail fast。

## 实现

- `shared/config-limits.ts`：`RepoScanLimits`、`DEFAULT_LIMITS.repoScan`、`LIMITS_KEYS`、解析与校验。
- `shared/config.ts`：模板新增 `limits.repoScan` 块（`config init` 自动生成）。
- `cli/args.ts`：可配置旗标改为「只在显式传入时填值」。
- `cli/repo-scan-settings.ts`：CLI / 配置 / 缺省三级合并（纯函数）。
- `cli/repo-spike-command.ts`：用合并结果构造运行参数。
- `PiAgent.example.jsonc`：与模板同步。

## 验收

- `config init` 模板含 `limits.repoScan`，示例文件逐字节同源。
- 配置缺省 = 5 / 60k；可配、越界 fail fast、未知键仍只告警。
- 合并单测：无配置用缺省；配置覆盖缺省；CLI 覆盖配置；CLI 空 include 清空配置。
- 全包回归通过。
- 全包 1314 passed / 1 skipped；`config init` 实测输出 `limits.repoScan`；build 通过。
