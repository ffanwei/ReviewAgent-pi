# R-05 · 输出契约与呈现

- Status: TODO
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
