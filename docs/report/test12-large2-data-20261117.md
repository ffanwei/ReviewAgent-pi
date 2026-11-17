# test12 大 diff 2 条：exp-tools + `search_code` 对比数据

> 范围：`test12-baseline.json` 的 `selected.large`，共 19 条 GT：
> - `infiniflow__ragflow@7051234`（6 GT，检视成功，切 5 片）
> - `FreeCAD__FreeCAD@699b45c`（13 GT，本次因 `diff-too-large` 跳过）  
> 小 diff 10 条见 [`test12-small10-data-20261117.md`](test12-small10-data-20261117.md)；12 条全量见
> [`test12-exp-tools-search-code-20261117.md`](test12-exp-tools-search-code-20261117.md)。  
> 运行：`exp-tools` @ `31b3c8b`，`deepseek-v4.1-flash`，`benchmark-aacr-v2.jsonc`（仅关 `findingScope`），
> judge `deepseek-v4-pro` 1 轮。

## 1. 完成状态

| 来源 | ragflow@7051234 | FreeCAD@699b45c |
|---|---|---|
| OCR | ok，128.1s | ok，114.3s |
| 旧 baseline | ok，1011.1s | ok，1699.5s（58 条意见，0 覆盖） |
| `current` | ok，1008.1s | **skipped**（`diff-too-large`，2.0s） |
| 本次 | ok，1263.3s，5 片 | **skipped**（`diff-too-large`，2.3s） |

`FreeCAD@699b45c` 在旧 baseline 里是被检视过的（当时体积门口径不同），在 `current` 和本次都被 `maxDiffChars=1,000,000` 直接挡掉，13 条 GT 全部无法覆盖——这是大 diff 口径下最大的结构性差异。

## 2. 聚合结果（2 条 / 19 GT）

| 来源 | Precision | Recall | Balanced | 生成 | 覆盖 GT | 总 token | 累计耗时 |
|---|---:|---:|---:|---:|---:|---:|---:|
| OCR v1.13.10 | **0.462** | **0.632** | **0.533** | **13** | **12/19** | **1.04M** | **242s** |
| 旧 baseline | 0.008 | 0.053 | 0.014 | 124 | 1/19 | 15.90M | 2711s |
| `current` | 0.008 | 0.053 | 0.013 | 130 | 1/19 | 14.44M | 1010s |
| **本次** | 0.015 | 0.053 | 0.023 | 67 | 1/19 | 8.70M | 1266s |

本次相对旧 baseline：生成意见从 124 降到 67（−46%），precision 从 0.008 升到 0.015，但 recall 不变（1/19）；与 OCR 的 balanced 差距为 **51.0pp**，比小 diff 上的 13.8pp 大得多。

## 3. 逐样本数据

| 样本 | GT | 来源 | P | R | B | 生成 | 覆盖 GT | 无 GT 文件意见 |
|---|---:|---|---:|---:|---:|---:|---:|---:|
| `ragflow@7051234` | 6 | OCR | 0.429 | 0.500 | 0.462 | 7 | 3 | 0 |
| `ragflow@7051234` | 6 | 旧 baseline | 0.015 | 0.167 | 0.028 | 66 | 1 | 65 |
| `ragflow@7051234` | 6 | `current` | 0.008 | 0.167 | 0.015 | 130 | 1 | 128 |
| `ragflow@7051234` | 6 | **本次** | 0.015 | 0.167 | 0.027 | 67 | 1 | 66 |
| `FreeCAD@699b45c` | 13 | OCR | 0.500 | 0.692 | 0.581 | 6 | 9 | 2 |
| `FreeCAD@699b45c` | 13 | 旧 baseline | 0.000 | 0.000 | 0.000 | 58 | 0 | 57 |
| `FreeCAD@699b45c` | 13 | `current` | 0.000 | 0.000 | 0.000 | 0（跳过） | 0 | 0 |
| `FreeCAD@699b45c` | 13 | **本次** | 0.000 | 0.000 | 0.000 | 0（跳过） | 0 | 0 |

两个样本的问题不同：

- **`ragflow@7051234`**：本次把意见从 130 压到 67，precision 翻倍，但 66/67（98.5%）仍落在无 GT 文件；有 GT 的文件上只报了 1 条，且命中。问题不是“文件内判不准”，而是**根本没往有 GT 的文件上报**。
- **`FreeCAD@699b45c`**：本次直接跳过，0 覆盖；OCR 用 114s 覆盖 9/13 GT。

## 4. ragflow@7051234 分片明细（本次）

| 分片 | 文件数 | 字符数 | 工具调用 | 生成意见 |
|---|---:|---:|---:|---:|
| s01 | 35 | 117,476 | 56 | 10 |
| s02 | 39 | 102,634 | 52 | 15 |
| s03 | 22 | 118,740 | 56 | 14 |
| s04 | 51 | 119,798 | 56 | 15 |
| s05 | 40 | 80,488 | 35 | 13 |
| 合计 | 187 | 539,136 | 255 | 67 |

5 片全部 `complete`、单轮；总耗时 1263.3s。每个分片审计带 `out-of-validated-domain (boundary-unmeasurable: diff is not a countable unified diff)` 警告，但检视正常完成。

## 5. `search_code` 使用（ragflow 5 片合计）

| 工具 | 调用次数 | 占比 |
|---|---:|---:|
| `review.get_file` | 139 | 54.5% |
| **`review.search_code`** | **87** | **34.1%** |
| `review.find_references` | 23 | 9.0% |
| `review.get_symbol` | 6 | 2.4% |
| 合计 | 255 | 100% |

逐片 `search_code`：s01 20、s02 22、s03 21、s04 16、s05 8。`FreeCAD@699b45c` 跳过，无调用。

## 6. token 与成本效率

| 来源 | 成本 | 覆盖 GT | 每条覆盖 GT 的成本 |
|---|---:|---:|---:|
| OCR | 1.04M token / 242s | 12 | 约 87K token / 20s |
| 旧 baseline | 15.90M token / 2711s | 1 | 约 15.9M token / 45min |
| `current` | 14.44M token / 1010s | 1 | 约 14.4M token / 17min |
| **本次** | 8.70M token / 1266s | 1 | 约 8.7M token / 21min |

本次比旧 baseline 省 45% token、比 `current` 省 40% token，但仍用 8.7M token 只换来 1 条 GT 覆盖；OCR 用 1.04M 覆盖 12 条。

## 7. 结论

1. **大 diff 是当前方案与 OCR 差距的主要来源**：2 条样本上 OCR B 0.533，本次 0.023；小 diff 上差距是 13.8pp，大 diff 上是 51.0pp。
2. **意见收缩方向有效但不够**：`ragflow` 意见 130 → 67，precision 翻倍；但 98.5% 仍报在无 GT 文件，覆盖没有增加。
3. **`FreeCAD@699b45c` 的跳过是结构性损失**：13 条 GT（占大 diff GT 的 68%）被体积门整体放弃；OCR 能覆盖 9 条。若基准 recall 重要，需要先分组/预过滤再判体积门，而不是整条 MR 跳过。
4. **成本效率仍然很差**：本次每条覆盖 GT 约 8.7M token，是 OCR 的约 100 倍。

## 8. 口径限制

1. 只有 2 条大 diff，结论方向性大于统计意义。
2. 旧 baseline 检视过 `FreeCAD@699b45c`，`current` / 本次跳过，聚合值不是严格同口径。
3. `current` 使用 `findingScope=true` + 分组 + 规则目录，与本次 `findingScope=false`、无分组/规则不同。
4. judge 单轮；OCR 判定标志复用 11-16 全量 OCR judge 结果。

## 9. 数据文件

- 逐样本机器可读数据：[`test12-large2-metrics-20261117.csv`](test12-large2-metrics-20261117.csv)
  - 8 行 = 2 样本 × 4 来源
  - 列：`instance_id, source, status, precision, recall, balanced, generated, covered_gt, expected_gt, generated_on_non_gt_file, tokens, duration_seconds`
- 原始产物：`D:\Project\bench\aacr-bench\evaluation\results\aacr_bench_v2_test12\reviewpi\exp-tools-searchcode-20261117\`
- 分片审计：同目录 `.reviewpi/tasks/infiniflow__ragflow@7051234/audit/shards/`
