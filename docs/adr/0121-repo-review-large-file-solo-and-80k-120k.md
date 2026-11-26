# 0121. 全仓检视上限调整为 5 文件 / 80k 组 / 120k 文件，并补大文件单文件成组

**状态**：已接受（2026-11-26）
**关联**：[ADR-0117](0117-full-repo-mcp-reporting.md)（全仓上报）、[ADR-0118](0118-language-defect-checklists.md)（语言清单）、[ADR-0120](0120-finding-path-repair.md)（路径修复）
**范围**：只改全仓扫描的缺省预算与分组规则；不改 MR diff 路径、不改 `runReviewOutcome`、不改提示词。

## Context

全仓扫描原缺省是 `maxFilesPerGroup=5`、`maxGroupChars=60,000`、
`maxFileChars=100,000`。5 文件上限来自实跑（单组超过 5 个文件后注意力下降），
但两个字符上限之间存在一个死区：

```text
size ≤ 59,744            → 正常进组
59,745 ≤ size ≤ 100,000  → 枚举 selected，分组 group-too-large，从未送模型
size > 100,000           → 枚举 too-large，直接跳过
```

60–100 KB 的源码文件因此“被选中但不检视”。典型仓库影响很小（R-06 基准仓最大
文件 46.6 KB），但真实仓库里 2,000–3,000 行的 Service / God Class 正好落在这个
区间。单纯把 `maxGroupChars` 抬到 100k 仍会留下 100k 附近的新死区，且会让普通
多文件组变大。

## Decision

1. 缺省调整为 **5 文件 / 80,000 组 / 120,000 单文件**；
2. `maxGroupChars` 只约束**多文件装箱**。单文件估算 `size + 256 > maxGroupChars`
   且 `size ≤ maxFileChars` 时，**单独成组**（`soloLarge`），不再整文件跳过；
3. `maxFileChars` 仍是硬上限：超过它的文件在枚举阶段记 `too-large`，不读入、
   不拆分、不截断；
4. `groupBy=none` 下每个文件本来就是一组，所有 ≤ `maxFileChars` 的 selected
   文件都进入检视；
5. dry-run 的 `repo-review-plan.json` 在对应组写 `soloLarge: true`，进度行追加
   `solo=true`，便于审计大文件入口；
6. 按 R-06 的 Java 密度 35.2 B/行折算：80k ≈ 2,270 行，120k ≈ 3,400 行；
   典型 5 文件组约 680 行，5 文件上限先触发，普通组不会被 80k 放大。

## Consequences

- **正**：60–120 KB 的文件从 `not-reached` 变成真正 reviewed；普通仓库的分组
  形态不变（基准仓零影响）；单文件组的内容上限仍由 120k 兜底，上下文可控。
- **负 / 风险**：
  - 大文件组的单次上下文变大，注意力可能下降；影响面仅限确实存在 60 KB 以上
    源码文件的仓库；
  - 每个大文件多一次请求，成本可预期但会增加；大文件多时组数也随之增加，
    可能更早触及 `maxGroups`，需要显式调高护栏或收窄 `--path`；
  - 没有针对 80k/120k 的 A/B 精度数据；后续应在含大文件的真实仓库上补测。
- **不做**：不拆文件、不截断文件、不按 AST 切块；>120 KB 仍显式跳过，避免
  制造“只看了前半文件”的假阴性。

## 验收

- `repo-spike/group.test.ts`：`none` 模式大文件成组、`directory` 模式 solo、
  估算字符边界（恰好 80k 正常装箱、超过 1 字符 solo）；
- `repo-spike/run.test.ts`：dry-run 计划含 `soloLarge: true`，`skippedFiles` 为空；
- `shared/config.test.ts` / `cli/repo-scan-settings.test.ts`：缺省 5 / 80k / 120k；
- `config init` 模板与 `PiAgent.example.jsonc` 同步，全包测试与 typecheck 通过。
