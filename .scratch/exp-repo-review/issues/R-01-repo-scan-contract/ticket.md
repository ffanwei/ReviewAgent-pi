# R-01 · 全仓扫描方案与输入契约

- Status: claimed
- Branch: `exp-repo-review`
- Base: `exp-flow@09870c7`
- Created: 2026-11-24

## 问题

现有 Review Runtime 以 MR diff 为入口：`prepareReview` 接收 unified diff，分片 / 分组、覆盖账本、证据门、tips 行分组都围绕「变更行」构建。全仓扫描没有 diff，上述契约需要重新定义。

## 目标

1. 产出 `docs/design/全仓扫描-方案与契约.md`；
2. 明确输入、检视单元、行锚点、证据、输出、成本护栏与非目标；
3. 决定 CLI 形态（新 `scan` 子命令 vs `review` 的新输入模式）；
4. 给出 R-02–R-07 的依赖顺序与验收口径。

## 研究输入

- [OCR 全仓扫描（`ocr scan`）对照分析](../../research/ocr-scan-analysis.md)：源码级事实、可学习点、局限、准确率 / token / 并发建议。

## 方案要点（待定稿）

- **输入**：仓库根 + include / exclude + 语言 / 大小上限；无 diff。
- **单元**：文件 → 目录 / 模块组；组内文件不跨组、不重复。
- **行锚点**：finding 指向现有行，证据必须引用真实行内容；无「新增行」概念。
- **输出**：沿用 `reviews_en.json` / `reviews_tips_zh.json`，还是新增 scan 专用产物？需定。
- **成本**：总文件数、总字符、组数、token / 墙钟上限；超限显式失败而非静默截断。
- **执行**：先零模型计划与账本，再逐组模型检视。

## 验收

- 设计文档评审通过；
- CLI / 产物 / 行锚点三项决策有明确结论；
- R-02–R-07 的依赖关系和验收标准写入本票；
- 不改 `review-run.ts` 主路径，或明确最小改动点。

## 待决问题

- 全仓扫描复用现有六阶段循环，还是独立精简循环？
- findings 是否仍按 severity / confidence / tips 同一套 schema？
- 是否需要「最近变更优先」作为排序信号（读 git 历史）？
- 输出是否兼容平台 MR 评论模型，还是显式声明「非 MR 形态」？
