# 0078. 检视范围正则：`--include` / `--exclude` 与 `limits.mrFilter.includeRegex` / `excludeRegex`

**状态**：已接受（2026-11-13，用户决策：要能在一次命令里指定"只检视哪些文件、再去掉其中哪些"；include 与 exclude 共存，先 include 再 exclude；空值跳过；不传入不筛）
**关联**：[ADR-0069](0069-configurable-diff-exclude-globs.md)（glob 版排除，本 ADR 新增正则版并保留 glob）、[ADR-0068](0068-report-every-changed-file-including-filtered.md)（变更文件全覆盖上报）、[ADR-0075](0075-diff-too-large-skip-with-report.md)（跳过检视仍上报空意见的既有模板）、[ADR-0064](0064-finding-scope-out-of-diff-filter.md)（输出侧范围过滤；与本 ADR 的输入侧限范围不同层）、[ADR-0025](0025-user-config-file.md)（配置面）
**范围**：本仓 pi 线 0078。只新增输入侧范围选择（白名单 + 黑名单），新增两个审计原因与 `mrFilter.filters` 留痕；其余过滤规则、输出侧过滤、findings / tips 口径不变。

## Context

用户需要"这次只检视 `src/**` 和 `packages/*/src/**`，但去掉测试与生成目录"的能力。现有配置面只能做**排除**：

- `limits.mrFilter.excludeGlobs`（ADR-0069）是 glob 黑名单，无法表达"只检视这些"；
- `limits.testFiles.skip` 是固定规则的开关；
- `limits.findingScope` / `severity` / `confidence` 都是**产物侧**过滤，不省输入、不省 token；
- `binary / lockfile / minified / generated` 是硬编码启发式，不可配。

因此需要一层 CLI 驱动的**范围选择**。用户明确要求：

1. `--include` 与 `--exclude` **共存**，先由 include 选出列表，再由 exclude 从列表里剔除；
2. 多个模式可传（"列表"），但正则里 `{m,n}`、`[,;]`、字面逗号都合法，**不能用逗号拼接**；
3. 传空值 = 跳过该维度；不传入 = 不筛，直接检视；
4. 不修改现有 glob 排除的行为。

## Decision

### 1. CLI 面：两个可重复正则旗标

```
--include <regex>   可重复，OR 语义：命中任意一条入选；出现即替换配置 includeRegex
--exclude <regex>   可重复，OR 语义：命中任意一条剔除；出现即替换配置 excludeRegex
```

- 一条正则一个 argv，**不进 `COMMA_LIST_FLAGS`**：逗号是正则的合法字符（量词 `{m,n}`、字符类 `[,;]`、字面逗号），`split(",")` 会把 `^src/a{1,3}\.ts$` 切成 `^src/a{1` 与 `3}\.ts$`——两半在 JS 里都是合法字面量，结果是**静默不命中**。也不支持空格列表（与含空格的正则不可区分）。
- 同类内多条 = OR；完全相同去重保序；大小写敏感（正则原生语义，不退化成 glob 的 `i`）。
- 空值语义（`--include ''`、纯空白、旗标后无值）：**本次清空该维度**（不筛该维度，配置默认不再生效），按 ADR-0044 的零静默口径在 stderr 打一行提示。
- 非法正则（ADR-0078 后续修订）：**只忽略该条**并逐条打 stderr 提示，不中断检视；同维度其余合法条目照常生效。配置里的 `includeRegex` / `excludeRegex` 仍在装载期 fail fast（配置文件的语法错误不该被静默吞掉）。
- 长列表（命令行超长）不在本 ADR 处理；需要时另开 `--include-file`。

### 2. 配置面：`limits.mrFilter.includeRegex` / `excludeRegex`

- 类型 `string[]`，缺省 `[]`；非空字符串、去重保序、**不 trim**（首尾空格可能是正则语义的一部分）、装载期试编译（`ConfigError`）。
- 与现有 `excludeGlobs` 并列：名字带 `Regex` 以区分方言。
- **CLI 出现即整体替换对应维度**（include 与 exclude 各自独立）；两者都缺席 = 配置值；CLI 空值 = 清空。

### 3. 判定顺序（唯一入口 `run/mr-input.ts#filterDiffForReview`）

逐文件块，先命中先落原因：

```text
1. binary                                   → drop("binary")        // 无正文，任何名单都不救
2. include 非空 且 不命中                    → drop("not-included")
3. exclude 命中                              → drop("regex-exclude") // exclude 压过 include
4. include 非空（走到这里 = 命中）            → keep                  // 显式白名单越过启发式
5. include 为空 → 原有链：
     lockfile → minified → generated → test(skip=true) → config excludeGlobs
```

关键取舍：

- **include 命中越过全部启发式**。否则默认 `excludeGlobs` 含 `**/*.md`、`testFiles.skip` 缺省 true，`--include '\.md$'` / `--include '.*\.test\.ts$'` 会静默失效。
- **binary 恒剔**：没有可检视正文，白名单不救。
- 只有 exclude 时，等价于在现有链上多加一条正则排除；`excludeGlobs` 继续生效（并集）。
- 过滤后 0 个文件块且输入本来有块 → 抛 `NoReviewableFilesError`，CLI 跳过检视（见 §5）。
- 触发条件限定为"输入有块、过滤后为 0"：输入本身就是空 diff / malformed 时仍走既有边界护栏（`boundary-unmeasurable`），不改 ADR-0012 的契约。

### 4. 匹配对象：仓库相对路径 + 一次归一化

- 匹配对象是 `blockPath()` 产出的 diff 路径（新侧优先，删除文件退回旧侧）。
- 只给**正则层**做归一化：去 git C 风格引号、解八进制（按 UTF-8 字节还原）与 `\t/\n/\"` 等转义、`\`→`/`、去一层 `a/` / `b/` 前缀。原因：`--mr-diff` 里非 ASCII 路径是 `+++ "b/\344\270\255\346\226\207.md"`，`--mr-json` 是原样路径；不归一化则同一个 `--include '^docs/design/'` 在两种输入下命中结果不同。
- 现有 glob 层（ADR-0069）**一行不改**：两层路径形态可能不同，文档写明。

### 5. 过滤后 0 个文件：跳过检视但仍上报（对齐 ADR-0075）

- 不调用模型；不写 audit / `run.json`（run 未开始）。
- 若 MCP 业务工具开启且 `startTask` 已成功：`mrReviewResult(changedFiles[0], reviewTips: [])` → `saveReviewSummary(固定文案)` → 既有 finally 发 `endTask`；`mcp.report.task=false` 时只打 stderr + stdout。
- stdout：`{ "ok": true, "caseId": …, "skipped": "no-reviewable-files", "findings": [] }`，exit 0。
- 固定总结：`# 检视总结\n\n无可检视文件，跳过检视。`
- 这是 ADR-0068"每个变更文件一条 `mrReviewResult`"在**零文件终态**下的例外：该路径只补一条任意文件（取 diff 首个可解析路径），因为检视根本没有开始；有文件进入检视时 ADR-0068 口径不变。

### 6. 审计

- `MrFilterReason` 新增 `not-included` / `regex-exclude`，`reasons` 恒含八类键（未命中为 0）。
- 新增 `mrFilter.filters.include` / `filters.exclude`：`{ source: "cli" | "config", patterns: string[] }`，记录生效规则原文。
- `mrFilter` 的出现条件从"有剔除"扩展为"有剔除 **或** 配置了范围规则"：0 剔除但配了名单时也留痕，保证 run 可复现。
- stderr 仍只在确有剔除时打一行汇总；范围规则本身由参数回显与审计 `filters` 呈现。

## Options（为什么不是别的）

- **逗号拼接多值**：否。正则自身含逗号，切分无法区分语法与内容；且会拆掉"多余 token = 错误"的护栏。实测 `new RegExp("a{2")` 不报错而是当字面量，失败是静默的。
- **include 只做"再过滤"、不越过启发式**：否。默认排除 md/test/snap 会让白名单对最常见的用途失效。
- **include 与 exclude 互斥**：否。用户明确要"先选再剔"。
- **exclude 覆盖 include**：是。黑名单是更晚、更具体的意图。
- **把二进制也放行**：否。没有可检视正文，只会浪费 token。
- **扩展现有 `excludeGlobs` 而不加新键**：否。glob 与正则方言不同，混在一个键里无法表达也无法审计。
- **过滤后为 0 仍跑空 diff**：否。白花一次模型调用，且结果不可解释；ADR-0075 已给出"跳过但上报"的成熟形态。
- **改 `changedFiles` 为过滤后集合**：否。与 ADR-0068 冲突，会把"未检视"重新变成静默空洞。

## Consequences

- **好**：一次命令即可"只看这些、去掉那些"；默认启发式不会吃掉显式白名单；0 文件不再白跑模型；规则原文进审计，run 可复现。
- **代价 / 风险**：
  - 两种方言并存（glob 配置 + regex CLI/配置），接口文案必须写清；
  - include 越过启发式意味着"include 里写了 lockfile 就会真的检视 lockfile"——这是显式选择的代价；
  - 正则大小写敏感与 glob 的大小写不敏感不同；
  - `mrFilter` 在"0 剔除但配了规则"时也会出现，下游若假设"有 mrFilter 必有剔除"需改为看 `droppedFiles`；
  - 零文件终态只补一条 `mrReviewResult`（ADR-0068 的例外）。
- **测试面**：`run/mr-input.test.ts`（OR、include 越过启发式、exclude 压过 include、binary 恒剔、UTF-8 八进制归一化、审计 `filters`/0 剔除留痕）、`cli/args.test.ts`（多值、空值、非法正则只忽略、裸 token 报错）、`shared/config.test.ts`（缺省 / 去重 / 非法正则 fail fast）、`run/review-run.test.ts`（0 文件抛 `NoReviewableFilesError` 且零模型调用）、`cli/bin.process.test.ts`（全过滤 → 跳过检视的四工具 + 固定总结 + exit 0；部分过滤仍补报）。
