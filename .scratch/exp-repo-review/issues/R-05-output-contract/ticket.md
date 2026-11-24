# R-05 · 输出契约与呈现

- Status: DONE
- Branch: `exp-repo-review`
- Created: 2026-11-24

## 问题

现有 findings 与中文 tips 依赖「变更行」语义；全仓扫描没有 diff，需要重新定义定位与分组。

## 目标

- 定义全仓模式的 findings 与中文 tips：文件 / 行定位、severity / confidence、按文件或目录分组；
- 明确不依赖 MR 评论模型；
- 决定沿用现有产物（`reviews_en.json` / `reviews_tips_zh.json`）还是新增 scan 专用产物。

## 验收

- schema 与示例样例；
- 无 diff 下的行锚点语义明确；
- tips 分组不依赖「变更行」；
- 下游消费方（CLI / 平台）边界写清。

## 依赖

R-01。

## 实现与验收证据（2026-11-24）

- schema：`docs/design/全仓扫描-方案与契约.md` §6（`repo-spike-result.json` / 组内 MR 兼容产物）。
- 样例：`D:/Project/.repos/out/spring-calib-ours/repo-spike-result.json`（10 文件 / 6 findings / 带 tips）。
- 行锚点：`Finding.file` 为仓库相对路径，`Finding.line` 为真实 1-based 行号；无 `lineType`。
- tips：`Finding.tips`（review / suggestion / subcategory）随候选产出；按文件分组不依赖 diff 变更行。
- 下游边界：不写 `mrReviewResult` / `baseSha` / `headSha`；聚合产物只供 CLI 与本地复核，不伪造平台 MR 报文。
- 未做：独立 `reviews_tips_zh.json` 投影（当前 tips 内嵌 finding）；产品化时由 R-04 的 delivery 层补。

