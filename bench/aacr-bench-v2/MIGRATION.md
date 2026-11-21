# AACR-Bench v2 归档迁移说明

> 2026-11-21：本目录先迁入 `docs/bench/`，同日再迁到顶层 `bench/aacr-bench-v2/`。
> 下文保留第一次迁移的原始记录；`git show exp-group:docs/bench/...` 里的 `docs/bench`
> 是 exp-group 的历史路径，不是本仓当前路径。

## 来源

- 分支：`exp-group`（`origin/exp-group`）
- 提交：`c72fbc8 exp(review): 分组/规则/JSON 恢复实验与 AACR benchmark 数据`
- 迁移日期：2026-11-21

## 已迁移

| 目录 / 文件 | 文件数 | 说明 |
|---|---:|---|
| `README.md` | 1 | AACR-Bench v2 评测归档总说明 |
| `MIGRATION.md` | 1 | 本迁移说明 |
| `MANIFEST.json` | 1 | 归档索引（指向 artifacts / ocr / results） |
| `scripts/` | 14 | 桥接、运行、后处理、报告、离线调参、子集生成 |
| `data/` | 9 | 151 条标准样本、run / eval_ok / smoke10 / iter20、排除分析、原始数据 |
| `configs/` | 10 | iterS / iterB / iterM / iterF 配置集 |
| `metrics/` | 27 | 全量 baseline、smoke10 / iter20 / 各 config 基线、过滤扫描 |
| `artifacts/` | 217 | review-pi 逐样本产物（reviews_all / tips / audit-summary） |
| `ocr/` | 121 | OCR 结果、指标与对比材料 |
| `results/` | 151 | 桥接层历史结果（status / review_output / token） |
| `comparison/` | 2 | OCR vs review-pi 对比材料 |

合计约 **554 个文件 / 20.5 MB**。`artifacts/`、`ocr/`、`results/` 都是历史运行产物，
不是运行输入；重跑评测时请使用 `data/` / `configs/` 与外部 evaluation 环境。

## 未迁移

无（归档已全量迁入 `bench/aacr-bench-v2/`）。`data/aacr-bench/` 是另一份本地数据集，仍在 `.gitignore` 中。

## 运行时依赖（重要）

本目录是**归档副本**，不是自包含评测环境。真实执行目录是：

```text
D:/Project/bench/aacr-bench/evaluation
```

该目录包含本仓未迁移的评测框架模块与数据：

- `repo_utils.py` / `schema.py` / `pipeline` / `converters`
- `.venv`、`benchmark/` 原始数据、`results/` 输出
- `aacr_reviewpi_bridge.py` 会 `sys.path.insert(EVAL_DIR)` 后 import `repo_utils` / `schema`；在 `bench/aacr-bench-v2/scripts` 直接运行会缺模块。
- `run_smoke.py` / `run_config.py` 的 `EVAL` / 数据路径按 evaluation 根目录布局计算；本仓路径不满足。

## 推荐用法

### 只读参考 / 取脚本

```bash
# exp-group 中的历史路径
git show exp-group:docs/bench/README.md
git show exp-group:docs/bench/scripts/aacr_reviewpi_bridge.py
```

### 真实跑评测

```bash
cd D:/Project/bench/aacr-bench/evaluation
python aacr_reviewpi_bridge.py \
  --dataset data/aacr_bench_v2_run.jsonl \
  --results-dir results/aacr_bench_v2/reviewpi/<run-id> \
  --config C:/Users/Li/.PiAgent/benchmark-aacr-v2.jsonc \
  --concurrency 2 --timeout-minutes 30
```

smoke10 / iter20 的完整命令见本目录 `README.md` 第 9 节。

### 本仓直接跑（需要额外工作）

若要在本仓直接执行，需要至少：

1. 把 evaluation 的 `repo_utils.py` / `schema.py` / `pipeline` / `converters` 一并迁入；
2. 调整 `run_smoke.py` / `run_config.py` 的 `EVAL` 与数据路径；
3. 准备 `.venv` 与 repo clone / 代理环境。

## 与 F-01 的关系

`data/` 里的 JSONL 是 AACR 样本（含 diff/GT 字段），可用于构造覆盖账本的零模型基线；当前
`scripts/coverage-baseline.mjs` 只吃 `.diff` 文件，若要直接消费 AACR JSONL，需要一个小转换器
（从每个样本提取 diff 后逐条建账）。

