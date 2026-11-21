# review-pi 优化建议（基于 91 条交集的根因）

数据依据：OCR 82.0% 的意见落在有 GT 的文件，review-pi 只有 21.3%；两者在**有 GT 文件内**的命中率
几乎相同（38.1% vs 36.7%）。所以优化重点不是“让模型更会判”，而是“让意见落在该落的地方、少报无 GT 噪声”。

## P0：先做，直接改变文件靶向与意见密度

> 证据分级（基于离线重放，91 条交集）：
> - **意见预算**：top 8 / 每文件 3 条 → B 0.109→0.132，P 7.8%→13.5%，R 18.0%→12.9%；
> - **excludeGlobs**：只删 62/1242（5.0%），B +0.003，几乎无效；
> - **规则层**：OCR 内置规则层确实存在，但 review-pi 本次没有 rule-skill 实验，是假设；
> - **反射过滤**：尚未单独量化，但它针对的是 978 条无 GT 意见，优先级高于 excludeGlobs。
>
> 所以顺序调整为：预算 → 反射 → 文件排除 → 规则层实验。

### 1. 每 PR / 每文件意见预算 + 排序（最高优先级）

现状：review-pi 平均 13.6 条/样本，GT 平均 6.5 条；1242 条意见只覆盖 106 条 GT。
978 条无 GT 意见里，可靠性 475、可维护 238、可读性 101、性能 48、安全 44、可移植 43、可测试性 18；
P1/P2 合计 655 条——不是纯 style，而是“报得太多、铺得太广”。建议新增输出侧预算（需要小改代码/配置）：

- `limits.findings.maxPerPr`：建议 8–10；
- `limits.findings.maxPerFile`：建议 2–3；
- 排序键：severity（P0>P1>P2>P3）→ confidence → category（Defect/Security/Performance 优先）；
- 超过预算的 finding 只进审计，不进 tips/最终输出。

离线模拟（91 条交集）：

| 预算 | 保留意见 | Precision | Recall | Balanced | 有 GT 文件内占比 |
|---|---:|---:|---:|---:|---:|
| 无预算 | 1242 | 0.0781 | 0.1803 | 0.1090 | 21.3% |
| **top 8 / file 3** | **542** | **0.1347** | 0.1293 | **0.1319** | **30.3%** |
| top 10 / file 3 | 622 | 0.1254 | 0.1378 | 0.1313 | 27.7% |
| top 6 / file 3 | 438 | 0.1484 | 0.1156 | 0.1300 | 33.3% |

这不是简单调 `confidence.min`/`severity.min`：离线扫描显示单靠阈值只降 recall、不升 balanced。
预算 + 排序才能在保留高价值意见的同时压分母。

**注意：单独限制每文件条数几乎无效。** cap 3 只保留 1136 条，B 0.109→0.1066；cap 5 才回到 0.109。
原因是无 GT 意见平均只有约 1.4 条/文件，大多数文件只有 1 条，per-file cap 碰不到长尾。
必须加**每 PR 全局预算**（top 8/10），才能砍掉“长尾文件上的一条意见”。

### 2. 输出前反射/过滤一遍

在 findings 定稿前加一个轻量过滤（可用一次 one-shot 模型调用，或确定性规则）：

- 该意见是否由本次 diff 引入/直接受本次 diff 影响？
- 是否落在可检视代码文件（非配置/数据/生成物）？
- 是否只是风格/nit，且没有明确失败场景？
- 与同文件其他意见是否重复？

OCR 有独立的评论定位/反射模块；review-pi 目前只有证据门/去重门，缺少“这条值不值得输出”的最后一层。
**这个问题的主要来源是 978 条无 GT 意见，反射过滤比 excludeGlobs 更对症。**

### 3. 扩展文件排除：配置/数据/生成物/基线（噪声卫生，不是主杠杆）

当前 `limits.mrFilter.excludeGlobs` 只有 md/lock/fixtures/snap。建议增加：

```jsonc
"limits": {
  "mrFilter": {
    "excludeGlobs": [
      "**/*.md", "**/*.lock", "**/*.snap",
      "**/package-lock.json", "**/pnpm-lock.yaml", "**/yarn.lock",
      "**/uv.lock", "**/pixi.lock", "**/poetry.lock",
      "**/build/**", "**/dist/**", "**/generated/**",
      "**/testdata/**", "**/baselines/**", "**/__snapshots__/**",
      "**/*.min.js", "**/*.map", "**/*.vocab.json", "**/*.interp",
      "**/.github/workflows/**", "**/*.yml", "**/*.yaml"
    ]
  }
}
```

**离线实测**：91 条交集只删 62/1242 条（5.0%），P 0.0781→0.0814，R 0.1803→0.1786，B 0.1090→0.1118。
原因是大头是 `.ts/.py/.java/.go/.c/.js` 代码文件，不是配置/锁文件；且通用 `.json` 未排除。
所以保留它作为噪声卫生，但不要期待单独改变指标。若加 `**/*.json` 可再删一批，但会误伤真实配置缺陷。

### 4. 规则层实验（待验证，不是默认前提）

**OCR 确实内置规则层**：`internal/config/rules/system_rules.json` + `rule_docs/*`，按文件路径/语言
`SystemRule.Resolve(path)` 后作为 `<rules for="...">` 注入 prompt，默认开启；规则文档明确写
"Favor precision over recall"。

但**不能直接照搬到 review-pi**：

- review-pi 的 `--rule-skill` 是可选装载，默认不扫描、不加载（ADR-0027）；
- 我之前引用的 `packages/review-pi/testdata/rule-skills/general-code-review` 是 **testdata 夹具**，
  不是产品默认规则包；
- 本次 91 条跑的是 review-pi 的**无规则包**默认形态，还没有 rule-skill on/off 的实测。

正确做法是 arm3 实验：`findingScope` 关 + 一个生产级规则包（或 testdata 包作 stand-in），在
91 条交集/smoke20 上看 `on-GT share`、comments/PR、P/R/B。若没有提升，不要默认开启。

## P1：结构性改造

### 5. 确定性文件选择 + 文件分组

OCR 覆盖 138/272 个 GT 文件，review-pi 只有 74/272。建议引入确定性的“检视文件选择层”：

- 从 diff 里枚举所有 changed files → 过滤 generated/config/test/docs → 得到 reviewable set；
- 按“实现 + 头文件/同模块测试/相关资源”分组，每组一个 agent 会话（隔离上下文）；
- 每个 reviewable 文件至少被一个组覆盖；未覆盖的文件显式记录为 skipped。

这比“让通用 agent 自己探索整个仓库”更接近 OCR 的覆盖率，也能减少大仓库上的上下文稀释。

### 6. 文件级 / 仓库级上下文意见

GT 的 File Level 和 Repo Level 覆盖率 review-pi 只有 17.4% / 15.9%，OCR 为 30.7% / 36.3%。
建议在 diff 级检视之外增加：

- 文件级 pass：看完整文件语义、调用关系、命名/契约；
- 仓库级 pass：看跨文件引用、接口变更、配置/部署影响；
- 每个 pass 有独立的 finding 预算，避免又变成“多而散”。

### 7. 验证门调优

91 条里 review-pi 的 `VERIFICATION_FAILED` 有 38 条。建议：

- 抽样人工复核这 38 条，区分“验证器误杀”与“证据确实不足”；
- 若误杀为主，放宽高置信候选的验证要求，或让验证器输出可执行的补充证据建议；
- 在审计里记录每条 verification reason，便于回归。

### 8. 降低重复候选

`DUPLICATE_ID` 113 条说明模型在多轮里反复报同一问题。建议在提示词里明确“已报问题列表”，
或在每轮后把已报内容注入下一轮上下文，减少重复候选与 token 浪费。

## P2：指标与评测

### 9. 增加“靶向”指标

当前报告只有 P/R/B。建议在评测报告里增加：

- `on_gt_file_share` = 落在有 GT 文件的意见 / 总意见；
- `gt_file_coverage` = 覆盖的 GT 文件 / GT 文件总数；
- `comments_per_covered_gt`；
- `non_gt_comment_count`。

这些指标能直接解释 precision 变化，避免只盯总分。

### 10. 用两套集合

- **排名**：91 条交集（全量可比集）；
- **回归**：smoke20（`make_smoke_subset.py --per-language 2`），3 轮 judge；
- **人工审计**：随机抽 30 条无 GT 意见，判定“有效但未标注” vs “噪声”，再决定是否继续压 precision。

### 11. 不要只优化 AACR GT

- v2 的 GT 77% 是 AI 评论，且文件级指标不看行号；
- 无 GT 文件上的意见可能是真问题，只是没有标注；
- 目标应是“可执行、可定位、低噪声的缺陷意见”，不是把分数刷到某个数。

## 不要做的过滤

- **不要按 category 一刀切删除**（见 [`category-severity-filter.md`](category-severity-filter.md)）：
  没有组合超过 baseline 0.109；可靠性/可维护/可读性里都有真实 GT，删类别会同时删 recall 分子。
- **不要只调 severity 阈值**：P2+ → B 0.097，P1+ → 0.054，P0 → 0.007。
- **不要只调 confidence 阈值**：20 组扫描没有任何一组提高 balanced。
- **不要只做 excludeGlobs**：只删 62/1242（5.0%），B +0.003。

类别适合用来**排序**（Defect/Security/Performance 优先），不适合用来**删除**。

## 建议的验证顺序

1. P0-1（意见预算）→ 先离线重放（本目录 `offline-mrfilter-budget.md` 已有 top N 结果）；产品实现后再用 91 条交集/1 轮 judge 验证；
2. P0-2（反射过滤）→ 91 条交集/1 轮 judge，看 on-GT share / comments/PR / B；
3. P0-3（文件排除）→ 91 条交集；离线已显示只删 5% 意见，预期变化很小；
4. P0-4（规则层 arm3，假设验证）→ 91 条交集/smoke20，与无规则包对比；
5. P1-5（确定性文件选择/分组）→ smoke20 + 91 条交集；
6. P1-6/7/8 → 分语言看 File/Repo level 覆盖与验证误杀；
7. 最终用 3 轮 judge 汇报。

> 输出侧的预算/排除/反射可以先用现有结果离线重放；输入侧的文件排除和规则层会改变模型看到的 diff，
> 精确结论需要重跑。

目标（方向性，不作承诺）：

- on-GT share：21% → 40–60%；
- comments/PR：13.6 → 7–9；
- GT file coverage：74/272 → 100+；
- 91 条交集 balanced：0.109 → 0.20+。
