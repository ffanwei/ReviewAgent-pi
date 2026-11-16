# 0092. 放宽缺省检视范围：测试文件不再跳过、Markdown 不再默认排除

**状态**：已接受（2026-11-16，用户决策：`limits.testFiles.skip` 缺省改为 `false`；`limits.mrFilter.excludeGlobs` 缺省移除 `**/*.md`）
**关联**：[ADR-0069](0069-configurable-diff-exclude-globs.md)（`excludeGlobs` 机制）、[ADR-0070](0070-single-file-truncation-and-tighter-diff-limits.md)（把 md 等四条 glob 设为缺省——本 ADR 推翻其中一条）、[ADR-0078](0078-review-scope-include-exclude-regex.md)（include/exclude 正则；其「白名单必须越过缺省排除」的论证前提随之减弱）、[ADR-0068](0068-report-every-changed-file-including-filtered.md)（被剔除文件补报空意见）、[ADR-0014](0014-rule-skill-pass-as-independent-session.md)（规则 Skill 在 Phase 5 之后独立会话检视）
**范围**：本仓 pi 线 0092。只改两个缺省值；预过滤机制、原因优先级、审计 `mrFilter`、补报语义、include/exclude 语义与边界护栏均不变。

## Context

ADR-0070 把 `limits.mrFilter.excludeGlobs` 的缺省定为 `["**/*.md", "**/*.lock", "**/fixtures/**", "**/*.snap"]`，同时 `limits.testFiles.skip` 长期缺省 `true`。这两条缺省的前提是「检视对象 = 生产代码 MR」：Markdown 被当作噪声，测试文件被当作噪声。

当检视对象变成**规则 Skill 包**或**文档为主的变更**时，这个前提失效：

- Skill 的主体是 `SKILL.md` 与 `references/*.md`；默认 glob 会在 Phase 1 之前把它们整块剔掉，模型看到的 diff 为空，后续任何规则 Skill 会话（ADR-0014）都拿不到可比对的输入。
- 只改测试文件的 MR 同样默认不可检视——这是 ADR-0068 已经实测到的空洞；当时的选择是「仍补报空意见」，而不是「检视它」。

缺省值同时承担两件事：默认行为与「白名单越过启发式」的论证前提。既然本仓明确要把文档 / Skill 变更纳入检视面，缺省应回到「尽量都检视」，把降噪交给用户显式配置。

## Decision

1. **`limits.testFiles.skip` 缺省 `false`**：测试文件与生产代码同等检视。开启（`true`）时行为与旧版一致：输入阶段整块剔除、审计 `mrFilter.test`、收尾补报空 `mrReviewResult`、Phase 5 附加提示同步。
2. **`limits.mrFilter.excludeGlobs` 缺省移除 `**/*.md`**，变为 `["**/*.lock", "**/fixtures/**", "**/*.snap"]`。Markdown 需要排除时由用户显式写回（如 `["**/*.md"]`）。
3. **机制不变**：内置原因 `binary / lockfile / minified / generated` 仍然生效且不可配置；原因优先级、`--include` 越过启发式、`--exclude` 优先、审计 `mrFilter` 的八类键序、被剔除文件补报、`limits.boundary` 体积门与分片均不改。
4. **回放 lane 钉住录制期值**：`scripts/offline-replay/lib/lane.mjs` 显式设 `testFiles = { skip: true }`、`mrFilter = { excludeGlobs: [] }`。离线 trace 录制于旧缺省，若不钉住，Phase 5 提示与 diff 形状会分叉、请求哈希命中率归零。
5. **配置模板与文档同步**：`config init` 模板、`PiAgent.example.jsonc`、CONTEXT 与运行手册按新缺省更新；ADR-0070 只加「后续修订」注记，不改正文。

## Options（为什么不是别的）

- **保持缺省，用 `--include '\.md$'` 绕过**：否。白名单是「命中即保留、未命中即剔除」，混有代码与文档的 MR 用它会连带丢掉代码；且要求每次检视都记得加旗标，属于把产品默认行为错误转嫁给调用方。
- **新增「文档检视模式」开关**：否。当前没有文档专属的检索 / 证据 / tips 契约；先放宽输入范围暴露真实问题，再决定要不要做模式分叉（属于后续产品决策）。
- **只放宽 md、保留测试文件跳过**：否。两者是同一个错误前提的两半；且只改测试文件的 MR 在 ADR-0068 里已有实测空洞，默认检视测试文件同时消除该空洞。
- **把 `testFiles.skip` 的缺省写死进 `filterDiffForReview` 而不同步配置**：否。运行期真正的配置来源是 `ConfigSnapshot`；只在入口改常量会让直调路径与 CLI 路径分叉。本次两处一起改（`DEFAULT_LIMITS` 与函数缺省参数）。

## Consequences

- **好**：Skill / 文档类 MR 默认进入检视，规则 Skill 会话（ADR-0014）拿到完整 diff；测试文件默认与生产代码同等检视，只改测试文件的 MR 不再走「全过滤 → 跳过」；默认行为与「尽量检视、显式降噪」的产品直觉一致。
- **代价 / 风险**：同样的 MR 请求体变大——测试文件与 Markdown 会消耗上下文与 token；测试噪声可能进入 findings。护栏仍在：`limits.boundary.maxDiffChars`、分片（ADR-0039）、`findingScope`（ADR-0064）与严重级 / 置信度过滤（ADR-0052）。需要旧行为的用户显式配 `testFiles.skip: true` 与 `excludeGlobs: ["**/*.md", …]`。
- **兼容性**：配置面不新增 / 不删除键，只改缺省；显式写了旧值的用户行为不变。审计 `mrFilter.test` / `exclude` 原因在缺省配置下会更少出现，属于预期。
- **测试面**：全量 vitest 1023 passed / 1 skipped（100 文件）；`pnpm --filter @baize/review-pi typecheck` 通过；离线回放 6/6（lane 显式钉住旧值）；受影响的既有用例按新语义改写（`config` / `mr-input` / `review-run` / `review-admission` / `bin.process`），其中「全被过滤」用例改用 lockfile 作为被剔除样本，不再依赖测试文件缺省。
