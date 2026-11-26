# exp-repo-review · 无 diff 全仓扫描跟踪

> 分支：`exp-repo-review`（从 `exp-flow` @ `09870c7` 切出）
> 状态：active
> 更新：2026-11-24
> 设计依据：R-01 待产出 `docs/design/全仓扫描-方案与契约.md`
> 约定：每个任务一个目录 `issues/<task-id>/`，内含 `ticket.md`（详情票）与 `discussion.md`（讨论归档）；本文件只做索引、状态与验收证据。

## 目标

在现有 MR/diff 检视之外，新增**无 diff 的全仓扫描**形态：输入仓库快照，确定性枚举与分组，逐组独立检视，产出可定位的 findings 与中文 tips。先定契约与零模型计划，再发模型请求。

**不做**：

- 不把全仓扫描做成 `limits.group.enabled` 的开关翻版；
- 不在 R-01 契约定稿前改 `review-run.ts` 主路径；
- 不直接拿 iterF91 / AACR 的 MR 指标当全仓成绩；
- 不在行锚点 / 证据语义定稿前发模型请求；
- 不继承 `exp-multifile-recall` 的未提交改动；
- 不为覆盖放开建议 / 风格 / 测试类意见。

## 现状与边界

- 基点 `exp-flow@09870c7`。`exp-flow` 相对 `main` 领先 **121 commits / 202 files（+22.7k/−10.0k）**，其中 **57 个 commit 动 `packages/`**；`main` 为 release 0.6.1。
- 现有 CLI 输入是 `--mr-diff` / `--mr-json`，`--repo` 只是仓库根目录。
- `boundary` 默认 `maxFiles=10`、`maxDiffLines=2000`、`maxDiffChars=1M`，全仓扫描会直接撞门。
- 现有评测 `iterF91` / AACR 是 MR + diff GT，全仓扫描不能直接复用。
- `exp-multifile-recall` 有未提交的 `group-planner` 改动与 M-03/M-04 DOING；本分支**不继承**，只按需要评审后 cherry-pick。
- 当前工作区隔离：本分支在 `.claude/worktrees/exp-repo-review`，不影响主工作区的 `exp-multifile-recall` 会话。
- 研究输入：[OCR 全仓扫描（`ocr scan`）对照分析](research/ocr-scan-analysis.md)：源码级事实、可学习点、局限与准确率 / token / 并发建议。

## 分组复用边界（R-03 核心判断）

**不能直接复用 `planGroups`**：它消费 unified diff（`splitDiffIntoFileBlocks`），单元是 diff 块，输出含 diff 文本与「其他变更文件」摘要；全仓扫描的输入是文件树，单元是文件内容，还需要忽略规则、语言、二进制 / 生成物识别、总量预算与优先级。

可复用的是**概念与零模型纪律**：文件数 + 字符双上限、确定性排序、不拆单元、截断留痕、组摘要、`directory` / `language` 键、单测形态。待 M-03/M-04 定稿后，再评估从 `group-planner` 抽出共享「单元装箱」原语，供 diff 与全仓两个来源复用；在此之前不绑定其接口。

## 状态图例

| 状态 | 含义 |
|---|---|
| `TODO` | 已登记，未开工 |
| `DOING` | 已开工；必须有一个 `issues/<task-id>/ticket.md` 且 `Status: claimed` |
| `BLOCKED` | 等外部条件（数据 / 决策 / 依赖） |
| `DONE` | 已合并 / 已验证；必须贴验收证据（测试、报告、commit） |
| `DROPPED` | 明确不做；必须写原因 |

## 目录约定

```text
.scratch/exp-repo-review/
  map.md                          # 本文件：索引 / 状态 / 验收证据
  issues/
    R-01-repo-scan-contract/
      ticket.md                   # 详情票：方案、验收、待决问题
      discussion.md               # 讨论归档：按日期追加
    R-02-file-inventory/
    ...
```

- 开工：建 `issues/<task-id>/ticket.md`（`Status: claimed`），状态改 `DOING`。
- 讨论：每次讨论追加到同目录 `discussion.md`，按 `YYYY-MM-DD · 主题` 分段；只增不改历史结论，结论变化写新日期段。
- 本表「讨论」列必须指向对应 `discussion.md`；没有讨论文件的写 `—`。

## 实验命名

```text
{branch}-{taskId}[-{stage}]-{YYYYMMDD}
```

示例：`exp-repo-review-R02-20261124`、`exp-repo-review-R04-stage0-20261124`。run-id、外部结果目录、仓内归档目录统一使用同一字符串。

## 任务清单

| ID | 任务 | 对应问题 | 优先级 | 状态 | 验收（摘要） | 证据 / 备注 | 讨论 |
|---|---|---|---|---|---|---|---|
| R-01 | 全仓扫描方案与输入契约 | 无 diff 输入、行锚点、输出、CLI 形态都没有定义 | P0 | DONE | 设计文档评审通过；CLI / 产物 / 行锚点三项决策有结论；R-02–R-07 依赖顺序成文 | 2026-11-24 完成：[`docs/design/全仓扫描-方案与契约.md`](../../docs/design/全仓扫描-方案与契约.md)；D1–D8 决策表；依赖顺序 §10 | [票](issues/R-01-repo-scan-contract/ticket.md) · [讨论](issues/R-01-repo-scan-contract/discussion.md) |
| R-SPK | 全仓检视 spike：分组 + 合成 diff + 复用 `runReviewOutcome` | 先用最小侵入验证可行性、隔离性与 Skill 透传 | P0 | DONE | dry-run + fake-fetch 全链；PR 核心零修改；报告 md/pdf | 2026-11-24 完成：commit `511b256`；6 个测试文件 63 passed；全包 1265 passed / 1 skipped；报告 [`repo-spike-方案报告.md`](reports/repo-spike-方案报告.md) + `.pdf` | [票](issues/R-SPK-repo-spike/ticket.md) · [讨论](issues/R-SPK-repo-spike/discussion.md) |
| R-02 | 仓库文件枚举与过滤 | 全仓扫描没有可检视文件清单 | P0 | DONE | 同快照两次枚举一致；忽略 / 二进制 / 生成物 / 超大文件规则可配；跳过有原因 | 2026-11-24 完成：`enumerate.ts` 5 单测；1607 文件 dry-run；规则配置化留 R-02b | [票](issues/R-02-file-inventory/ticket.md) · — |
| R-03 | 仓级分组与预算账本 | 全仓不能沿用 diff 字符分片 | P0 | DONE | 确定性分组；文件不重复 / 不跨组；文件数 + 字符双上限；组数护栏；截断留痕 | 2026-11-24 完成：四策略 + 双上限 + `maxGroups` 护栏；单测与 dry-run 证据见票 | [票](issues/R-03-repo-grouping-budget/ticket.md) · [讨论](issues/R-03-repo-grouping-budget/discussion.md) |
| R-04 | 全仓扫描执行路径 | 现有 `review-run.ts` 是 diff 入口 | P0 | DONE | 单组 / 多组均可跑通；行锚点真实；组失败隔离；与 MR 路径不互相污染 | 2026-11-25 完成：255/255 组、1,342 findings、207.5 min；主跑被宿主内存保护停在 253 组，缺失 2 组用 `--files` 补跑；生产契约补齐见 R-04b | [票](issues/R-04-repo-scan-execution/ticket.md) · — |
| R-04b | scan 语义与产品命令 | R-04 按 spike 形态验收，仍把文件伪装成新增 | P0 | DONE | `repo-review` 命令；中性文件快照消息；scan Zone A；MR 提示词字节不变；20 组 A/B 不回退 | 2026-11-25 完成：全包 1275 passed / 1 skipped；真实 1 组 smoke；20 组 A/B：73 vs 83 findings、token +5.4%、precision 0.816 vs 0.776（+4.1pp）；replay 5/6（rule-skill 父提交同样失败，既有 trace 陈旧） | [票](issues/R-04b-scan-semantics/ticket.md) · [讨论](issues/R-04b-scan-semantics/discussion.md) |
| R-05 | 输出契约与呈现 | findings / tips 依赖「变更行」语义 | P1 | DONE | schema 与样例；无 diff 行锚点语义；tips 不依赖变更行；下游边界写清 | 2026-11-24 完成：R-01 §6 schema + calibration 样例；tips 内嵌 finding；三态覆盖见 R-05b | [票](issues/R-05-output-contract/ticket.md) · — |
| R-05b | 覆盖账本与结果契约 | R-05 只完成 schema，coverage 仍是 MR hunk 账本 | P0 | DONE | 文件三态；失败 / 跳过 / 超预算归因；三态之和 = selected；`repo-review-result.json` | 2026-11-25 完成：`coverage.ts` 文件级三态 + 稳定 reason + CLI 计数；全包 1280 passed / 1 skipped；真实 smoke selected=2/candidate=2；区域级与 budget 归因留后续 | [票](issues/R-05b-repo-coverage/ticket.md) · [讨论](issues/R-05b-repo-coverage/discussion.md) |
| R-06 | 全仓评测集与基线 | 现有 iterF91 / AACR 是 MR + diff GT | P1 | DONE | 全仓对照口径成文；precision / 耗时 / token 可复核；不与 MR 结果混报；召回留 R-06b | 2026-11-25 完成：我方 255/255 组（1,390 文件）、OCR 1,388 文件；报告 md/pdf；precision 0.82 vs 0.69（我方 120 条 / OCR 150 条抽样） | [票](issues/R-06-repo-eval/ticket.md) · — |
| R-06b | 全仓召回评测 | 全仓没有逐行 GT，precision 不能推 recall | P2 | TODO | 冻结注入/回滚清单；recall + 注入文件 precision；不与自然召回混报 | 2026-11-25 决定暂缓：本轮不测 recall，后续可能做 | [票](issues/R-06b-recall/ticket.md) · [讨论](issues/R-06b-recall/discussion.md) |
| R-07 | 增量扫描 | 全仓重扫成本高 | P2 | TODO | 同快照全量 vs 增量结果一致；缓存失效规则明确；审计记录命中 | 依赖 R-02、R-04；2026-11-25 决定暂缓，后续可能做 | [票](issues/R-07-incremental-scan/ticket.md) · [讨论](issues/R-07-incremental-scan/discussion.md) |
| R-08 | 与多文件实验及主线的合并路径 | 三条实验线共享文件，长期分叉 | P1 | BLOCKED | 集成顺序与冲突面清单；共享文件改动清单；合并前回归范围 | 等 `exp-flow → main` 与 multifile 结论 | [票](issues/R-08-merge-path/ticket.md) · — |
| R-09 | 持久化编排与总预算 | 单进程；253/255 内存停止后靠人工 `--files` 补跑 | P0 | DONE | `job.json` + `--resume`；kill 后续跑一致；临时 / 永久错误分流；`--max-total-tokens` | 2026-11-25 完成：job 清单 + hash 校验 + resume + 重试 + 总预算；全包 1290 passed / 1 skipped；真实 resume 8.4s 无模型请求；预算超出上界为在飞组数 | [票](issues/R-09-durable-scan-job/ticket.md) · [讨论](issues/R-09-durable-scan-job/discussion.md) |
| R-10 | 全仓检视 MCP 上报 | `repo-review` 不接 MCP，平台收不到任务与按文件意见 | P0 | DOING | 四工具（start / report / currentTips / end）顺序；按批逐文件上报；复用同一 server 配置；失败不改退出码 | 2026-11-25 实现、单测与进程级 stub 端到端完成：全包 1307 passed / 1 skipped，build 通过；待真实 MCP server 联调 | [票](issues/R-10-full-repo-mcp-reporting/ticket.md) · [讨论](issues/R-10-full-repo-mcp-reporting/discussion.md) |
| R-11 | 全仓 CLI 与 review 对齐 | repo 缺 taskId/tasks-dir/model 口径，产物不在任务目录 | P0 | DONE | `--taskId` 必填；产物落 `<tasks>/<taskId>`；`--tasks-dir` / `--model` 同 review；`--include/--exclude` 过滤路径 | 2026-11-25 完成：全包 1309 passed / 1 skipped，build 通过；参数 / 枚举 / 进程级用例覆盖 | [票](issues/R-11-repo-cli-task-dir/ticket.md) · [讨论](issues/R-11-repo-cli-task-dir/discussion.md) |
| R-12 | `limits.repoScan` 配置块 | repo 缺省只能靠 CLI，`config init` 不含这些值 | P1 | DONE | `config init` 生成 repoScan 默认块；CLI > 配置 > 内置；范围校验 | 2026-11-25 完成：`config init` 实测生成 repoScan 块；全包 1314 passed / 1 skipped，build 通过 | [票](issues/R-12-repo-scan-config/ticket.md) · [讨论](issues/R-12-repo-scan-config/discussion.md) |
| R-13 | 语言缺陷清单（MR + 全仓） | 需要复用 OCR 的语言规则，但不能增加每组会话成本 | P1 | DONE | 5 种 AST 语言；Phase 5 注入；MR / Repo 独立开关；中文缺陷清单；`<rules for>` 分块 | 2026-11-25 完成：全包 1324 passed / 1 skipped，build 通过；Phase 5 注入与开关单测通过 | [票](issues/R-13-language-rules/ticket.md) · [讨论](issues/R-13-language-rules/discussion.md) |
| R-14 | 全仓运行日志 | 全仓只有 stderr，宿主停止后无法复盘执行过程 | P1 | DONE | `<out>/runs/review-pi.log` 实时镜像 stderr；dry-run 也留痕；打开失败不改退出码 | 2026-11-25 完成：全包 1325 passed / 1 skipped，build 通过；dry-run 与真跑进程用例断言日志内容 | [票](issues/R-14-repo-run-log/ticket.md) · — |
| R-15 | 跳过检视按文件上报 | 跳过路径只报首个文件，平台无法按文件登记 | P1 | DONE | 跳过路径按变更文件全集逐个上报空 tips；全仓零意见组同样逐文件 | 2026-11-25 完成：全包 1328 passed / 1 skipped，build / typecheck 通过；ADR-0119 | [票](issues/R-15-report-every-file-when-skipped/ticket.md) · — |
| R-16 | Finding 路径修复 | 模型路径少量字符错误 → 读不到源码行，意见丢失 | P0 | DONE | 按已知文件全集修 `Finding.file`；唯一最佳才修；覆盖 / 落盘 / 报文统一用修复值 | 2026-11-25 完成：新增 `finding/path-repair.ts` + 9 单测 + repo 集成测试；ADR-0120 | [票](issues/R-16-finding-path-repair/ticket.md) · — |
| R-17 | 大文件入口与上限调整 | 60–100k 文件被 selected 后 `group-too-large`，从未送检 | P1 | DONE | 缺省改 5 文件 / 80k 组 / 120k 文件；单文件超组上限时单独成组（soloLarge）；>120k 仍显式跳过 | 2026-11-26 完成：group / dry-run / config 单测；设计文档与流程图更新；ADR-0121 | [票](issues/R-17-large-file-solo/ticket.md) · — |

## 当前焦点

- [x] **R-SPK**：全仓检视 spike 已完成；验证了分组、合成 diff、Skill 透传与 PR 零修改。
- [x] **R-01 契约定稿**：输入、单元、行锚点、输出、CLI 五项已定，D1–D8 写入设计文档。
- [x] **R-02 零模型文件枚举**：确定性、排除规则、跳过原因与单测已完成。
- [x] **R-03 分组与预算**：四策略 + 双上限 + `maxGroups` 护栏已完成。
- [x] **R-04 执行路径**：255/255 组全仓实跑（主跑 253 + 补跑 2），行锚点真实，组失败隔离。
- [x] **R-05 输出契约**：`repo-spike-result.json` + tips 内嵌 finding。
- [x] **R-06 全仓对照**：我方 vs OCR，precision / 耗时 / token 已出报告。
- [x] **R-04b scan 语义**：完成；`repo-review` + 中性文件快照 + scan Zone A，20 组 A/B 通过（precision 0.816 vs 0.776）。
- [x] **R-05b 覆盖账本**：完成；文件三态 + 稳定 reason + `repo-review-result.json`，真实 smoke 通过。
- [x] **R-09 持久化编排**：完成；`job.json` + `--resume` + 重试 + 总 token 预算，真实 resume 通过。
- [ ] **R-10 全仓 MCP 上报**：实现与单测完成；待真实 server 联调（四工具顺序、按批文件包、currentTips 空数组）。
- [x] **R-11 CLI 对齐**：完成；`--taskId` 必填、产物落 `<tasks>/<taskId>`、`--tasks-dir` / `--model` 同 review、`--include/--exclude` 路径过滤。
- [x] **R-12 repoScan 配置**：完成；`config init` 生成 `limits.repoScan`，优先级 CLI > 配置 > 内置。
- [x] **R-13 语言缺陷清单**：完成；5 种 AST 语言、Phase 5 注入、MR / Repo 独立开关，缺省关闭。
- [x] **R-14 全仓运行日志**：完成；`<out>/runs/review-pi.log` 实时镜像 stderr，dry-run 同样留痕。
- [x] **R-15 跳过检视按文件上报**：完成；跳过路径按变更文件全集逐个发空 tips，全仓零意见组同样逐文件。
- [x] **R-16 Finding 路径修复**：完成；按已知文件全集修正少量字符错误，唯一最佳才修；ADR-0120。
- [x] **R-17 大文件入口与上限调整**：完成；缺省 5 文件 / 80k 组 / 120k 文件，单文件超组上限时单独成组（soloLarge）；ADR-0121。
- [ ] **R-06b 召回**：暂缓（2026-11-25 决定，本轮不测；后续可能做，建议先合成注入再真实修复回滚）。
- [ ] **R-07 增量扫描**：暂缓（2026-11-25 决定，本轮不做；后续可能做）。

## 变更记录

- 2026-11-24：从 `exp-flow@09870c7` 切出 worktree `.claude/worktrees/exp-repo-review`；确认 A 方案（无 diff 全仓扫描）；登记 R-01–R-08；明确「不改主路径」「不继承未提交改动」边界。
- 2026-11-24：讨论确认全仓扫描**不直接复用 `planGroups`**，只复用零模型分组纪律；详见 R-03 讨论。
- 2026-11-24：R-SPK 完成：新增 `src/repo-spike/` + `repo-spike` 子命令；每组一次 `runReviewOutcome`；PR 核心零修改；报告 md/pdf 已产出。
- 2026-11-25：R-01–R-06 完成；全仓对照报告 `reports/全仓检视-OCR对照-报告.md` + `.pdf`；我方 255/255 组（主跑 253 + `--files` 补跑 2，1,342 findings），OCR 全量 1,388 文件；precision 0.82 vs 0.69。
- 2026-11-25：决定暂缓 R-06b 召回与 R-07 增量扫描；本轮范围锁定在已完成的 R-01–R-06，后续需要时再启动。
- 2026-11-25：按「快速上生产（内部非阻断）」拆分 R-04b / R-05b / R-09；R-04 / R-05 的 DONE 保留为 spike 验收，不改写历史。
- 2026-11-25：R-04b 代码与单测完成（`repo-review`、scan Zone A、中性文件快照、`source=repo-scan`）；1 组真实 smoke 通过，20 组 A/B 待跑。
- 2026-11-25：R-04b 完成；20 组 A/B 73 vs 83 findings、token +5.4%、precision 0.816 vs 0.776，均满足验收。
- 2026-11-25：R-05b 完成；文件级三态覆盖账本、reason 归一化、CLI 计数；全包 1280 passed / 1 skipped。
- 2026-11-25：R-09 完成；job.json 持久化、hash 校验续跑、临时错误重试、总 token 预算与 0/2/1 退出码。
- 2026-11-25：登记 R-10；全仓 MCP 四工具上报实现、单测与进程级 stub 端到端完成（全包 1307 passed / 1 skipped），待真实 server 联调。
- 2026-11-25：生产缺省调整为 5 文件 / 60k 字符（原 10 / 120k）：全仓实跑（255 组、平均 5.45 文件/组）表明单组超过 5 个文件后注意力下降。
- 2026-11-25：登记 R-11；repo CLI 对齐 review：`--taskId` 必填、产物落 `<tasks>/<taskId>`、`--tasks-dir` / `--model` 同策略、`--include/--exclude` 路径过滤。
- 2026-11-25：登记 R-12；新增 `limits.repoScan` 配置块，`config init` 生成默认值，优先级 CLI > 配置 > 内置。
- 2026-11-25：登记 R-13；Phase 5 语言缺陷清单（5 种 AST 语言、中文、缺陷导向），`limits.languageRules` MR / Repo 独立开关，缺省关闭。
- 2026-11-25：R-14 完成；全仓命令接入 `review-pi.log`（`<out>/runs/review-pi.log`），stderr 实时镜像，dry-run 也留痕。
- 2026-11-25：R-15 完成；跳过检视（diff-too-large / no-reviewable-files）改为按变更文件全集逐个上报空 tips；ADR-0119。
- 2026-11-25：R-16 完成；新增 Finding 路径修复（宽松匹配 + 有界编辑距离，唯一最佳才修），修复值进入覆盖账本与报文；ADR-0120。
- 2026-11-26：R-17 完成；缺省调整为 5 文件 / 80k 组 / 120k 文件，单文件超 `maxGroupChars` 时单独成组（`soloLarge`），不再整文件跳过；>120k 仍显式跳过；ADR-0121。
