# exp-flow · 检视流程优化跟踪

> 分支：`exp-flow`（从 `exp-skill` @ `331ccc6` 切出）
> 状态：active
> 更新：2026-11-21
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
| F-01 | 覆盖账本：文件 × hunk 三态（candidate / no-issue / not-reached） | P0-1、P1-11、V1/V7 | P0 | DOING | not-reached 比例可见；未覆盖 hunk 只对缺口发补漏；P/R 不回退 | — | 先定账本 schema 与审计键 | [票](issues/F-01-coverage-ledger/ticket.md) · [讨论](issues/F-01-coverage-ledger/discussion.md) |
| F-02 | 大 MR 准入与分片一致：split 启用时不再按 `maxDiffChars` 整条跳过 | P0-2、V2 | P0 | TODO | FreeCAD 类 diff 不再 skipped；片数 ≤ maxShards；截取留痕 | — | 需定“超 maxShards”失败语义 | — |
| F-03 | 分片并行（可配 3–8） | P0-3、V2 | P0 | TODO | findings 集合与串行一致；墙钟显著下降；429 不增加 | — | 片级审计/转录路径不变 | — |
| F-04 | 证据接地：文件/行号/引文可核对 | P0-4、V3 | P0 | TODO | 伪造行号/引文/越界文件被确定性拒绝；真证据不误杀 | — | 先做零模型硬门 | — |
| F-05 | 独立证伪核验（新会话；保护性主题 fail-open） | P0-5、V3 | P0 | TODO | 噪声率下降；真值损失 ≤ 阈值；核验理由可审计 | — | 与 F-04 分开实验 | — |
| F-06 | 独立补漏默认开启 / 标准化 | P0-6、V4 | P0 | TODO | 3 轮 Balanced ≥ OCR；token 不高于当前 | B2 报告已有小 diff 数据 | 需补大 diff 数据 | — |
| F-07 | 阶段压缩：合并 1+2、条件化 Phase 4 | P1-7、V5 | P1 | TODO | 每单元请求 -≥1；P/R/B ±2pp 内 | — | 6/4/2 三臂 A/B | — |
| F-08 | 检索预算 + 重叠区间 Ledger | P1-8/9 | P1 | TODO | 同文件区间不重读；空搜索比例下降 | — | 12 run 已证区间盲 | — |
| F-09 | 输出校准：confidence 0.3；范围外 `scope` 标注 | P1-10、V8 | P1 | TODO | 真值不丢；噪声不升；范围外可被下游选择 | VUL4J 10 例数据 | 需产品口径确认 | — |
| F-10 | Phase 5/6 按需读取 | P1-13、V5 | P1 | TODO | 工具调用 -≥20%；P/R/B 不回退 | 12 run：P5 仅 1 次、P6 为 0 | 提示词 + 预算 | — |
| F-11 | 多轮语义：边际收益停止 + 硬上界 | P1-12 | P1 | TODO | 无新增即停；不再依赖模型显式 false | 12 run 全部 rounds=1 | 与 F-06 联合看 | — |
| F-12 | 确定性预取（changed symbols / 直接引用 / 调用点） | P1-8、V6 | P2 | TODO | head 侧可用；base/mixed 降级；工具调用下降 | `resolveChangedFileSymbols` 无运行时调用方 | 先补 `newSpansOf` | — |
| F-13 | 大 diff severity 区分度复核 | D.3 | P2 | TODO | 复跑数据；确认是否仍需校准 | 旧实验记忆，未复跑 | — | — |
| F-14 | `search_rule` / `search_history` 可见性复核 | D.3 | P2 | TODO | 当前版本命中率与调用价值有结论 | 历史 run 24 次、约 111 字符/次 | — | — |
| F-15 | preview / resume / manifest / PR 原生闭环 | 对比文档 P0 | P2 | TODO | 逐项产品验收 | — | 不阻塞流程正确性 | — |

## 当前焦点

- [ ] [F-01 覆盖账本（P0-1）](issues/F-01-coverage-ledger/discussion.md)——先写 schema、审计键、`not-reached` 统计，不先改提示词
- [ ] F-02 准入与分片一致（P0-2）——用 FreeCAD 同类构造用例先红后绿
- [ ] F-03 分片并行（P0-3）——先证明 findings 与串行逐字节等价

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
- 2026-11-21：每个任务的讨论归档到 `issues/<task-id>/discussion.md`，并在本表「讨论」列提供跳转链接。

## Changelog

- 2026-11-21：创建 `exp-flow` 跟踪清单；从评估文档 Appendix D 导入 P0/P1/P2 任务。
- 2026-11-21：改为「每任务一个目录」（`ticket.md` + `discussion.md`）；归档 F-01 讨论并在任务表新增「讨论」跳转列。
- 2026-11-21：F-01 开工；F-01a 账本骨架落地（`contracts/coverage.ts` + `run/coverage-ledger.ts` + 23 单测，未接线）。
- 2026-11-21：截取区间 producer 落地（`ShardTruncationRecord.dropped` + 文件内累计序号；15 个 shard-planner 用例），待接线。
