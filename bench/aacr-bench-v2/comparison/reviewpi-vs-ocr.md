# review-pi vs Open Code Review 官方 benchmark 数据

> 数据来源：`D:/Project/open-code-review` 自带的官方 leaderboard（README + `pages/src/components/BenchmarkSection.tsx` + `imgs/benchmark-en.png`）。
> **不是本地重跑**；本地没有 OCR 的逐样本 results/metrics。
>
> 官方表口径：AACR-Bench v1 全量 200 PR / 1,505 条标注 GT，P = 命中/生成，R = 命中/GT，F1 为二者调和平均；Avg Time 为单次评审墙钟，Avg Token 为单次评审 token（表中为 输入 / 输出）。

## 对照表

| 来源 | 模型 | F1 | Precision | Recall | 平均耗时 | 平均 token |
|---|---|---:|---:|---:|---:|---:|
| Open Code Review | Claude-4.6-Opus | 25.10% | 33.90% | 20.00% | 1m23s | 385K |
| Open Code Review | Qwen3.8-Max | 23.00% | 33.90% | 17.40% | 5m14s | 334K |
| Open Code Review | GLM-5.2 | 21.30% | 32.30% | 15.90% | 7m58s | 682K |
| Open Code Review | Qwen3.7-Max | 21.20% | 25.20% | 18.30% | 4m41s | 625K |
| Open Code Review | GPT-5.5 | 21.00% | 32.10% | 15.50% | 2m51s | 422K |
| Open Code Review | GLM-5.1 | 20.40% | 28.90% | 15.70% | 4m11s | 743K |
| Open Code Review | Claude-4.8-Opus | 17.90% | 37.80% | 11.70% | 1m6s | 352K |
| Open Code Review | Deepseek-V4-Pro | 17.90% | 30.60% | 12.70% | 6m28s | 394K |
| Claude Code | Claude-4.8-Opus | 14.13% | 15.93% | 12.70% | 5m38s | 2,062K |
| Claude Code | Qwen3.7-Max | 12.17% | 8.23% | 23.37% | 8m6s | 5,153K |
| Claude Code | GLM-5.1 | 11.93% | 8.37% | 20.80% | 14m10s | 4,038K |
| Claude Code | Claude-4.6-Opus | 11.57% | 7.23% | 28.90% | 13m6s | 5,664K |
| Claude Code | Deepseek-V4-Pro | 10.93% | 8.27% | 16.13% | 14m24s | 5,450K |
| Codex | GPT-5.5 | 8.36% | 27.82% | 4.92% | 2m58s | 525K |
| **review-pi（本次）** | **deepseek-v4.1-flash** | **10.2%** | **7.3%** | **17.5%** | **8m1s** | **2,226K** |

review-pi 明细：P = 108/1489，R = 118/676；token 为 2,170K 输入（含 cache read）/ 56K 输出，非缓存输入约 155K。

## 解读

1. **review-pi 的画像接近 Claude Code，而不是 OCR。**
   - 与 Claude Code + Deepseek-V4-Pro（10.93% / 8.27% / 16.13%）几乎重合；
   - 与 OCR + Deepseek-V4-Pro（17.90% / 30.60% / 12.70%）是相反的取舍：OCR 高精度低召回，review-pi 低精度较高召回。

2. **成本处在两者之间。**
   - 耗时 8m1s：OCR 为 1m6s–7m58s，Claude Code 为 5m38s–14m24s；
   - token（含 cache）2,226K：接近 Claude Code（2,062K–5,664K），是 OCR（334K–743K）的约 3–6.6 倍；
   - 相对 Claude Code + Deepseek-V4-Pro：质量基本持平，快约 1.8 倍、token 少约 2.4 倍；
   - 相对 OCR + Deepseek-V4-Pro：F1 约为其 57%，precision 约为其 24%，token 约为其 5.6 倍。

3. **召不是短板，precision 才是。**
   review-pi 的 17.5% 落在 OCR 区间上沿（11.7%–20.0%），但 precision 只有 7.3%，远低于 OCR 的 25.2%–37.8%。这与“每 PR 生成 13.8 条意见（OCR 约 2.3–5.5 条）”一致：意见多、标注覆盖窄，导致 precision 被拉低。

## 口径限制（不可忽略）

- **数据集不同**：官方表是 v1 全量 200 PR / 1,505 GT；本次是 v2 的 108 条 ok / 676 GT，排除了 30 条 skipped 和 13 条 failed。
- **模型不同**：review-pi 用 `deepseek-v4.1-flash`；官方表的 DeepSeek 行是 `Deepseek-V4-Pro`，不是同一版本。
- **指标实现可能有细微差异**：官方表 P/R 分子相同（如 191/624 与 191/1505）；review-pi 的文件级语义匹配允许一条生成意见覆盖多条 GT（本次 108 vs 118）。
- **token 口径**：两侧是否都把 cache read 计入 input，页面未明示；review-pi 同时给出含 cache 和非缓存两个口径。
- **单轮 judge**：review-pi 为 `deepseek-v4-pro` 单轮判定，未做多轮平均。

## 结论

在现有可用的官方数据里，review-pi 本次属于 **Claude Code 档**，明显低于 OCR 档；时间与 token 也落在两者之间，没有拿到 OCR 的“低噪声 + 低成本”优势。严格同模型、同子集对比需要让 OCR 与 review-pi 在 v2 同一批样本上重跑，本次未做。
