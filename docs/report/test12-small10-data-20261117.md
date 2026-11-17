# test12 小 diff 10 条：exp-tools + `search_code` 对比数据

> 数据来源：`aacr_bench_v2_test12.jsonl` 的 10 条小 diff（`test12-baseline.json` 的 `selected.small`），47 条 GT。  
> 大 diff 两条（`ragflow@7051234`、`FreeCAD@699b45c`）已排除，12 条全量口径见
> [`test12-exp-tools-search-code-20261117.md`](test12-exp-tools-search-code-20261117.md)。  
> 本次运行：`exp-tools` @ `31b3c8b`，`deepseek-v4.1-flash`，`benchmark-aacr-v2.jsonc`（仅关 `findingScope`），
> judge `deepseek-v4-pro` 1 轮。

## 1. 聚合结果

| 来源 | Precision | Recall | Balanced | 生成 | 覆盖 GT | 总 token | 累计耗时 |
|---|---:|---:|---:|---:|---:|---:|---:|
| OCR v1.13.10 | **0.528** | **0.426** | **0.471** | **36** | 20/47 | 9.09M | 2449s |
| 旧 review-pi baseline | 0.388 | 0.426 | 0.406 | 49 | 20/47 | **2.45M** | 1530s |
| exp-group `current` | 0.289 | 0.298 | 0.293 | 45 | 14/47 | 4.59M | 1467s |
| **exp-tools + `search_code`** | 0.294 | 0.383 | 0.333 | 51 | 18/47 | 3.51M | 1433s |

排名：**OCR（0.471）> 旧 baseline（0.406）> 本次（0.333）> `current`（0.293）**。

本次相对旧 baseline：precision **−9.4pp**、recall **−4.3pp**、balanced **−7.3pp**；生成意见 +2 条、覆盖 GT −2 条、token +43%。  
即：**在小 diff 上，当前方案没有超过旧 baseline**；12 条聚合的 B 提升（0.170 → 0.185）来自大 diff 上意见数大幅减少，而不是小 diff 质量提升。

`current` 使用 `findingScope=true` + 分组 + 规则目录，与另外三行（`findingScope=false`）不是同一口径，仅供参照。

## 2. precision 拆解

| 来源 | 生成 | 落在无 GT 文件 | 占比 | 落在有 GT 文件 | 文件内 precision |
|---|---:|---:|---:|---:|---:|
| OCR | 36 | 0 | 0.0% | 36 | 52.8% |
| 旧 baseline | 49 | 12 | 24.5% | 37 | 51.4% |
| `current` | 45 | 14 | 31.1% | 31 | 41.9% |
| **本次** | 51 | 13 | 25.5% | 38 | **39.5%** |

本次相对旧 baseline，无 GT 文件意见占比略升（24.5% → 25.5%），文件内 precision 下降 11.9pp（51.4% → 39.5%）。**小 diff 上的问题不是“找不到文件”，而是“在有 GT 的文件里报得不准”**。

## 3. 逐样本数据

| 样本 | GT | OCR P/R/B | 旧 baseline P/R/B | `current` P/R/B | 本次 P/R/B | 本次生成/覆盖 | ΔB（旧→本次） |
|---|---:|---|---|---|---|---|---:|
| `valkey@36f37c0` | 2 | 1.000/0.500/0.667 | 0.333/0.500/0.400 | 0.000/0.000/0.000 | 0.200/0.500/0.286 | 5/1 | −11.4pp |
| `aspnetcore@0ce67cd` | 5 | 0.500/0.200/0.286 | 1.000/0.400/0.571 | 0.333/0.200/0.250 | 0.500/0.400/0.444 | 4/2 | −12.7pp |
| `FreeCAD@39c5968` | 5 | 0.000/0.000/0.000 | 0.250/0.200/0.222 | 0.200/0.200/0.200 | 0.000/0.000/0.000 | 5/0 | −22.2pp |
| `gofr@dc0b3e6` | 3 | 0.600/1.000/0.750 | 0.333/1.000/0.500 | 0.231/1.000/0.375 | 0.333/0.667/0.444 | 6/2 | −5.6pp |
| `spring-ai-alibaba@3555a95` | 2 | 0.667/1.000/0.800 | 0.250/1.000/0.400 | 0.000/0.000/0.000 | 0.200/0.500/0.286 | 5/1 | −11.4pp |
| `three.js@b55b9e9` | 8 | 0.625/0.625/0.625 | 0.444/0.500/0.471 | 0.000/0.000/0.000 | 0.571/0.625/0.597 | 7/5 | **+12.6pp** |
| `filament@77874d0` | 4 | 0.667/0.500/0.571 | 0.250/0.250/0.250 | 0.500/0.750/0.600 | 0.250/0.500/0.333 | 4/2 | **+8.3pp** |
| `ragflow@a63caa1` | 6 | 0.667/0.333/0.444 | 0.000/0.000/0.000 | 0.750/0.500/0.600 | 0.333/0.333/0.333 | 6/2 | **+33.3pp** |
| `linera@3535ddb` | 5 | 0.500/0.400/0.444 | 0.750/0.600/0.667 | 0.333/0.400/0.364 | 0.333/0.400/0.364 | 3/2 | −30.3pp |
| `cline@2195a68` | 7 | 0.400/0.286/0.333 | 0.333/0.429/0.375 | 0.100/0.143/0.118 | 0.167/0.143/0.154 | 6/1 | −22.1pp |

本次优于旧 baseline 3 条（`three.js`、`filament`、`ragflow@a63caa1`），差于旧 baseline 7 条。`linera`、`cline`、`FreeCAD@39c5968` 的下降幅度最大。

## 4. 逐样本 token / 耗时

| 来源 | 输入 token（非缓存） | cache read | 输出 token | 总 token | 累计耗时 |
|---|---:|---:|---:|---:|---:|
| OCR | 8,770,408 | 4,797,440 | 323,517 | 9,093,925 | 2449s |
| 旧 baseline | 333,346 | 1,959,296 | 153,908 | 2,446,550 | 1530s |
| `current` | 490,071 | 3,864,192 | 235,854 | 4,590,117 | 1467s |
| **本次** | 257,251 | 3,069,696 | 182,932 | 3,509,879 | 1433s |

本次总 token 比旧 baseline 多 43%，耗时反而少 97s；比 OCR 少 61% token、少 41% 时间，但 balanced 低 13.8pp。

## 5. `search_code` 使用（10 条小 diff）

| 工具 | 调用次数 | 占比 |
|---|---:|---:|
| `review.get_file` | 100 | 38.6% |
| **`review.search_code`** | **92** | **35.5%** |
| `review.search_rule`（占位） | 16 | 6.2% |
| `review.get_symbol` | 21 | 8.1% |
| `review.find_references` | 14 | 5.4% |
| `review.search_history`（占位） | 12 | 4.6% |
| `review.get_diff` | 4 | 1.5% |
| 合计 | 259 | 100% |

逐样本调用：`valkey` 11、`aspnetcore` 10、`FreeCAD@39c5968` 9、`gofr` 10、`spring-ai` 11、`three.js` 7、`filament` 11、`ragflow@a63caa1` 5、`linera` 7、`cline` 11。10 条全部使用。

## 6. 口径限制

1. 单次运行、judge 单轮；10 条 / 47 GT，样本量下结论需谨慎。
2. `current` 的 `findingScope=true` + 分组 + 规则目录与本次不同，不能作为纯版本消融。
3. exp-tools 不含 ADR-0094/0095；本次与 `current` 的差异混有功能缺失。
4. OCR 判定标志复用 11-16 全量 OCR judge 结果，与本次不是同一次运行。
5. 小 diff 口径不含两条大 diff；大 diff 的结论见 12 条报告。

## 7. 数据文件

- 逐样本机器可读数据：[`test12-small10-metrics-20261117.csv`](test12-small10-metrics-20261117.csv)
  - 40 行 = 10 样本 × 4 来源
  - 列：`instance_id, source, precision, recall, balanced, generated, covered_gt, expected_gt, generated_on_non_gt_file, tokens, duration_seconds`
- 原始运行产物：`D:\Project\bench\aacr-bench\evaluation\results\aacr_bench_v2_test12\reviewpi\exp-tools-searchcode-20261117\`
