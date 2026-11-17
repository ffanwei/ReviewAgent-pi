# review-pi 置信度 / 严重级过滤扫描（复用已有 judge 结果）

> 不重新跑 review-pi、不重新 judge。把已有 108 条 ok 的 1489 条生成意见，按结果文件里的
> `confidence` / `severity` 过滤后，重放已有 `matched_gt_indices`，精确重算 P/R/B。
>
> 基线复算：generated 1489 / matched_new 108 / covered_gt 118，与 metrics summary 完全一致。

## 为什么不能只改配置

`limits.confidence.min`（默认 0.5）和 `limits.severity.min`（默认 P3）只过滤 **中文 tips / MCP 上报**，
不改变 `reviews_all.json` 真源；本次 benchmark 用的是 `reviews_all.json`。所以直接改配置重跑，
指标不会变。下面的扫描是离线模拟“只保留高置信/高严重级意见”后的评测结果。

## 扫描结果（108 条 ok / 676 GT）

| confidence.min | severity.min | generated | Precision | Recall | Balanced | 有 GT 文件内 Precision |
|---:|---|---:|---:|---:|---:|---:|
| 0.0 | P3（全部） | 1489 | 0.073 | **0.175** | **0.102** | 0.374 |
| 0.5（产品默认 tips） | P3 | 1377 | 0.073 | 0.164 | 0.101 | 0.378 |
| 0.6 | P3 | 1059 | 0.077 | 0.135 | 0.098 | 0.394 |
| 0.7 | P3 | 651 | 0.075 | 0.081 | 0.078 | 0.386 |
| 0.8 | P3 | 347 | 0.084 | 0.044 | 0.058 | 0.414 |
| 0.0 | P2 | 996 | 0.074 | 0.114 | 0.090 | 0.381 |
| 0.0 | P1 | 224 | 0.098 | 0.034 | 0.051 | 0.458 |
| 0.0 | P0 | 4 | 0.500 | 0.003 | 0.006 | 1.000 |
| 0.8 | P2 | 229 | 0.109 | 0.038 | 0.057 | 0.500 |
| 0.8 | P1 | 116 | 0.129 | 0.024 | 0.040 | 0.517 |

完整 20 组见 `metrics/filter-sweep.json`。

## 结论

1. **没有任何阈值能提高 Balanced score。** 基线 0.102 是最高的；产品默认 tips 口径（0.5 / P3）为 0.101，几乎不变。
2. **置信度过滤对 precision 帮助很小。** 0.3–0.4 的低置信意见只有 41 条（2.8%）；大多数意见本身置信度在 0.5–0.8。把阈值提到 0.8 只把 precision 从 0.073 提到 0.084，recall 从 0.175 掉到 0.044。
3. **严重级过滤是更差的旋钮。** 意见以 P2（772）和 P3（493）为主；只保留 P1 时 recall 直接掉到 0.034，precision 仅 0.098。P0 只有 4 条，毫无统计意义。
4. **precision 低的主因不是低置信意见，而是标注覆盖。** 1489 条里 1200 条（80.6%）落在没有 GT 的文件上；这些意见即使高置信，也不会有 GT 可命中。过滤置信度/严重级改变不了这个结构。
5. 如果目标是**用户可见 tips 的噪声**，可以把 confidence.min 调到 0.7–0.8，但要接受 recall 大幅下降；如果目标是 **benchmark 的 balanced score**，保持默认值即可。

## 复现

```bash
cd D:/Project/bench/aacr-bench/evaluation
PYTHONIOENCODING=utf-8 ./.venv/Scripts/python.exe sweep_filters.py \
  --metrics results/aacr_bench_v2/reviewpi/arm2/metrics_claude_20261116_102219.json \
  --results-dir results/aacr_bench_v2/reviewpi/arm2 \
  --out .pilot-logs/filter-sweep.json
```
