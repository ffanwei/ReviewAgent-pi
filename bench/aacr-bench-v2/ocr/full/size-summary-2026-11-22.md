# 按 diff 规模汇总：v3 与 OCR

> 数据日期：2026-11-22（OCR 侧最后一次全量为 2026-11-16）
> 样本：OCR 与 review-pi 都成功的 **91 条交集 / 588 GT**
> 指标：文件级语义 P/R/B，同一 judge（`deepseek-v4-pro`），单轮
> 范围：只比较 v3 baseline 与 OCR

## 1. 结论

| 切片 | 样本 / GT | 运行 | P | R | B | 覆盖 GT | 生成意见 |
|---|---:|---|---:|---:|---:|---:|---:|
| **全量** | 91 / 588 | v3 baseline | 38.1% | 24.5% | 29.8% | 144 | 320 |
| | | **OCR** | 31.3% | **36.9%** | **33.9%** | 217 | 601 |
| **小 diff <50KB** | 41 / 186 | **v3 baseline** | **41.9%** | 32.8% | **36.8%** | 61 | 136 |
| | | OCR | 31.4% | **38.2%** | 34.5% | 71 | 207 |
| **大 diff ≥50KB** | 50 / 402 | v3 baseline | **35.3%** | 20.7% | 26.1% | 83 | 184 |
| | | **OCR** | 31.2% | **36.3%** | **33.6%** | 146 | 394 |

三句话：

1. **小 diff：v3 已反超 OCR**，B 36.8% vs 34.5%；靠的是 precision（41.9% vs 31.4%），recall 仍低 5.4pp。
2. **大 diff：OCR 仍领先**，B 33.6% vs 26.1%；v3 的 precision 已更高（35.3% vs 31.2%），差距主要在 recall/覆盖（20.7% vs 36.3%）。
3. **全量：OCR 33.9% vs v3 29.8%，只差 4.1pp**；旧基线 B 10.9% 的“3 倍差距”已不成立。

成本侧同样关键：**v3 评审耗时 24,734s，比 OCR 的 26,891s 少约 8%；非缓存 token 6.89M，只有 OCR 29.81M 的 23%。**

## 2. 原始计数

P = 命中生成意见 / 生成意见；R = 覆盖 GT / GT 总数；B = 2PR/(P+R)。以下计数可直接复算上表。

| 切片 | 运行 | GT | 覆盖 GT | 生成意见 | 命中生成意见 |
|---|---|---:|---:|---:|---:|
| 全量 | v3 baseline | 588 | 144 | 320 | 122 |
| 全量 | OCR | 588 | 217 | 601 | 188 |
| 小 diff | v3 baseline | 186 | 61 | 136 | 57 |
| 小 diff | OCR | 186 | 71 | 207 | 65 |
| 大 diff | v3 baseline | 402 | 83 | 184 | 65 |
| 大 diff | OCR | 402 | 146 | 394 | 123 |

## 3. 时间与消耗

### 3.1 全量

| 运行 | 总耗时 | 平均/实例 | 总 token（含缓存） | 非缓存 token | 输入 / 输出 / 缓存读 |
|---|---:|---:|---:|---:|---|
| v3 baseline | 24,734s | 271.8s | 53.10M | **6.89M** | 2.81M / 4.08M / 46.22M |
| OCR | 26,891s | 295.5s | 198.67M | **29.81M** | 未拆分 |

- v3 的总 token 由 91 条逐实例 `token_usage` 汇总：input 2,808,997 + output 4,079,988 + cache_read 46,215,154。
- OCR 的“总 token”包含 cache；“非缓存 token”取自既有对照报告的非缓存 input+output 口径。
- 耗时为评审耗时，不含 judge 的模型时间。

### 3.2 按切片耗时

| 切片 | v3 总耗时 | v3 平均 | OCR 总耗时 | OCR 平均 |
|---|---:|---:|---:|---:|
| 小 diff <50KB | **7,566.5s** | 184.5s | 9,845.3s | 240.1s |
| 大 diff ≥50KB | 17,167.5s | 343.4s | **17,045.5s** | 340.9s |
| 全量 | **24,734s** | 271.8s | 26,890.8s | 295.5s |

小 diff 上 v3 明显更快；大 diff 上两者基本持平。全量的时间优势主要来自小 diff。

## 4. 口径与方法

- **样本**：取 v3 与 OCR 都存在的 91 个 `instance_id`；GT 合计 588。
  OCR 自身成功 113 条，review-pi 成功 108 条，这里只取交集，避免用不同分母比较。
- **分档**：`diff_size < 50KB` 为小 diff（41 条 / 186 GT），`≥50KB` 为大 diff（50 条 / 402 GT）。
  `diff_size` 取自 `bench/aacr-bench-v2/data/exclusion-analysis.json` 的 `groups.ok`。
  50KB 按 50,000 与 51,200 两种阈值试算，分档结果相同（41 / 50）。
- **匹配**：GT 侧用 `comments[].file_semantic_match`，生成侧用
  `generated_comments[].hit_new_gt`；均为文件级语义匹配，不看行号。
- **汇总方式**：先跨实例累加计数，再算 P/R/B；不是对逐样本分数取平均。
- **校验**：按同一方法重算 OCR 小 diff，得到 P 31.4% / R 38.2% / B 34.5%，
  与既有 `size-stratification.md` 完全一致。

## 5. 数据来源

| 运行 | 文件 |
|---|---|
| v3 baseline（2026-11-22 01:26） | `bench/experiments/2026-11-21-f02/baseline-f91-v3/metrics.json` |
| v3 逐实例耗时/用量 | `bench/experiments/2026-11-21-f02/baseline-f91-v3/results/*.json` |
| OCR（2026-11-16） | `bench/aacr-bench-v2/ocr/full/metrics_ocr_20261116_161311.json` |
| OCR 逐实例耗时 | `bench/aacr-bench-v2/ocr/full/results/*.json` |
| OCR token/耗时（91 条汇总） | `bench/aacr-bench-v2/ocr/full/comparison.md` |
| diff 大小 | `bench/aacr-bench-v2/data/exclusion-analysis.json` |
| 旧分层报告（对照） | `bench/aacr-bench-v2/ocr/full/size-stratification.md` |

## 6. 限制

- **交集口径**：只覆盖双方都成功的 91 条；失败样本不在表内。
- **文件级语义指标**：AACR v2 的 GT 约 77% 来自 AI 评论，匹配到文件/语义即可，不校验行号。
- **单轮 judge**：judge 噪声仍在，尤其小样本分档（41 / 50 条）。
- **模型别名不完全一致**：v3 记录为 `deepseek-flash`（上游 V4.1 Flash 别名），
  OCR 为 `deepseek-v4.1-flash`；若两者并非同一服务，数字仍有小幅不可比。
- **token 口径**：OCR 的总 token 包含 cache，非缓存口径可直接比较；OCR 的输入/输出未拆分。
- **v3 不是回退后的新默认**：v3 是当前可用的最佳全量基线；默认配置在 ADR-0116 回退后尚未重新跑全量。
- **大 diff 的“差距缩小”不等于追平**：v3 在大 diff 上的 recall 仍只有 20.7%，
  OCR 为 36.3%；当前瓶颈是覆盖，而不是 precision。
