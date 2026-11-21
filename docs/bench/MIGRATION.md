# docs/bench 迁移说明

## 来源

- 分支：`exp-group`（`origin/exp-group`）
- 提交：`c72fbc8 exp(review): 分组/规则/JSON 恢复实验与 AACR benchmark 数据`
- 迁移日期：2026-11-21

## 已迁移

| 目录 | 文件数 | 说明 |
|---|---:|---|
| `README.md` | 1 | AACR-Bench v2 评测归档总说明 |
| `scripts/` | 14 | 桥接、运行、后处理、报告、离线调参、子集生成 |
| `data/` | 9 | 151 条标准样本、run / eval_ok / smoke10 / iter20、排除分析、原始数据 |
| `configs/` | 10 | iterS / iterB / iterM / iterF 配置集 |
| `metrics/` | 27 | 全量 baseline、smoke10 / iter20 / 各 config 基线、过滤扫描 |
| `comparison/` | 2 | OCR vs review-pi 对比材料 |

## 未迁移

| 目录 | 原因 |
|---|---|
| `artifacts/` | 217 个历史 review-pi 产物，约 5.2 MB；不是运行所需 |
| `ocr/` | 121 个 OCR 结果/指标，约 7.6 MB；历史对照材料 |
| `results/` | 历史运行结果；按 ADR-0033 运行留痕不入库 |
| `MANIFEST.json` | 归档索引，指向未迁移的 artifacts / ocr / results |

## 运行时依赖（重要）

本目录是**归档副本**，不是自包含评测环境。真实执行目录是：

```text
D:/Project/bench/aacr-bench/evaluation
```

该目录包含本仓未迁移的评测框架模块与数据：

- `repo_utils.py` / `schema.py` / `pipeline` / `converters`
- `.venv`、`benchmark/` 原始数据、`results/` 输出
- `aacr_reviewpi_bridge.py` 会 `sys.path.insert(EVAL_DIR)` 后 import `repo_utils` / `schema`；在 `docs/bench/scripts` 直接运行会缺模块。
- `run_smoke.py` / `run_config.py` 的 `EVAL` / 数据路径按 evaluation 根目录布局计算；本仓路径不满足。

## 推荐用法

### 只读参考 / 取脚本

```bash
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

