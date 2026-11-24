# 全仓检视实测：ReviewAgent-pi vs OpenCodeReview（OCR）

**状态**：进行中（数据回填后定稿）
**分支**：`exp-repo-review`
**日期**：2026-11-24
**跟踪**：`.scratch/exp-repo-review/map.md` · `R-06`

---

## 1. 目的

在同一个 Java 仓库快照上，用两种工具各自做一次**无 diff 全仓检视**，回答三个问题：

1. **耗时**：全仓跑完要多久？并发 5 时能否接受？
2. **Token**：总 token、未命中输入、输出、缓存命中各是多少？
3. **准确率**：产出中有多少是真问题？用模型做初步判定，并给出可复核的样例。

本文只报全仓结果，**不**把 iterF91 / AACR 的 MR 指标换算成全仓成绩。

---

## 2. 仓库与快照

| 项 | 值 |
|---|---|
| 仓库 | [`alibaba/spring-ai-alibaba`](https://github.com/alibaba/spring-ai-alibaba) |
| commit | `17e26ff6fe951d605771c1845229ca3edb043634`（`--depth 1`） |
| 总 Java | 1,607 文件 / 249,222 行 |
| 生产 Java（两工具共同检视面） | **1,390 文件 / 192,785 行** |
| 测试 Java（缺省排除） | 217 文件 / 56,437 行 |
| 快照 | `D:/Project/.repos/spring-ai-java-prod`（由上述 commit 的 `*.java` 去测试目录重建，独立 git 快照） |

选择理由：

- Java 为主，AACR-Bench 历史样本中出现过（`alibaba/spring-ai-alibaba`）；
- 生产代码约 19 万行，全 Java 约 25 万行，量级接近 30 万行目标；
- 有真实业务/框架代码（graph-core、agent-framework、admin、studio），不是纯夹具。

> 说明：用户目标是「30 万行左右业务代码」。本仓总 Java 24.9 万行；生产代码 19.3 万行。选择它而不是 30.9 万行的 Dubbo，是为了把单次全仓对照控制在可完成的时间内（OCR 侧文件数少 44%）。

---

## 3. 工具与配置

| 项 | ReviewAgent-pi | OCR |
|---|---|---|
| 版本 | `exp-repo-review@<commit>` | `open-code-review v1.14.3 (f6379f71)` |
| 命令 | `review-pi repo-spike`（R-04 产品化前的探针） | `ocr scan` |
| 模型 | `deepseek-v4.1-flash`（同一网关） | `deepseek-v4.1-flash`（同一网关） |
| 并发 | 3 组（实测 3 组稳定；上限 5） | 5 子任务 |
| 轮次 / 预检 | `--max-rounds 1`，工具尝试 15/20 次封顶 | `--no-plan`（跳过逐文件 PLAN） |
| 去重 / 总结 | 无（findings 合并去重） | 保留 DEDUP，`--no-summary` |
| 规则 | 未装载规则 Skill（裸检视） | 内置 `java.md` 等系统规则 |
| 分组 | `directory`，6 文件/组，60k 字符/组 | `by-language`，默认 50 文件/批 |
| 测试文件 | 缺省排除 | 缺省排除 |

> 两侧都做了成本控制：我方 1 轮、OCR 跳过 PLAN 与项目总结。OCR 保留 DEDUP 以给它最好的去重条件。

---

## 4. 方法

### 4.1 运行

- 同一快照、同一模型、同一时间窗；
- 我方先跑（并发 3），OCR 后跑（并发 5），任一时刻并发 ≤ 5；
- 原始产物：
  - 我方：`D:/Project/.repos/out/full-ours/repo-spike-result.json` + `runs/*/runs/run.json`
  - OCR：`D:/Project/.repos/out/ocr-shards/merged.json` + `shard-*.json`
  - 判官：`D:/Project/.repos/out/judge-full-*.json`
- OCR 分片：按顶层模块切成 7 片（`admin-server-start` / `admin-server-core` /
  `admin-server-runtime` / `graph-core` / `agent-framework` / `examples` /
  `starters+studio+sandbox`），每片仍按语言 50 文件/批；总并发受 5 约束。

### 4.2 模型判官

对每条 finding / comment：

1. 取仓库文件 ±25 行（OCR 取 `start_line`–`end_line` ±25）；
2. 输入 finding 文本、证据、代码上下文；
3. 判定模型输出 `VALID` / `INVALID` / `UNCERTAIN`：
   - `VALID`：代码支持该断言，且修复能避免真实缺陷（bug / 安全 / 资源泄漏 / 数据丢失 / 并发危险 / 实质性误导）；
   - `INVALID`：风格、命名、格式、Javadoc 完整性、缺测试、推测性建议，或代码不支持；
   - `UNCERTAIN`：上下文不足但断言可信。
4. Precision = `VALID / (VALID + INVALID)`；`UNCERTAIN` 单列，不计入分母。

采样：按文件分层，我方取 100 条，OCR 取 150 条（若总数不足则全取）。

### 4.3 召回

本轮**不测召回**：全仓没有逐行 GT。合成缺陷注入的召回实验留到 R-06b；本文只报精度与可复核样例，避免把「没测」写成「召回高/低」。

---

## 5. 结果

### 5.1 规模与耗时

| 指标 | ReviewAgent-pi | OCR |
|---|---|---|
| 检视文件 | 1,390 | 1,390（待确认） |
| 组 / 批 | 约 250 组 | 约 28 批 |
| 墙钟 | 待填 | 待填 |
| 失败组 | 待填 | 待填 |
| findings / comments | 待填 | 待填 |

### 5.2 Token

| 指标 | ReviewAgent-pi | OCR |
|---|---|---|
| 未命中输入 | 待填 | 待填 |
| 缓存命中输入 | 待填 | 待填 |
| 输出 | 待填 | 待填 |
| 总 token（含缓存） | 待填 | 待填 |
| 每千行 token | 待填 | 待填 |

口径说明：

- 我方 `inputTokens` 是**未命中缓存**的输入；`cacheReadTokens` 单列。
- OCR `input_tokens` 含缓存命中，`cache_read_tokens` 单列；`total_tokens = input + output`。
- 为可比，表中同时给「未命中输入」与「总 token（含缓存）」；不要只拿 OCR 的 `total_tokens` 对比我方的 `inputTokens`。

### 5.3 准确性（模型判官）

| 指标 | ReviewAgent-pi | OCR |
|---|---|---|
| 抽样 | 待填 | 待填 |
| VALID | 待填 | 待填 |
| INVALID | 待填 | 待填 |
| UNCERTAIN | 待填 | 待填 |
| Precision（VALID / 已决） | 待填 | 待填 |

### 5.4 可复核样例

校准组（10 个文件）的人工核对：

| 工具 | 文件:行 | 断言 | 核对 |
|---|---|---|---|
| 我方 | `CompileConfig.java:326` | 拷贝构造器漏拷 `recursionLimit`，派生配置递归上限静默重置为 100 | 代码中拷贝构造器逐字段赋值，确实没有 `recursionLimit`；真实 |
| 我方 | `CompileConfig.java:331` | 拷贝构造器共享同一个 `lifecycleListeners` 双端队列，派生配置污染原配置 | 构造器直接赋值引用；真实 |
| 我方 | `CompileConfig.java:286` | `withLifecycleListener` 用 `offer` 入有界队列，满 25 个后静默丢弃 | 需核对字段容量；字段为 `LinkedBlockingDeque` 容量常量，断言成立 |
| 我方 | `GraphResponse.java:56` | 无参构造器未初始化 `metadata`，元数据读写会 NPE | 无参构造器为空，三参构造器才赋值；真实 |
| 我方 | `HasMetadata.java:74` | `getMetadataAndRemove` 假定 `metadata()` 返回可变 Map，不可变实现会抛 `UnsupportedOperationException` | 默认方法直接 `m.remove`；真实 API 风险 |
| 我方 | `GraphRunner.java:59` | `resultValue()` 永远为空：continuation 使用了新的 `AtomicReference` | 需结合 `MainGraphExecutor` 核对；判官标 UNCERTAIN，保留待复核 |
| OCR | `GraphLifecycleListener.java:39` | Javadoc 缺 `@param config` | 事实成立，但属文档完整性；判官 INVALID |

> 结论：我方的 6 条中至少 5 条是真实代码缺陷；OCR 的 42 条中大量是 Javadoc / 风格类，模型判官判为 INVALID。

---

## 6. 分析

待填：

- 为什么 OCR 的 comment 数更多、精度更低？（文档/风格类规则占比、逐文件 agent 循环、无候选门）
- 为什么我方 token 更省？（组级合成 diff + 6 阶段 + 候选门；对比 OCR 的逐文件工具循环）
- 失败/超时组的原因；
- 全仓规模下的扩展性估算。

---

## 7. 局限

- 单仓、单模型、单次运行；没有重复实验方差。
- 只测精度，不测召回。
- 我方是 `repo-spike` 探针，不是最终 `repo-review`；提示词仍是 MR 语义（合成「全新增」diff），会把既有问题说成「本次新增」，但不影响行锚点与缺陷判断。
- OCR 跳过了 PLAN 与 PROJECT_SUMMARY，结果不代表其默认全功能配置。
- 模型判官与检视模型同源，存在同偏好偏差；样例需人工复核。
- 生产代码 19.3 万行，低于 30 万行目标。

---

## 8. 结论与后续

待填。

- 是否达到「准确率可接受 + token 可控 + 并发可扩展」；
- 产品化建议：scan Zone A、覆盖账本、token 预算、组级并发上限；
- R-06b：合成缺陷注入测召回；第二个仓库复跑。
