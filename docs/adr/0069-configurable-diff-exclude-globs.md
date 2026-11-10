# 0069. 配置驱动的 diff 跳过：`limits.mrFilter.excludeGlobs`

**状态**：已接受（2026-11-10，用户决策：要一个配置列表，按后缀 / glob 跳过特定文件的检视，被跳过的文件仍直接上报空检视意见）
**后续修订**：[ADR-0070](0070-single-file-truncation-and-tighter-diff-limits.md) 把本键的**缺省值**从 `[]` 改为 `["**/*.md", "**/*.lock", "**/fixtures/**", "**/*.snap"]`；机制、原因口径与上报行为不变。
**关联**：[ADR-0068](0068-report-every-changed-file-including-filtered.md)（变更文件全覆盖：被过滤文件补空 `mrReviewResult`；本 ADR 复用该机制）、[ADR-0061](0061-every-diff-file-reported-before-summary.md)（每文件必报）、[ADR-0052](0052-tips-four-tier-severity-and-confidence-filter.md)（输出侧过滤；与本 ADR 的输入侧跳过不同层）、[ADR-0041](0041-language-agnostic-symbol-model-and-multi-language-extractors.md)（`codeintel.excludeGlobs` 的扫描排除；与本键作用域不同）、[ADR-0025](0025-user-config-file.md)（配置面）
**范围**：本仓 pi 线 0069。只加一个输入预过滤开关，新增 audit 原因 `exclude`；其余过滤规则、findings / tips、MCP 上报口径与退出码不变。

## Context

输入预过滤（`run/mr-input.ts#classifyBlock`）目前只认**五类硬编码原因**：`binary / lockfile / minified / generated / test`。其中唯一配置驱动的是 `limits.testFiles.skip`（布尔开关，规则固定在 `shared/test-file.ts`）。

想跳过 `.md` / `.rst` / `.txt` / 许可证文件这类「非代码变更」时，配置面没有入口：

- `codeintel.excludeGlobs` 只控制符号级工具的扫描范围（`repo-context.ts` / `rg.ts` 的 `-g` 排除），语言 glob 本来就不含 `.md`，改它等于空操作；
- `limits.confidence` / `limits.severity` / `limits.findingScope` 都是**产物侧**过滤，不省输入、不省 token；
- `limits.boundary.maxDiffChars` 是体积闸，不是类型闸。

用户口径：要一个**列表**，按后缀或路径跳过检视；并且被跳过的文件**仍然直接上报空检视意见**（不能变成「未检视」的静默空洞）。

## Decision

### 1. 新配置键 `limits.mrFilter.excludeGlobs: string[]`

- 缺省 `[]` = 不排除；非空字符串数组，去重保序，空串 / 非字符串装载期 `ConfigError`（与其他 glob 键同口径）；
- 用 **glob 列表**而不是 `skipMarkdown: true`：同一机制顺带覆盖 `.rst` / `.txt` / `LICENSE` / `*.snap`，且与 `codeintel.excludeGlobs` 的心智模型一致；后缀场景就写 `["**/*.md"]` 或 `["*.md"]`；
- 配置解析复用抽出的 `parseGlobList(value, label, fallback)`，`codeintel.excludeGlobs` 的报错文案逐字不变。

### 2. 匹配语义

- 匹配对象是 diff 里的**仓库相对 POSIX 路径**，**大小写不敏感**；
- 不含 `/` 的 glob **只比文件名**：`*.md` 与 `**/*.md` 等价，任意目录下的 md 都命中；
- `*` / `?` 不跨 `/`；`**` 跨目录，且 `**/` 可匹配零级目录（`**/*.md` 命中根 `README.md`）；
- 块级分类**排在全部内置原因之后**：`binary > lockfile > minified > generated > test > exclude`。命中的文件若已经因内置原因被剔除，只记更早的原因（不重复记账）。

### 3. 跳过发生在检视输入阶段

`filterDiffForReview(diff, { skipTestFiles, excludeGlobs })` 在**整块剔除**时使用同一套块边界，绝不切 hunk。命中块不进 diff、不产 findings、不进中文 tips / MCP 意见 —— 与 `test` 原因完全同层。

### 4. 被跳过的文件仍上报空检视意见

**不新增任何上报代码**：ADR-0068 已经把「变更文件全集」定义在**过滤前** diff（`cli/main.ts#listChangedFilePaths`），收尾对「全集 − 已上报」逐文件补 `mrReviewResult(taskId, filePath, reviewTips: [])`。`exclude` 与其余五类原因走同一条补报旁路。

因此审计原因新增 `"exclude"`（`contracts/run.ts#MrFilterReason`），`mrFilter.reasons` 恒含六类键（未命中为 0），stderr 一行与审计 `mrFilter.paths` 自动带上该原因。

### 5. 其它口径不动

- stdout / `reviews_en.json` / 退出码不变；
- 分片（`limits.split`）在过滤后执行，被 `exclude` 剔除的文件不会进入任何片；
- 体积门（`maxDiffChars`）度量的是过滤后 diff，因此排除文档可能让原本超限的 MR 通过。

## Consequences

- 文档型 MR（`docs/**` 大改、CHANGELOG、README）可以配置跳过，省输入字符与分片槽位；
- 平台仍然收到每个变更文件的一次登记，不会把「被跳过」读成「未检视」（沿用 ADR-0068）；
- 可见性：本地 stderr 与审计 `mrFilter`（`reason = "exclude"`）可区分跳过原因；
- 成本：一处分类扩展 + 配置面 + 模板 + 测试；无新增运行时依赖、无新增 CLI 旗标；
- 边界：glob 只是路径匹配，不做内容嗅探；`**` 语义是「跨目录」而非「任意层级递归」的完整 gitignore 方言（不支持 `!` 取反、`[]` 字符类、`{a,b}` 花括号）。
