# 0070. 大 MR 缺省阈值收紧 + 单文件超预算改为整 hunk 截取

**状态**：已接受（2026-11-10，用户决策：`maxDiffChars=200000` / `maxShardChars=80000` / `maxShards=6` / 四条 `excludeGlobs` 落成缺省；单个文件超过 80k 必须「截取检视」，禁止直接报错）
**关联**：[ADR-0039](0039-sharded-review-for-large-mrs.md)（按文件块分片；本 ADR 只改缺省值与单块超预算的处置方式）、[ADR-0064](0064-finding-scope-out-of-diff-filter.md)（另一个缺省开启的输入侧护栏）、[ADR-0069](0069-configurable-diff-exclude-globs.md)（`excludeGlobs` 机制；本 ADR 只改缺省值）、[ADR-0068](0068-report-every-changed-file-including-filtered.md)（被剔除文件仍补空检视意见）、[ADR-0052](0052-tips-four-tier-severity-and-confidence-filter.md)（输出侧过滤，与本 ADR 不同层）

**范围**：本仓 pi 线 0070。改三个缺省数字 + 一个缺省列表；把「单文件块 > `maxShardChars`」从**预检期抛错**改为**按整 hunk 截取并留痕**。hunk 字节、行号、evidence 链语义不变。

## Context

ADR-0039 的分片只按 `diff --git` 文件块装箱，绝不在文件内部切 hunk。原实现对「单个文件块 > `maxShardChars`」的选择是**直接抛错**：

```
文件 <path> 单块 N 字符，超过单片预算 M 字符（limits.split.maxShardChars）；
请拆分该文件或等待第三期按需读取，不要在分片边界内切 hunk。
```

缺省值是按 128K 上下文网关定的（`maxDiffChars=1 500 000` / `maxShardChars=400 000` / `maxShards=12` / `excludeGlobs=[]`）。实际接入的网关上下文更小，且真实 MR 里「一个文件顶掉整片预算」并不罕见：

- 大的 OpenAPI / k8s YAML、SQL 迁移、fixture JSON；
- 整文件重排的模块；
- 长行 JSON（本仓历史提交 `7d45ed1`：3 591 变更行却有 804 万字符，几乎全在 `testdata/traces/*.json`）。

在这些场景下直接报错等于**整次检视失败**（零模型请求、平台只看到 `startTask → endTask`）。用户的明确要求：单文件超预算要**能检视**，宁可只看前半部分也不能报错。

## Decision

### 1. 缺省值收紧（配置面）

```jsonc
"limits": {
  "boundary": { "maxDiffLines": 2000, "maxDiffChars": 200000 },
  "split":    { "enabled": true, "maxShardChars": 80000, "maxShards": 6 },
  "mrFilter": { "excludeGlobs": ["**/*.md", "**/*.lock", "**/fixtures/**", "**/*.snap"] }
}
```

换算基准（实测，非估算）：本仓源码平均行 34.3 字符；真实提交 `61c749b` 52.5 字符/变更行、`a964e02` 62.3；仓库自带 `large-mr.diff` 36.1。

| 阈值 | 约变更行 | 作用 |
|---|---:|---|
| `maxDiffLines=2000` | 2 000 | 只告警（`domainWarning` / 审计 `mrBoundary`） |
| `maxShardChars=80 000` | 1 300 – 2 350 | 超了自动分片 |
| `maxDiffChars=200 000` | 3 200 – 5 900 | 超了拒检（`exit 1`） |

三个数自洽：`200 000 / 80 000 = 2.5`，最坏 3 片，`maxShards=6` 有 2 倍余量；且 `maxShardChars < maxDiffChars`，分片真正可触发（若反过来，体积门会先报错、分片永不触发）。

`excludeGlobs` 缺省非空是配套的：80k 的分片尺寸偏保守，一个数据文件就能顶满一片。缺省排除 Markdown / lockfile / fixtures / snapshot，属「非代码变更」或「测试夹具」，被剔除后仍按 ADR-0068 补空 `mrReviewResult`。

### 2. 单文件块超预算：整 hunk 截取（不报错）

`planShards` 对每个块先做 `prepareBlock(block, maxShardChars)`：

1. `block.chars <= maxShardChars` → 原样；
2. 否则找出块内全部 `@@ ` hunk 起点，**只删整 hunk**：保留文件头（`diff --git` / `index` / `---` / `+++` …）+ 前缀 k 个**完整** hunk，选「不超预算的最大 k」；
3. 退化情形（文件头 + 首个 hunk 本身就超预算）→ 保留首个 hunk，如实记录（宁可超目标，也不留一个只有文件头、模型完全看不到改动的空块）；
4. 块内没有 hunk（二进制 / 纯头部）→ 无法安全截取，原样保留、不产生留痕。

**绝不切 hunk 体**这条不变量不变：被丢弃的是整个 hunk，保留下来的 hunk 与原始字节逐字相同，行号与 evidence 链仍自洽。

### 3. 截取必须留痕（零静默）

- `Shard.truncated`（进程内）→ 聚合为审计尾键 `RunAudit.shardTruncation`（`ShardTruncationRecord[]`：`path / originalChars / keptChars / hunks / keptHunks / droppedHunks / droppedAdded / droppedRemoved`）；
- `ReviewRunResult.shardTruncation` 同源投影，CLI 在 stderr 报一行：`已截取检视 N 个超预算文件（丢弃 M 个完整 hunk，保留 K 字符），明细见审计 shardTruncation`；
- 无截取时整键缺席（零漂移）。

### 4. 唯一一片也可能是截取片

`planReviewShards` 原本在「只装出一片」时返回 `null`（走单遍）。但单文件超预算恰恰会装出**唯一一片**：若仍走单遍，截取结果会被丢弃、原始超预算 diff 被整份发给模型。因此改为：

- 规划结果 > 1 片 → 分片路径；
- 规划结果 = 1 片且该片含截取 → 仍走分片路径（`shards: {total: 1}`，审计 `shards[]` 一条）；
- 规划结果 = 1 片且无截取 → 单遍（旧行为，零字节漂移）。

## Consequences

- 单文件超 80k 不再让整次检视失败：只检视前若干个完整 hunk，尾部整 hunk 丢弃并在审计 / stderr 可见；
- 缺省阈值更贴合小上下文档位，成本上界从「最坏 12 片」收窄到「最坏 6 片」；同时 80k 分片线让 2 000 行标注线与分片线基本重合；
- 未检视的尾部是**已知损失**：截取后 findings 不含尾部 hunk，报告口径必须能解释这一点（靠 `shardTruncation`）；
- 单个文件 > `maxDiffChars`（200k）仍会被体积门拒检——那是用户显式设置的整份输入上限，与「单片预算」不是同一个闸；
- 回放 lane（`scripts/offline-replay/lib/lane.mjs`）必须显式把 `excludeGlobs` 固定为空数组：冻结 trace 的产物里 `README.md` 是被检视过的，产品缺省变化不能让历史 trace 失效；
- 成本：一处 `prepareBlock` + 三个尾部留痕点 + 缺省值 / 模板 / 手册 / 测试；无新增依赖、无新增 CLI 旗标。
