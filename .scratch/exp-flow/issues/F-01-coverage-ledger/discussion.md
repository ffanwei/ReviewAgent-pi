# F-01 讨论归档

> 归档约定：本文件按日期追加，只增不改历史结论；结论变化写新日期段。
> 票与验收在 [`ticket.md`](ticket.md)；任务总表在 [`../../map.md`](../../map.md)。

## 2026-11-21 · 任务解释

- F-01 = **覆盖账本**：文件 × hunk 三态（`candidate` / `no-issue` / `not-reached`），对应评估文档 P0-1、P1-11。
- 证据：
  - 漏掉的 GT 中 **56.8%** 所在文件没有任何意见（OCR 31.5%）；
  - 大 diff 上 **98.5%** 的意见落在没有 GT 的文件；
  - 小 diff 漏报中 **11/31** 是 Phase 1 已描述改动但没生成候选（F 类）；
  - **6/31** 是同 hunk 注意力被更显眼问题吸走（C 类）。
- 现状代码事实：
  - 准入/分片只记录输入有哪些文件（`run/review-run.ts:299-366`、`run/shard-planner.ts`）；
  - 审计有 `phaseLog` / `toolCallLog` / `rejections` / `shardTruncation`，没有「文件 × hunk」状态（`contracts/run.ts:335-374`）；
  - 流程可以正常 `complete`，即使某个文件一条候选都没有，且不产生任何记录；
  - `Finding.line` 是新侧行号；位置门已用新侧 hunk 区间（`gate/diff-scope.ts:5-7`）；
  - ADR-0070 截取只记 `droppedHunks` 计数，没有行区间（`contracts/run.ts:245-269`）。
- 与相邻任务：F-01 提供分母与缺口；F-06 是通用第二视角；F-04 的接地可复用同一套 hunk 区间。

## 2026-11-21 · OCR 如何保障每个 diff 被检视

OCR（`D:/Project/open-code-review` @ `d77d70b`）的做法是四层 + 一个出口：

1. **确定性选择**：`selectFiles` 一次完成 binary / secret / user rule / extension / default path / deleted / too_large 判断（`internal/agent/selection.go:43-102`）；`--preview` 与真实 run 用同一函数。
2. **冻结分母**：分发前 `registerCoverage` 注册所有非删除 selected 项并 `SealSelected`（`internal/agent/agent.go:1258-1278`、`internal/session/manifest.go:590-601`）。
3. **分组是全覆盖分区**：LLM 只返回索引；未认领文件自动成单文件组；max 10/组；token 超限拆单文件；分组失败回退每文件一组（`internal/agent/grouping.go:263-367`）。
4. **全出口终态 + Finalize 兜底**：completed / reused / failed / waived 每条出口都 Mark；仍为 selected 的项在 Finalize 一律扫成 failed（`internal/session/manifest.go:811-852`）；分区恒等式硬校验（`:900-934`）。
5. **出口语义**：`terminal_state` 只由覆盖推导（`:1009-1026`）；`complete/partial/skipped` 退出 0，`failed` 非 0（`cmd/opencodereview/review_cmd.go:357-380`）。

边界：粒度是**文件**；`completed` 只表示 subtask 跑完，不区分「审了没问题」和「跳过了」；`too_large` 整文件放弃；组内逐文件依赖提示词（`prompts/main_task_system.md:17,22`）。

## 2026-11-21 · OCR 对 F-01 的启发

可直接照搬的五个机制：

1. 分母先于任何模型请求，并 seal；之后只允许回填 / 收口。
2. selected 与 excluded 分离，excluded 带 reason、不进分母。
3. 每条出口写终态，未决由 Finalize sweep 兜底。
4. 分区恒等式作为测试 oracle：`candidate + no-issue + not-reached == hunk 总数`；分片并集 == 整份账本。
5. 覆盖进入输出语义（审计 / 摘要 / 可选退出码），而不是只报 findings。

必须改造的三点：

1. 粒度文件 → hunk；截取丢弃的 hunk 要诚实进覆盖（`not-reached(cause=truncated)`）。
2. 分发单位 ≠ 覆盖单位：shard / group 是分发单位，账本按 hunk 聚合。
3. `no-issue` 不能靠提示词自称；v1 不产生 `no-issue`，v2 由定向补漏的结构化回执产生。

## 2026-11-21 · diff 与上下文事实核查

- **是的，diff 一开始就在提示词里**：初始 user 消息由 `buildInitialUserMessage` 构造，diff 包在 ` ```diff ` 围栏中（`loop/messages.ts:3-27`、`run/review-pass.ts:211-221`）。
- 分片模式下 `initialDiff` = 片内 diff + 其他文件摘要；工具与位置门用 `input.diff`（不含摘要）（`run/pass-runner.ts:371-386`）。
- **六阶段不重新注入 diff**：Phase 1–6 是追加的 user 指令（`loop/phases.ts:10-55`、`agent-review-loop.ts:881-896`）；会话 append-only，每次请求带完整历史；多轮从 Phase 1 重来但历史仍在；规则 Skill 会话 fork Phase 5 末快照。
- **代码层不压缩输入**：ADR-0102 明确拒绝输入侧压缩 / 会话截断（`docs/adr/0102-context-window-budget-and-overflow-retry.md:78`）。
- **窗口层是硬失败，不是静默丢**：发送前估算，余量不足本地 fail fast；溢出 400 最多两次把 `max_tokens` 减半重试（`provider/pi-client.ts:157-190`、`:432-449`）。
- **ADR-0070 截取是真丢**：超预算文件块在进入提示词前按整 hunk 丢弃尾部，只留计数（`run/shard-planner.ts:146-214`）。
- **解析器现状**：
  - `diff/parse.ts` 的 `parseUnifiedDiff` 是单源，产出文件 + 新旧侧 hunk 区间 + hunk 正文；
  - 运行时唯一 hunk 消费者是 `gate/diff-scope.ts:78-99`（新侧区间）；
  - `analysis/diff-analysis.ts` 走旧侧区间，但 `resolveChangedFileSymbols` 无运行时调用方；
  - `diff/blocks.ts` 只切文件块；`shard-planner.prepareBlock` 只记截取计数；
  - **没有运行时的「文件 × hunk 目录」**。

## 2026-11-21 · 批次混合检视风险

- **一个批次 = 一次模型会话**：单遍 = 整份过滤后 diff；分片 = 一个 shard；同一片内所有文件混在同一上下文。
- 分片是 `diff --git` 贪心装箱，只受 `maxShardChars`（默认 120K）约束，**没有每片文件数上限、没有语义分组**（`run/shard-planner.ts:79-129`）。
- Phase 5 一次请求产出整片所有候选；没有 per-file 循环 / 子会话；规则 Skill 与 sweep 都不扩大覆盖单元。
- 丢失机制（结构性）：
  1. 注意力竞争：diff 在会话最前，Phase 5 在最后，中间是阶段回复与最多 100 次工具结果（单结果 8K 字符）；
  2. 输出预算：Phase 5 一次返回 candidates JSON，撞 `max_tokens` 时 `truncated`，而三层解析恢复都跳过 `kind === "truncated"`（`agent-review-loop.ts:350-355`、`:426-450`）；
  3. 无逐文件收口：Phase 5 不要求枚举文件或对每个文件给结论；
  4. 分片边界按 diff 顺序，相关文件可能被切开。
- 证据：56.8% 文件级无意见、98.5% 大 diff 意见落在无 GT 文件、F 类 11/31、C 类 6/31；12 个 run 中 Phase 5 仅 1 次工具调用、Phase 6 为 0。
- 两条杠杆：**缩小单元**（每片文件数/hunk 数上限、语义分组）vs **事后收口**（账本 + 缺口补漏）。F-01 先选后者，避免变量混在一起。

## 未决问题

1. **单元大小是否在 F-01 内调整？**
   - A：不调整，只做账本 + 补漏（推荐，变量最少）；
   - B：同时加每片 ≤N 文件 / ≤M hunk 的确定性上限（会影响片数与 `maxShards=12`）；
   - C：按目录/模块确定性分组（更大改动，另开任务）。
2. **补漏粒度**：整文件补漏 vs 只带未覆盖 hunk；是否允许一个请求跨文件（推荐一个请求一个文件，避免混合注意力）。
3. **是否引入确定性的「读过」信号**：用工具 Ledger / `get_file` 行区间标记 `read-overlap`，区分「没读」与「读了但没报」。可选增强，不改变 `no-issue` 定义。
4. **Phase 5 输出截断是否单独处理**：当前截断不重试；建议先在账本标 `not-reached(cause=output-truncated)` 交给补漏，不把「截断自动分批」混进 F-01。

## 2026-11-21 · F-01 工作分解（WBS）

### F-01a：确定性账本（零模型，先做）

**A. 契约**

- A1 `contracts/run.ts`：新增 `CoverageStatus`、`NotReachedCause`、`HunkCoverage`、`FileCoverage`、`CoverageLedgerRecord`；给 `RunAudit` 加可选尾键 `coverage?`。
- A2 `ShardTruncationRecord` 增加被丢弃 hunk 的区间（如 `droppedHunks: { oldStart, oldCount, newStart, newCount }[]`），保留现有计数字段兼容。
- A3 `audit/audit-writer.ts`：`AuditFileContent` 增加可选 `coverage?`，`buildAuditFileContent` 按尾键顺序追加；同步 `audit-writer.test.ts` 的键序断言。

**B. 纯逻辑 `run/coverage-ledger.ts`**

- B1 `buildCoverageLedger(diff, { truncation? })`：用 `diff/parse.ts` 的 `parseUnifiedDiff` 建文件 × hunk 分母；deleted / binary / 无 hunk 文件进 `excluded(reason)`。
- B2 `markCandidates(ledger, findings, source)`：按新侧行号回填 `candidate` + `findingIds`；hunk 外候选单独计数。
- B3 `closeCoverage(ledger, cause)`：未回填的 hunk 收口为 `not-reached(cause)`；cause 用封闭枚举。
- B4 `mergeCoverageLedgers(ledgers)`：分片聚合；校验无重复 `(file, hunkIndex)`。
- B5 `assertCoverageInvariant`：`candidate + no-issue + not-reached == hunk 总数`。
- B6 `summarizeCoverage(ledger)`：counts + cause 分布，供 stderr 与审计。

**C. 截取区间**

- C1 `run/shard-planner.ts` 的 `prepareBlock`：解析被丢弃的 `@@` 头，记录区间（复用 `diff/hunk.ts` 的 `parseHunkHeader`）。
- C2 `run/pass-runner.ts`：把 `descriptor.shard.truncated` 传进 `ReviewPassInput`（当前只传了 `shard` 标签，没有截取明细）。
- C3 账本按区间把对应 hunk 标 `not-reached(cause=truncated)`。

**D. 接入 pass**

- D1 `run/review-pass.ts`：在 `runAgentReviewLoop` 之前用 `input.diff` 建账本（不要用 `initialDiff`）。
- D2 loop 返回后 `markCandidates(outcome.findings, source="main|sweep|skill")`。
- D3 `finally` 中 `closeCoverage`：正常结束 `no-signal`；异常 `flow-error`；预算 `budget`；输出截断 `output-truncated`。
- D4 账本挂到 `RunAudit.coverage`，随审计落盘；stderr 打一行摘要。
- D5 失败路径：当前审计在 loop 之后才投影，异常时不会落审计；需要旁路写 coverage（如 `coverage.json` 或 request-timeline 同级），否则一次窗口溢出会让整次覆盖记录消失。

**E. 聚合与单遍**

- E1 `run/review-run.ts` 的 `aggregateShards`：合并各片 `pass.audit.coverage`，写进聚合审计。
- E2 单遍：`review-pass.ts` 已有的审计投影直接带 `coverage`。
- E3 stderr / 汇总：单片与聚合各一行，输出 candidate / no-issue / not-reached 及 cause 分布。

**F. 配置与开关**

- F1 `shared/config-limits.ts`：`limits.coverage`（至少 `enabled`；默认值待定）。
- F2 零漂移策略：审计键是「恒在场（非空 run）」还是「启用才在场」，需要一次明确决策并更新快照测试。

**G. 测试**

- G1 单测：多文件 / 新增 / 删除 / binary / 无 hunk / 多 hunk 分母；新侧行号回填；hunk 外候选；多候选同 hunk。
- G2 截取：dropped hunk 全部落成 `not-reached(truncated)`，分母不缩水。
- G3 分片性质：`merge(ledger(shards)) == ledger(fullDiff)`（无截取时）；串行/并行（F-03）逐字节一致。
- G4 确定性：同输入 + 同配置 → deep equal。
- G5 审计键序 / 可选键快照。
- G6 replay 不受影响（不改提示词/工具 schema）；`tsc -p tsconfig.build.json` + 包级测试全绿。

**H. 零模型基线**

- H1 用现有 golden diff / test12 样本跑账本，产出：文件级未覆盖率、hunk 级未覆盖率、cause 分布。
- H2 对照 56.8% / 98.5% 历史数据，确认口径一致后再决定 F-01b 的补漏上限。

### F-01b：缺口驱动补漏（独立请求）

- B1 配置：`limits.coverage.repair { enabled, maxRequests, maxChars, maxHunksPerRequest }`。
- B2 缺口按文件分组；整文件空 → 整文件补漏；部分空 → 只带未覆盖 hunk 正文 + 少量上下文。
- B3 结构化回执：逐 hunk `no-issue(reason)` 或 `candidate`；`no-issue` 只从这里产生。
- B4 补漏候选走现有候选门（schema / evidence / scope / 去重），findings 合并进本遍结果。
- B5 审计：`coverageRepair`（请求数、覆盖 hunk 数、新增候选数、no-issue 数、失败原因）。
- B6 验收：只对缺口发请求；P/R/B 不回退；token / 墙钟 / 请求数一起报。

### F-01c：出口与平台化

- C1 汇总 / JSON 输出暴露覆盖比例（不进 tips 正文）。
- C2 可选阈值策略（告警或失败）——产品口径确认后再定，不阻塞 F-01a/b。
- C3 manifest / CI / `--preview` 复用同一账本（与 F-15 对接）。

### 明确不在 F-01 内

- 缩小分发单元（每片文件数/hunk 数上限、语义分组）——另开任务。
- Phase 5 提示词加「逐文件自报」——不做，避免 coverage theater。
- 退出码语义改动——F-01c / 产品决策。
- resume / preview 本体——F-15；F-01 只提供确定性账本作为底座。

## 2026-11-21 · 代价与收益

> 量级估计，未排期；运行成本需 E1 实测。

### 代价

| 维度 | F-01a（账本） | F-01b（补漏） |
|---|---|---|
| 工程 | 约 4 个 commit：契约 / 纯逻辑 / 截取区间 / 接线与聚合；含单测与审计快照 | 约 3–5 个 commit：补漏请求、结构化回执、候选门接入、审计、A/B |
| 模型调用 | **0** | 每个有缺口的单元 +1 请求；输入只含未覆盖 hunk，不含整片 diff |
| token | 0 | 与未覆盖 hunk 正文成正比；需设 `maxChars` / `maxHunksPerRequest` 上限 |
| 墙钟 | 可忽略（一次 O(diff) 解析） | 串行时增加一次请求延迟；缺口多时会叠加 |
| 审计体积 | 每个 hunk 约百字节级；大盘可能增加数十 KB 到数百 KB | 另加 `coverageRepair` 记录（很小） |
| 维护 | 新审计键需保持形状稳定；失败路径要额外落盘 | 补漏候选要与现有候选门/去重保持一致 |
| 机会成本 | 不直接提升 P/R；占用 F-02/F-03/F-06 的时间 | 若缺口很大，补漏可能退化成第二次全量检视 |

### 收益

- **把 56.8% 文件级漏报变成可测量**：文件级 / hunk 级未覆盖率、cause 分布。
- **零模型基线**：F-01a 不需要真跑模型就能回答「分母多大、截取吃掉多少、哪些文件完全没候选」。
- **补漏只打缺口**：比 B2 全量第二视角更省；理论上 recall 增益与 B2 同量级。
- **验收底座**：F-02 准入、F-03 并行的等价性都可以用「分片账本并集 == 整份账本」验证。
- **可解释性 / CI**：审计、汇总、未来的 manifest 都能回答「为什么没审」。
- **避免盲目加成本**：没有账本时，F-06/B2 的提升无法区分是「补到了漏审文件」还是「多报噪声」。

### 主要风险

1. **指标失真**：`not-reached` 是上界，v1 没有 `no-issue`；比例高不代表质量差，低也不代表覆盖好。
2. **指标与 GT 不相关**：必须先验证「历史漏掉的 GT 是否落在 not-reached hunk」。若不相关，账本只是好看，不是瓶颈。
3. **补漏退化**：缺口太多时，补漏接近全量重扫，成本收益反转；必须设上限并保留 `not-reached(budget)`。
4. **模型敷衍**：补漏回执可能一律 `no-issue`；需要 reason + 抽样审计，不能只看状态。
5. **coverage theater**：绝不能把「模型自报看过」当证据；`no-issue` 只认结构化回执。
6. **失败路径复杂**：当前审计在 loop 后投影，异常时无审计；旁路落盘会增加一处新产物。

### 与其他任务的取舍

| 方案 | 工程成本 | 运行成本 | 立即质量收益 | 结构收益 |
|---|---|---|---|---|
| F-01a only | 中 | ~0 | 无 | 高（可见、可验收） |
| F-01a + b | 中高 | +缺口请求 | 待验证（预期与 B2 同量级） | 高 |
| F-06 only（默认开 B2） | 低（配置） | +1 请求/单元 | **已验证** R +10pp、B +6.1pp | 低（盲扫） |
| F-02 / F-03 | 中 | 0 / 延迟下降 | 大 MR 恢复覆盖 | 高 |

**建议**：F-01a 先做（零模型、低成本、是其它任务的验收底座）；做完先验证指标与历史漏报的相关性，再决定 F-01b 与 F-06 谁先上。若当前目标是「尽快提 recall」，F-06 是更便宜、更确定的赌注。

## 2026-11-21 · F-01a 骨架落地

- 新增 `packages/review-pi/src/contracts/coverage.ts`：三态、`NotReachedCause` 封闭枚举、`CoverageCounts`、`CoverageLedger`、`TruncatedHunkRange`、`NoIssueClaim`。
- 新增 `packages/review-pi/src/run/coverage-ledger.ts`：
  - `buildCoverageLedger`：用 `parseUnifiedDiff` 建分母；deleted / binary / no-hunks 进 `excluded`；截取 range 接回分母；同一路径的多个 diff 块合并；文件按路径排序；hunk 序号连续校验。
  - `backfillCandidates`：按新侧行号回填；finding id / source 去重；hunk 外计 `outOfHunk`；与 `no-issue` 冲突抛错；不修改输入账本。
  - `markNoIssue`：显式声明；空 reason / 未知 hunk / candidate 冲突抛错。
  - `closeCoverage`：把 `no-signal` 收口为现场原因；首个具体 cause 优先；candidate / no-issue 不变。
  - `mergeCoverageLedgers`：分片合并；重复文件 / 冲突排除抛错；输出顺序与片顺序无关。
  - `assertCoverageInvariant`：分区、序号、区间、counts/byCause、excluded 一致性硬校验。
- 新增 `packages/review-pi/src/run/coverage-ledger.test.ts`：23 个用例全绿。
- 验证命令：
  - `pnpm --filter @baize/review-pi exec vitest run src/run/coverage-ledger.test.ts`
  - `pnpm --filter @baize/review-pi typecheck`
  - `pnpm --filter @baize/review-pi build`（严格 flags）
- 未接线：pass / 审计 / stderr / 截取区间 producer 仍待 F-01a 后续 commit；当前不改变任何运行时字节，replay 不受影响。
- 文档：`docs/开发指南-仓库结构与文件职责.md` 的 `run/` 表已补 `coverage-ledger.ts`。

## 2026-11-21 · 截取区间 producer 落地（未提交）

- `contracts/coverage.ts`：拆出 `DroppedHunkRange`（index + old/new 区间），`TruncatedHunkRange extends DroppedHunkRange` 并带 `file`。
- `contracts/run.ts`：`ShardTruncationRecord` 新增 `dropped: readonly DroppedHunkRange[]`。
- `run/shard-planner.ts`：
  - `prepareBlock` 解析被丢弃的 `@@` 头，记录区间与**文件内 1-based 序号**；
  - `planShards` 按文件累计 hunk 偏移，同一路径多个 diff 块时序号不重置；
  - 所有 hunk 都以 `@@ ` 行计数，未截取的块也推进偏移；
  - diff 前置块（path = ""）不产生区间，只保留计数。
- 测试：
  - `shard-planner.test.ts` 15 个用例（新增同文件多块序号累计）；
  - `sharded-review.test.ts` 断言 `dropped` 区间；
  - 全包 `1186 passed / 1 skipped`；`typecheck` 与严格 `build` 通过。
- 未接线：`ShardTruncationRecord[] → TruncatedHunkRange[]` 的映射与 pass / 审计接线仍待下一步。

## 2026-11-21 · pass + 审计接线落地（未提交）

- `run/review-pass.ts`：
  - `runReviewPass` 在**任何模型请求之前**从 `input.diff` 建账本；分片时用 `truncatedRangesFromShardRecords` 把截取区间接回分母；
  - loop 返回后 `backfillCandidates(outcome.findings, "main")`，再按现场 `closeCoverage`：
    - `MODEL_MAX_TOKENS_REACHED` → `output-truncated`
    - `TOOL_BUDGET_EXHAUSTED` → `budget`
    - `complete=false` → `round-cap`
    - 否则 `no-signal`
  - 异常路径：`closeCoverage(..., "flow-error")` 并把账本旁路写到 `<runDir>/coverage.json`（失败不覆盖原始错误）；
  - 账本挂到 `RunAudit.coverage`，随审计落盘；`ReviewPassResult.coverage` 供分片聚合。
- `run/pass-runner.ts`：分片时把 `descriptor.shard.truncated` 传进 `ReviewPassInput.shardTruncation`。
- `run/review-run.ts`：`aggregateShards` 用 `mergeCoverageLedgers` 合并各片账本，写进聚合审计。
- `audit/audit-writer.ts`：`AuditFileContent` 新增 `coverage?`，键序在 `config` / `modelFallback` 之前（`modelFallback` 仍是最后一个可选键）。
- `contracts/run.ts`：`RunAudit.coverage?`。
- 测试：
  - `review-run.test.ts` 顶层键序加入 `coverage`，断言 vul4j-1 单 hunk = `not-reached(no-signal)`；
  - `sharded-review.test.ts` 断言截取场景账本 `hunks=2 / truncated=1`；
  - `coverage-ledger.test.ts` 新增 shardTruncation → 区间映射；
  - 全包 `1187 passed / 1 skipped`；`typecheck` 与严格 `build` 通过。
- 已知边界：同一文件多个 diff 块若被分到不同 shard，各片账本会重复文件路径并在聚合时抛错；正常 git diff 一文件一块，暂不处理。
- 未做：stderr 覆盖摘要；失败旁路的自动化测试。

## 2026-11-21 · stderr / 失败旁路 / 基线脚本（未提交）

- stderr：`formatCoverageNotice` + CLI `announceInput` 输出一行
  `review-pi: 覆盖账本 candidate X / no-issue Y / not-reached Z（cause…）`；
  单遍与分片聚合各一次。
- 失败旁路：`review-run.test.ts` 新增 `content_filter` 用例，断言
  `<runsRoot>/runs/coverage.json` 存在，且 `notReached=1 / flow-error=1`。
- 零模型基线脚本：`scripts/coverage-baseline.mjs`，root 脚本 `coverage:baseline`。
  - `--diff <file>`（可重复）/ `--dir <dir>` / `--limit N` / `--shard-chars N` / `--json`
  - 只读 diff + `planShards` + 账本，不读配置、不发请求
  - 输出 files / hunks / excluded / truncated / not-reached / shards
- 实测：
  - `vul4j-1.diff`：1 file / 1 hunk / 1 shard；
  - `data/clean-mr/diffs` 前 3 个：11 files / 32 hunks / 3 shards；
  - `large-mr.diff --shard-chars 1000`：9 files / 11 hunks / 9 shards / 截取 2 hunk。
- 验证：全包 `1189 passed / 1 skipped`；`typecheck` 与严格 `build` 通过。

## 2026-11-21 · AACR-Bench 归档迁移

- 从 `exp-group` @ `c72fbc8` **全量迁入** `docs/bench/`（554 files / 20.5 MB）：`README` / `MIGRATION` / `MANIFEST`、`scripts/`（14）、`data/`（9）、`configs/`（10）、`metrics/`（27）、`artifacts/`（217）、`ocr/`（121）、`results/`（151）、`comparison/`（2）。
- **运行时仍依赖外部 evaluation**：`D:/Project/bench/aacr-bench/evaluation` 提供 `repo_utils.py` / `schema.py` / `pipeline` / `converters` / `.venv`；桥接脚本 `sys.path.insert` 后 import 这些模块，直接在 `docs/bench/scripts` 跑会缺模块。
- **测试数据只有样本元数据**：JSONL 字段为 `instance_id, repo, base_commit, head_commit, reference_comments`，**不含 diff**；diff 由桥接脚本运行时从仓库 clone 后生成。因此不能直接喂给 `scripts/coverage-baseline.mjs`。
- 验证：14 个 Python 脚本 `py_compile` 通过；JSONL 逐行可解析（smoke10=10 / iter20=20 / iterS10=10）。
- 细节与用法见 `docs/bench/MIGRATION.md`。

## 2026-11-21 · 归档路径迁到 `bench/aacr-bench-v2`

- `docs/bench` 与 `docs/` 的文档语义不符（554 文件 / 22MB，约 40× `docs/report`），且包含约 15MB 逐样本运行产物。
- 已 `git mv docs/bench bench/aacr-bench-v2`，内部结构不变；新增 `bench/README.md` 作为归档索引与约定。
- 同步更新引用：`bench/aacr-bench-v2/{README,configs/README,MIGRATION}.md`、`scripts/make_iter_sets.py`、`scripts/run_config.py`、`ocr/full/non-target-analysis.json`、`docs/report/exp-group-missed-gt-classification-20261118.md`。
- 历史讨论中的 `docs/bench` 保留为当时路径；`git show exp-group:docs/bench/...` 也保留为 exp-group 历史路径。上文「细节与用法见 `docs/bench/MIGRATION.md`」现指向 `bench/aacr-bench-v2/MIGRATION.md`。
- 未处理：`artifacts/` + `results/` + `ocr/**/results/` 约 15.2MB 仍入库；是否转出 git / Git LFS 待单独决定。

## 2026-11-21 · F-01a iterF91 零模型验收

- 数据：91 条 diff（iterF91 全量），来源外部 evaluation 的 `.reviewpi/diff` 缓存；**0 模型请求**。
- 原始账本：6,603 文件 / 22,266 hunk / 1,037 excluded（deleted 701 / binary 291 / no-hunks 45）/ unattributed 0；分区恒等式 0 失败；同输入两次构建 deep-equal。
- 分片 120K / `maxShards=12`：88 条成功，3 条显式失败（appwrite 20 片、keycloak 13 片、typescript-go 19 片）；合并后 16,003 hunk，818 个截取 hunk 全部为 `not-reached(truncated)`；分母集合与整份账本 0 不一致；分区恒等式 0 失败。
- 分片 120K / `maxShards=32`：91/91 成功，0 失败；1,056 个截取 hunk 全部正确标记；分母 0 不一致。
- 结论：F-01a 在 iterF91 上满足分母不缩水、截取不留白、分片合并等价、确定性；3 条 >12 片是 F-02 的已知准入问题，把 `maxShards` 调到 32 后消失。
- 证据：[`f01a-iterf91-zero-model.json`](f01a-iterf91-zero-model.json)；原始 JSON 在 `.artifacts/coverage-baseline/`（gitignored）。
- 范围：本次是零模型账本验收，不代表补漏（F-01b）的质量收益；F-01b 尚未实现。

## 2026-11-21 · F-01b 缺口补漏落地

- 契约：`limits.coverage.repair { enabled, maxRequests, maxChars, maxHunksPerRequest }`（缺省关闭）；`CandidateSource` 增加 `repair`；`RunAudit.coverageRepair` 与审计尾键。
- 账本：新增 `markNotReached`，把因请求 / 字符上限未发出的缺口标 `not-reached(cause=budget)`，不覆盖 candidate / no-issue / truncated。
- 新模块 `run/coverage-repair.ts`：
  - 从 diff 提取文件内 hunk 正文；按文件把 `not-reached(no-signal)` 缺口装箱（整文件 / 部分、`maxHunksPerRequest` / `maxChars` / `maxRequests`）；
  - 一次性请求逐 hunk 回执 `no-issue(reason)` 或 `candidate`；补漏候选统一重编号 `CR001…`，走现有候选门（schema / evidence / scope / 内容去重）；
  - `no-issue` 只来自结构化回执；补漏候选按 `repair` 来源回填；
  - 审计 `coverageRepair`：请求、失败、hunk 发送 / 覆盖、no-issue、候选 / 接受、预算跳过、usage。
- 接线：`review-pass` 在 main findings 回填后、`closeCoverage` 前执行补漏；分片聚合求和；`delivery` 增加一行补漏摘要。
- 缺口优先级：预算先给「整文件一条意见都没有」的缺口（历史漏报 56.8% 落在这类文件），同优先级内先小后大。
- 零模型预算模拟（iterB10，历史 findings 回填后）：
  - 总缺口 5,863 hunk；`maxRequests=12` 只发 121 hunk（2.1%），`24` 发 283（4.8%），`32` 发 419（7.1%），`64` 发 932（15.9%）；
  - 补漏请求输入约 440K 字符（32 档），token 成本远小于主检视；主要成本是请求延迟；
  - 因此 A/B 配置取 `maxRequests=32`：能覆盖多数「整文件空」缺口，又不至于把一次 10 条 run 拖成数小时。
- 测试：新增 `coverage-repair.test.ts` 12 例、账本 `markNotReached` 3 例、config 3 例；全包 **1207 passed / 1 skipped**，`typecheck` 与严格 `build` 通过。
- 配置：
  - `C:/Users/Li/.PiAgent/benchmark-aacr-v2-f01b.jsonc`：与历史 arm2 完全一致，只开补漏（干净 A/B）；
  - `benchmark-large-pr.jsonc`：大 MR 专项配置，已开补漏。
- 未做：真实模型 A/B；下一步用 iterB10 跑 arm A（补漏关）/ arm B（补漏开），看 not-reached 下降与 P/R/B、token、墙钟。

## 2026-11-21 · F-01b iterB10 A/B 实测（官方 deepseek-flash）

### 先修一个真实 bug

- 线上模型按提示词示例输出 `candidate` 回执时**不带 `hunk` 字段**；v1 解析器却对每个回执强制要求 `hunk`，导致首轮 arm B 的 26 条候选全部 `invalid`、`acceptedFindings=0`。
- 修复：`candidate` 回执改为按 `candidate.line` 落在哪个缺口 hunk 归属；`no-issue` 仍要求合法 `hunk`。补单测；全包 **1207 passed / 1 skipped**，严格 `build` 通过。
- 首轮 arm B（`f01b-on-c10-20261121`）指标作废，只保留日志 `arm-b-c10-v1.log`；下表使用修复后重跑的 `f01b-on-c10-fixed-20261121`。

### 口径

- 数据：iterB10，10 条大 diff / 95 GT；judge `deepseek-v4-pro`，1 轮。
- arm A：补漏关闭（复用 `f01b-off-c10-20261121`）；arm B：补漏开启，`maxRequests=32`、`maxHunksPerRequest=6`、`maxChars=24000`。
- 两臂均为官方 `deepseek-flash`；arm B review 与 judge 分两段执行。

### 指标

| 指标 | arm A（off） | arm B（on，修复后） | Δ |
|---|---:|---:|---:|
| Precision | 0.500（17/34） | 0.449（22/49） | **-5.1pp** |
| Recall | 0.316（30/95） | 0.358（34/95） | +4.2pp |
| Balanced | 0.387 | 0.398 | +1.1pp |
| generated | 34 | 49 | +15 |
| matched generated | 17 | 22 | +5 |
| covered GT | 30 | 34 | +4 |
| 样本耗时合计 | 1,542.3s | 2,868.9s | +86% |
| review 墙钟 | 277s | 591s | +113% |
| 报告输入 token | 7,076,645 | 5,611,254 | -21% |
| 报告输出 token | 238,607 | 229,687 | -4% |

> **token 口径已修**：上表 B 的 5,840,941 是审计根 `usage`（仅 Agent 内调用，ADR-0066），不含 `coverageRepair.usage`。基准桥接 `read_usage` 已改为把两者相加，并输出 `token_usage_breakdown` 分项；归档副本同步修改。计入补漏后 B 实际为输入 267,279 / 输出 468,770 / cache 5,450,863，总计 **6,186,912**（约为 arm A 7,315,252 的 0.85 倍；输出约为 arm A 的 1.96 倍）。旧结果文件不会自动回填，需要重跑桥接或离线重算。

### 补漏自身

- 审计合计：117 请求 / 0 失败；发送 256 hunk / 覆盖 215；`no-issue` 200；候选 15 / 接受 15；invalid 11；预算跳过 11。
- 账本覆盖：297 hunk 中 `not-reached` 从 **267（89.9%）降到 52（17.5%）**；`candidate` 30→45；新增 `no-issue` 200。未到达的 52 = 模型未回执 41（`no-signal`）+ 预算 11。
- 候选质量：按 path+line 把 15 条 `CRxxx` 映射到 judge 的 `generated_comments`，**4 条命中**（appwrite Create.php / Functions.php、gofr ctx_logger.go、lvgl lv_span.c），补漏精度约 **26.7%**；主检视 18/34≈52.9%。补漏主要贡献 recall，但显著拉低 precision。
- 低质量候选集中在文档/资源/头文件（`observer.rst`、`globals.xml`、`lv_switch.xml`、`lv_span.h`）和部分 Rust 代码；候选门只校验 schema/evidence/scope/去重，没有质量分层。
- `no-issue` 200 条是结构化回执，但仍需抽样核对 reason 是否敷衍；本轮未做人工抽样。

### 结论

- F-01b v1 的**覆盖机制成立**：缺口可见、请求有上限、`no-issue` 有结构化来源、补漏候选能进候选门。
- 但**质量验收未通过**：`P -5.1pp`，不满足任务表“P/R 不回退”；`B +1.1pp` 很小，不能据此宣称有效。
- 下一步二选一（另开新一轮，不与本轮混算）：
  1. 收紧补漏候选门：只接受整文件空缺口的高置信候选，或对文档/资源/头文件加路径过滤；
  2. 先做 `no-issue` 抽样与补漏提示词校准，再复跑 iterB10；在 precision 回到 ≥ arm A 之前不进入 iterF91。
- 成本侧先修汇总口径：审计消费方应把 `coverageRepair.usage` 计入总 token，或在 bridge 里显式求和；否则任何“补漏更省”的结论都不可信。

## 2026-11-21 · 离线置信度与漏报结构分析

### 置信度阈值扫描（复用当前 A/B 的 judge 结果，不重新调用模型）

口径：按 `path + new line` 把每条 finding 映射到 judge 的 `generated_comments`（A/B 均 0 条未映射）；阈值 0.0 复算结果与 metrics 完全一致，说明映射可用。

| confidence.min | A 生成 / P / R / B | B 生成 / P / R / B |
|---:|---|---|
| 0.0（全部） | 34 / 0.500 / 0.316 / 0.387 | 49 / 0.449 / 0.358 / 0.398 |
| 0.4 | 34 / 0.500 / 0.316 / 0.387 | 48 / 0.458 / 0.358 / 0.402 |
| 0.5（产品 tips 默认） | 32 / 0.500 / 0.253 / 0.336 | 45 / 0.444 / 0.337 / 0.383 |
| 0.6 | 22 / 0.409 / 0.116 / 0.181 | 33 / 0.455 / 0.179 / 0.257 |
| 0.7 | 11 / 0.455 / 0.074 / 0.127 | 21 / 0.524 / 0.137 / 0.217 |

- 降低阈值到 0.0 只多拿回 2 条 A、4 条 B 的低置信意见；B 从 0.398 到 0.402（0.4 档）也只是 **+0.4pp**，在 judge 单轮噪声内。
- 再往下没有可降空间：benchmark 读 `reviews_all.json`，当前 34/49 条已经全部在真源里；`limits.confidence.min` 只过滤 tips / MCP，不改变 benchmark。
- 历史 108 条全量的 `filter-sweep` 结论相同：0.0 档 B 0.102，0.5 档 0.101，0.8 档 0.058；没有任何阈值提高 Balanced。低置信意见只占 2.8%，不是 precision 的主因。

### 漏报落在哪

| 口径 | A（补漏关） | B（补漏开） |
|---|---:|---:|
| 未覆盖 GT | 65 / 95 | 61 / 95 |
| 其中：文件内已有意见但未命中 | 12 | 21 |
| 其中：文件内没有任何意见 | 45 | 40 |
| 其中：落在 `not-reached` hunk | 50 | 10 |
| 其中：落在 `candidate` hunk | 12 | 13 |
| 其中：落在 `no-issue` hunk | 0 | **35** |
| 其中：GT 行不在账本 hunk 内 | 3 | 3 |

补充事实：

- B 的 49 条意见中，32 条落在有 GT 的文件、17 条落在无 GT 文件；A 是 28 / 6。补漏新增 15 条里，只有 4 条落在有 GT 文件，11 条落在无 GT 文件。
- B 未覆盖的 61 条 GT 中，**35 条（57%）所在 hunk 被补漏标成 `no-issue`**；这些 hunk 并不是“没审到”，而是补漏看过之后判定“没问题”。抽样可见典型误判：debug console.log 未删、`Promise.all` 部分写入失败、`std::roundf` 浮点转换、`fiber.elementType` 覆盖真实类型、`delete_by_ids` 空列表 SQL / 事务缺失等，均被 `no-issue` 关掉。
- 因此 B 相对 A 的 recall +4.2pp，来自 4 条补漏命中；代价是 11 条无 GT 文件意见和 35 条被 no-issue 吞掉的 GT。**`no-issue` 覆盖了 200 个 hunk，但只换来 15 条候选、4 条命中，质量明显不足。**

### 结论

- **不是“置信度太高把意见滤掉了”**：benchmark 真源本来就没有置信度过滤，降阈值最多 +0.4pp；历史全量也证明阈值不是杠杆。
- **确实有“意见提得不够”**，但更准确地说是两层：
  1. 45 / 65（A）、40 / 61（B）的漏报在**完全没有意见的文件**里，说明文件级覆盖仍不足；
  2. 补漏把大量未覆盖 hunk 判成 `no-issue`，其中 35 条仍含 GT，说明**`no-issue` 过于自信**，不是“没生成候选”这么简单。
- 下一步优先级应是：先让 `no-issue` 更保守（有疑问不输出 / 只对确定安全的小 hunk 输出），再谈扩大候选数量；单纯加意见或降 confidence 会把 B 的 precision 继续往下拉。

## 2026-11-21 · F-01b v2：no-issue 收紧 + 候选优先 + 代码文件优先

### 改动

1. `no-issue` 必须有非空 `reason` + 至少一条 `evidence`（引用 hunk 内真实代码/行号）；只给 reason 的回执判 invalid，不再关闭缺口。
2. 提示词改为“可疑就报 candidate”；`no-issue` 只适用于纯格式/注释/重命名/等价重构或能正面证明安全；拿不准省略，保持 `not-reached`。
3. 补漏预算排序：整文件缺口 → 源码 → 头文件 → 文档/资源，避免 `.rst` / `.xml` 吃掉预算。
4. 测试：13 个补漏用例 + 全包 **1208 passed / 1 skipped**；严格 `build` 通过。

### iterB10 结果（同 arm A 对照，官方 `deepseek-flash`，judge 单轮）

| 指标 | arm A（补漏关） | v1（原补漏） | **v2（本次）** | OCR |
|---|---:|---:|---:|---:|
| Precision | 0.500 | 0.449 | **0.439** | 0.4468 |
| Recall | 0.316 | 0.358 | **0.432** | 0.5895 |
| Balanced | 0.387 | 0.398 | **0.435** | 0.5083 |
| generated | 34 | 49 | **66** | 94 |
| matched generated | 17 | 22 | **29** | 42 |
| covered GT | 30 | 34 | **41** | 56 |
| 总 token | 7,315,252 | 6,186,912 | **7,725,485** | 28,447,839 |
| 输出 token | 238,607 | 468,770 | **590,677** | — |
| 样本耗时合计 | 1,542.3s | 2,868.9s | **3,824.1s** | 3,391.8s |

- v1 → v2：P **-1.0pp**、R **+7.4pp**、B **+3.7pp**。
- A → v2：P -6.1pp、R +11.6pp、B +4.8pp。
- v2 vs OCR：P -0.8pp、R -15.8pp、B -7.3pp；差距从 v1 的 11.0pp 缩到 7.3pp。
- 成本：v2 总 token 比 v1 修正值高 25%，非缓存 input+output 914K（v1 736K、A 509K）；补漏自身输出 322,532（v1 239,083）。

### 补漏质量

- 116 请求 / 0 失败；发送 253 hunk / 覆盖 191；`no-issue` 164（v1 200）；候选 **27 / 接受 27**（v1 15）；invalid 12；预算跳过 10。
- 27 条候选 **7 条命中**（25.9%；v1 4/15=26.7%）——候选精度没有变好，但候选量翻倍，绝对命中 +3。
- 账本：candidate 45→61，no-issue 200→164，not-reached 52→72；`not-reached` 上升是“证据不足不再假关闭”的预期结果，不是退化。
- 未覆盖 GT：61→54；其中落在 `no-issue` hunk 的从 35 降到 29，仍是最主要的假阴性桶。
- 有 GT 文件内的意见：32→50；无 GT 文件意见：17→16。**同样的预算下，v2 把意见明显推向了有 GT 的文件**，这是 B 提升的主因。
- lvgl 的补漏候选从 v1 的 6 条（多为 `.rst` / `.xml` / `.h`）降到 3 条（1 条 `.rst` + 2 条 `.c`），说明代码优先级生效。
- 反例：codex 的 10 条补漏候选全部未命中（含 4 条 P1 / 高置信），提示还需要独立证伪/验证门，单靠提示词无法消掉这类整文件误报。
- 置信度离线扫描（v2）：0.0 档 B 0.4355 最优；0.5 档 0.416，0.6 档 0.340。没有任何阈值能提高 B，**不要用 confidence 过滤**。

### 结论

- v2 达到“B 提升、R 明显提升、P 小幅回退”的结果；若验收按 Balanced，v2 通过（0.435 > 0.398 > 0.387）；若严格按“P/R 都不回退”，P 仍差 A 6.1pp，不应标 DONE。
- 下一步优先级：给补漏候选加独立证伪/验证门（尤其是整文件空、非主检视文件），而不是继续放宽提示词；`no-issue` 仍有 29 条 GT 误判，需继续收紧或抽样审计。
- 当前不建议上 iterF91：先确认 v2 在 iterB10 的单轮结果可复现，再决定是否扩大。

## 2026-11-21 · 验收口径调整：Balanced 不回退即可

- 原口径：F-01 的补漏效果要求“P/R 都不回退”。
- 新口径（本日决策）：**Balanced 不回退即可**；P 允许回退，但必须在报告中披露，不能只报 B。
- 按新口径复核：
  - arm A B 0.387；
  - F-01b v1 B 0.398（+1.1pp）；
  - F-01b v2 B 0.435（+4.8pp）；
  - v2 通过 F-01 效果验收。
- 保留的未决项：F-01c（汇总比例 / 阈值 / manifest / CI）未做；F-01b 仍缺独立验证门，不因验收口径调整而视为质量已完成。
- 状态：F-01 仍为 `DOING`，不标 `DONE`——避免把“验收口径通过”误读为“所有子阶段完成”。

## 2026-11-21 · F-01b v3：补漏候选独立验证门

### 实现

- 新增 `run/coverage-repair-verify.ts`：按补漏单元批量发独立证伪请求，真实 verdict 替代 v2 的 `pass:true`。
- 验证器只读 hunk + 候选；pass 需 file/line 落在 hunk、evidence 可在原文核对、缺陷描述与代码一致；不确定即 reject。
- 验证请求失败 / 回包不可解析时 fail-open（候选保留，计 `unverified`）。
- 审计新增 `coverageRepair.verification { requests, failedRequests, accepted, rejected, unverified, usage }`；补漏总 `usage` 含验证器。
- 单测 **1212 passed / 1 skipped**；严格 `build` 通过。

### iterB10 结果

| 指标 | arm A | v2 | **v3** | OCR |
|---|---:|---:|---:|---:|
| Precision | 0.500 | 0.439 | **0.522** | 0.4468 |
| Recall | 0.316 | 0.432 | **0.400** | 0.5895 |
| Balanced | 0.387 | 0.435 | **0.453** | 0.5083 |
| generated | 34 | 66 | **46** | 94 |
| matched generated | 17 | 29 | **24** | 42 |
| covered GT | 30 | 41 | **38** | 56 |
| 总 token | 7,315,252 | 7,725,485 | **7,738,434** | 28,447,839 |
| 输出 token | 238,607 | 590,677 | **634,523** | — |
| 样本耗时合计 | 1,542s | 3,824s | **3,827s** | 3,392s |

- v2 → v3：P **+8.3pp**、R **-3.2pp**、B **+1.8pp**。
- v3 vs OCR：P +7.5pp、R -19.0pp、B -5.5pp；B 差距从 v2 的 7.3pp 缩到 5.5pp。
- 补漏：117 生成请求 / 0 失败，30 候选；验证器 26 请求（2 失败）、accept 9 / reject 17 / unverified 4；最终 13 条进门，4 条命中。
- 主检视 33 条（v2 39），命中 20；主检视本身的轮次波动也是 recall 下降的一部分，不能全部归因于验证门。
- 未覆盖 GT 57：no-issue 21（v2 29）、not-reached 22（v2 9）、candidate 11、no-file 3。验证器拒绝的候选保持未覆盖，不再假关闭。
- 验证器用量：输入 31,073 / 输出 35,614 / cache 3,200；相对 v3 总输出 634,523 约 5.6%。

### 判断

- v3 是当前 Balanced 最高的一版（0.453），precision 已高于 arm A 与 OCR；recall 仍是主要短板。
- 按 2026-11-21 调整后的“Balanced 不回退”口径，v3 通过；相对 v2 有 +1.8pp 提升。
- 代价是 recall -3.2pp，其中既验证门拒掉了一部分候选，也有主检视轮次波动；下一轮若要继续提 B，应优先看“验证器拒绝里有没有真命中”，而不是继续放宽/收紧阈值。

### F-01c（C1）落地

- `run.json` 的 `audit.coverageSummary` 现在带 `hunks / candidate / noIssue / notReached / outOfHunk / byCause / candidateRatio / noIssueRatio / notReachedRatio`。
- 逐 hunk 明细仍只在审计文件；run.json 只放汇总，避免体积膨胀。
- C2（阈值告警/失败）与 C3（manifest/CI/preview 复用）仍需产品口径与 F-15 对接，未做。

## 2026-11-21 · F-01 收口：C2/C3 拆到 F-15

- F-01c C1（`run.json` 的 `coverageSummary`）已完成并通过全包测试。
- C2（覆盖阈值 `warn` / `fail`）与 C3（manifest / CI / preview 复用）**拆到 F-15**：它们需要产品口径与 F-15 的 preview/manifest 本体，不属于 F-01 的验收范围。
- F-01 状态改为 **DONE**：
  - F-01a：iterF91 零模型 91/91；
  - F-01b v3：P 0.522 / R 0.400 / B 0.453（arm A 0.387），Balanced 不回退；
  - F-01c C1：`run.json` `coverageSummary`（counts + ratios + byCause）；
  - 全包 1212 passed / 1 skipped，严格 build 通过。
- 后续覆盖阈值/平台化在 F-15 继续，不回改本任务的历史实验结论。

## 下一步

- 先落 F-01a：纯确定性账本 + 截取区间 + 审计键 + 恒等式测试 + 历史 diff 基线（零模型调用）。
- 基线出来后再决定补漏（F-01b）的单元与上限。
