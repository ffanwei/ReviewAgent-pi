# test12 基准对比：exp-tools + `review.search_code` vs 既有版本与 OCR

> 运行日期：2026-11-17  
> 代码：`exp-tools` @ `31b3c8b`（八工具面，新增 `review.search_code`，ADR-0099）  
> 模型：`deepseek-v4.1-flash`；judge：`deepseek-v4-pro`（1 轮，39 次语义匹配请求）  
> 配置：`~/.PiAgent/benchmark-aacr-v2.jsonc`（仅关闭 `limits.findingScope`，与 `previous_review_pi` 基线同口径）  
> 数据集：`aacr_bench_v2_test12.jsonl`，12 条（10 小 diff + 2 大 diff）/ 66 条 GT  
> 产物：`D:\Project\bench\aacr-bench\evaluation\results\aacr_bench_v2_test12\reviewpi\exp-tools-searchcode-20261117\`

## 1. 结论

1. **当前 exp-tools（含 `search_code`）在 12 条上是 review-pi 各版本中最好的聚合结果**：P 13.6% / R 28.8% / B 18.5%。相对旧 baseline（11.6% / 31.8% / 17.0%）precision +2.0pp、balanced +1.5pp，recall −3.0pp；相对 exp-group `current`（8.0% / 22.7% / 11.8%）三项都更高。
2. **但仍与 OCR 有明显差距**：OCR 为 51.0% / 48.5% / 49.7%，precision 是当前的 3.75 倍，recall 是 1.68 倍。
3. **主要短板仍是“报到没有 GT 的文件”**：当前 118 条意见里 79 条（66.9%）落在无 GT 文件；OCR 只有 2/49（4.1%）。在“有 GT 的文件内”，当前 precision 为 41.0%，OCR 为 53.2%——差距远小于总 precision 的差距。
4. **`search_code` 被模型高强度使用**：11 条实际检视样本中 10 条调用，共 **179 次**，占全部工具调用的 34.8%（仅次于 `get_file` 的 239 次）；大样本 `ragflow@7051234` 一片内累计 87 次。工具可用性不是瓶颈，瓶颈在“报什么、报在哪”。
5. **大 diff 样本决定成败**：`ragflow@7051234` 单条生成 67 条意见（占全部的 57%），只覆盖 1/6 GT，B 仅 0.027；`FreeCAD@39c5968` 0/5；`FreeCAD@699b45c` 因 diff 超体积门直接跳过（13 条 GT 无法覆盖）。

## 2. 运行口径与完成情况

| 项 | 值 |
|---|---|
| 样本 | 12 |
| 成功检视 | 11 |
| 跳过 | 1（`FreeCAD__FreeCAD@699b45c`，`diff-too-large`，2.3s） |
| 实际生成意见 | 118 |
| 覆盖 GT | 19 / 66（`hit_new_gt` 16） |
| 总耗时（样本累计） | 2698.7s（平均 224.9s） |
| 总 token | 12,212,707（输入 11,843,874 / 输出 368,833） |
| 分片 | `ragflow@7051234` 切 5 片（`split.maxShardChars=120000`），1263.3s |

> 本次 `run_smoke.py` 退出码为 1，但**评审与 eval 均已完成并落盘**；退出码来自其汇总打印假定基线文件含 `baseline` 键，而 `test12-baseline.json` 用的是 `previous_review_pi` / `ocr` 结构。指标文件未受影响。

## 3. 聚合对比

| 来源 | 配置要点 | Precision | Recall | Balanced | 生成 | 覆盖 GT | 总 token | 累计耗时 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| OCR v1.13.10 | 同模型 `deepseek-v4.1-flash` | **0.510** | **0.485** | **0.497** | 49 | 32/66 | 10.13M | 2691.9s |
| 旧 review-pi baseline | `findingScope=false` | 0.116 | 0.318 | 0.170 | 173 | 21/66 | 18.34M | 4240.9s |
| exp-group `current` | `findingScope=true` + 分组 + 规则目录 | 0.080 | 0.227 | 0.118 | 175 | 15/66 | 19.03M | 2477.3s |
| **exp-tools + `search_code`（本次）** | `findingScope=false`，八工具 | **0.136** | 0.288 | **0.185** | **118** | 19/66 | **12.21M** | 2698.7s |

说明：`current` 用的是产品默认 `findingScope=true`（只保留 diff 内意见），与其余三行（`false`）不是同一口径，不能当作纯粹的版本消融；它同时带有 exp-group 的分组（ADR-0094）与规则目录（ADR-0095），而 exp-tools 没有这两个功能。

### 3.1 precision 拆解

| 来源 | 生成 | 落在无 GT 文件 | 占比 | 落在有 GT 文件 | 文件内 precision |
|---|---:|---:|---:|---:|---:|
| OCR | 49 | 2 | 4.1% | 47 | 53.2% |
| 旧 baseline | 173 | 134 | 77.5% | 39 | 51.3% |
| `current` | 175 | 142 | 81.1% | 33 | 42.4% |
| **本次** | 118 | 79 | **66.9%** | 39 | 41.0% |

本次相对旧 baseline 的 precision 提升，主要来自**总意见数减少 32%、无 GT 文件意见占比下降 10.6pp**；文件内 precision 反而略降（51.3% → 41.0%）。

## 4. 逐样本对比（P / R / B）

| 样本 | GT | OCR | 旧 baseline | `current` | 本次 | 本次生成/覆盖 | ΔB（旧→本次） |
|---|---:|---|---|---|---|---|---:|
| `ragflow@7051234`（大） | 6 | 0.43/0.50/0.46 | 0.02/0.17/0.03 | 0.01/0.17/0.02 | 0.02/0.17/0.03 | 67/1 | −0.0pp |
| `linera@3535ddb` | 5 | 0.50/0.40/0.44 | 0.75/0.60/0.67 | 0.33/0.40/0.36 | 0.33/0.40/0.36 | 3/2 | −30.3pp |
| `aspnetcore@0ce67cd` | 5 | 0.50/0.20/0.29 | 1.00/0.40/0.57 | 0.33/0.20/0.25 | 0.50/0.40/0.44 | 4/2 | −12.7pp |
| `gofr@dc0b3e6` | 3 | 0.60/1.00/0.75 | 0.33/1.00/0.50 | 0.23/1.00/0.38 | 0.33/0.67/0.44 | 6/2 | −5.6pp |
| `spring-ai-alibaba@3555a95` | 2 | 0.67/1.00/0.80 | 0.25/1.00/0.40 | 0.00/0.00/0.00 | 0.20/0.50/0.29 | 5/1 | −11.4pp |
| `valkey@36f37c0` | 2 | 1.00/0.50/0.67 | 0.33/0.50/0.40 | 0.00/0.00/0.00 | 0.20/0.50/0.29 | 5/1 | −11.4pp |
| `ragflow@a63caa1` | 6 | 0.67/0.33/0.44 | 0.00/0.00/0.00 | 0.75/0.50/0.60 | 0.33/0.33/0.33 | 6/2 | **+33.3pp** |
| `FreeCAD@39c5968` | 5 | 0.00/0.00/0.00 | 0.25/0.20/0.22 | 0.20/0.20/0.20 | 0.00/0.00/0.00 | 5/0 | −22.2pp |
| `three.js@b55b9e9` | 8 | 0.63/0.63/0.63 | 0.44/0.50/0.47 | 0.00/0.00/0.00 | 0.57/0.63/0.60 | 7/5 | **+12.6pp** |
| `cline@2195a68` | 7 | 0.40/0.29/0.33 | 0.33/0.43/0.38 | 0.10/0.14/0.12 | 0.17/0.14/0.15 | 6/1 | −22.1pp |
| `FreeCAD@699b45c`（大） | 13 | 0.50/0.69/0.58 | 0.00/0.00/0.00 | 0.00/0.00/0.00 | 0.00/0.00/0.00 | 0/0（跳过） | 0.0pp |
| `filament@77874d0` | 4 | 0.67/0.50/0.57 | 0.25/0.25/0.25 | 0.50/0.75/0.60 | 0.25/0.50/0.33 | 4/2 | **+8.3pp** |

逐样本看，本次在 3 条上优于旧 baseline、7 条更差、2 条持平；聚合 B 的小幅提升主要来自大样本意见数减少带来的 precision 改善，而不是逐样本稳定提升。

## 5. `search_code` 使用情况

| 工具 | 调用次数 | 占比 |
|---|---:|---:|
| `review.get_file` | 239 | 46.5% |
| **`review.search_code`** | **179** | **34.8%** |
| `review.find_references` | 37 | 7.2% |
| `review.get_symbol` | 27 | 5.3% |
| `review.search_rule`（占位） | 16 | 3.1% |
| `review.search_history`（占位） | 12 | 2.3% |
| `review.get_diff` | 4 | 0.8% |
| 合计 | 514 | 100% |

逐样本 `search_code` 次数：`alibaba` 11、`cline` 11、`aspnetcore` 10、`filament` 11、`FreeCAD@39c5968` 9、`gofr` 10、`ragflow@7051234` 87（5 片合计）、`ragflow@a63caa1` 5、`linera` 7、`three.js` 7、`valkey` 11；`FreeCAD@699b45c` 跳过未调用。11 条实际检视样本中 10 条使用。

## 6. 已有子集迭代版本（不可与全 12 条直接排名）

| 版本 | 覆盖样本 | B | 说明 |
|---|---:|---:|---|
| `current-large2` | 2 | 0.026 | 两个大 diff 专项 |
| `current-min3` | 3 | 0.500 | 小样本专项 |
| `current-rerun7` | 7 | 0.337 | 7 条重跑 |
| `current-retry3` | 3 | 0.385 | JSON 重试相关 3 条 |
| `current-opt-ragflow` | 1 | 0.055 | ragflow 优化迭代 |
| `current-opt2/opt3-ragflow` | 1 | 0.112 | 同上，后续两轮 |

这些结果覆盖的样本和 GT 各不相同，只能用于诊断，不能与 12 条聚合值并列排名。

## 7. 口径限制

1. **小样本、单轮**：12 条 / 66 GT，且 test12 是 gap/outcome 定向挑出的开发集，不是无偏基准；judge 只跑 1 轮，B 的噪声不可忽略。
2. **`FreeCAD@699b45c` 系统性跳过**：13/66 GT（19.7%）无法覆盖，所有 review-pi 版本的 recall 上限都是 53/66 = 80.3%；OCR 没有该体积门。
3. **与 `current` 不是同一口径**：`current` 用 `findingScope=true` + 分组 + 规则目录；本次用 `findingScope=false`，且 exp-tools 没有 ADR-0094/0095。`current` 的低分不能全部归因于“版本更差”，本次的提升也不能全部归因于 `search_code`。
4. **`search_code` 的净效果未隔离**：exp-tools 同时包含 ADR-0097/0098 等改动。要做因果结论，需要把 `search_code` 移植到 exp-group 后用同一配置跑。
5. **OCR 侧**：逐样本判定标志取自 11-16 的全量 OCR judge 结果，judge 模型相同但并非与本次同一次运行。

## 8. 建议

1. **若目标是排名**：先补 exp-group + `search_code` 的对照跑，再做多轮 judge / 多次评审取均值；当前结论只适合作为方向性判断。
2. **若目标是提升 precision**：优先处理“无 GT 文件意见”（本次 66.9%）——把检视/上报范围收窄到 diff 触及文件、给每文件设意见预算，收益会比继续加检索工具更直接。
3. **大 diff 单独治理**：`ragflow@7051234` 一条贡献了 57% 的意见和 0.027 的 B；需要分组/分片后的“片级意见预算”，而不是让单片自由产出 67 条。
4. **保留 `search_code`**：使用率高且总意见数下降 32%，方向正确；下一步观察它与“文件范围门”叠加后的效果。

## 9. 产物

- 运行结果与逐样本 JSON：`D:\Project\bench\aacr-bench\evaluation\results\aacr_bench_v2_test12\reviewpi\exp-tools-searchcode-20261117\`
- 指标：同目录 `metrics_claude_20261117_183223.json`
- 审计 / 转录：同目录 `.reviewpi/tasks/<instance_id>/audit/`（大样本在 `audit/shards/`）
- 复现命令：

```bash
cd D:/Project/bench/aacr-bench/evaluation
python run_smoke.py \
  --dataset data/aacr_bench_v2_test12.jsonl \
  --baseline metrics/test12-baseline.json \
  --run-id <run-id> \
  --config C:/Users/Li/.PiAgent/benchmark-aacr-v2.jsonc \
  --concurrency 4 --timeout-minutes 45 --eval-rounds 1
```
