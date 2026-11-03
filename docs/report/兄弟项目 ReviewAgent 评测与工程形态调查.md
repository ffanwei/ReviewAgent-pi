# 兄弟项目 ReviewAgent 评测与工程形态调查

> **历史文献（时效注记）**：调查对象是 DSH 线兄弟仓，本文是该仓当时的工程形态
> 本文写于评测仪器层与 `runs/**` 留痕仍在的时期。评测仪器层（数据集构造 / 判定链 / 指标聚合 /
> 实验运行器 / 字节门）已于 [ADR-0024](../adr/0024-drop-config-matrix-and-config-identity.md) 删除，
> `runs/**` 自 [ADR-0033](../adr/0033-task-id-output-location.md) 起不入库、旧目录已清理，故文中数字**不可复跑**；
> 内核四包现为 npm 上游依赖 `@earendil-works/*`（精确锁 `0.85.1`，[ADR-0035](../adr/0035-upstream-kernel-as-npm-deps-and-single-package.md)）。
> 现行形态见 [`CONTEXT.md`](../../CONTEXT.md)。

> **调查日期**：2026-09-18 · **调查人**：调查子代理（主会话委托）
> **调查对象**：`D:\xubao\code\AI4SE\ReviewAgent`（PI 项目的兄弟项目，成熟运行的 TypeScript pnpm workspace 项目）。只读调查，未修改其任何文件。
> **调查问题**：为 PI 项目（ReviewAgent-pi）的构建提供「项目介绍与评测等内容参考兄弟项目」的对齐基线——评测体系全景、项目介绍骨架、工程形态三部分。
> **引用约定**：本文所有来源引用均为**相对兄弟项目根的路径**（如 `src/metrics/verdict.ts:16` 指 `D:\xubao\code\AI4SE\ReviewAgent\src\metrics\verdict.ts` 第 16 行）；带行号的引用来自本次调查时的文件快照。查不到的一律明示「未找到/未确认」。

---

## TL;DR

- ReviewAgent 是「AI4SE 研究项目 + 企业 MR 检视产品」双重身份：核心资产是一条**核外评测工具链**（数据集 → 实验矩阵 → 四层判定链 → 指标 → 报告 → 对齐门），内核侧（检视执行本体）历经 POC1 薄 harness → DSH 内核两代，评测链对内核**同构中立**（`README.md:3-5`、`src/experiment/runner.ts:159-222`）。**PI 项目对齐的对象是核外评测链的口径与产物格式，而不是内核实现。**
- 评测集四源：vul4j（Phase 2 主数据实际使用的 30 案目标集）、defects4j（设计上的 Dataset A 主集，仅清单入库）、msb-java（真实 PR 外部效度，仅清单入库）、clean-mr（50 条阴性对照，全量交付物入库，diffSha256 强校验）（`docs/design/基于 DeepSeek Harness 的 Review Agent 总体架构设计方案.md:1334-1350`、`data/` 各清单、`runs/phase2-main/cases.json`）。
- 指标口径全部由代码钉死：S/A/B 判据（ADR-0004，S 级四判据）、line/file 双级 P/R/F1（文件∧行位∧性质、一对一贪心占用）、token 双口径（计费 / 含缓存读）、RIE/CARC、cacheHitRate 按画像分口径（ADR-0008）（`src/metrics/`）。
- 验收机制是「指标对齐门 v2」：对称 max σ 带 + 最小样本护栏 + 单元配对符号检验（ADR-0007）——**PI 内核与 DSH 内核做同评测集对比时，这扇门就是现成的协议**。
- 工程形态：pnpm workspace 三包（根包 POC1 冻结 harness / review-llm 共享缝 / review-dsh 内核）+ `scripts/` tsc 即编即跑入口；测试 vitest 全镜像布局，coverage 80% 门 + e2e 独立配置 + 确定性纪律门（零网络）双层 CI。

---

# 第一部分：评测体系全景

## 1.1 评测集构成与角色

### 1.1.1 四源角色（设计口径 vs 实际执行）

数据源规范名硬编码为四元组：`EXPERIMENT_SOURCES = ["defects4j", "vul4j", "msb-java", "clean-mr"]`（`src/experiment/plan.ts:16`）。

**设计口径**（总体架构设计方案 §7「五源组合」表，`docs/design/基于 DeepSeek Harness 的 Review Agent 总体架构设计方案.md:1334-1350`）：

| 数据集 | 条数 | 角色 |
|---|---|---|
| Defects4J（17 项目分层抽样，MR 边界过滤） | ~100 | Dataset A 主集：五配置全跑、S/A/B 判定主真值（最小修复补丁、真值最干净） |
| Vul4J 安全子集 | ~30 | Dataset D：驱动 Risk Class=High 的 C2/C3 深加载验证（CVE/CWE 标签） |
| Multi-SWE-bench Java 抽样 | ~30 | Dataset A（MR 形态）：真实 PR 上下文的外部效度检查，只跑 C/E |
| 自建 clean MR（MSB 9 仓挖 merged、无 issue 关联、未被 revert 的 PR） | ~50 | Dataset C 阴性对照：测 FP，含「主动检索是否推高无中生有率」的 A vs C 对比 |
| MCR-Bench Java（ISSTA 2026） | 556 全量参照 | Dataset B：不进主判定，用于 LLM-as-judge 校准与类别分布参照 |

**实际执行口径**：Phase 2 主数据只用 VUL4J——`runs/phase2-main/cases.json` 实际 30 案、`labels.source` 全部为 `vul4j`（本调查实测），`runs/phase2-main/runs/` 与 `judge/` 目录下也只有 `vul4j` 一级子目录；README 明确「Phase 2 主数据：30 case × 5 配置 × 3 rep = 450 单元」（`README.md:21`）。注意 `plan.json` 的 `sources` 字段记录的是计划选择面（默认全四源，`src/experiment/cli.ts:109`），实际入样案集由 `--cases-file` 注入的物化文件决定——判定「一场实验用了哪些数据」的权威是 `cases.json` 而非 `plan.sources`。

MCR-Bench 校准有代码实现（`src/calibration/agreement.ts` / `mcr-bench.ts` / `run.ts`），但 MCR-Bench 数据本身不在仓库内（设计文档标注「license 核查后用」，`docs/design/基于 DeepSeek Harness 的 Review Agent 总体架构设计方案.md:1350`）。AACR-Bench 仅有接入方案文档（`docs/design/AACR-Bench 公开评测接入方案.md`），`src/` 下无对应实现——**未确认已实现**（本调查 grep `aacr|AACR` 在 `src/` 零命中）。

### 1.1.2 MR 构造方法：逆补丁法（评测语义的地基）

所有带真值数据集共用**逆补丁法（Inverse-Patch）**：base 为修复后版本，MR diff 为修复补丁的逆 diff（合入即回到历史真实 buggy 版本），真值 = 最小修复补丁的精确行位与性质（`CONTEXT.md:128-134`「逆补丁法」条目、`src/contracts/mr-case.ts:15-16` 契约头注释）。真值可从修复补丁机械推导，无需人工标注（`docs/design/VUL4J 评测方案与数据复制指南.md:159-161`）。

### 1.1.3 vul4j：目标集 + 冒烟集

`data/vul4j/` 下四个文件（`data/vul4j/` 目录清单）：

| 文件 | 内容 | 角色 |
|---|---|---|
| `target-manifest.json` | 抽样留痕清单（见 §1.2） | 30 案的选择依据，可复制性锚点 |
| `target-cases.json` | 物化后的 30 条 `MRCase[]`（repoPath / diff / issueDescription / truth / labels / extensions） | **实验直接输入**（`pnpm experiment --cases-file` 的对象） |
| `smoke-cases.json` | 3 条冒烟切片 MRCase（含 VUL4J-38） | 链路预检（`docs/design/VUL4J 评测方案与数据复制指南.md:58-60`） |
| `fix-commit-dates.json` | 各 case 修复合入时间戳（caseId / repoSlug / fixSha / fixCommitAt） | 时点口径辅助数据 |

来源链全程留痕于 manifest（`docs/design/VUL4J 评测方案与数据复制指南.md:21-28`）：VUL4J CSV 129 条 → 带 CWE 标注 66 条 → diff 可达 65 条（1 条 404 剔除）→ 剥测试/二进制节 → CWE 分层确定性抽样 30 案。

评测口径三要素（README 明文）：**物化仓（base 态）+ 数据集原生 diff + 数据集原生英文 issue**——issue 改自编文本属「口径污染」（`README.md:69`）。

### 1.1.4 defects4j / msb-java：清单入库、产物留本机

两源仅有 sampling-manifest 入库，物化产物（MRCase JSON）落 `.cache/`（gitignored，`README.md:149` 入库约定表）。角色与边界由清单自带：

- `data/defects4j/sampling-manifest.json`：seed `poc1-d4j-2026`、targetTotal 100、17 个 project 的 `bugCount` / `sampledBugIds`；`bugCountsVerified: true`、`bugIdPoolsVerified: false`（如实声明校验边界）。
- `data/msb-java/sampling-manifest.json`：seed `poc1-msb-java-2026`、targetTotal 30、**by-repo 分层**、显式 `boundary: {maxFiles: 10, maxDiffLines: 2000}`、pool 128 / eligible 124 / rejected 4（`too-many-files`）。

### 1.1.5 clean-mr：阴性对照集（误报率基准）

`data/clean-mr/` 是唯一「清单 + 全量 diff 交付物」入库的数据集（50 个 `.diff` 文件 + `manifest.json` + `README.md`，`data/clean-mr/` 目录）。设计定位（`data/clean-mr/README.md:1-5`）：50 条 merged、无 issue 关联且未被 revert 的真实 GitHub PR，构造**无真值阴性对照**，专测 False Positive（config A vs C：主动检索是否推高无中生有率）；候选仓库与 MSB Java 子集相同的 9 仓。

FP 口径代码化：`truth === null` 时每条 Finding 计 1 FP、无 Recall/Precision 分母（`data/clean-mr/README.md:54-55`、`src/metrics/screening.ts:103-120` `screenCleanMr`）；不进主指标与 S/A/B 判定，报告单列（`src/experiment/report.ts:47-48`）。

### 1.1.6 验证域与边界过滤

质量结论锚定的输入域：**≤10 文件、diff ≤2K 行**（`CONTEXT.md:140-143`「验证域」）。MR 边界过滤作为数据装载的最终防线统一应用（`src/experiment/datasets.ts:21`、`:149-162` `applyBoundaryFilter`，实现于 `src/dataset/mr-boundary-filter.ts`）。

## 1.2 数据清单（manifest）格式

### 1.2.1 vul4j / msb-java：抽样留痕清单

共同骨架（`data/vul4j/target-manifest.json` 顶层字段，msb 同构）：

```
seed / targetTotal / minPerStratum / stratification（自然语言描述抽样协议）
poolTotal / eligibleCount / rejectedCount / rejectedByReason{...}
pool[]（全量池条目） / sampled[]（入样条目，= targetTotal 条） / total
```

池条目字段（vul4j 侧，`data/vul4j/target-manifest.json` pool[0]）：`vulId / cveId / cweId / cweName / owaspId / repoSlug / fixCommitUrl / fixSha / nature / natureMatched / fetchStatus / parseStatus / excludedTestFiles[] / excludedBinaryFiles[] / files / changedLines / status / rejectReason`。msb 侧为 `instanceId / org / repo / number / files / changedLines / status / rejectReason`。

抽样协议是**确定性纯函数**：vul4j 按 CWE id 比例（最大余数法）+ 层内 mulberry32（种子 = `hash("poc1-vul4j-2026:<cwe>")`）（`data/vul4j/target-manifest.json` stratification 字段；`docs/design/VUL4J 评测方案与数据复制指南.md:30-34`）。「同种子同输入重跑得到相同 30 案」，复制核对以 `seed/targetTotal/poolTotal/eligibleCount/rejectedByReason` 字段 + vulId 列表一致为准（`docs/design/VUL4J 评测方案与数据复制指南.md:62`）。

### 1.2.2 clean-mr：带规则文本与 FP 口径声明的清单

`data/clean-mr/manifest.json` 顶层：`schemaVersion / source / generatedAt / generator（脚本名+配额）/ target{total, perRepoQuota, scan} / rules{...} / negativeControl{...} / repos[9] / cases[50] / total`。

三个独特块（`data/clean-mr/manifest.json` 实测）：

- `rules`：**显式挖掘规则文本**——merged 判定、issueLink（逐字移植 Multi-SWE-bench `extract_resolved_issues` 的正则与关键词）、revertPr、revertedByLaterPr、dependencyBump、javaFile，含已知口径差异声明（`issueLinkPort` 条目）。
- `negativeControl`：FP 口径声明——`truthPolicy: "none"`、`fpCriteria: "every-finding-counts-as-fp"`、`comparison: {dimension: "active-retrieval-vs-diff-only", configA, configC, metric: "false-positive findings per clean MR"}`。
- `repos[]`：每仓采集统计（scannedPrs / evaluated / accepted / selected / quota / rejectedByReason 分类计数）。

case 条目字段：`caseId / org / repo / number / title / bodyPreview / htmlUrl / mergedAt / baseRef / baseSha / mergeCommitSha / diffFile / diffSha256 / diffBytes / metrics{files, addedLines, removedLines, changedLines, totalDiffLines}`。

**完整性校验**：`diffSha256` 为 diff 文件的 sha256，装载时默认强校验（数据损坏显式失败、失败项显式收集）（`data/clean-mr/README.md:51-53`；消费入口 `cleanMrCasesFromManifest`，`src/dataset/clean-mr/manifest.ts`）。独立校验脚本 `scripts/verify-clean-mr-dataset.ts` + 离线回归测试 `tests/clean-mr/dataset.test.ts`（`data/clean-mr/README.md:37-47`）。

### 1.2.3 MRCase：下游统一契约（数据集无关的适配接口）

所有数据集最终产出满足 `MRCase` 契约的数组（`src/contracts/mr-case.ts:13-38`）：

```ts
MRCase = { caseId, repoPath, diff, issueDescription,
           truth: MRTruth | null,          // clean MR 为 null
           labels: { source, riskClass: Low|Medium|High, allowedConfigs: ConfigId[] },
           extensions?: Record<string,string> }  // 数据源私有元数据，harness 不消费
MRTruth = { locations: TruthLocation[], fixPatch }   // TruthLocation = { file, lineStart, lineEnd, defectNature }
```

换数据集 = 新写一个「CSV/元数据 → eligible 池 + 确定性抽样」生成器 + 一个「池条目 → MRCase[]」物化器，下游全部复用（`docs/design/VUL4J 评测方案与数据复制指南.md:145-151`）。

## 1.3 评测 harness

### 1.3.1 入口脚本（scripts/ 与 package.json 一一对应）

运行形态为「tsc 即编即跑」：`pnpm exec tsc --outDir .tmp-gen scripts/<x>.ts && node .tmp-gen/scripts/<x>.js`，产物落 `.tmp-gen/`（不入库）（`README.md:29`、`package.json:17-23`）。全部脚本入口（`scripts/` 目录 + `package.json` scripts）：

| 脚本 | pnpm 命令 | 用途 |
|---|---|---|
| `run-experiment.ts` | `pnpm experiment` | 实验运行器主入口（26 行薄壳，`main` 在 `src/experiment/cli.ts`）（`scripts/run-experiment.ts:23-26`） |
| `run-alignment-gate.ts` | `pnpm alignment-gate` | 指标对齐门 v2 复算（纯离线）（`scripts/run-alignment-gate.ts:1-16`） |
| `analyze-phase2.ts` | `pnpm analyze:phase2` | Phase 2 六面分析一键复算（`scripts/analyze-phase2.ts:1-14`） |
| `materialize-vul4j.ts` | `pnpm materialize:vul4j` | 数据集物化（tarball 下载 → 逆补丁 MRCase）（`scripts/materialize-vul4j.ts:1-25`） |
| `run-claude-code-reference.ts` | `pnpm reference` | Claude Code 外部参照运行器（单列报告，不进 S/A/B）（`README.md:58`） |
| `run-sharding-validation.ts` / `analyze-sharding-validation.ts` | `sharding-validation` / `sharding-analysis` | 切分 v2 验证（ADR-0009 面） |
| `generate-vul4j/d4j/msb-manifest.ts` | — | 三源清单生成器（`docs/design/VUL4J 评测方案与数据复制指南.md:151`） |
| `collect-clean-mrs.ts` / `verify-clean-mr-dataset.ts` | — | clean-mr 采集（断点续采、预算 1500 次 API）与独立校验 |

### 1.3.2 一次评测的完整流程（输入 → 运行 → 评分 → 产出）

CLI 形态（`src/experiment/cli.ts:48-54`）：

```bash
pnpm experiment -- --id <experiment-id> \
  --cases-file data/vul4j/target-cases.json \
  [--clean-mr --clean-mr-repo <path>] \
  --configs A,B,C,D,E --reps 3 \
  --kernel poc1|dsh --model <id> \
  --judge --judge-model glm-5-3-260814
```

完整流程（`src/experiment/cli.ts:404-612` `runExperimentCli` → `executeCli`，逐环节）：

1. **参数解析与计划校验**：`parseExperimentArgs`（表驱动 flag）→ `cliOptionsToPlan`（zh 语言要求 kernel=dsh 的预检等）→ `validateExperimentPlan`（fail fast：id 格式、configs A–E、reps ≥1、`deepseek-v4-pro` 强制 highRiskOnly 成本护栏等，`src/experiment/plan.ts:121-201`）。
2. **`.env.local` 装载**：自动装载、已有非空环境变量优先、摘要只报键名与行号（key 绝不回显）（`src/experiment/cli.ts:425-431`、`README.md:114`）。
3. **环境校验**：`checkExperimentEnv`——`REVIEWER_API_KEY`（旧名 `DEEPSEEK_API_KEY` 兼容）恒需；`--judge` 另需 `JUDGE_API_KEY`（`src/experiment/cli.ts:432-444`）。
4. **留痕与异构预检**：`reviewerBaseUrl` 写入 plan（「连到哪」入 manifest、绝不记 key）；judge 与被测同源且双侧官方端点即报错阻断（不烧检视预算），任一侧自定义接入点降级 warning（`src/experiment/cli.ts:445-468`、ADR-0008）。
5. **数据装载**：`loadExperimentCases`——cases 文件（形状校验、逐 case 失败留痕）+ clean-mr（sha256 校验）+ 边界过滤（≤10 文件 / ≤2K 行）（`src/experiment/datasets.ts:48-71`）。
6. **计划展开**：`expandPlan` → 单元序列 `(source, caseId, configId, rep)`，顺序 case → config(A–E) → rep 1..N；排除 case 留痕 `SkippedCase{reason}`（五种 SkipReason，不静默跳过）（`src/experiment/plan.ts:204-233`）。
7. **逐单元执行**（`src/experiment/runner.ts:159-222` `executeUnit`）：
   - **检视调用（review 主流程的两个入口）**：`--kernel poc1` → 进程内 `runReview(CONFIGS[configId], mrCase, llmClient, …)`（`src/run/run-review.ts`）；`--kernel dsh` → 长驻内核 host 进程 JSON-RPC `review/run`（`src/experiment/dsh-kernel.ts`），configId 逐单元切 preset，返回与 POC1 **同构的 RunResult**，下游零改动；model / outputLanguage 随请求透传，**回传与 plan 漂移即拒绝落盘**（口径诚实护栏）。
   - 审计落 `runs/<id>/audit/<source>/<caseId>/<configId>/rep-N/`；可选 Verifier 二遍复核（消融开关，usage 计入 CARC）；记录落 `runs/<id>/runs/<source>/<caseId>/<configId>/rep-N.json`（`RunStore.save`）。
   - **失败隔离**：单单元失败留痕（failures）不拖垮整批（`src/experiment/runner.ts:24-25`）。
8. **断点续跑**：启动时读全部既有记录，model / verifier / outputLanguage 与计划不符即报错（防静默重跑烧钱）；`cases.json` 案集不一致即拒绝续跑（`src/experiment/runner.ts:277-312`、`:362-391`）。
9. **报告装配**：`buildExperimentReport` → `report.json` + `human-review/forms.json` + `dashboard.md`（`src/experiment/cli.ts:590-612`）。judge 阶段独立断点续跑（`judge/<source>/<caseId>/<configId>/rep-N.json`，`src/experiment/report.ts:443-480`）。
10. **退出码契约**：0 = 完成（单元级失败已隔离留痕）；1 = 一条记录都没产出；2 = 用法/环境/配置错误（`src/experiment/cli.ts:52-54`）。

### 1.3.3 实验配置 A–E（被测自变量）

矩阵真源是 `CONFIGS` 字节级固定表（`src/contracts/config.ts:23-46`）：

| 配置 | toolsEnabled | prefetch | fullRepo | stablePrefix | ledger | 语义 |
|---|---|---|---|---|---|---|
| A | ✗ | ✗ | ✗ | ✗ | ✗ | 零工具，纯 MR 上下文 |
| B | ✗ | ✓ | ✗ | ✗ | ✗ | A + 确定性预取（Diff → Symbol → Reference → Call Chain） |
| C | ✓ | ✗ | ✓ | ✗ | ✗ | 工具 + 全仓注入（锚配置，带预算守卫） |
| D | ✓ | ✗ | ✗ | ✓ | ✗ | 工具 + 自主拉取 + 稳定前缀 |
| E | ✓ | ✗ | ✗ | ✓ | ✓ | D + Context Ledger |

每案可经 `labels.allowedConfigs` 限制适用配置（与计划配置求交，`src/experiment/plan.ts:267-273`）。另有外部参照伪配置位 `"claude-code"`：仅作指标分组键，永不进入计划与 S/A/B 判定（`src/contracts/config.ts:10-20`）。

### 1.3.4 运行纪律（长跑实操，写在方案文档 §8）

并行 = 案级不相交分片 + **新 experiment id**（数据集守卫拒绝同 id 不同案集）；Windows 停进程纪律（绝不用 TaskStop）；judge 格式错误删留痕重跑；单案 15 单元冒烟作预算锚点（`docs/design/VUL4J 评测方案与数据复制指南.md:132-139`）。

## 1.4 指标口径

### 1.4.1 四层判定链（评测的骨架）

**原生真值（逆补丁法）→ 规则粗筛 → LLM-as-judge（异构）→ 人工抽检**（`README.md:19`、`src/metrics/types.ts:9`、`docs/human-review-sampling-protocol.md:4`）。

**第 2 级：规则粗筛**（`src/metrics/screening.ts`，纯函数）——Finding × TruthLocation 匹配口径三条件（`src/metrics/screening.ts:13-25`）：

1. 文件匹配：路径归一后字符串相等（`\`→`/`、去 `./`、去 diff `a/`|`b/` 前缀、折叠重复 `/`）；
2. 行位匹配：`finding.line` 落在 `[lineStart - tol, lineEnd + tol]`（tol 默认 **0**，`src/metrics/types.ts:36-40`）；
3. 性质匹配：category 与 defectNature 归一（trim + 大写 + 别名表）后相等，词表为 `DEFECT_NATURES`（`src/dataset/defect-nature.ts`，真值侧 fail fast、Finding 侧容忍词表外记 NO_NATURE_MATCH）。

line-level = 1∧2∧3；file-level = 1∧3。**一对一贪心占用**（先精确区间后容差带，确定性按下标顺序）；FP 归因四类 + clean MR 专属一类：`NO_FILE_MATCH / NO_LINE_MATCH / NO_NATURE_MATCH / DUPLICATE / CLEAN_MR`（`src/metrics/types.ts:43-53`）。

**第 3 级：LLM-as-judge**（`src/judge/orchestrate.ts`）——LLM-Hit-Judge 卡片匹配协议，系统提示词为 MCR-Bench 官方原文 + 两条标注的扩展判据（`src/judge/prompt.ts:1-13`）；judge 失败时该单元 judge 指标回落 rule 值（`src/judge/orchestrate.ts:15-20`）。协议参数（`docs/design/VUL4J 评测方案与数据复制指南.md:99-106`）：

- judge 模型必须与被测**异构**（精确同 id 或同已知 provider 家族即同源；同源 + 双侧官方端点启动即拒，`CONTEXT.md:122-124`）；Phase 2 用 `glm-5-3-260814`。
- 校准参数锁定 MCR-Bench 论文值：**temperature 0.2 / top_p 0.95**；max_tokens 按模型族（glm 系推理模型 32768，gpt 系/未知 8192）。
- 有界重试：仅 429/500/503/网络/超时（3 次指数退避）；格式错误与截断**不自动重试**。
- clean MR（truth=null）与零 finding 不调用 judge（平凡）。

**第 4 级：人工抽检**（`docs/human-review-sampling-protocol.md`）——10% 分层抽样（disagreement / agreement / no-judge 三层独立抽 `ceil(n×0.1)`），确定性选择（FNV-1a32(seed + " " + unit.key)，与输入顺序无关）；表单含 MR 材料 + 逐条 FINDING / MISSED_TRUTH 裁定条目；裁定回收后量化 judge 可信度。协议版本号常量 `HUMAN_REVIEW_PROTOCOL_VERSION` 在 `src/sampling/review-plan.ts`（`docs/human-review-sampling-protocol.md:3`）。

### 1.4.2 P/R/F1 计法

`Recall = tp/(tp+fn)`；`Precision = tp/(tp+fp)`；`F1 = 2PR/(P+R)`；分母为零显式处理：无真值（clean MR）→ recall = null；零 finding → precision = null（`src/metrics/quality.ts:3-15`）。file-level 与 line-level 同一套公式（`src/metrics/quality.ts:4`）。

### 1.4.3 S/A/B 判级（ADR-0004）

锚 = **配置 C 的 rep2+ 热口径**；判据输入取 rep2+（热稳定）主口径均值；Recall/Precision/Token 为相对锚倍乘、Cache Hit 为绝对阈值（`src/metrics/verdict.ts:17-27`）。默认阈值（`src/metrics/types.ts:341-345`）：

| 档 | 判据 |
|---|---|
| **S** | Recall ≥ C×90% ∧ **Precision ≥ C×100%** ∧ Token ≤ C×30% ∧ Cache Hit ≥ 85% |
| **A** | Recall ≥ C×80% ∧ Token ≤ C×30% ∧ Cache Hit ≥ 80% |
| **B** | Recall ≥ C×70% ∧ Token ≤ C×50%（无缓存判据） |

裁决要点（`docs/adr/0004-s-grade-includes-precision-not-tool-calls.md`）：S 级纳入 Precision（防「滥报换检出」策略性冲线）；**不设 Tool Calls ≤ C×30% 门槛**（锚 C 全仓注入下工具调用基数低，结构性不可达；工具调用数仍在 Agent Efficiency 指标组报告）。档位取全部判据通过的最高档；无档通过 → `BELOW_B`；锚不可用（Recall/Token 缺失）→ `NOT_EVALUABLE`；锚 Precision 缺失时 S 级该判据按未通过处理（保守，不升级 NOT_EVALUABLE）（`src/metrics/verdict.ts:22-25`）。比较带 ε=1e-9 容差（`src/metrics/verdict.ts:30`）。阈值可经 options 覆盖（`src/metrics/types.ts:396-399`）。论文写作采用 ADR-0004 口径（`docs/adr/0004:20`）。

**重要 caveat（呈现纪律）**：主数据上锚 C 实测塌缩（热 recall 0.0097），「B=S 的实证内核是 B 显著优于塌缩的锚，不是达到高质量水位」——引用 S 档结论必须连同注记（`docs/report/Phase 2 主数据分析报告.md:54-62` §3.3）。

### 1.4.4 Token 成本与 Cache 命中计量

Token 记账口径（DeepSeek 语义，`src/metrics/tokens.ts:7-23`）：

```
uncachedInputTokens = usage.inputTokens（prompt_cache_miss_tokens）
cachedInputTokens   = usage.cacheReadTokens（prompt_cache_hit_tokens）
cacheWriteTokens    = usage.cacheWriteTokens（通常 0；计入总输入）
totalInputTokens    = 三者之和
totalTokens         = totalInputTokens + outputTokens     ← RIE 分母与 S/A/B Token 判据口径
cacheHitRate        = cachedInputTokens / totalInputTokens（分母 0 → null）
```

**token 双口径并列**（预算与报告必须双列）：计费口径 = uncachedInput + output；含缓存读口径 = totalInput + output（`docs/design/VUL4J 评测方案与数据复制指南.md:117-120`、`docs/report/Phase 2 主数据分析报告.md:184`）。

**分口径纪律（ADR-0008，画像表驱动）**：模型 id pattern → 画像三维度（thinking 序列化 / completion 信封 / usage 能力声明）单源查表（review-llm `profileOf`）；画像声明无缓存计量的 provider → **cacheHitRate 记 null（N/A，未知 ≠ 0）**、CARC 记保守上界（cached 记 0 = 全输入按未命中计价，方向性安全）（`docs/adr/0008-reviewer-model-swappable-with-capability-scoped-metrics.md:9-13`、`src/metrics/tokens.ts:26-49`）。跨模型对比：Cache-Hit-Rate 只在声明缓存计量的模型间可比；CARC 恒可比但无计量侧偏高（`docs/adr/0008:27`）。

派生效率指标（`src/metrics/efficiency.ts:3-29`）：

```
RIE  = line-level Recall × Precision / (Total Tokens / 1K)
CARC = uncachedInputTokens + cacheWriteTokens + outputTokens + toolCostTokens
```

工具成本计价可配置（`fixedCostPerCall × 调用次数 + costPerResultChar × 结果字符数`，默认全 0 不计价；数据取自 `audit.toolCallLog`）（`src/metrics/tokens.ts:51-65`）。

统计聚合：冷热分层——rep1（冷）单列、rep2+（热）为主口径；先 case 内热均值再跨 case 均值 ± 标准差（每 case 等权）；另有逐 repIndex 预热曲线（`src/metrics/types.ts:248-304`）。指标字段全集 `METRICS_FIELDS` 24 项为可枚举词表（`src/metrics/types.ts:186-211`）。

### 1.4.5 指标对齐门 v2（验收协议）

**门是「换实现后指标对齐」的验收机制**——PI 项目与 DSH 项目对比评测的现成协议。协议五要点（`docs/adr/0007-alignment-gate-protocol-v2.md:3`、`src/metrics/alignment-gate.ts:5-26`）：

1. **对称 max σ 带**：带宽取两侧样本 σ 较大者、中心为基线均值（方向无关）；#29 单侧带以「遗留列」并列报告（协议变更可见性）；
2. **最小样本护栏**：任一侧 n < 3 的格标 `INSUFFICIENT_SAMPLE` 不判定（不 FAIL）；
3. **单元配对符号检验为主判据**（噪声对照在场时）：精确二项、α=0.05，按单元键跨三侧配对、平局剔除、仅显著更差方向 FAIL；配对 PASS 的指标其带外格不触发 FAIL；NOT_TESTED / 噪声缺席回落格判定；
4. **advisory 面**：judged n < 15 样本量建议（取最小侧）+ 两侧执行窗间隔 > 48h 时点配对预警（跨日部署漂移）；
5. 遗留带并列报告不删除。

缺省判定四指标：`lineRecall / linePrecision / totalTokens / cacheHitRate`（`src/metrics/alignment-gate.ts:28-34`）。CLI：`pnpm alignment-gate -- --baseline <dir> --candidate <dir> [--noise <dir>]`，退出码 PASS/INCONCLUSIVE→0、FAIL→1、错误→2；门 JSON 留痕（`scripts/run-alignment-gate.ts:8-11`、`README.md:55`）。门不进 CI（输入是 runs/ 留痕，不入仓）（`docs/adr/0007:19`）。分层落位：metrics 纯函数 + experiment 加载器 + scripts 薄 CLI，与实验报告同一指标管线（杜绝门自造第二套口径）（`docs/adr/0007:10`）。

### 1.4.6 质量门全景

| 门 | 内容 | 位置 |
|---|---|---|
| 确定性纪律门 | 具名 gate 套件、零网络强制进 CI（#28） | CI |
| 指标对齐门 | 真实网关重跑 vs 参照实现对照（#29，v2 协议 #31） | 手动 |
| 噪声底校准 | 冻结 harness 自身重跑判不过 ±1σ 门（#30） | 手动 |
| 完成预算门 | judge completion 容量随模型族（#39） | 实现层 |
| 噪声控制门 | 数据采集窗 ≤48h（#36） | 运行期 |

（`docs/design/VUL4J 评测方案与数据复制指南.md:123-130`）

## 1.5 报告产物

### 1.5.1 实验目录布局（runs/<experimentId>/）

```
runs/<id>/
├── plan.json            # 实验计划留痕（含 model + reviewerBaseUrl，绝不记 key）
├── cases.json           # 入样案集快照（续跑一致性守卫的对照面）
├── failures.json        # 失败单元留痕（每次运行覆盖为最新状态）
├── report.json          # canonical 全量报告（自动生成）
├── dashboard.md         # 自动看板（自动生成）
├── REPORT.md            # 人写结论文档（入库例外，仅网关实验有）
├── runs/<source>/<caseId>/<configId>/rep-N.json     # 每单元 RunRecord
├── audit/<source>/<caseId>/<configId>/rep-N/        # 审计（可重放请求字节）
├── judge/<source>/<caseId>/<configId>/rep-N.json    # judge 判定留痕（断点续跑）
└── human-review/forms.json                           # 人工抽检表单
```

（`src/experiment/runner.ts:87-90` 文件名常量、`src/experiment/run-store.ts:12-19` 与 `:166-170` 布局、`runs/dsh-vul4j-gateway/` 实测目录）入库约定：`runs/**` 不入库，**`runs/**/REPORT.md` 是唯一例外**（实验结论文档）（`README.md:145-148`）。

### 1.5.2 runs/REPORT.md 的确切结构

`runs/` 顶层无总 REPORT.md，入库的是各实验目录下的 `runs/<id>/REPORT.md`（现存 5 份：`poc1-vul4j-gateway` / `-r2` / `dsh-vul4j-gateway` / `dsh-gateway-smoke-r3` / `poc1-vul4j-smoke`）。以 `runs/dsh-vul4j-gateway/REPORT.md` 为范本的结构（全 23 行）：

1. **标题**：`# <实验名>（<目的/票号>）`——实验 ID 命名带上目的短语与关联 issue 号；
2. **元数据 bullet 块**（`- **键**: 值` 形式）：实验 ID / 日期 / 规模（case × config × rep = 单元数与完成率）/ 模型（含网关与 ADR 锚定说明）/ 运行时（kernel）/ 对照基线（runs 目录引用）（`runs/dsh-vul4j-gateway/REPORT.md:3-8`）；
3. **`## 结论`**：一段加粗的一句话判定 + 归因指向 + 「完整对照表见 docs/report/<对应报告>」的指针（`:10-14`）——**runs/REPORT.md 是短版结论 + 指针，长表在 docs/report/**；
4. **`## 预算`**：总 token 实际账（未命中/命中/输出三分解 + 与基线的倍率）（`:16-18`）；
5. **产物索引行**（斜体尾注）：report.json / dashboard.md / runs/**/rep-*.json / audit/** 的角色说明与关联冒烟 REPORT 指针（`:22`）。

冒烟版可更短（标题 + 4 条元数据 + 结果 + 意义，`runs/dsh-gateway-smoke-r3/REPORT.md`）。

### 1.5.3 report.json（canonical 数据）与 dashboard.md（自动看板）

`ExperimentReport` 字段全集（`src/experiment/report.ts:134-156`）：`experimentId / plan / executed / resumed / failed / failures / corruptRecordFiles / caseCount（主集）/ negativeControlCaseCount / metrics / verdicts / negativeControl / verifierAblation / dedup / cacheBreaks / judge / humanReview`。口径纪律：clean MR 不进主指标与 S/A/B、单列 FP 报告；Verifier on 时主口径 = 复核后 Finding + 合并 usage（`src/experiment/report.ts:45-52`）。

`dashboard.md` 由 `renderDashboardMarkdown` 确定性渲染（`src/experiment/dashboard.ts:7-14`），章节序：标题 + model/units 摘要 → S/A/B verdicts 表（锚可用性 + Config|Outcome|Recall|Total tokens|Cache hit|Basis）→ **Metrics — rep2+ hot（主口径）** → Metrics — rep1 cold → 预热曲线 → 阴性对照 → Verifier 消融 → Ledger 去重 → Cache Breaks → judge → 人工抽检 → failures → 损坏记录。指标按四组分组行序：Review Quality / Context Efficiency / Agent Efficiency / Cache Efficiency + Derived（RIE/CARC）（`src/experiment/dashboard.ts:31-45`）。

### 1.5.4 docs/report/ 行文约定

六份既有报告（`docs/report/` 目录：POC1 实现报告 / DSH 迁移实现报告 / DSH 指标对齐门报告 / DSH 指标对齐门噪声底报告 / Phase 2 主数据分析报告 / 生产化可行性事实调查）呈现的稳定范式：

1. **头部 blockquote 元数据**：`> 范围 / 交付形态 / 数据底盘 / 报告日期`（`docs/report/Phase 2 主数据分析报告.md:3-6`）；调查类报告另加 `> 调查日期 / 调查人 / 调查问题 / 性质声明（只做事实汇总不做判断）/ 调查时工作区状态`（`docs/report/生产化可行性事实调查.md:2-6`）。
2. **§1 概述与一句话结论**——首段交代数据齐备性，次段加粗一句话结论（结论 + 关键数字 + 最大 caveat）（`docs/report/Phase 2 主数据分析报告.md:8-12`）。
3. **§2 复算路径（「无手抽数字」声明）**：全部表格由复算脚本一键重放（`pnpm analyze:phase2`），报告表格与脚本输出逐项对应；数字来源仅三类——canonical report.json、判定留痕、gate JSON（`docs/report/Phase 2 主数据分析报告.md:14-19`）。**这是最核心的行文纪律：结论表格必须可机器重放。**
4. **表格编号体系**：T1–T8 编号表 + 表头内标注口径（如「main 侧 judge 口径每配置 90 单元均值」）；口径标注约定：**rule 口径** = 规则粗筛直接产出，**judge 口径** = 判定链裁定后（`:21`）。
5. **caveat/判读纪律显式成节**：如 §3.3「锚塌缩与判定语义注记（本报告最重要的 caveat）」——判定按协议机械呈现并全程注记，论文引用须连同注记（`:54-62`）。
6. **固定收尾章节**：预算总账（token 双口径并列）、人工抽检状态（**未完成就如实标注「裁定未回收」**，不以自动化替代）、口径衔接说明（跨阶段口径对照表）、ADR 按需评估（说明本票无新架构决策）、来源与产物索引（本机留痕路径清单表）（`:205-261`）。
7. 实现报告类则用：概述 / 需求与任务结构 / 架构决策（ADR）/ 核心交付（4.x 小节）/ 实现规模 / 质量保障 / 交付与验证状态 / 遗留事项与下一步（`docs/report/POC1 实现报告.md` 目录结构）。

---

# 第二部分：项目介绍骨架

## 2.1 四份入口文档的职责划分

| 文档 | 职责 | 读者 |
|---|---|---|
| `README.md` | 项目门面：定位 + 研究设计 + 仓库结构 + 快速开始 + 命令 + 凭据 + 入库约定 + 参考项目 + 文档地图 + 协作约定 | 人类（新加入者/复现者） |
| `CONTEXT.md` | **领域词汇表（术语唯一权威，单一上下文）** | 人 + agent（所有协作方共用） |
| `CLAUDE.md` | Claude Code 的仓库指引（仅 agent skill 索引，17 行） | Claude Code |
| `AGENTS.md` | Codex 的仓库指引（与 CLAUDE.md **逐字同构**，仅首行工具名不同） | Codex |

CLAUDE.md 与 AGENTS.md 结构完全一致（`CLAUDE.md` / `AGENTS.md` 全文对照）：一句定位 + 三个 skill 小节——Issue tracker（GitHub Issues + `gh` CLI，详见 `docs/agents/issue-tracker.md`）、Triage labels（五个规范标签，详见 `docs/agents/triage-labels.md`）、Domain docs（single-context：根 `CONTEXT.md` + `docs/adr/`，详见 `docs/agents/domain.md`）。**两文件本体不承载内容，全部指向 docs/agents/ 三个约定文件**——约定正文只存一处。

## 2.2 README.md 结构范式（约 190 行）

章节序（`README.md` 全文）：

1. **一段话定位**（3 行）：产品主张（20~30% Token 成本）+ 研究项目身份 + 论文数据指针（`README.md:3-5`）；
2. **研究设计一览**：A–E 配置表 + 判定链四层 + 判级 + 验收 + Phase 2 主数据规模（`README.md:7-21`）——研究项目的核心设计在 README 顶部一屏讲完；
3. **仓库结构**：目录树 + 每目录一句话（`README.md:23-35`）；
4. **快速开始**：前置（Node ≥22、pnpm 10.30.3）+ 三条命令 + CI 两层门说明（`README.md:37-46`）；
5. **常用命令表**：命令 | 用途 两列表，覆盖测试/实验/门/分析/物化/参照/内核 CLI/冒烟（`README.md:48-62`）；
6. **单次检视执行**：评测场景（口径三要素 + 可复制命令块）与任意仓检视（参数抽象化命令）+ 三条使用注意（zh 语言门、Java 面向、基线态语义）（`README.md:63-110`）；
7. **凭据配置**：.env.local 键名清单（推荐名 + 兼容别名）与加载纪律（`README.md:112-138`）；
8. **目录与入库约定表** + **参考项目表**（上游 / 锚定 commit / 参照角色 + 恢复命令）+ **DSH 依赖口径注意**（npm 包 vs 本地参考仓的区分）（`README.md:140-172`）；
9. **文档地图表** + **协作约定**（Issue 即 spec / triage 标签 / Conventional Commits / 零网络纪律）（`README.md:174-192`）。

写作范式要点：表格密度高（配置表/命令表/入库表/参考项目表/文档地图五张表）；每节开头一句黑体定性；命令块可直接复制执行；口径性论断随文标注 ADR/issue 编号。

## 2.3 CONTEXT.md 词汇表结构

CONTEXT.md 头部重复 README 定位段，正文按**领域分区**组织术语（`CONTEXT.md` 全文 143 行），分区序：

1. `## 上下文`（Minimal Sufficient Context / Diff-first / C0–C3 / Context Ledger / Stable Prefix（Zone A）/ Zone B / Repo Map / Symbol Index / Append-only Context（Zone C）/ Cache-Stable Review Loop）
2. `## 检视`（Review Runtime / Finding / Evidence / Evidence Gate / Risk Class / 分片 / 合并层 / 输出语言）
3. `## 运行时边界`（核内 / 策略驱动器 / 核外）
4. `## 知识`（CWD / DTS）
5. `## 度量`（RIE / CARC）
6. `## 模型接入`（被测模型 / 参数画像 / 指标分口径 / 异构）
7. `## 基准`（逆补丁法 / 合成组合 / 良性填充 / 验证域）

**词条格式**（固定三段式）：

```markdown
**<术语>**:
<一句话定义——含边界条件与语义约束>。
_Avoid_: <禁止混用的近义词列表（附禁止理由）>
```

`_Avoid_` 反例是词汇表的核心纪律——每个术语显式登记「不要怎么叫」及原因（如「Context Ledger _Avoid_: 上下文缓存（与前缀缓存混淆）」，`CONTEXT.md:20-23`）。README 文档地图宣告其为「术语唯一权威」（`README.md:178`）；docs/agents/domain.md 要求所有产出（issue 标题、重构提案、测试名）使用词汇表定义的词汇、不漂移到 Avoid 词；与 ADR 冲突时显式标出而非静默覆盖（`docs/agents/domain.md:41-51`）。

## 2.4 docs/agents/ 协作约定

- `issue-tracker.md`：GitHub Issues 即 spec；`gh` CLI 全部操作的命令式约定（创建/读取/评论/打标/关闭 + wayfinding 操作面）（`docs/agents/issue-tracker.md:7-46`）。
- `triage-labels.md`：五标签映射表 `needs-triage / needs-info / ready-for-agent / ready-for-human / wontfix`（`docs/agents/triage-labels.md:5-11`）。
- `domain.md`：single-context 仓库的文档结构约定（根 CONTEXT.md + docs/adr/；多上下文才用 CONTEXT-MAP.md）；「文件不存在则静默继续，不建议预先创建」（`docs/agents/domain.md:15-24`）。

## 2.5 ADR 体系

`docs/adr/` 0001–0010，每篇结构：标题（决策一句话）→ 背景（spec 与文档分歧的裁决语境）→ **Considered Options**（每项列被选/被否 + 否决理由）→ **Consequences**（含「实现注记」补记段——落地后按票号回填实际形态修正）。评测相关的关键 ADR：0004（S 级判据）、0007（对齐门 v2）、0008（被测模型可换 + 指标分口径）、0009（超大 MR 切分）、0010（Zone A 分语言序列）。

---

# 第三部分：工程形态

## 3.1 pnpm workspace 包划分

`pnpm-workspace.yaml`：`packages/*` + `onlyBuiltDependencies` 白名单（`pnpm-workspace.yaml:1-6`）。三个包（`packages/` 目录）：

| 包 | 职责 | 依赖方向 |
|---|---|---|
| 根包 `review-agent-poc1` | **POC1 薄 harness 实验平台主链**（experiment / judge / metrics / sampling / codeintel / zoneb / tools / gate / dataset / calibration / reference / sharding），同时是全部 scripts 的宿主（`package.json:2-6`）。依赖：`@deepseek-ai/dsh-sdk-protocol`（类型）、`@vscode/ripgrep`、`tree-sitter-java`、`web-tree-sitter`、`review-llm: workspace:*`（`package.json:31-37`） | → review-llm |
| `packages/review-llm` | **LLM 接入共享缝**：endpoint/key 解析（resolver）、provider 参数画像表（profile）、deepseek 序列化、reviewer 命名（`packages/review-llm/package.json:5-6`；导出 `profileOf` 等被双包消费，`src/metrics/tokens.ts:3`）。exports 用 `source` 条件指向 TS 源、`default` 指向 dist（`packages/review-llm/package.json:10-16`；vitest 按 `resolve.conditions: ["source"]` 跑源码，`vitest.config.ts:3-8`） | 被根包与 review-dsh 共同依赖（单源） |
| `packages/review-dsh` | **DSH 内核侧**：核内五插件（review-runtime 策略驱动器 / review-context / review-policy / review-evidence / review-cache）+ 显式最小树 + 双 bin（`review-agent` 产品 CLI、`review-kernel-host` 实验长驻进程）（`packages/review-dsh/package.json:5-13`；`packages/review-dsh/src/` 目录）。依赖 10 个 `@deepseek-ai/*@0.1.2-rc.1` 锁定包 + cordis 4.0.2 + review-llm（`packages/review-dsh/package.json:26-39`） | → review-llm、→ @deepseek-ai/* |

关键定位说明：根 `src/` 的 POC1 薄 harness 是「冻结参照与共享模块源」——**产品路径（单 MR 检视）内核为 DSH**，POC1 不再是产品执行路径；但实验运行器保留 `--kernel poc1` 通道作基线复跑（`README.md:65`、`src/experiment/cli.ts:57-58`、`runs/poc1-vul4j-gateway-r2/REPORT.md` 即其用途实例）。内核形态决策见 ADR-0006：标准 agent-loop + 策略驱动器（不 setFactory 自定义 loop）、显式最小树（不骑 dsh-base）、单包多插件（`docs/adr/0006-dsh-kernel-shape.md:3-11`）。

## 3.2 src/ 模块划分与分层

根 `src/` 19 个模块目录（`src/` 文件清单），按架构设计文档的引擎分层（Review Engine / Context Engine / Cache Engine，`docs/design/基于 DeepSeek Harness 的 Review Agent 总体架构设计方案.md:3-5 章）可归组为：

**契约层**（一切的地基）：
- `contracts/`——config（A–E 表）/ finding / mr-case / run / run-unit（稳定单元键 `runUnitKeyString`）/ llm-client / prefetch / ledger / knowledge / output-language。跨包共享（review-dsh type-only import 冻结同一 contracts，`docs/adr/0006:41`）。

**核内等价层（POC1 冻结 harness——PI 项目对应物是自己的内核）**：
- `run/`——run-review 主流程 + validate-inputs（单次检视的编排入口）；
- `loop/`——六阶段骨架循环（review-loop / messages / phases / tools / cache-break / usage / parse / constants）；
- `zoneb/`——Zone B 上下文构造（prefetch / repo-context / symbols / reference-sites / call-chain / full-repo-injection / budget / zone-b-builder）；
- `codeintel/`——零构建静态代码情报（java-parser（tree-sitter-java）/ rg（ripgrep）/ fs-utils；ADR-0003）；
- `tools/`——7 个 `review.*` 工具与守卫（get-diff / get-file / get-symbol / search-tools / ledger / registry / toolkit / result-budget / json-canonical）；
- `gate/`——candidate-gate（Evidence Gate：No Evidence, No Finding）；
- `finding/`——finding-schema；
- `deepseek/`——POC1 直连 DeepSeek 客户端（deepseek-client / request-mapper / response-mapper / wire-types / errors）；
- `sharding/`——超大 MR 切分（plan-shards / orchestrate-review / merge-findings；ADR-0009 核外编排）。

**核外研究工具链层（评测资产——PI 应对齐的部分）**：
- `dataset/`——数据集构造（vul4j / defects4j / msb-java / clean-mr 四个 adapter + sampling；diff 处理四件套 parse/apply/reverse/serialize；inverse-patch / truth / verify-inverse / mr-boundary-filter / risk-class / defect-nature / defect-record）；
- `judge/`——判定链 LLM judge（orchestrate / prompt / parse / resolve / gpt-judge-client + mappers / report / fake-judge-client）；
- `metrics/`——指标纯函数（screening / quality / tokens / efficiency / aggregate / stats / verdict / alignment-gate / types；全部无网络无 IO，`src/metrics/types.ts:7`）；
- `experiment/`——实验运行器（cli / plan / runner / run-store / report / dashboard / datasets / env / verifier / dsh-kernel / alignment-gate-cli / alignment-gate-io + sharding/ + synthetic/ 子模块）；
- `sampling/`——人工抽检（sampler / review-plan）；
- `calibration/`——MCR-Bench judge 校准（agreement / mcr-bench / run）；
- `reference/`——Claude Code 外部参照（cli / client / normalize / plan / prompt / runner / run-store / report）。

**横切**：`audit/`（audit-writer 审计落盘）、`shared/`（cli-args 骨架 / env-local 装载 / openai-http-kernel / report-io）、`fake/`（fake-llm-client 测试替身）。

核内/核外边界由 CONTEXT.md 术语「核内（Review Runtime）/ 核外（研究工具链）」定义：核外普通库被 CLI 调用、不进内核插件树（`CONTEXT.md:78-88`）。

## 3.3 测试组织

**根包**（`vitest.config.ts` + `tests/` 目录）：

- include：`src/**/*.test.ts` + `tests/**/*.test.ts`（`vitest.config.ts:11`）；
- coverage：v8 provider，**只计 `src/**`**（scripts/ 为进程入口壳不计入门），阈值 80% 四项（lines/branches/functions/statements，当前基线 86.9% lines）（`vitest.config.ts:12-22`）；
- `tests/` 目录**镜像 src/ 模块**：`experiment/`（cli/plan/runner/run-store/report/dashboard/dsh-kernel/verifier + sharding/ + synthetic/）、`judge/`、`metrics/`、`sampling/`、`calibration/`、`reference/`、`clean-mr/`、`vul4j/`、`msb-java/`、diff/、loop/、sharding/、gate/、deepseek/（含 **golden-bytes** 请求字节锁定测试，`tests/deepseek/golden-bytes.test.ts`，ADR-0008 发布硬门槛）；
- 测试基建：`tests/fixtures/`（sample-java-repo 迷你仓 / vul4j-sample / msb-sample / defect-pair / clean-mr）+ `tests/helpers/`（stub-llm-server / llm-script / deepseek-stub / dsh-replies / happy-path-script）；
- e2e 独立配置：`vitest.config.e2e.ts`——include `tests/e2e/**/*.e2e.ts`，真实 DeepSeek API、**仅在 API key 在场时执行否则显式 SKIP**、单用例 30 分钟超时（`vitest.config.e2e.ts:3-20`）；
- 总量约 1080 项（`README.md:42`）。

**review-dsh 包**：`tests/` 镜像包内结构（cli/ context/ kernel-host/ llm/ loop/ plugins/ presets/ profile/ audit/ gate/ bin/）；**确定性纪律门**为独立 vitest 配置 `vitest.gate.config.ts`——9 件入选测试映射五族断言（Zone A 字节稳定 / 双包 wire parity / 无变更零 Cache Break / 审计可重放 / 六阶段骨架与两上界 / Evidence Gate / 五配置全覆盖），全部 fake LLM、**零网络强制**（setupFiles 出站拦截 + net-guard 自检）（`packages/review-dsh/vitest.gate.config.ts:3-27`）。

**CI**：push/PR 两层门——`discipline-gate`（确定性纪律门·零网络）+ `suites`（两包 typecheck + 全量测试）；**真实网关调用不进 CI**（零网络纪律 #28）（`README.md:46`）。

---

# 对 PI 项目的对齐建议

## A. 应当对齐（口径 / 格式 / harness 约定——不对齐则对比无效）

1. **评测数据集直接复用**：`data/vul4j/target-cases.json`（30 案）、`smoke-cases.json`、`data/clean-mr/` 交付物在 PI 仓库已就位（本调查确认 `ReviewAgent-pi/data/` 已含同一套文件）。MRCase 契约字段（`src/contracts/mr-case.ts:13-38` 对应物）必须逐字段兼容；评测口径三要素（物化仓 base 态 + 原生 diff + 原生英文 issue）不变（`README.md:69`）。
2. **指标口径逐条对齐**（全部是纯函数，可直接移植或重实现后用同夹具对拍）：规则粗筛匹配三条件与一对一贪心占用（`src/metrics/screening.ts`）；P/R/F1 分母语义（`src/metrics/quality.ts`）；token 记账与双口径（`src/metrics/tokens.ts` + 方案 §6）；RIE/CARC 公式（`src/metrics/efficiency.ts`）；S/A/B 默认阈值与 NOT_EVALUABLE/BELOW_B 语义（`src/metrics/types.ts:341-345`、`src/metrics/verdict.ts`）；cacheHitRate 按画像 N/A 的分口径纪律（ADR-0008）。**建议把兄弟项目的 metrics 单测夹具（`tests/metrics/`，含发布数字锚定夹具）作为对拍基准。**
3. **判定链协议**：judge 异构约束（同源拒绝 + 自定义端点降级 warning）、MCR-Bench 官方提示词 + 两条扩展判据、temperature 0.2 / top_p 0.95 / glm 32768 信封、有界重试语义、judge 失败回落 rule 口径（`src/judge/prompt.ts`、`docs/design/VUL4J 评测方案与数据复制指南.md:99-106`）；人工抽检协议 v1 的分层与 FNV-1a32 确定性选择（`docs/human-review-sampling-protocol.md`）。
4. **实验矩阵与单元语义**：单元键 `(source, caseId, configId, rep)` 及其字符串形/目录骨架（`src/experiment/plan.ts:307-311`）；A–E 配置表（`src/contracts/config.ts:23-46`）语义不变——PI 内核只是 `--kernel` 的第三个取值（poc1 | dsh | pi）；rep1 冷 / rep2+ 热分层；reps 缺省 3。
5. **产物布局与报告格式**：`runs/<id>/` 目录结构（plan.json / cases.json / failures.json / report.json / dashboard.md / runs|audit|judge 留痕树）；`report.json` 的 ExperimentReport 字段名（`src/experiment/report.ts:134-156`）——下游分析脚本（如 `analyze-phase2.ts`）才能零改动复用；runs/REPORT.md 的人写结论文档范式（短版结论 + 预算 + 产物索引 + 指向 docs/report/ 长文）。
6. **指标对齐门作为两项目对比的验收协议**：PI 侧跑同评测集后，用 `pnpm alignment-gate -- --baseline <DSH 侧 runs 目录> --candidate <PI 侧 runs 目录> [--noise <噪声侧>]` 走 ADR-0007 v2 协议（对称 max σ 带 + 护栏 + 配对符号检验）。PI 项目的「迁移验收」等价于兄弟项目的 #29/#37 三侧门。
7. **纪律性约定**：断点续跑的口径维度守卫（model/verifier/outputLanguage 漂移即拒）；失败隔离不拖垮整批；退出码契约（0/1/2）；`.env.local` 键名与不回显纪律；token 预算双口径进报告；零网络 CI（真实网关只走本地脚本）。
8. **文档骨架四件套**：README（门面 + 五表范式）/ CONTEXT（领域词汇表 + `_Avoid_` 反例纪律，PI 需继承全部既有术语并新增 Pi 内核特有术语）/ CLAUDE.md + AGENTS.md 同构薄指引（正文全部指向 docs/agents/）/ docs/adr 决策记录（Considered Options + Consequences + 实现注记补记）。docs/report/ 行文遵守「复算路径、无手抽数字、caveat 成节、来源与产物索引收尾」范式（本报告自身即按此范式撰写）。

## B. 天然不同（内核相关——PI 不应强行对齐）

1. **检视执行内核**：兄弟项目是 `src/loop + zoneb + deepseek + tools`（POC1 冻结 harness）与 `packages/review-dsh`（DSH 插件树）双形态；PI 对应物是自己的内核包（形态见 `docs/design/基于 Pi 内核的 Review Agent 总体架构设计方案.md`，本调查未展开内核方案内容）。实验 runner 的 `KernelMode` 扩展为 pi（`src/experiment/cli.ts:57-58` 的对应物）即可，核外工具链零改动——这正是兄弟项目「DSH 接入零改动核外」先例的复刻路径（`docs/adr/0006:69` #27 注记）。
2. **Zone A 字节序列与 wire 序列化**：DSH 侧的 golden bytes / wire-parity 双包锁定测试锚定的是 DeepSeek 请求字节；PI 内核的请求字节是否与 DSH 逐字节一致是**待验证命题而非前提**（兄弟项目用「指标对齐门」而非「字节对齐」验收换内核，正是这一点的协议化）。但 provider 画像表（review-llm `profileOf`）与凭据角色名双包收敛的做法应当继承（单源原则）。
3. **确定性纪律门的断言锚点**：五族断言语义（Zone A 字节稳定 / 零 Cache Break / 审计可重放 / 骨架与上界 / Evidence Gate）相同，但入选测试锚定的「主缝」（DSH 的 fake 适配器捕获字节 / 审计导出件）需按 PI 内核的可观测缝重写。
4. **包拓扑**：兄弟项目三包（poc1 根包 + review-llm + review-dsh）源于「冻结参照 + 新内核并存」的历史路径；PI 项目若从零起步，根包即 PI harness，无需保留 POC1 冻结层——但 review-llm 式「共享缝独立成包」的模式值得保留（endpoint/画像/凭据解析单源）。

## C. 未确认 / 未找到（如实登记）

- **AACR-Bench 接入**：仅有方案文档（`docs/design/AACR-Bench 公开评测接入方案.md`），`src/` 无实现代码（grep 零命中）——若 PI 计划做公开评测对齐，需另查该方案的落地计划。
- **MCR-Bench 数据与校准数据**：`src/calibration/` 有代码，但 MCR-Bench 数据集不在仓库内（设计文档标注 license 核查后用）；校准的实际运行状态未确认。
- **defects4j / msb-java 物化产物**：两源仅 sampling-manifest 入库，物化 MRCase JSON 未入库（落 `.cache/`）；兄弟项目 Phase 2 主数据实际只跑了 vul4j 30 案——defects4j 主集（~100 案）与 msb-java（~30 案）的设计角色**未见有全量实验执行的留痕**（runs/ 目录仅有 vul4j 与 phase2 系实验）。
- **runs/ 目录的具体实验数据**：全部不入库（本机留痕）；本报告引用的 `runs/phase2-main/` 等数字均来自本机快照，其他机器需数据在位才可复算（`docs/report/Phase 2 主数据分析报告.md:18` 同款声明）。
- `docs/plan/` 两份计划书与 `docs/design/` 下 Pi 内核系列方案的具体内容未在本次调查范围内展开（本报告聚焦评测与工程形态）。

---

*调查方法说明：本报告全部结论来自兄弟项目一手来源（代码 / 数据清单 / ADR / 设计文档 / runs 本机留痕 / REPORT.md 实物），关键数字经脚本实测（data/*.json 结构解析、runs/phase2-main/cases.json 源构成核验、src/ 与 docs/ 全量文件枚举）。未对兄弟项目做任何写操作。*
