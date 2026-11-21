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

## 下一步

- 先落 F-01a：纯确定性账本 + 截取区间 + 审计键 + 恒等式测试 + 历史 diff 基线（零模型调用）。
- 基线出来后再决定补漏（F-01b）的单元与上限。
