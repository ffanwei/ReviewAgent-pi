# test12 小 diff 10 条：收窄检视范围 + 同根因去重（exp-tools）

> 数据来源：`aacr_bench_v2_test12.jsonl` 的 10 条小 diff（`test12-baseline.json` 的 `selected.small`），47 条 GT。
> 本次运行：`exp-tools-wt` @ `1011e22`（将在 `exp-tools` 合入），`deepseek-v4.1-flash`，
> 配置 `benchmark-exp-tools-pr.jsonc`（`findingScope.contextLines=0`、`testFiles.skip=true`、测试/文档/锁文件/生成物/配置整块剔除），
> judge `deepseek-v4-pro` 1 轮。
> 桥接层已在外部脚本 `aacr_reviewpi_bridge.py` 修正为 merge-base diff（PR 语义）。

## 1. 结论

| 指标 | 上一轮 exp-tools | 本次 | 变化 |
|---|---:|---:|---:|
| Precision | 0.294 | **0.591** | **+29.7pp** |
| Recall | 0.383 | 0.298 | −8.5pp |
| Balanced | 0.333 | **0.396** | **+6.3pp** |
| 生成意见 | 51 | **22** | −29 |
| 覆盖 GT | 18/47 | 14/47 | −4 |
| 命中 GT | 15 | 13 | −2 |

- **precision 大幅提升，recall 下降**，B 比上一轮高 6.3pp。
- 22 条意见**全部落在有 GT 的文件里**；上一轮有 13 条（25.5%）落在无 GT 文件。
- 5 条丢失 GT 中：**3 条模型完全没生成，2 条（`filament`）被同根因去重误杀**。
  反事实判分显示，被拦的 F003 可直接命中这 2 条 GT；若不拦，预计 P 0.609 / R 0.340 / **B 0.437**。
- 与既有对照：仍低于 OCR（B 0.471）1.5pp 的差距来自 recall；比旧 review-pi baseline（B 0.406）低 1.0pp，已在噪声范围内。
- 方向正确：先解决“报得准”，recall 是下一步要补的；但去重规则需要先收紧。

## 2. 聚合对比（10 条小 diff，47 GT）

| 来源 | Precision | Recall | Balanced | 生成 | 覆盖 GT | 总 token | 累计耗时 |
|---|---:|---:|---:|---:|---:|---:|---:|
| OCR v1.13.10 | **0.528** | **0.426** | **0.471** | 36 | 20/47 | 9.09M | 2449s |
| 旧 review-pi baseline | 0.388 | **0.426** | 0.406 | 49 | 20/47 | **2.45M** | 1530s |
| 上一轮 exp-tools + `search_code` | 0.294 | 0.383 | 0.333 | 51 | 18/47 | 3.51M | 1433s |
| **本次（收窄 + 去重）** | **0.591** | 0.298 | 0.396 | **22** | 14/47 | 3.44M | **1399s** |

排名：**OCR（0.471）> 旧 baseline（0.406）> 本次（0.396）> 上一轮（0.333）**。

本次总 token 与上一轮基本持平（−1.8%），耗时少 34s；用少 57% 的意见换来了 precision +29.7pp。

## 3. Precision 拆解

| 来源 | 生成 | 落在无 GT 文件 | 占比 | 落在有 GT 文件 | 文件内 precision |
|---|---:|---:|---:|---:|---:|
| OCR | 36 | 0 | 0.0% | 36 | 52.8% |
| 旧 baseline | 49 | 12 | 24.5% | 37 | 51.4% |
| 上一轮 exp-tools | 51 | 13 | 25.5% | 38 | 39.5% |
| **本次** | 22 | **0** | **0.0%** | 22 | **59.1%** |

两件事同时发生：

1. merge-base 修正 + 配置文件过滤，把“不在本次 PR 变更里的文件”从输入中拿掉了；
2. 提示词 + `findingScope.contextLines=0` 把“文件对了但行不对”的意见也大幅压缩。

文件内 precision 从 39.5% 升到 59.1%，已经超过 OCR 的文件内 52.8%。

## 4. 逐样本数据

| 样本 | GT | OCR P/R/B | 旧 baseline P/R/B | 上一轮 P/R/B | **本次 P/R/B** | 本次生成/覆盖 |
|---|---:|---|---|---|---|---|
| `valkey@36f37c0` | 2 | 1.000/0.500/0.667 | 0.333/0.500/0.400 | 0.200/0.500/0.286 | **1.000/0.500/0.667** | 1/1 |
| `aspnetcore@0ce67cd` | 5 | 0.500/0.200/0.286 | 1.000/0.400/0.571 | 0.500/0.400/0.444 | 1.000/0.200/**0.333** | 1/1 |
| `FreeCAD@39c5968` | 5 | 0.000/0.000/0.000 | 0.250/0.200/0.222 | 0.000/0.000/0.000 | 0.000/0.000/**0.000** | 1/0 |
| `gofr@dc0b3e6` | 3 | 0.600/1.000/0.750 | 0.333/1.000/0.500 | 0.333/0.667/0.444 | **1.000/1.000/1.000** | 3/3 |
| `alibaba@3555a95` | 2 | 0.667/1.000/0.800 | 0.250/1.000/0.400 | 0.200/0.500/0.286 | **0.333/0.500/0.400** | 3/1 |
| `three.js@b55b9e9` | 8 | 0.625/0.625/0.625 | 0.444/0.500/0.471 | 0.571/0.625/0.597 | **0.800/0.500/0.615** | 5/4 |
| `filament@77874d0` | 4 | 0.667/0.500/0.571 | 0.250/0.250/0.250 | 0.250/0.500/0.333 | 0.000/0.000/**0.000** | 2/0 |
| `ragflow@a63caa1` | 6 | 0.667/0.333/0.444 | 0.000/0.000/0.000 | 0.333/0.333/0.333 | 0.500/0.167/**0.250** | 2/1 |
| `linera@3535ddb` | 5 | 0.500/0.400/0.444 | 0.750/0.600/0.667 | 0.333/0.400/0.364 | **0.500/0.400/0.444** | 2/2 |
| `cline@2195a68` | 7 | 0.400/0.286/0.333 | 0.333/0.429/0.375 | 0.167/0.143/0.154 | **0.500/0.143/0.222** | 2/1 |

相对上一轮：6 条 B 上升、3 条下降、1 条持平（`FreeCAD` 两轮都是 0）。
上升最明显的是 `gofr`（0.444→1.000）、`valkey`（0.286→0.667），下降的是 `filament`（0.333→0）、`ragflow`（0.333→0.250）、`aspnetcore`（0.444→0.333）。

## 5. 机制拆解

### 5.1 diff 范围与文件过滤

- merge-base 修正后，10 条样本的 diff 文件数从 **43 → 27**（−37%），字符数从 **122K → 86K**。
  `valkey` 4→1、`gofr` 8→2、`cline` 7→3、`alibaba` 5→4、`ragflow` 4→3。
- `limits.mrFilter.excludeGlobs` 实际再剔除 **5 个文件 / 6,957 字符**，只发生在 3 条样本：
  `aspnetcore` 3 个（test=1, exclude=2）、`alibaba` 1 个（exclude）、`gofr` 1 个（test）。
  其余 7 条本次 PR 不涉及测试/文档/配置类文件。
- 因此本轮的 precision 提升主要不是“配置文件过滤”，而是 **merge-base 范围修正 + 变更行锚定 + 提示词收窄**。

### 5.2 意见结构变化

| 维度 | 上一轮 | 本次 |
|---|---:|---:|
| P0 | 1 | 1 |
| P1 | 13 | 8 |
| P2 | 19 | 12 |
| P3 | 18 | **1** |
| 可测试性 | 7 | **0** |
| 可读性 | 5 | **0** |
| 可维护 | 10 | **2** |
| 可靠性 | 21 | 16 |

P3、测试缺失、可读性类意见基本消失，正是第 2/4 条要求的直接结果。

### 5.3 同根因去重

- 共产生 **8 条拦截记录**：6 条同根因（`cline` / `filament` / `gofr` / `ragflow` 各 1，`linera` 2 条为同一候选在后续轮重复触发），2 条 Phase 6 证据裁决驳回（均 `linera`）。
- 示例：`gofr` 的 F003（`url.PathEscape` 二次转义）与已产出的 F001（凭据二次转义）在 `mongo.go:152/156`，同类别 ±5 行内，被保留首条策略拦掉。
- **已确认误杀**：`filament` 的 F001（79 行，主键 tiebreaker 丢失）与 F003（79 行，`$originalOrders[0]` 可能不存在）是两个不同根因，F003 被误伤。对 F003 做反事实判分（把它的完整 description 直接送 judge），结果为命中 GT#2（153 行，`orders[0]` 未判空）和 GT#3（78 行，Collection 下标访问）两条。
  也就是说，**5 条丢失 GT 里有 2 条是本轮去重造成的，不是模型没发现**。若不拦 F003：生成 23、命中 14、覆盖 16/47 → P 0.609 / R 0.340 / B 0.437。
- 建议把去重收紧为“同文件 + 同 category + 标题/rule 高相似”或仅拦截同 rule 同位置，避免再次误杀。

### 5.4 候选拦截链

| 阶段 | 次数 |
|---|---:|
| SCHEMA_INVALID | 0 |
| NO_EVIDENCE | 0 |
| VERIFICATION_FAILED | 2 |
| OUT_OF_SCOPE | **0** |
| DUPLICATE_ID（内容键 + 同根因） | 6 |

`OUT_OF_SCOPE` 为 0，说明提示词与 `contextLines=0` 已经把模型约束在 hunk 内，范围门主要是兜底而非主要贡献。

### 5.5 工具使用

| 工具 | 上一轮 | 本次 |
|---|---:|---:|
| `review.get_file` | 100 | 80 |
| `review.search_code` | 92 | 71 |
| `review.get_symbol` | 21 | 16 |
| `review.find_references` | 14 | 13 |
| `review.search_rule` | 16 | 8 |
| `review.search_history` | 12 | 5 |
| `review.get_diff` | 4 | 4 |
| `review.get_call_chain` | 0 | 1 |
| 合计 | 259 | **198** |

`search_code` 仍是第二大工具（35.9%），但检索总量下降 24%；意见数下降没有靠“禁用检索”实现。

## 6. Recall 损失明细

本次覆盖 GT 14 条（上一轮 18 条）。净变化 −4：丢失 5 条、新增 1 条（`gofr` GT#2）。

| 样本 | 丢失 GT | 位置 | 是否在 hunk 内 | 原因 |
|---|---|---:|---|---|
| `aspnetcore@0ce67cd` | GT#3 | `SocketAddress.cs:70` | 是 | **完全没生成**：本样本只有 1 条候选（端口截断），没有 scope ID 相关候选 |
| `three.js@b55b9e9` | GT#3 | `WebGPUBackend.js:1327` | 是 | **完全没生成**：5 条候选里只有另一个文件（`WGSLNodeBuilder`）的 `workgroupSize` 长度校验，没有后端 `dispatchSize` 校验 |
| `filament@77874d0` | GT#2 | `PrepareCsvExport.php:153` | 是 | **被同根因去重拦截**：F003 与 F001 同为 79 行、同类别，被 `DUPLICATE_ID` 丢弃；反事实判分 F003 命中本 GT |
| `filament@77874d0` | GT#3 | `PrepareCsvExport.php:78` | 是 | 同上，F003 被去重拦截；反事实判分同时命中本 GT |
| `ragflow@a63caa1` | GT#3 | `extractor.py:216` | 是 | **完全没生成**：候选只在 `entity_resolution.py` 与 `utils.py`，没有 `extractor.py` 的候选 |

**结论：3 条是完全没发现，2 条（`filament`）是同根因去重误杀。** 5 条位置全部在 diff hunk 内，没有一条是 `findingScope` / `OUT_OF_SCOPE` 拦截，也没有 `SCHEMA_INVALID` / `NO_EVIDENCE` / `VERIFICATION_FAILED` 丢候选。

## 7. 剩余 9 条未命中意见

| 样本 | 位置 | 判断 |
|---|---|---|
| `linera@3535ddb` | `state.rs:1418` | 静默截断缺少 has-more 标志；邻近 GT 但描述不同 |
| `alibaba@3555a95` | `AliTranslateService.java:148` | 构造器删除属源码级 breaking change；GT 未收录 |
| `alibaba@3555a95` | `AliTranslateService.java:105` | 异常改返回 null，丢失错误码；GT 未收录 |
| `ragflow@a63caa1` | `entity_resolution.py:114` | 一条意见同时写了 `.nodes` 与闭包两个问题，judge 未按 GT#0/#1 匹配（合并根因导致漏配） |
| `FreeCAD@39c5968` | `Application.cpp:1167` | NUL 截断保护失效；GT 未收录 |
| `three.js@b55b9e9` | `WebGPUBackend.js:1329` | `dispatchSize` 形参重绑定；GT 未收录 |
| `cline@2195a68` | `extension.ts:318` | 关闭弹窗被当作同意；GT 未收录 |
| `filament@77874d0` | `PrepareCsvExport.php:79` | 主键 tiebreaker 丢失；GT 未收录（GT 另有 153/78 两条） |
| `filament@77874d0` | `PrepareCsvExport.php:154` | `distinct` 条件化；GT 未收录 |

这 9 条**全部在有 GT 的文件里，且没有一条落在无 GT 文件**。从描述看，多数是“真实但不在 GT 内”或“与 GT 描述角度不同”，不是上一轮那种跑题噪声。这也支持第 6 条：**不要加价值过滤**，否则会把这些真实问题一起砍掉；应继续在生成约束上收紧。

## 8. 口径限制

1. **单轮 judge、10 条样本**：B 的噪声不可忽略；本次结论只适合方向判断，不宜当最终排名。
2. **`contextLines=0` 比生产默认更严**：生产默认是 10，本次为了验证“严格锚定”用了 0；若上线用 10，recall 可能略高、precision 略低。
3. **同根因去重存在误伤**：`(文件, category, ±5 行)` 会吞掉同位置的另一个独立根因（已观察到 `filament` 一例）。
4. **`run_smoke.py` 退出码 1**：eval 已完成、metrics 已落盘，退出码来自其汇总打印假定基线文件含 `baseline` 键，而 `test12-baseline.json` 是 `previous_review_pi` / `ocr` 结构；指标不受影响。
5. **桥接修正不在产品仓**：merge-base diff 改的是外部评测脚本 `D:\Project\bench\aacr-bench\evaluation\aacr_reviewpi_bridge.py`，未提交到本仓。

## 9. 建议

1. **保留当前方向**：precision 已超过 OCR 的文件内水平，B 也超过上一轮；不要回退范围门。
2. **优先收紧同根因去重**：本轮 5 条 GT 损失里有 2 条由去重造成。建议改为“同文件 + 同 category + 标题或 rule 高相似（或同 rule 同位置）”，而不是仅凭 ±5 行；改完需复跑 10 条小 diff 验证，预期 B 可从 0.396 回到约 0.437。
3. **再补生成侧 recall**：另外 3 条丢失 GT 都在 hunk 内、都是模型没生成。可考虑对每个新增 hunk 做一次“逐行过一遍”的收尾提示（尤其 feature-completeness 类，如 scope ID、数组长度校验）。
4. **两条大 diff 待批准**：本次只跑了 10 条小 diff；大 diff 需要验证分组/分片下的范围锚定与去重是否仍然成立。

## 10. 产物

- 评审结果与逐样本 JSON：`D:\Project\bench\aacr-bench\evaluation\results\aacr_bench_v2_test12_small10\reviewpi\exp-tools-pr-20261117\`
- 指标：同目录 `metrics_claude_20261117_194537.json`
- 配置：`C:\Users\Li\.PiAgent\benchmark-exp-tools-pr.jsonc`
- 逐样本指标 CSV：[`test12-small10-pr-scope-metrics-20261117.csv`](test12-small10-pr-scope-metrics-20261117.csv)
- 复现命令：

```bash
cd D:/Project/bench/aacr-bench/evaluation
REVIEW_PI_BIN="D:/Project/ReviewAgent-pi/.claude/worktrees/exp-tools-wt/packages/review-pi/bin/review-pi.js" \
python run_smoke.py \
  --dataset C:/Users/Li/.claude/jobs/c7b993af/tmp/aacr_bench_v2_test12_small10.jsonl \
  --baseline metrics/test12-baseline.json \
  --run-id exp-tools-pr-20261117 \
  --results-root D:/Project/bench/aacr-bench/evaluation/results/aacr_bench_v2_test12_small10/reviewpi \
  --config C:/Users/Li/.PiAgent/benchmark-exp-tools-pr.jsonc \
  --concurrency 4 --timeout-minutes 45 --eval-rounds 1
```
