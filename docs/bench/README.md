# AACR-Bench v2 × review-pi 评测归档

> 运行日期：2026-11-15（评审）/ 2026-11-16（judge）
> 本目录保存本次评测的数据、结果、指标、排除样本分析与对比材料；所有指标均来自已跑完的产物，不包含未完成任务。
> 迁移说明：本目录是 `exp-group` 的归档副本，不是自包含评测环境；未迁移 `artifacts/` / `ocr/` / `results/`，运行依赖见 [MIGRATION.md](MIGRATION.md)。

## 1. 摘要

- 数据集：AACR-Bench **v2**，151 个 PR / 42 个仓库 / 944 条 GT 评论。
- 评审器：review-pi **0.6.1**（`feat/zh-only`，提交 `bf032de`），模型 `deepseek-v4.1-flash`。
- 评测口径：**产品默认配置**开 `findingScope`；本次主结果使用**benchmark 对齐配置**（仅关闭 `findingScope`）。无规则 Skill。
- 完成情况：**108 ok / 30 skipped / 13 failed**。
- 主指标（108 ok，676 GT）：**Precision 7.3% / Recall 17.5% / Balanced 10.2%**。
- 关键原因：1489 条生成意见中 **1200 条（80.6%）落在没有 GT 的文件上**，按框架口径全部计为误报；在有 GT 的文件内 precision 为 **37.4%**（108/289）。

## 2. 运行标识

| 项 | 值 |
|---|---|
| benchmark | AACR-Bench v2（`dataset/v2/positive_samples.json`） |
| 标准数据 | `data/aacr_bench_v2.jsonl`（151 条） |
| 评审范围 | `data/aacr_bench_v2_run.jsonl`（按仓库由小到大排序） |
| 评测子集 | `data/aacr_bench_v2_eval_ok.jsonl`（108 条 ok） |
| review-pi | 0.6.1 / `feat/zh-only` `bf032de` |
| 评审模型 | `deepseek-v4.1-flash`（来自 `~/.PiAgent/PiAgent.jsonc`） |
| 评审配置 | `~/.PiAgent/benchmark-aacr-v2.jsonc`（仅 `limits.findingScope.enabled=false`） |
| judge | `deepseek-v4-pro`，并发 10，单轮 |
| 评审并发 | 2 个 repo group |
| 单条超时 | 30 分钟 |
| 评审地址 | 模型网关直连；仓库 clone 走 `http://127.0.0.1:7890` 代理 |

## 3. 覆盖与口径

| 状态 | 样本 | GT 评论 | 占 GT | 处理 |
|---|---:|---:|---:|---|
| `ok` | **108** | **676** | **71.6%** | 纳入评测 |
| `skipped` | 30 | 186 | 19.7% | 排除（产品主动跳过） |
| `failed` | 13 | 82 | 8.7% | 排除（不可复现 / 超时） |
| 合计 | 151 | 944 | 100% | — |

当前指标只覆盖 v2 的 71.6% GT；排除样本在语言和仓库上有明显偏置（见第 5、6 节）。

## 4. 指标结果

### 4.1 总体

| 指标 | 值 |
|---|---:|
| Precision | 0.073（108/1489） |
| Recall | 0.175（118/676） |
| Balanced score | 0.102 |
| 平均 findings / 样本 | 13.8（GT 平均 6.3） |
| 平均评审耗时 | 481s（8m1s） |
| 总评审耗时 | 51,954.5s |
| 总 token（含 cache read） | 240,427,683（输入 234,398,510 / 输出 6,029,173） |
| 平均 token / 样本 | 2,226K（非缓存输入 155K + 输出 56K + cache read 2,015K） |
| judge 请求数 | 289 |

### 4.2 Precision 拆解

| 项 | 数量 |
|---|---:|
| 生成意见总数 | 1489 |
| 落在有 GT 的文件 | 289（19.4%） |
| 落在无 GT 的文件 | 1200（80.6%） |
| 命中此前未覆盖 GT | 108 |
| 仅重复命中已覆盖 GT | 9 |
| 有 GT 文件内未命中 | 172 |
| **有 GT 文件内 precision** | **37.4%（108/289）** |
| 零 GT 覆盖的样本 | 52 / 108 |

### 4.3 分语言

| 语言 | Precision | Recall | Balanced | GT 命中/总数 |
|---|---:|---:|---:|---:|
| Rust | 0.250 | 0.240 | 0.245 | 6/25 |
| Go | 0.132 | 0.189 | 0.155 | 20/106 |
| PHP | 0.113 | 0.222 | 0.150 | 6/27 |
| JavaScript | 0.126 | 0.176 | 0.147 | 12/68 |
| Python | 0.086 | 0.324 | 0.135 | 24/74 |
| Java | 0.079 | 0.224 | 0.117 | 15/67 |
| C# | 0.051 | 0.174 | 0.079 | 4/23 |
| C | 0.066 | 0.090 | 0.076 | 8/89 |
| TypeScript | 0.037 | 0.137 | 0.059 | 16/117 |
| C++ | 0.023 | 0.087 | 0.036 | 7/80 |

小样本语言（Rust 25 条 GT、PHP 27 条 GT）排名不稳定，不宜单独下结论。

### 4.4 置信度 / 严重级过滤扫描

`limits.confidence.min` / `limits.severity.min` 只过滤 tips / MCP，不改变 `reviews_all.json`；本次 benchmark 用真源，
所以改配置重跑不会改变指标。我们用已有 judge 结果做了离线过滤扫描（`metrics/filter-sweep.md`），按结果文件里的
`confidence` / `severity` 过滤后重放覆盖关系，不重新 judge。

| confidence.min | severity.min | generated | Precision | Recall | Balanced |
|---:|---|---:|---:|---:|---:|
| 0.0 | P3（全部） | 1489 | 0.073 | **0.175** | **0.102** |
| 0.5（产品默认 tips） | P3 | 1377 | 0.073 | 0.164 | 0.101 |
| 0.6 | P3 | 1059 | 0.077 | 0.135 | 0.098 |
| 0.8 | P3 | 347 | 0.084 | 0.044 | 0.058 |
| 0.0 | P2 | 996 | 0.074 | 0.114 | 0.090 |
| 0.0 | P1 | 224 | 0.098 | 0.034 | 0.051 |
| 0.8 | P2 | 229 | 0.109 | 0.038 | 0.057 |
| 0.8 | P1 | 116 | 0.129 | 0.024 | 0.040 |

**没有任何阈值能提高 Balanced score**；置信度/严重级过滤主要是用 recall 换很小的 precision 提升。
低置信意见只占 2.8%，precision 低的根因仍是 80.6% 的生成意见落在无 GT 的文件上，而不是低置信噪声。


## 5. 30 条 skipped 的特点

**结论：不是“改动行数大”的 PR，而是被生成物/依赖物/数据文件撑爆了输入体积门。**

- 29 条 `diff-too-large`，1 条 `no-reviewable-files`。
- 改动行数：min 5 / **median 138.5** / max 862——按代码改动量看都是普通 PR。
- diff 体积：0.8MB–17MB，远超 `limits.boundary.maxDiffChars = 1,000,000`。
- 语言：C++ 9、Java 6、TypeScript 4、Go 3、C 2、Python 2、C# 2、JavaScript 1、Rust 1。
- 仓库：elasticsearch 6、FreeCAD 5、langflow 2、typescript-go 2、lvgl 2、cline 2、ClickHouse 2、bitcoin 2，其余 1 条。
- GT context：Diff 78 / File 78 / Repo 30；GT category：Defect 100 / Maintainability 55 / Performance 25 / Security 6。
- 典型 diff 大头（见 `data/exclusion-analysis.md`）：
  - elasticsearch：多语言模型词表 `.vocab.json`（单文件 11.4MB）、生成的 `EsqlBaseParser.java`/`EsqlBaseLexer.java`、`.interp`；
  - three.js：`build/three.*.min.js` 打包产物；
  - langflow / cline / gemini-cli / typescript-go：`package-lock.json`、`uv.lock`；
  - FreeCAD：`pixi.lock`、`json.hpp` 单头、SVG/字体资源；
  - lvgl：字体 C 数组（单文件 1.2MB）、demo 图片数组；
  - bitcoin：`chainparamsseeds.h`、wycheproof 测试向量 JSON；
  - ollama：`integration/testdata/embed.json`、vendored ggml/llama 源码。
- 唯一 `no-reviewable-files`：`dotnet/aspnetcore@2f372e8`，唯一变更文件是 `src/SignalR/server/StackExchangeRedis/test/Docker.cs`（测试文件，1602 字符），被 `limits.testFiles.skip` 整块过滤；GT 恰好在该测试文件上。
- 影响：这 30 条带 **186 条 GT（19.7%）**，且 C++ 占 30%（ok 组 C++ 只占 13%）。因此当前 C++ 指标对“含大生成物的真实 PR”代表性不足。

**根因**：体积门在“过滤后”的 diff 上计算，但产品默认过滤只覆盖 `**/*.md`、`**/*.lock`、`**/fixtures/**`、`**/*.snap` 等少数模式，未覆盖 `package-lock.json`、`uv.lock`、`pixi.lock`、`*.vocab.json`、`.interp`、`chainparamsseeds.h`、字体/图片 C 数组、`testdata/baselines/**` 等。这些文件不该进模型，但先把体积门顶爆了。

## 6. 13 条 failed 的特点

**结论：9 条是数据不可复现，4 条是超大仓库/长评审超时；都不是“模型答错”。**

### 6.1 不可复现（9 条）

- 原因：`target_commit` / `source_commit` 已从 GitHub 删除或 force-push，`git fetch` 返回 `not our ref`；本地无法重建快照。
- 样本：`astral-sh/uv@ed57db2`、`ComfyUI@4936d01`、`ComfyUI@cfc3122`、`keycloak@79dbba9`、`keycloak@21d4538`、`keycloak@460f800`、`keycloak@2373a48`、`ClickHouse@cc96255`、`ClickHouse@fd6ba0c`。
- 语言：Java 4、C++ 2、Python 2、Rust 1；改动行数 12–871；GT 4–15 条/样本。
- PR 创建时间 min 2024-12 / median 2025-01 / max 2025-08——不是单纯“老 PR”，更像仓库清理了已合并的 PR 分支 commit。
- 影响：keycloak 4 条全部不可复现，因此当前结果里 keycloak 只有 2 条 ok，Java 指标的代表性明显受限。

### 6.2 超时（4 条）

- 超时阈值：桥接层 30 分钟/条（实际 1800–2006s 被杀）。
- 样本：`elasticsearch@902352a`、`elasticsearch@a6a4623`、`ClickHouse@3eee886`、`valkey@8b2137d`。
- 语言：Java 2、C++ 1、C 1；改动行数 160–540；GT 1–9 条/样本。
- 原始 diff 1.1–1.5MB，但**过滤后低于 1MB**，所以检视已经启动；耗时主要花在超大仓库的上下文检索和多轮工具调用上。
- 影响：4 条共 18 条 GT；它们与 skipped 的偏置方向一致——大仓库/长评审被系统性排除。

### 6.3 与 ok 组相比

| 组 | 样本 | GT | 语言偏置 | 改动行数 median | context（Diff/File/Repo） | AI 评论占比 | PR 创建时间 median |
|---|---:|---:|---|---:|---|---:|---|
| ok | 108 | 676 | 10 语言均衡 | 136.5 | 308 / 241 / 127 | 76.9% | 2025-04-03 |
| skipped | 30 | 186 | C++ 30%、Java 20% | 138.5 | 78 / 78 / 30 | 77.4% | 2025-04-03 |
| failed | 13 | 82 | Java 46%、C++ 23% | 259 | 33 / 33 / 16 | 74.4% | 2025-01-30 |

AI 评论占比和 PR 时间没有明显偏置；偏置主要是**语言/仓库**：C++（FreeCAD/ClickHouse/bitcoin）、Java（elasticsearch/keycloak）、大仓库（node/aspnetcore/electron）被排除得更多。

## 7. 与 Open Code Review 官方数据对比

完整表与解读见 [`comparison/reviewpi-vs-ocr.md`](comparison/reviewpi-vs-ocr.md)；原始数据见 [`comparison/ocr-benchmark.json`](comparison/ocr-benchmark.json)。

要点：

- 官方 OCR 表是 **v1 全量 200 PR / 1,505 GT**；本次是 v2 的 108 ok / 676 GT，不是同一分母。
- review-pi（F1 10.2% / P 7.3% / R 17.5%）的画像接近 **Claude Code + Deepseek-V4-Pro**（10.93% / 8.27% / 16.13%），而不是 OCR（17.9%–25.1%）。
- 耗时 8m1s 在 OCR（1m6s–7m58s）的慢端；token（含 cache）2,226K 接近 Claude Code（2,062K–5,664K），是 OCR（334K–743K）的约 3–6.6 倍。
- 相对 Claude Code + Deepseek-V4-Pro：质量基本持平、快约 1.8 倍、token 少约 2.4 倍；相对 OCR + Deepseek-V4-Pro：F1 约 57%、precision 约 24%、token 约 5.6 倍。

## 8. 局限

1. **覆盖率**：指标只覆盖 71.6% 的 v2 GT；skipped/failed 在 C++/Java 与大仓库上偏置。
2. **模型不同**：官方 OCR 表的 DeepSeek 行是 `Deepseek-V4-Pro`，本次是 `deepseek-v4.1-flash`。
3. **指标实现差异**：官方表 P/R 分子相同；本次文件级语义匹配允许一对多（GT 118 vs 生成 108）。
4. **单轮 judge**：`deepseek-v4-pro` 单轮，未做多轮平均；judge 的跨语言判定已抽检，但仍有波动。
5. **token 口径**：是否把 cache read 计入 input 未与官方表对齐；本归档同时保留含 cache 与非缓存两个数。
6. **非行级指标**：默认文件级语义匹配不看行号；行级定位需 `--use-deprecated-score`，本次未跑。
7. **AACR v2 的 GT 77% 是 AI 评论**：不是纯人类评审真值。

## 9. 快速验证集（smoke10）

用途：review-pi 代码/提示词改动后，用 10 条固定样本在约 10–15 分钟内做回归/改进验证。它是
**outcome-stratified 开发集，不是无偏指标**。

选择规则：

- 从 108 条 `ok` 中按语言各取 1 条（10 种语言）；
- GT ≥ 2、改动行数 ≤ 400、单条耗时 ≤ 600s、diff ≤ 1.2MB；
- 语言之间交替偏向“基线有命中”和“基线零命中”（5 正 5 负），兼顾回归与改进信号；
- 固定文件：`data/aacr_bench_v2_smoke10.jsonl`。

3 轮 judge 基线（`deepseek-v4-pro`）：

- **P 0.250 / R 0.246 / B 0.248**；GT 46，生成 44，覆盖 GT 11.33；
- 轮间标准差：R 0.0104、B 0.0052；单轮 judge 噪声约 ±0.01 R / ±0.005 B；
- 10 条评审串行 1838s；并发 5 约 10–15 分钟（3 轮 judge 另约 5 分钟）。

用法：

```bash
# 1) review-pi 改动后先构建
cd D:/Project/ReviewAgent-pi
pnpm --filter @baize/review-pi build

# 2) 跑 smoke + judge，并自动与 3 轮基线对比
cd D:/Project/bench/aacr-bench/evaluation
python run_smoke.py \
  --config C:/Users/Li/.PiAgent/benchmark-aacr-v2.jsonc \
  --run-id after-change
```

- 输出目录：`results/aacr_bench_v2_smoke10/reviewpi/<run_id>/`；控制台打印 P/R/B delta 与逐样本表。
- `--skip-review` 只重评已有结果；`--eval-rounds` 默认 3。
- 判读：delta 超过噪声（R ±0.01 / B ±0.005）才有意义；需要更稳时用
  `python make_smoke_subset.py --per-language 2` 生成 20 条版本。
- 注意：smoke10 的基线（0.25/0.246/0.248）高于全量 108 条的 0.073/0.175/0.102，
  因为小样本更容易命中；不要把它当全量指标。

### 9.1 OCR vs review-pi（smoke10）

同一批 10 条、同一个 judge（`deepseek-v4-pro`，3 轮平均）。OCR：`open-code-review v1.13.10` +
`deepseek-v4.1-flash`；review-pi：`0.6.1` + `deepseek-v4.1-flash`。完整逐样本表见
[`ocr/smoke10/comparison.md`](ocr/smoke10/comparison.md)。

| 指标 | OCR | review-pi | 差异 |
|---|---:|---:|---:|
| Precision | 0.2517 | 0.2500 | +0.0017 |
| Recall | **0.2900** | 0.2463 | **+0.0437** |
| Balanced | **0.2697** | 0.2477 | **+0.0220** |
| 总 token（含 cache） | **19,369,707** | 4,113,194 | **4.71×** |
| token（非缓存 input+output） | **2,139,883** | 649,130 | **3.30×** |
| 评审耗时 | **2,419s** | 1,838s | **1.32×** |

结论：OCR 用约 4.7× 总 token（3.3× 非缓存）和 1.3× 时间，换来 +4.4pp recall / +2.2pp balanced，
precision 基本持平。OCR 的 token 高度集中在 `svelte`（8.31M，0 命中）和 `opencv`（6.93M）；
10 条 / 46 GT 的 smoke 结论是方向性的，不能外推。**全量交集（9.2）显示两者差距远大于 smoke10。**

### 9.2 OCR vs review-pi（91 条全量交集）

同一 judge（`deepseek-v4-pro`）、同一文件级指标、单轮。交集 = OCR 成功 ∩ review-pi ok，
共 **91 条 / 588 GT**。完整逐语言表见 [`ocr/full/comparison.md`](ocr/full/comparison.md)。

| 指标 | OCR | review-pi | 差异 |
|---|---:|---:|---:|
| Precision | **0.3128** | 0.0781 | **4.01×** |
| Recall | **0.3690** | 0.1803 | **2.05×** |
| Balanced | **0.3386** | 0.1090 | **3.11×** |
| 覆盖 GT | **217 / 588** | 106 / 588 | +111 |
| 生成意见 | 601 | 1242 | −641 |
| 总 token（含 cache） | 198,665,508 | 200,753,912 | 0.99× |
| token（非缓存 input+output） | 29,810,212 | 18,856,824 | 1.58× |
| 评审耗时 | 26,891s | 43,159s | 0.62× |

OCR 在 10/10 种语言的 balanced 上都更高；差距最大的是 C++（0.381 vs 0.016）、TypeScript（0.362 vs 0.059）、
Python（0.392 vs 0.151）。review-pi 的主要问题是意见量大但命中率低：1242 条意见只覆盖 106 条 GT，
OCR 601 条意见覆盖 217 条。

> smoke10 与全量交集的结论差异，来自 smoke10 的 outcome-stratified 小样本选择；
> smoke10 适合“改动是否有效”的快速回归，不适合两者排名。
>
> 根因分析见 [`ocr/full/root-cause.md`](ocr/full/root-cause.md)：两者在**有 GT 文件内**的命中率几乎相同
> （OCR 38.1% vs review-pi 36.7%），precision 的 4 倍差距主要来自**意见落在有 GT 文件的比例**
> （OCR 82.0% vs review-pi 21.3%）——review-pi 的 978 条无 GT 文件意见（OCR 108 条，约 9 倍）
> 主导了分母；其中 814/978 是可靠性/可维护/可读性，P1/P2 合计 655 条，不是纯 style。
>
> 按规模分层见 [`ocr/full/size-stratification.md`](ocr/full/size-stratification.md)：
> **≤5 个 changed files 时两者几乎打平（B 0.328 vs 0.327）；>40 文件时 0.046 vs 0.353**；
> 差距随文件广度/diff 足迹扩大，`change_line_count` 不是好变量。

> 按 severity 分层见 [`ocr/full/severity-analysis.md`](ocr/full/severity-analysis.md)：
> **小 diff（<50KB）P1 41.4% / P2 29.5% / P3 19.8%（趋势 p=0.014）；大 diff（≥50KB）
> 4.0% / 3.6% / 2.9%（p=0.51）**——severity 只在小 diff 有区分度；P3 贡献约 1/3 已覆盖 GT，不能删；
> P0 仅 4 条，暂不可作为门槛。
>
> 具体优化建议见 [`ocr/full/optimization-plan.md`](ocr/full/optimization-plan.md)：
> P0 = **意见预算** + 输出反射 + 文件排除；规则层是待验证假设（arm3）。
> 离线实测见 [`ocr/full/offline-mrfilter-budget.md`](ocr/full/offline-mrfilter-budget.md)：
> 提议的 excludeGlobs 只删 62/1242（5.0%），B +0.003；而 top 8 / 每文件 3 条的预算把 B 从
> 0.109 提到 0.132（P 7.8%→13.5%，R 18.0%→12.9%）。**单独做 per-file cap 几乎无效**
> （cap 3 → B 0.107），必须加每 PR 全局预算，砍掉长尾文件上的单条意见。
> 按 severity/category 一刀切过滤见 [`ocr/full/category-severity-filter.md`](ocr/full/category-severity-filter.md)：
> 没有任何组合超过 baseline 0.109；去可靠性/可维护/可读性会同时删掉真实 GT，recall 掉得更快。
> 离线调参见 [`ocr/full/budget-tuning.md`](ocr/full/budget-tuning.md)：最优是
> `scope + cat_sev_conf + top 6/PR + cap 4/file`（B 0.1392）；更稳的是 `top 8/PR + cap 3/file`
> （B 0.1376）；2-fold held-out 提升约 +0.007–0.011 B。输出侧排序/预算不增加模型 token。
> P1 = 确定性文件选择/分组、文件级/仓库级 pass、验证门调优；P2 = 靶向指标与人工审计。
>
> arm1（scope 开）vs arm2（scope 关）的影响见 [`ocr/full/arm1-vs-arm2.md`](ocr/full/arm1-vs-arm2.md)：
> 只丢 40/1242 条意见（3.2%），命中新 GT 与覆盖 GT 均无损失；scope 不是本次差距的杠杆。

### 9.3 iter20 低成本迭代集

从 91 条交集里选 20 条（每语言 2 条，一正一负），固定文件
[`data/aacr_bench_v2_iter20.jsonl`](data/aacr_bench_v2_iter20.jsonl)。覆盖 10 语言；GT context
Diff/File/Repo = 37/22/13；category = Defect 42 / Maintainability 15 / Security 10 / Performance 5。

基线（**复用已有 review-pi 结果与已有 judge 匹配，单轮；没有重新检视，也没有重跑 3 轮 judge**）：

| 指标 | review-pi | OCR 参考 |
|---|---:|---:|
| Precision | 0.1513 | 0.1829 |
| Recall | 0.2639 | 0.2361 |
| Balanced | **0.1923** | 0.2061 |
| GT / 生成 / 覆盖 | 72 / 119 / 19 | 72 / 82 / 17 |
| 评审耗时合计 | 4296.5s | 4843.8s |
| 总 token（含 cache） | 15,477,965 | 25,245,893 |

- 20 条评审串行约 1.2h；并发 5 约 20–25 分钟。
- judge 单轮噪声约 ±0.01 B；3 轮 baseline 已按用户要求停止，未使用。
- 这是 **outcome-stratified 开发集**，B 0.192 高于全量 91 条的 0.109，不能当全量排名。

用法：

```bash
cd D:/Project/bench/aacr-bench/evaluation
python run_smoke.py \
  --dataset data/aacr_bench_v2_iter20.jsonl \
  --baseline metrics/iter20-baseline.json \
  --run-id after-change
```

- `--results-root` 缺省为 `results/aacr_bench_v2_iter20/reviewpi`；输出 P/R/B delta 与逐样本 Δcov。
- 只改输出侧（过滤/排序/预算/确定性反射）时**不需要重跑 review-pi**，可直接用
  `offline_tune.py` 复用已有检视 + judge 结果，零模型调用。
- 改 prompt/规则/文件选择时才需要重检视这 20 条。

### 9.4 测试配置矩阵（小 / 大 / 混合 / 全量）

定义：**小 diff = `git diff` < 50KB；大 diff = ≥50KB**。小池按语言轮转、正负交替；大池按语言轮转、
语言内按 B 差距/无 GT 意见排序。基线全部复用已有 review-pi + judge 结果，**未重跑模型**。

| 配置 | 组成 | 样本 | 小 | 大 | GT | review-pi B | OCR B |
|---|---|---:|---:|---:|---:|---:|---:|
| iterS10 | 小池前 10 | 10 | 10 | 0 | 40 | 0.3715 | 0.2790 |
| iterS20 | 小池前 20 | 20 | 20 | 0 | 73 | 0.2856 | 0.2533 |
| iterB2 | 大池前 2 | 2 | 0 | 2 | 15 | 0.1081 | 0.7417 |
| iterB5 | 大池前 5 | 5 | 0 | 5 | 43 | 0.0156 | 0.6772 |
| iterB10 | 大池前 10 | 10 | 0 | 10 | 95 | 0.0276 | 0.5083 |
| iterM10 | 8 小 + 2 大 | 10 | 8 | 2 | 43 | 0.2896 | 0.3955 |
| iterM20 | 15 小 + 5 大 | 20 | 15 | 5 | 103 | 0.1630 | 0.3784 |
| iterM50 | 40 小 + 10 大 | 50 | 40 | 10 | 263 | 0.1792 | 0.4028 |
| iterF91 | 91 条交集全量 | 91 | 41 | 50 | 588 | 0.1090 | 0.3386 |

读法：

- 纯小 diff 的 iterS10/iterS20 上 review-pi 反超 OCR（选择偏向 review-pi 表现好的样本，见下）；
- 纯大 diff 的 iterB2/B5/B10 上差距巨大（B 0.108 vs 0.742、0.016 vs 0.677、0.028 vs 0.508）；
- 混合配置显示 gap 随大 diff 比例单调扩大：M10 0.290 vs 0.396 → M20 0.163 vs 0.378 →
  M50 0.179 vs 0.403。

**误报（benchmark 文件级口径，FP = 未命中“此前未覆盖 GT”的生成意见）：**

| 配置 | review-pi FP 率 | OCR FP 率 | review-pi non-GT 误报 | OCR non-GT 误报 |
|---|---:|---:|---:|---:|
| iterS10 | 69.5% | 75.6% | 6 | 2 |
| iterS20 | 75.5% | 78.2% | 24 | 16 |
| iterB10 | **98.4%** | **55.3%** | 227 | 29 |
| iterM20 | 88.7% | 67.7% | 135 | 14 |
| iterF91 | **92.2%** | **68.7%** | 978 | 108 |

小 diff 上 RP 误报率反而略低；大 diff 上 RP 的误报以“无 GT 文件”为主（B10 227/244）。
完整拆解（non-GT / 未匹配 / 重复）见
[`metrics/configs/false-positives.md`](metrics/configs/false-positives.md)；
机器可读的误报率表见 [`metrics/configs/false-positive-rates.md`](metrics/configs/false-positive-rates.md) / `.csv` / `.json`。

> **选择偏差**：小配置是 outcome-stratified（正负交替）→ 可能偏向 review-pi；大配置是 gap-targeted
> （按差距选）→ 不是大 diff 的无偏样本。它们用于**迭代/回归**，排名仍看 iterF91。
> 完整基线见 [`metrics/configs/summary.md`](metrics/configs/summary.md)，配置说明见
> [`configs/README.md`](configs/README.md)。

用法：

```bash
cd D:/Project/bench/aacr-bench/evaluation
python run_config.py --list
python run_config.py --config iterS10 --run-id after-change
python run_config.py --config iterB5 --run-id after-change \
  --review-config C:/Users/Li/.PiAgent/benchmark-aacr-v2.jsonc
```

## 10. 文件索引

```
docs/bench/
├── README.md                          # 本文件
├── data/
│   ├── aacr_bench_v2.jsonl            # 151 条标准样本
│   ├── aacr_bench_v2_run.jsonl        # 本次运行顺序（按仓库由小到大）
│   ├── aacr_bench_v2_eval_ok.jsonl    # 纳入评测的 108 条 ok
│   ├── aacr_bench_v2_smoke10.jsonl    # 快速验证集（10 条，每语言 1 条）
│   ├── aacr_bench_v2_iter20.jsonl     # 低成本迭代集（20 条，每语言 2 条，一正一负）
│   ├── raw_positive_samples.json      # 原始 v2（AACR-Bench 数据）
│   ├── exclusion-analysis.json        # 逐样本状态/统计/大 diff 块
│   └── exclusion-analysis.md          # 排除样本可读清单
├── configs/
│   ├── README.md                      # 测试配置定义、选择偏差与用法
│   └── {iterS10,iterS20,iterB2,iterB5,iterB10,iterM10,iterM20,iterM50,iterF91}.jsonl
├── metrics/
│   ├── metrics_claude_20261116_102219.json   # judge 全量指标（含 eval_res）
│   ├── filter-sweep.json                     # 20 组置信度/严重级过滤结果
│   ├── filter-sweep.md                       # 过滤扫描解读
│   ├── smoke10-baseline.json                 # smoke10 的 3 轮 judge 基线
│   ├── smoke10-selection.md                  # smoke10 选择依据与基线表
│   ├── smoke10-rounds.json                   # 3 轮明细与标准差
│   ├── smoke10-3r/                           # smoke10 3 轮 judge 原始 metrics
│   ├── iter20-baseline.json                  # iter20 迭代集基线
│   ├── iter20-selection.md                   # iter20 选择表与覆盖
│   └── configs/                              # 配置基线 + summary / false-positives / false-positive-rates
├── results/
│   └── <safe_id>.json                 # 151 条桥接结果（status / review_output / token）
├── artifacts/reviewpi/
│   ├── reviews_all/                   # 108 条 review-pi 真源（完整 Finding）
│   ├── tips/                          # 108 条中文按行 tips
│   └── audit-summary.json             # 从 audit 抽取的 slim 汇总（usage / rejections / config）
├── comparison/
│   ├── ocr-benchmark.json             # OCR 官方表原始数值
│   └── reviewpi-vs-ocr.md             # 对比与解读
├── ocr/smoke10/
│   ├── results/                       # 10 条 OCR 结果（含 comments/summary）
│   ├── metrics/                       # OCR 3 轮 metrics + average
│   ├── comparison.json                # OCR vs review-pi 结构化对比
│   └── comparison.md                  # 逐样本对比与解读
├── ocr/full/
│   ├── results/                       # 91 条交集 OCR 结果
│   ├── metrics_ocr_20261116_161311.json
│   ├── comparison-91.json             # 91 条交集结构化对比
│   ├── comparison.md                  # 总体/分语言对比与解读
│   ├── root-cause.md                  # 根因分析（文件靶向/无 GT 噪声/效率）
│   ├── size-stratification.md         # 按 PR 规模分层：小 PR 接近，大 PR 差距扩大
│   ├── severity-analysis.md           # severity 分层：P0–P3 只在小 diff 有区分度
│   ├── optimization-plan.md           # 明确的优化建议（P0/P1/P2）
│   ├── offline-mrfilter-budget.md     # 离线估算：excludeGlobs vs 意见预算
│   ├── category-severity-filter.md    # 离线估算：severity/category 过滤
│   ├── budget-tuning.md               # 离线调参：预算/排序/反射过滤的最优参数
│   ├── budget-tuning.json             # 1536 组离线调参结果
│   ├── non-target-analysis.json       # 非 GT 文件意见的结构化统计
│   └── arm1-vs-arm2.md                # findingScope 开关的实际影响
└── scripts/
    ├── aacr_reviewpi_bridge.py        # review-pi → 框架结果桥接
    ├── analyze_exclusions.py          # 排除样本分析
    ├── report_aacr.py                 # 指标汇总/分语言
    ├── postprocess_aacr.py            # 结果收口/分类
    ├── sweep_filters.py               # 置信度/严重级离线过滤扫描
    ├── make_smoke_subset.py           # 生成 smoke10 / smoke20 快速验证集
    ├── make_iter20.py                 # 从 91 条交集生成 iter20 迭代集
    ├── make_iter_sets.py              # 生成 iterS10/iterS20/iterB*/iterM*/iterF91 配置
    ├── run_config.py                  # 按配置名跑 review-pi + judge
    ├── run_smoke.py                   # 跑子集 + judge 并与基线对比（支持 --dataset/--baseline）
    ├── compare_smoke.py               # OCR vs review-pi smoke10 对比
    ├── offline_tune.py                # 离线预算/排序/过滤网格搜索
    ├── offline_cv.py                  # 离线调参 2-fold 稳定性检查
    └── check_aacr_v2_commits.py       # 可复现性扫描（本次未跑完）
```

**未归档**：review-pi 的完整 transcripts / 2.1GB audit / 2.7GB `.reviewpi` 原始目录仍在
`D:/Project/bench/aacr-bench/evaluation/results/aacr_bench_v2/reviewpi/arm2/`，未复制进本仓以免膨胀；`artifacts/reviewpi/audit-summary.json` 已保留分析所需字段。

## 11. 复现命令

```bash
cd D:/Project/bench/aacr-bench/evaluation
# 1) 转换 v2
./.venv/Scripts/python.exe -m converters.aacr_bench \
  --input benchmark/AACR-Bench/v2/positive_samples.json \
  --output data/aacr_bench_v2.jsonl --validate
# 2) review-pi 评审（benchmark 对齐配置）
./.venv/Scripts/python.exe aacr_reviewpi_bridge.py \
  --dataset data/aacr_bench_v2_run.jsonl \
  --results-dir results/aacr_bench_v2/reviewpi/arm2 \
  --config C:/Users/Li/.PiAgent/benchmark-aacr-v2.jsonc \
  --concurrency 2 --timeout-minutes 30
# 3) 只评 ok 子集
./.venv/Scripts/python.exe -m pipeline run --stage eval --reviewer claude \
  --dataset data/aacr_bench_v2_eval_ok.jsonl \
  --results-dir results/aacr_bench_v2/reviewpi/arm2 --eval-rounds 1
# 4) 汇总
PYTHONIOENCODING=utf-8 ./.venv/Scripts/python.exe report_aacr.py \
  --arm arm2=results/aacr_bench_v2/reviewpi/arm2/metrics_claude_20261116_102219.json \
  --v2 ../dataset/v2/positive_samples.json
```

## 12. 数据来源与许可

- AACR-Bench v2：Alibaba Aone，Apache-2.0；原始地址 `https://github.com/alibaba/aacr-bench`，
  本次使用的 `positive_samples.json` sha256 = `2e83975aba1ca06544ccecdee8d99ab7152bc1d02a3d86bce3022d8d4e3010ba`（meta 校验通过）。
- Open Code Review 官方 benchmark 表：`D:/Project/open-code-review`（Apache-2.0）。
- 本目录中的 review-pi 结果与指标由本次运行生成；不含 API key、`.env` 或用户配置秘密。
