# R-17 大文件入口与上限调整

- Status: `DONE`
- 优先级：P1
- 分支：`exp-repo-review`

## 问题

全仓扫描缺省为 5 文件 / 60k 组 / 100k 文件。分组阶段对单文件
`size + 256 > maxGroupChars` 直接记 `group-too-large` 并跳过，导致
60–100 KB 的文件虽然被枚举 `selected`，却从未送入模型；覆盖账本只能记
`not-reached`。这类文件通常是 2,000–3,000 行的 Service / God Class，正是全仓
检视最该看的对象。

## 方案

- 缺省调整为 **5 文件 / 80k 组 / 120k 单文件**；
- `maxGroupChars` 只约束多文件装箱；单文件超过它但不超过 `maxFileChars` 时
  单独成组，标记 `soloLarge`；
- `maxFileChars` 仍是硬上限：超过才在枚举阶段记 `too-large`；
- 不拆分、不截断；>120k 仍显式跳过；
- dry-run 计划与进度行显示 `soloLarge` / `solo=true`。

## 验收

- `group.test.ts`：`none` 大文件成组、`directory` solo、估算字符边界；
- `run.test.ts`：dry-run 计划含 `soloLarge: true` 且 `skippedFiles` 为空；
- `config.test.ts` / `repo-scan-settings.test.ts`：缺省 5 / 80k / 120k；
- `config init` 模板与 `PiAgent.example.jsonc` 同步；
- 全包 **1341 passed / 1 skipped**（123 个测试文件）；typecheck、build 通过。

## 决策记录

`docs/adr/0121-repo-review-large-file-solo-and-80k-120k.md`。

## 行数折算

按 R-06 实测 Java 密度 35.2 B/行：80k ≈ 2,270 行；120k ≈ 3,400 行；
典型 5 文件组约 680 行。

## 单次文件数依据

`baseline-f91-v3` 91 条按实际送检文件数分档：1–5 与 6–10 的 B 为
32.1% / 33.9%，11–20 降到 24.5%（R −9.3pp，单样本 token +91%，
时长 +104%）；21+ 仅 4 条，不作依据。设计文档 §4.2.1 记录完整表与判读；
5 文件缺省保持不变。
