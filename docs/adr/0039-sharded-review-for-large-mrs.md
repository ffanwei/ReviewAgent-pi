# 0039. 大 MR 第二期：按文件块分片检视 + findings 合并去重

**状态**：已接受（2026-11-04；实施待做，实施完成后补「实施记录」）
**日期**：2026-11-04
**关联**：ADR-0013（转录与 findings 导出）、ADR-0014（规则 Skill 会话）、ADR-0016（进度投影）、ADR-0025（用户级 JSONC 配置）、ADR-0030（收尾摘要）、ADR-0032（产物拍平与 `runId`）、ADR-0033（任务目录）、ADR-0036（cwd session 索引与 export）、ADR-0037（MCP 上报）、ADR-0038（退役外部真源逐字节对照）
**跨仓**：本 ADR 为本仓 pi 线序列 0039；引用 DSH 兄弟仓决策须写全限定语「DSH 线 ADR-XXXX」。
**前置**：大 diff 第一期已落地（`cfcebb3`：输入预过滤 + `limits.boundary.maxDiffChars` + `review.get_diff` 分页）。本文只覆盖第二期。

## Context

第一期解决了三类「假大」：lockfile / 生成物 / minified / 二进制整块剔除，过滤后仍超 `maxDiffChars` 则提前报错。**没有解决「文件多」**：几十上百个正常大小的文件仍然会一次塞进同一条消息，要么超窗口直接 400，要么在 1M 窗口里慢、贵、中段召回下降。

本仓对此已有明确记录：

- 《Config B 生产化方案》§3.1 把「按文件组切分 MR → 分别检视 → Finding 合并与去重」列为 **v2，单独立项**；
- `run/mr-boundary-guard.ts` 头注释同样标注「v2 切分另立项」；
- 第二期必须新开 ADR（0039 起），不能顺手改 ADR-0032 的「一个任务目录一次 run」。

这里要先钉死一个前提：**切分单位只能是 `diff --git` 文件块**。

| 切分单位 | 行号 | 文件级语义 | evidence 链 | 结论 |
|---|---|---|---|---|
| 文件块（本 ADR） | 完整保留 | 完整保留 | 可回查 | ✅ |
| hunk | 依赖上下文拼接 | 被破坏 | 易断 | ❌ |
| 按字符强行截断 | 不保证行边界 | 被破坏 | 必断 | ❌ |

单文件本身就巨大（例如一个 5 万行 SQL）不在第二期范围内：文件块不可再切，强行切 hunk 会破坏行号与证据；那属于第三期（triage + 工具化按需读取）。

## Decision

### 1. 触发条件与预算口径

```text
输入 diff
  → 第一期预过滤（一次性）
  → len > limits.boundary.maxDiffChars（非 null）      → 报错（第一期行为不变）
  → split.enabled = false 或 len ≤ split.maxShardChars → 单遍（今天的老路径）
  → 否则                                                → 分片（本 ADR）
```

- `limits.boundary.maxDiffChars` 继续是**总输入上限**，语义不变；
- 新增 `limits.split.maxShardChars` 是**单片目标预算**，不是硬失败线：装箱时每片尽量不超过它；
- 只有 `len > maxShardChars` 才进入分片；等于预算不分片；
- `split.enabled = false` 时行为与第一期完全一致（把是否接受成本外溢交给使用方）。

### 2. 切分算法：按 diff 顺序贪心装箱

```text
blocks = 解析 filteredDiff（复用 run/mr-input.ts 的块边界，不重新造解析器）
for block in blocks:
  if chars(block) > maxShardChars:
      error("文件 <path> 单块 <n> 字符，超过单片预算 <m>；请拆分该文件或等待第三期")
  if chars(current) + chars(block) > maxShardChars:
      flush(current)
  current.add(block)
flush(current)
if shards.length > maxShards:
    error("需要 <n> 片，超过 split.maxShards=<m>；请拆分 MR")
```

不变量（由纯函数测试把守）：

1. 每个文件块**恰好出现一次**，不跨片、不重复；
2. 片的顺序 = 文件在 diff 中的顺序；
3. 同一输入 + 同一配置 → 同一分片（可重放）；
4. 单片超预算 / 片数超上限都是**显式错误**，不静默丢文件；
5. 只有 1 片时，不进入分片主链（见决策 12）。

### 3. 每片的上下文：其他文件变更摘要

每个 shard 的初始消息由两部分组成：

```text
<本片 unified diff>

Other files changed in this MR (not shown in this shard):
- src/B.java (+12/-3)
- src/C.java (+40/-0)
```

- 摘要由**全部**过滤后文件块生成（含本片自己也列出？不：只列其他片），按 diff 顺序；
- 只含路径、增/删行数，不含代码正文；
- 受 `split.contextSummaryChars` 上限约束（超出按文件截断并留提示行）；
- 摘要用于让模型知道「还存在哪些改动」，**不是证据源**；shard 提示词明确「只对本片内文件产出 finding」；
- 摘要进入该 shard 的请求字节，因此天然可在审计的 `requests` 里回放。

### 4. 执行形态：串行、每片一次完整六阶段

- **第一版串行**：一次只跑一片，确定性最好、失败定位最简单、缓存行为可预测；并行化（`concurrency.shard`）不在本期。
- 每片复用现有六阶段循环 + 七工具 + 规则 Skill 会话；输入 diff 换成该片 diff，`review.get_diff` 只返回本片。
- **规则 Skill 装载一次**（在编排层完成），每片各跑自己的 skill 会话（因为规则要作用于该片代码）；装载审计只在聚合层记一次。
- **呈现投影（中文 tips）只在合并后跑一次**，输入是合并后的 findings。
- 每片有独立的 Context Ledger；不存在跨片共享账本（跨片去重由 findings merge 负责）。

### 5. Findings 合并与去重（reduce）

合并是纯函数，输入 = 按 shard 顺序排列的 findings 列表，输出 = 合并后的 findings。

| 规则 | 决策 |
|---|---|
| 去重键 | `(normalize(file), line, normalize(title))`；`normalize` = trim + 空白折叠 + 小写（只用于键，展示保留原文） |
| 严重度 | 取最高（P0 > P1 > P2 > P3） |
| confidence | 取最高 |
| evidence | 并集去重，保持首次出现顺序 |
| description | 取 confidence 最高的一条；并列取更长的一条 |
| title / category / rule | 取 confidence 最高的那条（并列取首次出现） |
| `id` | 合并后按最终顺序重新编号 `F001…`，**不复用**片内 id（每片都从 F001 起，直接合并必撞） |
| 排序 | diff 文件顺序 → 行号升序 → 严重度降序 → title |
| 近距离重复 | **不做**模糊聚类：同文件 10 行与 11 行仍是两条（宁可少量重复，不要误合并） |

**明确不做**：按 title 相似度合并、跨文件合并、LLM 二次裁决。合并只做确定性规则。

### 6. 产物布局与身份

单 shard 保持 ADR-0032 原布局不变（这是硬回归门）。多 shard 时：

```text
<tasks 根>/<taskId>/
├── runs/
│   ├── run.json                                  # 聚合记录（新增 shards[]）
│   ├── reviews_en.json                           # 合并后的唯一对外真源
│   ├── reviews_tips_zh.json                      # 合并 findings 后跑一次投影
│   └── shards/
│       └── attempt-<YYYYMMDD_HHMMSS_mmm>/
│           ├── s01/session-<shardRunId>.json
│           ├── s01/reviews_en.json               # 片内快照，仅诊断
│           └── s02/…
└── audit/
    ├── <aggRunId>.json                           # 聚合审计（不含全部请求正文）
    └── shards/
        └── attempt-<…>/s01/<shardRunId>.json     # 片内完整审计（requests 等）
```

- **聚合 `runId` = 第 1 片自己的 `runId`**（即全任务最早一次模型请求时刻，ADR-0032 口径不被破坏）；`audit/<aggRunId>.json` 仍可互推。
- 片内 `runId` = 该片首次请求时刻；片目录里不存在文件名冲突。
- `attempt-<…>` 用 **run 入口的 `startedAt`** 生成，仅作目录名，**不是 runId**；作用是让每次尝试独占一组片产物，避免重跑覆盖历史转录（ADR-0032「每次 run 独立留档」）。
- 失败重跑不会污染上一次成功任务的 `run.json`；旧 attempt 目录保留为取证现场。
- 聚合 `reviews_en.json` / `run.json` / 顶层审计在**全部片成功之后**才写。失败时不写聚合产物（见决策 10）。
- `review-result.json`（cwd 副本）内容 = 聚合 `reviews_en.json`，契约不变。

### 7. 审计与 RunRecord

聚合审计在既有尾部新增可选键（缺席省键纪律不变）：

```ts
interface ShardAuditRecord {
  readonly index: number;          // 1-based
  readonly files: number;
  readonly chars: number;
  readonly filePaths: readonly string[]; // 该片包含的仓库相对路径（排障用）
  readonly runId: string;          // 该片首次请求时刻
  readonly status: "ok" | "failed";
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly domainWarning?: string;
  readonly usage: LlmUsage;
  readonly rounds: number;
  readonly toolCalls: number;
}
```

- 聚合审计的 `shards[]` 记录每片事实；`findings`、`usage`（求和）、`truncated`（任一）、`truncationReasons`（并集）为聚合面；
- `requests` / `toolCallLog` / `phaseLog` / `rejections` / `cacheBreaks` 在聚合审计里为**空数组**（正文在各片审计里），避免把 N 份审计复制一遍；
- `ledger` 聚合层省键（各片 id 都从 `ctx#001` 起，无法无损合并）；
- `ruleSkill[]` 在聚合层记一次；
- `notes` 不加新键：`shards` 在场即表示分片模式。

`RunRecord`：

- `baseline` = 聚合快照（合并 findings / 求和 usage / 最大 rounds / 求和 toolCalls / 聚合 auditPath）；
- 顶层新增可选 `shards?: readonly ShardRecord[]`（含每片相对路径 `transcriptFile` / `auditFile`，供 export 寻址），单 shard 时整键缺席；
- `verifier` / `effective` / `verifierPass` 语义不变（恒 off / null）。

### 8. 进度、stderr、stdout

- **内部进度事件**新增可选 `shard: { index, total }` 字段；每片的事件由编排层注入该标签。
- CLI 渲染器在分片模式下给阶段/请求/工具/skill 行加 `[s2/5]` 前缀；收尾摘要仍是一行（聚合值）。
- 分片开始时 stderr 一行：`review-pi: 分片检视 5 片（每片 ≤400000 字符，共 3 个文件）`。
- **stdout 形状不变**（`cli/render.ts` 的 `Pick` 不动）：`runId` 用聚合值，`findings` 用合并值。shard 明细只进审计 / run.json / stderr。

### 9. MCP 上报（ADR-0037 的加法扩展）

- `streamId` **仍按一次任务一个**；外层只发**一次** `run.start` 和**一次** `run.end`，不让 N 片各发一组，否则机器流水会把一次任务看成 N 次。
- `run.start` 新增可选 `shards: { total: number }`；`run.end` 新增可选 `shards: { total, ok, failed }`。字段只增不改，`schemaVersion` 仍为 1。
- 阶段/请求/工具/skill 事件新增可选 `shard: { index, total }`，否则每片的 `round` 都从 1 重来，消费方无法区分。
- 默认 `include` 不变；`shard.*` 不新增事件类型。
- 失败路径：外层 `run.end(status="failed")` 照发；已完成的片在 `run.end.shards` 里如实计数。

### 10. 失败与完整性

| 情形 | 决策 |
|---|---|
| 某片在建链/请求/循环中抛错 | **快速失败**：不再跑后续片；不写聚合 `run.json` / `reviews_en.json` / 顶层审计；已落盘的片产物保留取证；外层 `run.end(failed)`；退出码 1 |
| 某片 `truncated=true` | 聚合 `truncated=true` + 原因并集；退出码仍 0（诚实截断不是失败） |
| 某片边界降级 | 聚合 `domainWarning` = 各片唯一警告用 `"; "` 连接；审计 `shards[].domainWarning` 保留归属 |
| 某片 `complete=false` | 聚合记录里 `shards[].complete=false`；`truncated` 已由既有链路的 truncationReasons 表达 |
| 片数/单片预算超限 | 预检期直接报错，零模型请求 |

**明确不做 v1**：部分结果合并（`partial: true`）。理由：下游无法区分「少了几条」和「本来就没有」，部分结果比失败更危险。需要时另开决策。

### 11. 配置

```jsonc
"limits": {
  "split": {
    "enabled": true,              // 是否允许在超过 maxShardChars 时自动分片
    "maxShardChars": 400000,      // 单片字符目标（约 100K tokens，给 128K 网关留余量）
    "maxShards": 12,              // 片数上限（成本护栏）
    "contextSummaryChars": 8000   // 其他文件摘要字符上限
  }
}
```

- 走主配置（ADR-0025 单一配置源），不新增 CLI 旗标；
- `enabled` 缺省 **true**（已拍板，理由见文末「已拍板」第 1 条）；
- 约束：`maxShardChars` 10 000…100 000 000；`maxShards` 1…64；`contextSummaryChars` 1 000…64 000；
- 模板（`DEFAULT_CONFIG_TEMPLATE` 与 `PiAgent.example.jsonc`）同步新增注释块；
- `enabled=true` 是行为变更：400K–1.5M 的 diff 从「一次跑」变成「多片跑」，成本与耗时按片数增加。发布说明必须写明；不愿接受的用户设 `enabled=false`。

### 12. 单 shard 零变更（硬回归门）

当 `split.enabled=false` 或过滤后 diff ≤ `maxShardChars`：

- 走今天完全相同的单遍路径；
- 请求字节、审计（除新增可选键的缺席）、`run.json`、stdout、MCP 事件与第一期逐字节一致；
- `mrFilter` 仍按第一期逻辑记一次。

这是本 ADR 的第一验收项：**分片能力不能改变小 MR 的任何字节**。

### 13. export 与 session 索引（ADR-0036 的局部修订）

分片后一个任务有 N 份主转录，`SessionPaths.main` 的单值假设不成立：

- `SessionIndex` 升到 **version 2**：`mains: string[]` 取代 `main`（单 shard 时长度 1）；
- 读取端**兼容 v1**（`main` → `mains: [main]`），新写一律 v2；
- `review-pi export` 输出的源路径顺序：`s01 主 → s01 skill → s02 主 → s02 skill → …`；
- `--path` 复制仍平铺、同名覆盖；片转录文件名含各自的 `shardRunId`，不会互撞；
- 旧的单 shard 索引/产物无需迁移。

### 14. 明确不做

- ❌ 切 hunk / 按行截断（单文件巨大留给第三期）；
- ❌ 并行发请求（第一版串行）；
- ❌ triage / 先选高风险文件（第三期）；
- ❌ 分片之间的 LLM 二次合并 / 跨片全局推理；
- ❌ 部分结果输出；
- ❌ 新增运行时依赖；
- ❌ 改 stdout JSON 形状 / 改七工具 schema（`review.get_diff` 分页已在第一期完成）。

## Options（为什么不是别的）

- **A. 维持现状，只保留第一期体积门**：最小改动，但「文件多」永远无解，只能让用户自己拆 MR。否（这是第二期存在的理由）。
- **B. 切 hunk**：能解决单文件巨大，但破坏行号与文件级语义，evidence 链最脆弱。否。
- **C. 按字符截断前 N 字节**：静默漏检，违反 No Evidence / 零静默纪律。否。
- **D. triage 先选高风险文件再精读**：成本更低，但漏选即静默漏检，且需要另一套质量门。留给第三期。
- **E. 把 diff 移出 prompt，全走 `review.get_diff` 按需读**：从根上解决窗口问题，但模型可能只读一半就下结论，且 prompt/工具/评测全变。留给第三期。
- **F. 每片各发一组 `run.start/run.end`**：机器流水会把一次任务看成 N 次，破坏 ADR-0037 的流语义。否。
- **G. 部分结果 + `complete:false` 输出**：下游无法区分缺几条；v1 不做。
- **H. 并行跑 N 片**：降低成本敏感度，但第一版会放大「同一时刻 N 个网关请求」与确定性/缓存问题。推迟。

## Consequences

- **正**：
  - 「文件多」的大 MR 从「必然失败或质量下降」变成「可检视」，且切分点可解释、可重放；
  - 单片预算明确，模型窗口风险前移到预检；
  - 小 MR 零字节漂移，现有产物与上报契约不被破坏；
  - 合并规则是纯函数，可单测、可复算。
- **负 / 风险**：
  - 成本与耗时按片数增加（`maxShards` 是唯一成本护栏）；
  - 跨文件缺陷可能被切散：靠「其他文件摘要 + 覆盖账 + domainWarning」缓解，不能完全消除；
  - 产物布局与 `export` / session 索引出现第二种形态，文档与测试面变大；
  - 每片都从 F001 起，合并必须重编号，漏做会产生重复 id；
  - 规则 Skill 每片各跑一次，skill 会话成本同步放大。
- **中性**：
  - 七工具 schema、阶段指令、stdout 键集、退出码语义不变；
  - 新增配置块缺省走单 shard（`split.enabled` 缺省 true，但 diff ≤ `maxShardChars` 时不分片）。

## 验收标准

1. **单 shard 零变更**：`enabled=false` 或 diff ≤ `maxShardChars` 时，请求字节、审计（除新键缺席）、`run.json`、stdout、MCP 事件与第一期逐字节一致。
2. **切分不变量**：每个文件块恰好出现一次、不跨片、顺序稳定、预算不被突破；超大片与超片数均报错且零模型请求。
3. **每片输入正确**：分片 e2e 中每片初始消息只含本片 diff + 其他文件摘要；`review.get_diff` 只返回本片。
4. **合并正确**：去重矩阵（同键 / 不同键 / 同文件不同行 / 同标题不同文件）、严重度取最高、evidence 并集、id 重编号、稳定排序。
5. **聚合账目闭合**：`usage` / `toolCalls` 求和、`rounds` 取最大、`truncated` 任一、`findings` 等于合并结果。
6. **产物可寻址**：`run.json.shards[]` 能定位每片转录/审计；`export --taskId` 按片顺序列出全部会话；v1 索引仍可读。
7. **上报语义**：一次任务恰好一条 `run.start` + 一条 `run.end`；`shards` 计数正确；阶段事件带 `shard` 标签；默认 `include` 不发分片事件。
8. **失败语义**：第二片失败 → 退出 1、无聚合 `reviews_en.json` / `run.json`、`run.end(failed)`；已成功片的产物保留且可读。
9. **预过滤只做一次**：`mrFilter` 是全局量，不被每片重复记账。
10. **无新依赖、无秘密泄漏**：审计/转录/stdout/stderr 不出现 apiKey 或 headers。

## 已拍板（2026-11-04）

评审结论：**三条均按推荐执行**，不再保留待定项。

1. **`split.enabled` 缺省 = `true`**。
   理由：缺省 false 等于大 MR 继续只会报错，第二期白做。代价是 400K–1.5M 的 diff 从「一次跑」变成「多片跑」，成本按片数增加；`maxShards` 是唯一成本护栏，发布说明必须写明，不愿接受的用户显式设 `enabled=false`。

2. **聚合 `runId` = 第 1 片自己的 `runId`**（不引入独立聚合 id）。
   理由：保住 ADR-0032 的「`runId` = 该 run 首次模型请求时刻」与「`audit/<runId>.json` 可互推」。独立 id 会让聚合审计文件名与任何一次真实请求脱钩，等于在身份体系里开第二个洞。

3. **失败不输出部分结果**（决策 10 原文保持不变）。
   理由：下游无法区分「少了几条」和「本来就没有」，部分结果比显式失败更危险。若业务确需「先看一部分」，另开 `partial` 模式与独立 ADR。

4. **规则 Skill 的装载与执行口径**：装载（规则解析 + 装载审计）在编排层**只做一次**；每个 shard 各跑自己的 skill 会话，使其对该片代码生效。不做「只在第 1 片跑 skill」的省成本变体——那会让后片的规则约束凭空消失，属于静默降级。

## 实施拆分（建议提交序）

1. **纯函数层**：`run/shard-planner.ts`（装箱 + 摘要）+ `run/findings-merge.ts` + 单元测试；不接线。
2. **编排层**：`runReview` 拆成「外层边界 + 单遍 / 分片编排」；`runReviewInner` 改为不发射 `run.start/end` 的单遍函数；接线分片与聚合。
3. **产物与审计**：聚合 `run.json` / 审计 / 片目录 / `export` / `SessionIndex` v2。
4. **上报与进度**：`shard` 标签、外层一次 `run.start/end`、CLI stderr 一行。
5. **文档与验收**：CONTEXT、使用/运行手册、本 ADR 的「实施记录」；跑全量测试与 typecheck。

版本节律：本期属于新增能力，release 时 `0.2.0 → 0.3.0`（`packages/review-pi/package.json` 与 `src/shared/version.ts` 同改，由 `version.test.ts` 把守）；不在功能提交里提前改版本。

## 实施记录（2026-11-05）

### 实际落地文件

| 层 | 文件 | 作用 |
|---|---|---|
| 纯函数 | `run/shard-planner.ts` | `splitDiffIntoFileBlocks` + 按文件块贪心装箱 + 「其他文件摘要」；预检超预算 / 超片数报错 |
| 纯函数 | `run/findings-merge.ts` | 按 `(file, line, title)` 归一化去重、字段合并、重编号、稳定排序 |
| 单遍执行单元 | `run/review-pass.ts` | 原 `runReviewInner` 抽出：六阶段 + skill 会话 + 审计/转录/reviews 落盘；**不发射** `run.start/end` |
| 编排层 | `run/review-run.ts` | 全局预过滤 / 体积门 / 边界 → `planReviewShards` → 一次 `run.start/end`；`executeSinglePass`（零变更）与 `executeShardedPasses`（串行、每片独立目录）→ `aggregateShards` |
| 契约 | `contracts/progress.ts` / `contracts/mcp-report.ts` / `contracts/run.ts` | `shard` / `shards` 进度标签、MCP 映射、`ShardAuditRecord` 与 `RunAudit.shards` |
| 记录与审计 | `experiment/run-record.ts` / `audit/audit-writer.ts` | `ShardRecord`、`RunRecord.shards`、`buildRunRecord({shards})`、审计透传 |
| CLI | `cli/main.ts` / `cli/progress-render.ts` | 一次 `run.start`（带片数 → stderr 一行提示）；事件/状态行 `[sN/M]` 前缀；session 索引 v2 |
| 上报 | `mcp/report.ts` | `shard` / `shards` 字段透传（默认 `include` 仍不发分片事件） |
| export | `export/session-index.ts` / `export/session-export.ts` | `SessionIndex` v2（`mains[]`，读兼容 v1）；`SessionPaths.mains` + 可选 `order`；按 `sNN` 前缀归组还原「主 → 该片 skill」顺序 |
| 配置 | `shared/config.ts` | `limits.split` 四键（`enabled` / `maxShardChars` / `maxShards` / `contextSummaryChars`） |
| 测试 | `run/sharded-review.test.ts`（新增 6 例）+ `export/*.test.ts` / `mcp/report.test.ts` / `cli/bin.process.test.ts` | 单 shard 零变更、预检零请求、输入隔离、合并/账目/寻址、失败无部分结果、索引 v2 / export 顺序、分片进程 e2e |

### 关键取舍（实现期确认）

1. **聚合审计只当索引，不当第二份明细**：`run.json.shards[]` 记每片 `runId` / 文件数 / 字符数 / `usage` / `rounds` / `toolCalls` / 转录与审计相对路径；聚合审计的 `requests` / `toolCallLog` 留空，明细一律在各片审计里。避免把 N 片的大对象再拷贝一遍，也避免聚合审计假装拥有不存在的请求。
2. **全局量只记一次账**：`mrFilter`、`mrBoundary`、`config` 只出现在单遍审计或聚合审计中，片内审计不带；每片 `domainWarning` 用全局边界文案。预过滤 / 体积门 / 边界度量也只做一次。
3. **`attempt-<startedAt>` 不是 `runId`**：只作片目录名，让每次尝试独占一组产物；聚合 `runId` = 第 1 片 `runId`（保住 ADR-0032 可互推关系）。
4. **`ReviewRunResult` 兼容面**：保留 `transcriptPath` = 首片转录，新增 `transcriptPaths` = 全部片；`run.recordPath` / `auditPath` / `reviewsPath` 恒指聚合产物。
5. **export 顺序显式化**：`SessionPaths` 新增可选 `order`；分片时由 `shards[].transcriptFile` 与 `skillPassLog[].transcriptFile`（已是 runs 目录相对 POSIX 路径，含 `sNN` 段）按目录前缀归组，显式拼 `s01 主 → s01 skill → s02 主 → …`；无 `order` 时退回旧顺序（先全部主、再全部 skill）。
6. **失败保留片产物但不是「部分结果」**：任一片失败 ⇒ 抛错、`run.end(failed)`、顶层 `run.json` / `reviews_en.json` / 聚合审计**一律不写**；已成功片的转录/审计/片内 `reviews_en.json` 留在 `shards/` 下供排查，不进入对外消费面。
7. **候选 id 各片从 `F001` 起**：合并后按最终顺序重编号，避免跨片 id 冲突；同片内仍由候选门保证唯一。

### 验证结果

- `pnpm --filter review-pi typecheck` / `pnpm -r typecheck`：exit 0。
- `pnpm --filter review-pi build`：exit 0。
- `pnpm --filter review-pi test`：**66 files / 625 passed / 1 skipped**。
- 新增 `run/sharded-review.test.ts` 6 例：单遍零变更（`enabled=false` / 未超预算）、预检错误零请求、分片输入隔离 + `review.get_diff` 只返回本片、合并/账目闭合/`run.json.shards` 寻址/进度事件、第二片失败无聚合产物。
- `cli/bin.process.test.ts` 新增分片进程 e2e：stderr 片数提示与 `[sN/M]` 前缀、stdout 键集不变、`run.json.shards`、session 索引 v2 两条 `mains`、export 顺序、密钥哨兵。
- `mcp/report.test.ts` 新增分片字段透传用例；`export/session-export.test.ts` 新增分片导出顺序用例；`export/session-index.test.ts` 覆盖 v2 写入与 v1 读取兼容。

### 已知限制

- **串行**：N 片按顺序执行，耗时与成本随片数线性增长；`maxShards` 是唯一成本护栏。
- **单文件巨型仍无解**：单个 `diff --git` 块超过 `maxShardChars` 直接报错（留给第三期按需读取），不切 hunk、不截断。
- **跨片缺陷不兜底**：不做跨片 LLM 二次合并 / 全局推理；跨文件缺陷可能被切散，靠「其他文件摘要 + 覆盖账」缓解。
- **聚合审计不含请求明细**：排查必须按 `shards[]` 打开片审计；`rounds` 取各片最大值（不是总轮数），`usage` / `toolCalls` 为求和。
- **尝试目录不自动清理**：同一任务重复运行会累积 `runs/shards/attempt-…/` 与 `audit/shards/attempt-…/`，目前靠人工清理。
- **规则 Skill 成本放大**：每个 shard 各跑一次 skill 会话（设计如此，不做「只在首片跑」的省成本变体）。
