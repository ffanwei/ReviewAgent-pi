# R-SPK · 全仓检视 spike：分组 + 合成 diff + 复用 runReviewOutcome

- Status: DONE
- Branch: `exp-repo-review`
- Created: 2026-11-24
- Completed: 2026-11-24

## 目标

用最小侵入验证全仓检视的三件事：

1. 按目录 / 文件数分组是否确定、可控；
2. 把每个文件合成为「全新增」unified diff 后，现有 MR 流水线能否复用；
3. 规则 Skill 能否按组透传。

## 方案

```text
enumerateRepoFiles
  → groupRepoFiles（directory / files / language / none）
  → synthesizeGroupDiff（每组合成「全新增」diff）
  → runReviewOutcome（每组一次，复用现有 MR 流水线）
  → merge findings / usage / coverage
  → <out>/repo-spike-result.json
```

## 实现

新增：

- `packages/review-pi/src/repo-spike/{types,enumerate,group,synthesize-diff,runtime,output,run}.ts`
- `packages/review-pi/src/cli/repo-spike-command.ts`
- 测试：`enumerate.test.ts` / `group.test.ts` / `synthesize-diff.test.ts` / `run.test.ts` / `cli/args-repo-spike.test.ts`

修改：

- `src/cli/args.ts`：新增 `repo-spike` 命令、旗标、usage、校验
- `src/cli/main.ts`：dispatch；dry-run 不加载配置
- `src/cli/args.test.ts`：更新命令文案与 usage 断言
- `docs/开发指南-仓库结构与文件职责.md`：新增模块说明

未修改（PR 核心）：

`run/review-run.ts`、`run/pass-runner.ts`、`run/shard-planner.ts`、`run/coverage-ledger.ts`、`loop/*`、`gate/*`、`shared/config-limits.ts`。

## 验收证据

- `pnpm --filter @baize/review-pi typecheck`：通过
- `pnpm --filter @baize/review-pi build`：通过
- `pnpm --filter @baize/review-pi test`：115 个测试文件，**1265 passed / 1 skipped**
- repo-spike 专项：6 个测试文件，**63 passed**
- dry-run（本仓 `src/loop`）：discovered=1969，selected=15，groups=2，diffChars=99,771 / 21,736
- 报告：`.scratch/exp-repo-review/reports/repo-spike-方案报告.md` / `.pdf`

## 限制

- 合成 diff 把所有行标成 `+`；现有 diff 提示词会把既有问题当「本次新增」。
- 审计 `source` 仍是 `mr`；没有 scan 专用 manifest。
- 没有文件 × 区域覆盖账本 / scan 评测口径。
- 未执行真实模型请求（避免 API 成本）；命令与配置已就绪。
