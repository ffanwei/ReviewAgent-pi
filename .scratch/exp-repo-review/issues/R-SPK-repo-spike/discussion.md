# R-SPK 讨论归档

## 2026-11-24 · spike 决策与实现

- 目标：先验证全仓检视可行性与 PR 隔离性，不直接产品化 scan。
- 取巧：把每个文件合成为「全新增」unified diff，复用 `runReviewOutcome`。
- 分组：spike 自己按目录 / 文件数 / 语言 / 单文件分组，每组一次 `runReviewOutcome`；不依赖现有字符分片（最多 64 片）。
- 运行时：注入 `buildSpikeRuntime`，不改 `DEFAULT_LIMITS`；`split.enabled=false`、`findingScope.enabled=false`、`boundary` 全开、`evidence.mode=warn`。
- 隔离：新增 `src/repo-spike/` + `repo-spike` 子命令；PR 核心零修改；独立 `--out` / `runsRoot` / `caseId`。
- Skill：`--rule-skill` / `--rule-skill-zip` / `--skill` / `--strict-rule-skill` 透传；每组独立跑一次 skill 会话。
- 结果：typecheck/build 通过；全包 1265 passed / 1 skipped；dry-run 成功。
- 语义债：合成 diff 的「全新增」语义、审计 source=mr、无覆盖账本、未跑真实模型。
- 下一步：R-01 契约 → scan Zone A → repo planner → 覆盖账本 → 全仓评测 → 产品化 `repo-review`。
