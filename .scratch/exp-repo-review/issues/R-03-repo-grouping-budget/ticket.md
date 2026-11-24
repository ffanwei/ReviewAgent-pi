# R-03 · 仓级分组与预算账本

- Status: DONE
- Branch: `exp-repo-review`
- Created: 2026-11-24

## 问题

全仓扫描不能沿用 diff 字符分片：需要从文件树枚举单元，按目录 / 模块聚合，并同时受文件数、总字符、组数、单文件大小约束。

## 目标

- 确定性、零模型的仓级分组计划；
- 文件不重复、不跨组；单文件超限按整块截取并留痕；
- 组数 / 总量护栏，超限在模型请求前显式失败；
- 输出可供 R-04 逐组执行，并写入审计。

## 与 `exp-multifile-recall` 的关系（重要）

- **不直接复用 `planGroups`**：它消费 unified diff（`splitDiffIntoFileBlocks`），单元是 diff 块，输出含 diff 文本与「其他变更文件」摘要；全仓输入是文件树与文件内容。
- **复用概念与纪律**：文件数 + 字符双上限、确定性排序、不拆单元、截断留痕、组摘要、`directory` / `language` 键、单测形态。
- 待 M-02/M-03 定稿后，再评估从 `group-planner` 抽出通用「单元装箱」原语；在此之前**不 cherry-pick 未提交代码、不绑定其接口**。

## 验收

- 零模型单测：顺序稳定、无重复 / 遗漏、组上限、超限显式失败、截断留痕；
- 同一输入两次计划字节一致；
- 账本字段写入审计（组号、文件数、字符数、截断、跳过原因）。

## 依赖

R-01、R-02。

## 实现与验收证据（2026-11-24）

- 实现：`packages/review-pi/src/repo-spike/group.ts` + `run.ts` 组数护栏。
  - `directory` / `files` / `language` / `none` 四种策略；路径排序 → 组键排序 → 桶内排序；
  - 文件数与字符双上限；单文件超 `maxGroupChars` 记 `group-too-large`，不拆文件；
  - `maxGroups`（缺省 500）超限显式失败，不静默截断；
  - 计划产物 `repo-spike-plan.json` 含组号、组键、文件清单、估算 `diffChars`、跳过原因。
- 单测：`group.test.ts` 覆盖四种策略、双上限、超限跳过、确定性排序。
- dry-run 证据：`spring-ai-java` 175 组；`spring-ai-java-prod` 待跑。
- 与 `planGroups` 的关系：仍按 R-03 讨论，只复用纪律，不绑定其接口。

