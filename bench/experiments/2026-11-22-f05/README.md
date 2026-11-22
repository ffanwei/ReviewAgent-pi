# F-05 独立证伪核验 · 离线回放

日期：2026-11-22；分支：`exp-flow`；数据：v3 iterF91 baseline（320 findings）。

## 问题

F-04 的确定性接地（`groundFindingEvidence`）会把 103 条语义正确但措辞/上下文不匹配的
finding 判成 `unverified`；若直接 `drop`，会丢 29 TP / 37 GT。F-05 想知道：给每条
finding 开一次独立 one-shot，只喂 finding + 行号附近片段，能否用语义证伪把这批
`unverified` 再分一层——pass 的返场、reject 的丢弃。

## 方法

- 样本：F-04 `unverified` 全部 103 条（`groundFindingEvidence` 重新计算，minMatchChars=30）。
- 输入：finding JSON + 目标行前后 80 行、带行号的片段（上限 8k 字符）；不读仓库、不调用工具。
- 请求：OpenAI 兼容 one-shot，`response_format=json_object`，max_tokens=4096；
  解析失败只重发一次（追加 "no reasoning text"），所以每条最多 2 次调用、无追问循环。
- 判定：`pass` / `reject` / `uncertain`（回包以 `uncertain:` 开头、空回包、请求失败均 fail-open 为 uncertain）。
- 标签：与 judge 的 `generated_comments` 按 `(instance, file, line)` 对齐；`hit_new_gt` 区分 TP/FP，
  `matched_gt_indices` 计 GT 覆盖。
- 模型：`deepseek-v4.1-flash`（与检视同档）与 `deepseek-v4-pro`（对照）。

## 结果

原始表见 [`replay-report.md`](replay-report.md)，逐条 verdict 见
[`full-flash.json`](full-flash.json) / [`full-pro.json`](full-pro.json)。

| 模型 | pass | reject | uncertain | tokens | pass 精度 | pass 覆盖 GT |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| flash | 44 | 2 | 57 | 240,050 | 15/44 = 34.1% | 17/39 |
| pro | 54 | 0 | 49 | 282,893 | 18/54 = 33.3% | 21/39 |

- `unverified` 子集本身：103 条，30 TP / 73 FP（P 29.1%），覆盖 39 GT。
- **reject 几乎不出现**（flash 2 条、pro 0 条）：80 行片段下验证器倾向说“片段不足”，
  而不是断言 finding 错误；即使 reject 也 1 TP 1 FP（flash），单独作 drop 门没有价值。
- **pass 有弱区分度**：flash 34.1% / pro 33.3%，比子集基线 29.1% 高 4–5pp；
  覆盖 17–21 个 GT（占该子集 39 GT 的 44%–54%）。

## 与 F-04 组合（全量 320 口径）

| 管线 | generated | matched | GT | P | R | B |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline（不 drop） | 320 | 122 | 144 | 38.1% | 24.5% | 29.8% |
| F-04 drop 全部 unverified | 217 | 93 | 107 | 42.9% | 18.2% | 25.5% |
| F-04 drop + F-05(flash) pass 返场 | 261 | 108 | 124 | 41.4% | 21.1% | 27.9% |
| F-04 drop + F-05(pro) pass 返场 | 271 | 111 | 128 | 41.0% | 21.8% | 28.4% |

- F-05 返场能把 F-04 丢掉的 37 GT 找回 17–21 个、29 TP 找回 15–18 个；
  但相比 baseline 仍是净损失（B −1.4 ~ −1.9pp），且 uncertain 里还压着 12–14 TP。
- 结论：**单次 80 行片段不足以为 drop 提供决策依据**。不接入主路径、不默认启用；
  若继续 F-05，瓶颈在上下文窗口（需要更大片段/多文件证据），而不是提示词或模型档位。

## 成本

- 103 条 240k（flash）/ 283k（pro）token → 全量 320 条约 0.75–0.88M，
  占 F91 baseline 53.1M 的 1.4%–1.7%；失败重试只影响少数条目。
- 延迟：flash 103 条 @ concurrency 3 约 4 分钟；pro 约 8 分钟。

## 复现

```bash
node bench/experiments/2026-11-22-f05/replay_verify.mjs \
  --scope unverified --concurrency 3 \
  --out bench/experiments/2026-11-22-f05/full-flash.json
node bench/experiments/2026-11-22-f05/replay_verify.mjs \
  --scope unverified --concurrency 3 --model deepseek-v4-pro \
  --out bench/experiments/2026-11-22-f05/full-pro.json
node bench/experiments/2026-11-22-f05/summarize_replay.mjs \
  full-flash.json full-pro.json --out replay-report.md
node bench/experiments/2026-11-22-f05/rescue_analysis.mjs \
  --replay full-flash.json --out rescue-flash.json
```

## 工具链修正记录

- 首轮判定正则被写成 `/^uncertain\x08/i`（字面退格符），导致“uncertain”被误判为 reject；
  已改为 `/^uncertain:/i`，全仓扫描无其它 0x08 残留。
- 首轮 `requestFailed` 13/103 来自推理模型把 1024/1536 token 预算花在隐藏推理上、
  content 为空；max_tokens 4096 + 一次有界重试后降为 0。
