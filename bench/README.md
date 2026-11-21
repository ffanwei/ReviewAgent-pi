# bench · 历史评测归档

本目录存放**已结束的评测活动**的数据、配置、指标、脚本与逐样本结果。它不是产品运行时代码，
也不在本仓直接复跑；新增或查阅归档前先读对应子目录的 `README.md` / `MIGRATION.md`。

## 归档索引

| 子目录 | 内容 | 状态 |
|---|---|---|
| [`aacr-bench-v2/`](aacr-bench-v2/) | AACR-Bench v2 × review-pi / OCR（2026-11-15/16，91 条交集 / 588 GT） | 归档，不可复跑 |

## 约定

- **按评测活动建子目录**：`bench/<benchmark>/`，自带 `README.md` 与 `MIGRATION.md`。
- **归档 ≠ 可执行**：真实运行依赖外部评测环境（如 `D:/Project/bench/aacr-bench/evaluation`），
  不要在 `bench/` 下直接跑桥接/评测脚本。
- **数据与结论分开**：`data/` / `configs/` 是可追溯输入，`metrics/` 是汇总指标，分析结论写在 Markdown；
  `artifacts/` / `results/` / `ocr/**/results/` 是历史运行产物，体积大、不可作为运行输入。
- **新增归档优先精简**：只入库输入、配置、汇总指标与可读分析；逐样本运行产物默认不入库
  （ADR-0033 的运行留痕口径），确需保留时单独评估 Git LFS 或外部存储。
- **路径变更要同步引用**：移动归档时更新脚本里的硬编码路径、各 README 与 `.scratch` 任务记录。
