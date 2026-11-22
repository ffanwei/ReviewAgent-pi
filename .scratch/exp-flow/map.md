# exp-flow · 检视流程优化跟踪

> 分支：`exp-flow`（从 `exp-skill` @ `331ccc6` 切出）
> 状态：active
> 更新：2026-11-22
> 设计依据：[检视流程合理性评估-OCR对照与历史Session证据](../../docs/design/检视流程合理性评估-OCR对照与历史Session证据.md)（§5 / §7 / 附录 D）
> 约定：每个任务一个目录 `issues/<task-id>/`，内含 `ticket.md`（详情票）与 `discussion.md`（讨论归档）；本文件只做索引、状态与验收证据。

## 目标

把评估文档里**已确证**的问题按 P0 → P1 → P2 落成可验证的改动；每个任务独立可回滚，实验数据单独留报告。

**不做**：为了追 benchmark recall 放开建议/风格/测试类意见；为了“像 OCR”拆掉规则 Skill、证据 schema、审计/回放。

## 状态图例

| 状态 | 含义 |
|---|---|
| `TODO` | 已登记，未开工 |
| `DOING` | 已开工；必须有一个 `issues/<task-id>/ticket.md` 且 `Status: claimed` |
| `BLOCKED` | 等外部条件（数据/决策/依赖） |
| `DONE` | 已合并/已验证；必须贴验收证据（测试、报告、commit） |
| `DROPPED` | 明确不做；必须写原因 |

## 目录约定

```text
.scratch/exp-flow/
  map.md                          # 本文件：索引 / 状态 / 验收证据
  issues/
    F-01-coverage-ledger/
      ticket.md                   # 详情票：方案、验收、待决问题
      discussion.md               # 讨论归档：按日期追加
    F-02-.../
```

- 开工：建 `issues/<task-id>/ticket.md`（`Status: claimed`），状态改 `DOING`。
- 讨论：每次讨论追加到同目录 `discussion.md`，按 `YYYY-MM-DD · 主题` 分段；只增不改历史结论，结论变化写新日期段。
- 本表「讨论」列必须指向对应 `discussion.md`；没有讨论文件的写 `—`。

## 任务清单

| ID | 任务 | 对应问题 | 优先级 | 状态 | 验收（摘要） | 证据 / commit | 备注 | 讨论 |
|---|---|---|---|---|---|---|---|---|
| F-01 | 覆盖账本：文件 × hunk 三态（candidate / no-issue / not-reached） | P0-1、P1-11、V1/V7 | P0 | DONE | not-reached 比例可见；未覆盖 hunk 只对缺口发补漏；**Balanced 不回退（P 允许回退）** | F-01a iterF91 零模型 91/91；F-01b v3 P 0.522/R 0.400/B 0.453（A 0.500/0.316/0.387；v2 0.439/0.432/0.435）→ B +6.6pp；F-01c C1 `coverageSummary` 进 run.json；全包 1212 passed | C2/C3 拆到 F-15 | [票](issues/F-01-coverage-ledger/ticket.md) · [讨论](issues/F-01-coverage-ledger/discussion.md) |
| F-02 | 大 MR 准入与分片一致：split 启用时不再按 `maxDiffChars` 整条跳过 | P0-2、V2 | P0 | DONE | FreeCAD 类 diff 不再 skipped；片数 ≤ maxShards；截取留痕 | 准入改为分片优先；单样本 cline（17,227 字符，maxDiffChars=8000）`ok` + `shards[]`（F-02 前会 skipped）；全包 1214 passed / 1 skipped；基准 91/91、B 0.298 已归档 | 超 maxShards = 模型前显式失败；不做大规模验证 | [票](issues/F-02-admission-split/ticket.md) · [讨论](issues/F-02-admission-split/discussion.md) |
| F-03 | 分片并行（可配 3–8） | P0-3、V2 | P0 | DONE | findings 集合与串行一致；墙钟显著下降；429 不增加 | live：3 样本 22 片，5298.9s → 2111.8s（**2.51×**），429 0/0；fake 等价通过，replay 待补 | 默认 1；网关 `deepseek-v4.1-flash`；归档 `bench/experiments/2026-11-22-f03/` | [票](issues/F-03-shard-concurrency/ticket.md) · [讨论](issues/F-03-shard-concurrency/discussion.md) |
| F-04 | 证据接地：文件/行号/引文可核对 | P0-4、V3 | P0 | DONE | 伪造行号/引文/越界文件被确定性拒绝；真证据不误杀 | v1 落地；回放 grounded 217/320、unverified 103/320；全包 1234 passed | 默认 off；warn 计数；drop 会误杀约 32%，未启用；live A/B 待做 | [票](issues/F-04-evidence-grounding/ticket.md) · [讨论](issues/F-04-evidence-grounding/discussion.md) |
| F-05 | 独立证伪核验（新会话；保护性主题 fail-open） | P0-5、V3 | P0 | DONE | 噪声率下降；真值损失 ≤ 阈值；核验理由可审计 | 回放 103 条 unverified：reject 仅 2/0 条、pass 精度 33–34%；F-04 drop + pass 返场 B 27.9%/28.4% < baseline 29.8% → 不接主路径（`bench/experiments/2026-11-22-f05/README.md`） | 一次调用/候选；不循环；默认 off | [票](issues/F-05-independent-verification/ticket.md) · [讨论](issues/F-05-independent-verification/discussion.md) |
| F-06 | 独立补漏默认开启 / 标准化 | P0-6、V4 | P0 | DROPPED | — | 六项镜头是按测评集 GT 类别反推的固定清单（测评集过拟合）；B2 仅 10 条小 diff、最差轮差距在 judge 噪声带内 → 不实现 | 独立第二视角并入 P0-1 覆盖驱动补漏 | [票](issues/F-06-independent-sweep/ticket.md) · [讨论](issues/F-06-independent-sweep/discussion.md) |
| F-07 | 阶段压缩：合并 1+2、条件化 Phase 4 | P1-6、V5 | P1 | DONE | 每单元请求 -≥1；P/R/B ±2pp 内 | S20：请求 308→271（−12%）、token 6.60M→6.27M（−5%）、B 25.8%→35.4%（ΔB CI +1.35~+15.63pp）；默认 `compact`（Phase 1 禁工具）；墙钟 +18.6% 待观察；条件化 4 零触发 | `off` 可回滚；P1-7 风险预算单列 | [票](issues/F-07-stage-compression/ticket.md) · [讨论](issues/F-07-stage-compression/discussion.md) |
| F-08 | 检索预算与空结果停止 | P1-8/9 | P1 | DONE | 工具调用下降；P/R/B 回退 ≤2pp；审计计数 | 默认 3 次/文件、4 次连续空搜索、40 万字符；S20 复本 270→254 请求、token 6.75M→5.95M、B −0.7pp（CI 跨 0）；不做区间切片；`bench/experiments/2026-11-22-f08/README.md` | ADR-0114；`audit.retrievalBudget` | [票](issues/F-08-retrieval-budget/ticket.md) · [讨论](issues/F-08-retrieval-budget/discussion.md) |
| F-09 | 输出校准：confidence 0.3；范围外 `scope` 标注 | P1-10、V8 | P1 | DONE | 真值不丢；噪声不升 | confidence 默认 0.5→0.3；v3 离线：0.5 砍 26 条含 6 TP，0.3 全保留；范围外 `scope` 标注留后续 | ADR-0114；F-09b 未做 | [票](issues/F-09-output-calibration/ticket.md) · [讨论](issues/F-09-output-calibration/discussion.md) |
| F-10 | Phase 5/6 按需读取 | P1-13、V5 | P1 | DROPPED | — | 并入 F-08（预算/定向取证实验臂），不单独立项 | 12 run：P5 仅 1 次、P6 为 0 | — |
| F-11 | 多轮语义：边际收益停止 + 硬上界 | P1-12 | P1 | DROPPED | — | 12 run 全部 rounds=1；F-06 已放弃；F-01b 补漏已提供显式第二遍；保留 maxRounds 硬上界 | 条件：未来默认机制实际产生多轮再重开 | — |
| F-12 | 确定性预取（changed symbols / 直接引用 / 调用点） | P1-8、V6 | P2 | DROPPED | — | 并入 F-08 实验臂；`resolveChangedFileSymbols` 无调用方、证据仅假设 | 若 F-08 后续证明需要再重开 | — |
| F-13 | 大 diff severity 区分度复核 | D.3 | P2 | DROPPED | — | 未复现：v3 归档大 diff P1/P2/P3 命中 54.2%/34.3%/32.1%，小 diff 40%/38.2%/21.4% | 不改 severity；P0 样本仅 1/6 条 | — |
| F-14 | `search_rule` / `search_history` 可见性复核 | D.3 | P2 | DROPPED | — | 生产默认不注入 knowledge 语料时两工具不可见；历史调用来自带语料配置 | 产品引入语料再重开 | — |
| F-15 | preview / resume / manifest / PR 原生闭环；含 F-01c C2/C3（覆盖阈值 warn/fail、manifest/CI 复用） | 对比文档 P0 | P2 | TODO | 逐项产品验收；覆盖阈值语义与退出码明确；manifest/CI 复用 `coverageSummary` | F-01c C1 已提供 `summarizeCoverage` 底座 | 不阻塞流程正确性 | [讨论](issues/F-15-delivery-platform/discussion.md) |
| F-16 | 评测方法学：成对多 run + bootstrap CI | — | P1 | DONE | 每次 A/B 报 CI/token/墙钟/工具 | `bench/experiments/compare_arms.py`；F-08/F-18 对比已用 | 单次运行不再作为结论 | [票](issues/F-16-eval-methodology/ticket.md) · [讨论](issues/F-16-eval-methodology/discussion.md) |
| F-17 | 一次性调用输出鲁棒性 | — | P1 | DONE | 空 content/截断重试一次；usage 相加 | ADR-0115；`one-shot-llm.test.ts` | 验证器不叠加重试 | [票](issues/F-17-oneshot-robustness/ticket.md) · [讨论](issues/F-17-oneshot-robustness/discussion.md) |
| F-18 | 覆盖补漏默认化评估 | — | P1 | DONE | P/R/B + token + 墙钟 | S20：B +3.65pp（CI 跨 0）、墙钟 +30% → 保持默认关闭 | 不启用 `coverage.repair` | [票](issues/F-18-coverage-repair-default/ticket.md) · [讨论](issues/F-18-coverage-repair-default/discussion.md) |
| F-19 | Replay trace 维护与门禁 | — | P2 | DONE | 6/6 场景通过 | 5 个 canned trace + large-mr 真网关重录；`test:replay` 6/6 | 改提示词必须重录 | [票](issues/F-19-replay-maintenance/ticket.md) · [讨论](issues/F-19-replay-maintenance/discussion.md) |
| F-20 | 证据策略默认值 | — | P2 | DONE | `evidence.mode=warn` 默认；不拒绝 | ADR-0114；全包测试 | `drop` 仍不启用 | [票](issues/F-20-evidence-default/ticket.md) · [讨论](issues/F-20-evidence-default/discussion.md) |

## 当前焦点

- [x] [F-01 覆盖账本（P0-1）](issues/F-01-coverage-ledger/discussion.md)——DONE 2026-11-21；C2/C3 已拆到 F-15
- [x] [F-02 准入与分片一致（P0-2）](issues/F-02-admission-split/discussion.md)——DONE 2026-11-22
- [x] F-03 分片并行（P0-3）——DONE 2026-11-22；live 2.51×，全包 1220 passed

## 验收门槛（每个任务都适用）

- [ ] 单测 / 包级测试全绿；`tsc -p tsconfig.build.json` 零错误
- [ ] 离线 replay 六场景通过；提示词 / 工具 schema 改动后已重录 trace
- [ ] 新增审计键有留痕；秘密不回显；失败语义不变
- [ ] 同一输入 + 同一配置 → 同一计划 / 分母 / 预取包（确定性）
- [ ] 效果验证按 `docs/design/检视流程合理性评估...` §8：3 轮评审 × 3 轮 judge；P/R/B + token + 墙钟 + 工具调用一起报
- [ ] 大 MR 与小 diff 分开列表，不聚合
- [ ] 完成时在本表补 `证据 / commit`，并在 `## Changelog` 追加一行

## 更新规则

1. **新增优化**：在任务清单加一行；编号 `F-NN` 递增；写清“对应问题”和“验收摘要”；同步建 `issues/<task-id>/` 目录。
2. **开工**：状态改 `DOING`；在 `issues/<task-id>/` 建 `ticket.md`（含 `Status: claimed`），把方案细节放票里。
3. **讨论**：每次讨论追加到 `issues/<task-id>/discussion.md`，并在本表「讨论」列补链接；不要只留在会话里。
4. **完成**：只有验收证据齐全才改 `DONE`；证据列填测试名 / 报告路径 / commit；不要只写“已实现”。
5. **阻塞/放弃**：`BLOCKED` / `DROPPED` 必须在备注写原因与解除条件。
6. **不要合并多个变量**：一个任务一个可回滚改动；实验分支按 F-01/F-02/F-03 拆，`exp-flow` 只做集成。
7. **文档同步**：新决策落 ADR 后，把 ADR 编号补进备注；评估文档的 D 清单如有变化，回链更新。

## Decisions so far

- 2026-11-21：采用 `.scratch/<branch>/map.md` 作为分支 TODO 总表；详情票按 `docs/agents/issue-tracker.md` 放 `issues/<task-id>/ticket.md`。
- 2026-11-21：先做 F-01/F-02/F-03 三个 P0，不做阶段压缩与预取（避免变量混在一起）。
- 2026-11-21：F-01 的效果验收从“P/R 都不回退”改为 **Balanced 不回退即可**；P 允许回退，但仍需随报告披露。
- 2026-11-21：F-01 收口为 `DONE`；F-01c C2/C3 拆到 F-15（覆盖阈值 warn/fail、manifest/CI/preview 复用）。
- 2026-11-21：每个任务的讨论归档到 `issues/<task-id>/discussion.md`，并在本表「讨论」列提供跳转链接。
- 2026-11-22：F-02 收口为 `DONE`；验收 = 单样本准入（17,227 字符 diff 在 maxDiffChars=8000 下由 skipped 变 ok + `shards[]`）+ 全包 1214 passed；不做大规模验证。桥接统一为 merge-base（PR 范围）口径。
- 2026-11-22：F-03 收口为 `DONE`；默认 `concurrency=1`，live 仅证明墙钟（2.51×）与 429（0/0），token/findings 等价由确定性 fake 覆盖；同一 trace 的 replay 对比列为后续验证，不作为阻塞。

## Changelog

- 2026-11-21：创建 `exp-flow` 跟踪清单；从评估文档 Appendix D 导入 P0/P1/P2 任务。
- 2026-11-21：改为「每任务一个目录」（`ticket.md` + `discussion.md`）；归档 F-01 讨论并在任务表新增「讨论」跳转列。
- 2026-11-21：F-01 开工；F-01a 账本骨架落地（`contracts/coverage.ts` + `run/coverage-ledger.ts` + 23 单测，未接线）。
- 2026-11-21：截取区间 producer 落地（`ShardTruncationRecord.dropped` + 文件内累计序号；15 个 shard-planner 用例），待接线。
- 2026-11-21：pass + 审计接线落地（`coverage` 尾键、分片聚合、失败旁路 `coverage.json`）；全包 1187 passed / 1 skipped。
- 2026-11-21：stderr 覆盖摘要、失败旁路测试、零模型基线脚本（`scripts/coverage-baseline.mjs`）；全包 1189 passed / 1 skipped。
- 2026-11-21：从 `exp-group` 全量迁移 `docs/bench`（554 files / 20.5 MB，含 artifacts / ocr / results）；运行时仍依赖外部 evaluation。
- 2026-11-21：AACR-Bench 归档从 `docs/bench` 迁到 `bench/aacr-bench-v2`；新增 `bench/README.md` 与结构指南条目。
- 2026-11-21：F-01a iterF91 零模型验收通过（91 条；22,266 hunk；818 截取 hunk；maxShards=12 下 3 条显式失败，32 下 91/91）；证据 `issues/F-01-coverage-ledger/f01a-iterf91-zero-model.json`。
- 2026-11-21：F-01b 缺口补漏落地（`coverage-repair.ts` + 配置 + 审计 + stderr）；全包 1206 passed / 1 skipped；待 iterB10 A/B。
- 2026-11-21：修复补漏 `candidate` 回执不带 `hunk` 的解析 bug（首轮 26 条候选全 invalid）；全包 1207 passed；iterB10 A/B 重跑：not-reached 89.9%→17.5%，P 0.500→0.449 / R 0.316→0.358 / B 0.387→0.398，补漏候选精度约 26.7%，质量验收未通过；证据 `issues/F-01-coverage-ledger/discussion.md`。
- 2026-11-21：修基准 token 汇总口径：桥接 `read_usage` 把审计根 `usage` 与 `coverageRepair.usage` 相加，并输出分项；B 实际总 token 6,186,912（报告旧值 5,840,941）。
- 2026-11-21：F-01b v2 落地（no-issue 必须带 evidence；候选优先提示词；代码文件优先预算）；全包 1208 passed；iterB10：P 0.439 / R 0.432 / B 0.435，较 v1 B +3.7pp、R +7.4pp；补漏候选 7/27 命中，GT 文件意见 32→50。
- 2026-11-21：F-01 验收口径改为 Balanced 不回退；v2 B 0.435 vs arm A 0.387，满足新口径（P 仍低 6.1pp，如实披露）。
- 2026-11-21：F-01b v3 独立验证门落地；iterB10 P 0.522 / R 0.400 / B 0.453（v2 0.439/0.432/0.435），验证器 26 请求、拒绝 17、accept 9、fail-open 4；F-01c C1 `coverageSummary` 进 run.json；全包 1212 passed。
- 2026-11-21：F-01c C1 验收：`summarizeCoverage`（counts + ratios + byCause）投影到 `audit.coverageSummary`，逐 hunk 明细仍在审计；单测 + 全包通过。C2（阈值告警/失败）与 C3（manifest/CI/preview）拆到 F-15。
- 2026-11-21：F-01 状态改为 DONE；验收证据 F-01a 91/91、F-01b v3 B 0.453、F-01c C1 coverageSummary、全包 1212 passed。
- 2026-11-22：iterF91 基准（F-02 前，最佳配置）91/91 ok，P 0.381 / R 0.245 / B 0.298，token 53,104,139；归档 `bench/experiments/2026-11-21-f02/baseline-f91-v3/`。
- 2026-11-22：桥接改为 merge-base（PR 范围）口径，仓内副本同步；F-02 单样本 cline 17,227 字符在 maxDiffChars=8000 下 `ok` + `shards[]`，F-02 前会 skipped；归档 `.../f02-small-check/`；全包 1214 passed；F-02 收口 DONE。
- 2026-11-22：F-03 有界并行落地（`limits.split.concurrency` 1–8，默认 1；片序聚合/回调；AsyncLocalStorage 时间线；pass 前建 runDir）。live 3 样本 22 片：5298.9s → 2111.8s（2.51×），429 0/0；归档 `bench/experiments/2026-11-22-f03/`。等价性 replay 待补。
- 2026-11-22：F-04 v1 落地（`limits.evidence` off/warn/drop + `EVIDENCE_UNGROUNDED` + `evidenceGrounding` 审计）。历史回放 v3 320 findings：grounded 217 / unverified 103；drop 会排除约 32%，默认保持 off。全包 1234 passed / 1 skipped。

- 2026-11-22：F-08b/F-09a/F-17/F-20 收官批次：检索预算默认 3/4/40 万、confidence 0.3、evidence warn、one-shot 截断重试；S20 预算复本 270→254 请求、token −12%、B −0.7pp；全包 1249 passed / 1 skipped。
- 2026-11-22：F-18 评估：coverage repair B +3.65pp（CI 跨 0）、墙钟 +30% → 保持默认关闭。
- 2026-11-22：F-19 replay 维护：5 个 canned trace 重录 + large-mr 真网关重录，`test:replay` 6/6。
- 2026-11-22：TODO 复盘：F-10/F-12 并入 F-08；F-11/F-13/F-14 DROPPED；新增 F-16–F-20 并收口。
