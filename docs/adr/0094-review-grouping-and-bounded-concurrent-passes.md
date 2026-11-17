# 0094. 检视分组与有界并发 pass（含 partial success）

**状态**：已接受（2026-11-16，用户决策：LLM 语义分组、全局组并发 4、v1 默认关闭、五项验收门槛）
**关联**：[ADR-0039](0039-sharded-review-for-large-mrs.md)（大 MR 分片：复用 `runPasses` / merge）、[ADR-0070](0070-single-file-truncation-and-tighter-diff-limits.md)（单文件整 hunk 截取）、[ADR-0071](0071-recalibrate-large-mr-defaults-for-128k.md)（分片预算）、[ADR-0082](0082-pass-assembly-context-and-descriptor.md)（pass 装配）、[ADR-0058](0058-shard-report-splits-and-retries-on-failure.md)（片级部分失败留痕）、[ADR-0095](0095-rule-catalog-and-heterogeneous-skill-overlay.md)
**范围**：本仓 pi 线 0094。新增 `limits.grouping`、LLM 语义分组、分组的体积/组数兜底、`runPasses` 有界并发与 partial success；规则目录/异构技能叠加见 ADR-0095。不改 diff 解析、Finding schema、单遍路径的字节。

## Context

AACR-Bench v2 的 91 条交集显示，review-pi 与 OCR 的差距**随文件广度急剧扩大**：

| changed files | review-pi Balanced | OCR Balanced |
|---|---:|---:|
| ≤5 | 0.328 | 0.327 |
| 6–15 | 0.320 | 0.354 |
| 16–40 | 0.104 | 0.284 |
| >40 | **0.046** | **0.353** |

按 `change_line_count` 分层时差距在所有箱都约 +0.21–0.26，说明驱动因素是**文件数/上下文广度**，不是改动行数。

现状：

- 分片只在 `diff > limits.split.maxShardChars`（缺省 12 万字符）时触发，且按连续文件块贪心装箱；文件多但 diff 不超预算时仍是单遍；
- `runPasses` 是 `for … await runPass` **串行**（`pass-runner.ts`），分片多时墙钟线性累加；
- 规则 Skill 会按 **round × shard × skill** 跑独立会话（ADR-0095 收口），分组后若不改执行模型，成本会乘性放大；
- 大 PR 单遍已经 1000–1700s，直接切多片串行会不可接受。

## Decision

1. **触发条件**：`changedFiles > limits.grouping.minFiles`（缺省 5）**或** `diffChars >= limits.grouping.minDiffChars`（缺省 51200）时分组；但文件数 ≤ `smallPrMaxFiles`（缺省 8）**且** diff ≤ `smallPrMaxChars`（缺省 120000）的小 PR 直接跳过，保持单遍。小 PR 拆成 1–2 个文件的组会丢跨文件上下文、放大输出。
2. **LLM 语义分组**：只喂文件元数据（相对路径、语言、changed lines、字符数、是否测试/配置），不喂 diff 内容；每样本一次调用；输出严格 JSON `{groups:[{label, files:[index...]}]}`，要求每个文件恰好出现一次、每组 1–8 个文件；校验失败重试一次，仍失败则 fallback 到**确定性顶层目录分组**（不是 per-file）。
3. **分组可复现**：分组结果按 `diff digest + 文件列表` 缓存；group 顺序按组内最小文件 index 排序；分组 LLM 的模型可配（`limits.grouping.model`，null 跟随 `model.default`）；分组调用单独计入 token 审计。
4. **组体积与组数兜底**：每组最多 `maxFilesPerShard=8` 个文件、`maxCharsPerShard=30000` 字符；语义组超限时按**整文件块**继续切（不切 hunk，复用 ADR-0070 的 `prepareBlock`）；小于 `minFilesPerGroup=3` 的碎组并入相邻组（优先并入合并后仍不超 `maxFilesPerShard` 的邻居）；总组数超 `maxShards=12` 时合并相邻最小分组，**不丢文件/不丢片**。
4b. **分组先于普通分片**：`grouping.enabled=true` 时 `prepareReview` 不再先跑 `limits.split` 的规划，否则 `split.maxShards` 会在大 diff 上先抛错、`grouping.maxShards` 根本没机会生效；分组未产生多片时才回退普通分片（仍按 split 上限报错）。
4c. **输出预算**：分组路径在合并后先按片截断（`maxFindingsPerShard=3`），再按全样本截断（`maxFindingsPerRun=30`）；排序为严重级优先、同级 confidence 降序；截断后重编号。`0` = 不限制。普通分片路径不应用该预算（零漂移）。
5. **每组一次规则增强检视**：一个 Review Group 只跑一次 rule-augmented review（规则由 ADR-0095 的 Rule Resolver 选定）；不再 per-skill / per-round 全量重审；main pass 的 Phase 5 候选作为 seed，规则侧只报增量。
6. **有界并发 pass**：`runPasses` 改为**进程级**有界 Promise 池，并发上限 `limits.grouping.concurrency=4`；`executed` 按 descriptor 顺序回填，merge / 审计 / 转录顺序确定；每个 pass 的目录、时间线、进度、上报保持现有隔离。并发上限是进程级，禁止“样本并发 × 组并发”的乘法；分组实验里 pipeline 样本并发先设 1。
7. **共享只读上下文**：同一 group 内 main pass 与规则 pass 共享只读 `RepoContext/sourceCache`；跨 group 不共享可变状态；缓存 key 含 repo snapshot / diff digest。
8. **Partial success**：只要 main pass 或至少一个 group 产出结果，run 状态为 `ok`、退出码 0，交付已有 findings；审计记录 `degradedGroups`（失败的 group / 原因 / 是否可重试）；**全部失败**才判 failed。不因个别 group 失败丢弃整次结果。
9. **默认关闭**：v1 `limits.grouping.enabled=false`；通过配置/benchmark 显式开启；只有第 11 条五项门槛全部通过后，才考虑改为默认开启。
10. **配置面**（新增 `limits.grouping`，不动 `limits.split`）：

| 参数 | 缺省 | 中文说明 |
|---|---:|---|
| `enabled` | `false` | 是否启用分组检视；v1 默认关闭，达标后再改默认。 |
| `minFiles` | `5` | 变更文件数**严格大于**该值时触发分组。 |
| `minDiffChars` | `51200` | diff 字符数达到该值时触发分组；与 `minFiles` 取 OR。 |
| `smallPrMaxFiles` | `8` | 小 PR 跳过：文件数不超过该值**且**字符数不超过 `smallPrMaxChars` 时不分组。 |
| `smallPrMaxChars` | `120000` | 小 PR 跳过：diff 字符数不超过该值**且**文件数不超过 `smallPrMaxFiles` 时不分组。 |
| `minFilesPerGroup` | `3` | 每组最少文件数；1–2 个文件的碎组并入相邻组。 |
| `maxFilesPerShard` | `8` | 每个检视组最多文件数；超出按文件块继续切。 |
| `maxCharsPerShard` | `30000` | 每个检视组最大 diff 字符数；单文件块超限按整 hunk 截取。 |
| `maxShards` | `12` | 单样本最多检视组数；超出合并相邻小组，不丢文件。 |
| `maxFindingsPerShard` | `3` | 每片最多保留 findings；`0` = 不限制。 |
| `maxFindingsPerRun` | `30` | 全样本最多保留 findings；`0` = 不限制。 |
| `concurrency` | `4` | 进程级检视组并发上限；不是每样本 × 组数。 |
| `model` | `null` | 分组 LLM 模型；`null` = 跟随 `model.default`。 |

11. **验收门槛**（gap 分层：>15 files 或 >50KB；A/B single-pass vs grouping，必须同时满足才允许默认开启）：

- `on-GT share` ≥ 40%（基线 21.3%）；
- Balanced 相对 single-pass 提升 ≥ 0.03；
- token 增量 ≤ 2×；
- 墙钟增量 ≤ 1.5×（并发 4 下）；
- ≤5 文件回归集 Balanced 下降 ≤ 0.01。

## Options（为什么不是别的）

- **只调低 `limits.split.maxShardChars` 做实验**：保留为第 0 层验证（零代码），但它是按 diff 顺序切、不按语义分组、且串行；不能作为产品形态。
- **确定性路径分组，不做 LLM**：成本更低、可复现，但无法处理“实现/头文件/测试/资源”跨目录的相关性；用户明确选择 LLM 语义分组，路径分组只作 fallback。
- **per-file 分组**：组数最多、固定前缀开销最大，且相关文件被拆散；不作为默认。
- **分组后仍 per-skill 全量重审**：会话数 = groups × rounds × skills，重复读文件与重复检视会爆炸；由 ADR-0095 收口。
- **无界并发**：会撞网关限流，且与样本并发相乘；只允许进程级有界并发。
- **任何 group 失败即整次失败**：与用户要求的“已有产物照常上报”冲突；改为 partial success + degraded 审计。

## Consequences

- **好**：多文件/大 diff PR 的上下文被切小，precision/recall 有机会接近 OCR 的小组表现；`runPasses` 并发把墙钟从“片数线性累加”压到“片数/并发”；partial success 不再因个别组失败丢整次结果。
- **代价/风险**：分组 LLM 多一次调用；每组重复固定提示词/规则上下文，token 可能上升；并发提高峰值吞吐与限流风险；分组结果依赖模型，需要 digest 缓存与确定性排序才能重放。
- **测试面**：`grouping` 配置解析/默认值、触发条件、LLM 输出校验与 fallback、组体积/组数兜底、`runPasses` 并发顺序与失败隔离、partial success 审计、grouping 缓存命中。
- **未完成**：规则目录/异构技能叠加见 ADR-0095；v1 默认关闭，五项门槛通过前不得改默认。
