# 测试配置（小 / 大 / 混合 / 全量）

定义：

- **小 diff**：`git diff` 文件 < 50KB
- **大 diff**：`git diff` 文件 >= 50KB
- 小池按语言轮转（字母序），语言内正/负样本交替，再按耗时 + 0.2×改动行数排序；
- 大池按语言轮转（语言按该语言最大 B 差距降序），语言内按 B 差距 / 无 GT 意见降序。

| 配置 | 组成 | 样本 | 小 | 大 | GT | review-pi B | RP 误报率 | OCR B | OCR 误报率 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| iterS10 | 小池前 10 | 10 | 10 | 0 | 40 | 0.3715 | 69.5% | 0.279 | 75.6% |
| iterS20 | 小池前 20 | 20 | 20 | 0 | 73 | 0.2856 | 75.5% | 0.2533 | 78.2% |
| iterS41 | 小池前 41 | 41 | 41 | 0 | 186 | 0.3066 | 72.7% | 0.3446 | 68.6% |
| iterS41-rest21 | 小池第 21–41 条 | 21 | 21 | 0 | 113 | 0.3216 | 70.5% | 0.4069 | 61.7% |
| iterB2 | 大池前 2 | 2 | 0 | 2 | 15 | 0.1081 | 93.8% | 0.7417 | 38.5% |
| iterB5 | 大池前 5 | 5 | 0 | 5 | 43 | 0.0156 | 99.2% | 0.6772 | 32.0% |
| iterB10 | 大池前 10 | 10 | 0 | 10 | 95 | 0.0276 | 98.4% | 0.5083 | 55.3% |
| iterM10 | 8 小 + 2 大 | 10 | 8 | 2 | 43 | 0.2896 | 78.5% | 0.3955 | 68.6% |
| iterM20 | 15 小 + 5 大 | 20 | 15 | 5 | 103 | 0.163 | 88.7% | 0.3784 | 67.7% |
| iterM50 | 40 小 + 10 大 | 50 | 40 | 10 | 263 | 0.1792 | 86.5% | 0.4028 | 64.2% |
| iterF91 | 91 条交集全量 | 91 | 41 | 50 | 588 | 0.109 | 92.2% | 0.3386 | 68.7% |

> 基线来自已有 review-pi 结果 + 已有 judge 匹配，**没有重跑模型**。误报按 benchmark 文件级口径，
> 明细（non-GT / 未匹配 / 重复）见 [`../metrics/configs/false-positives.md`](../metrics/configs/false-positives.md)，
> 机器可读误报率表见 [`../metrics/configs/false-positive-rates.md`](../metrics/configs/false-positive-rates.md) / `.csv`。
> 小配置是 outcome-stratified，可能偏向 review-pi；大配置是 gap-targeted；91 全量仍是排名依据。

## 用法

```bash
cd D:/Project/bench/aacr-bench/evaluation
python run_config.py --list
python run_config.py --config iterS10 --run-id after-change
python run_config.py --config iterB5 --run-id after-change --review-config C:/Users/Li/.PiAgent/benchmark-aacr-v2.jsonc
python run_config.py --config iterM20 --run-id after-change --skip-review
```

- 数据集：`bench/aacr-bench-v2/configs/<config>.jsonl`
- 基线：`bench/aacr-bench-v2/metrics/configs/<config>-baseline.json`
- 结果目录：`results/<config>/reviewpi/<run_id>/`
- 只改输出侧时不需要重跑 review-pi：用 `offline_tune.py` 复用已有检视+judge，零模型调用。
