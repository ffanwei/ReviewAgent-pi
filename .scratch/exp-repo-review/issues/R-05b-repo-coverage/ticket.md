# R-05b · 覆盖账本与结果契约

- Status: TODO
- Branch: `exp-repo-review`
- Created: 2026-11-25

## 问题

R-05 只完成了 findings / tips schema；覆盖仍是 MR 的 hunk 账本。由于合成 diff 把所有行都标成新增，coverage 天然 100%，无法回答「哪些文件没看到」。

## 目标

- 新增 repo 专用文件级三态：`candidate` / `no-issue` / `not-reached`；
- 跳过原因映射（excluded / binary / too-large / group-too-large / over-max-files / read-failed）；
- 失败组、预算未派发组全部记 `not-reached`；
- 聚合产物 `repo-review-result.json` 增加 `inventory` / `plan` / `coverage`；保留每组 MR 兼容产物；
- CLI 摘要输出三态计数。

## 验收

- 三态之和 = selected；无文件重复；
- 失败 / 跳过 / 超预算都有稳定 reason；
- 同快照两次运行 coverage 字节一致；
- schema 文档与样例更新。

## 依赖

R-01、R-05；与 R-04b 并行。

## 范围决定

- 2026-11-25：快速上生产的第二优先级；区域级（类 / 方法）三态留到后续，v1 只做文件级。

## 实现进展（2026-11-25）

- 新增 `repo-spike/coverage.ts`：`buildRepoCoverage` 纯函数，按 selected 枚举顺序输出文件级三态；`coverageIsConsistent` 自检。
- `RepoSpikeResult.coverage` 改为 repo 专用形状：`summary { selected, candidate, noIssue, notReached }` + `files[{ path, state, reason?, findingIds? }]`；不再复用 MR hunk 账本。
- 失败组 → `failed-group`；跳过组 → `no-reviewable-files`；分组/合成跳过 → `group-too-large` / `read-failed` / `empty` 等；`too-large(N>M)` 归一化为 `too-large`。
- CLI 摘要新增 coverage 三态计数。
- 单测：三态计数、失败/跳过/合成跳过归因、顺序与重复路径、reason 归一化、两次输出字节一致；全包 1280 passed / 1 skipped。
- 真实 smoke（2 个 Java 文件）：`selected=2, candidate=2, noIssue=0, notReached=0`，findingIds 正确。
- 未做：区域级（类/方法）覆盖；`budget-exhausted` 只预留 reason，等 R-09 接入。
