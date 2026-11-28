# iterS41 cap-hit 6 条：repair `maxRequests` 8 vs 16（2026-11-27）

回答一个问题：**小 diff 上补漏召回低，是不是因为 `maxRequests=8` 卡住了预算？**

从 `iterS41` 里挑出 6 条高缺口 session，同一模型、同一 worktree 构建、同一
judge，唯一差异是 `limits.coverage.repair.maxRequests`（8 vs 16）。两臂顺序
执行，10 并发；每臂 6/6 ok。本轮 cap8 臂除 `ComfyUI@0bb6023`（零缺口）外都有
预算跳过。

## 口径

- 数据集：`iterS41-cap6.jsonl`（6 条，54 条 GT；本目录自带）。
- 指标：`file_semantic`，单轮 judge `deepseek-v4-pro`；
  precision = `matched_generated / generated`，recall = `matched_file_semantic / expected`，
  balanced = `2PR/(P+R)`。
- 代码：worktree `exp-repo-review`，运行时 HEAD `732eff4`（2026-11-27 16:40–17:18）。
  归档 manifest 里的 `review_pi_commit` 是归档时 HEAD，不是运行版本。
- 两臂共同配置：`repair.enabled=true`、`maxChars=24000`、`maxHunksPerRequest=6`、
  独立验证开启；只有 `maxRequests` 不同。
- `results8` 原目录有 3 个 `metrics_*`，前两个是 judge 未生效的 0 分占位；本归档
  只收最终真实评分 `metrics_claude_20261127_171432.json`。

## 总体结果

| 指标 | cap8 | cap16 | Δ |
|---|---:|---:|---:|
| Precision | 38.7% | **41.9%** | +3.2pp |
| Recall | 24.1% | **29.6%** | +5.5pp |
| Balanced | 29.7% | **34.7%** | +5.0pp |
| generated | 31 | 31 | 0 |
| matched generated | 12 | 13 | +1 |
| covered GT | 13 / 54 | 16 / 54 | +3 |
| 样本耗时合计 | 2,622.4s | 3,487.3s | +33.0% |
| 非缓存 input+output | 495,481 | 683,432 | +37.9% |
| total tokens（含缓存） | 5,222,265 | 6,177,704 | +18.3% |

> 耗时是 6 条 session 的 `duration_seconds` 之和，不是并发墙钟。

## 补漏漏斗：预算确实被放开，但只多 1 条可归因 GT

| 项 | cap8 | cap16 |
|---|---:|---:|
| 补漏请求 | 48（每条 8） | 75 |
| 送出 hunk | 85 | 161 |
| 覆盖 hunk | 66 | 126 |
| no-issue | 60 | 119 |
| 候选 | 11 | 20 |
| 接受 finding | 6 | 7 |
| 验证请求 | 10 | 20 |
| 验证拒绝 | 5 | 13 |
| 预算跳过 hunk | **77** | **0** |
| 剩余 `not-reached(no-signal)` | 19 | 35 |

`maxRequests=16` 把预算跳过从 77 降到 0，但仍有 35 个 hunk 是模型主动省略回执
（`no-signal`），不是预算问题。继续加预算不会覆盖这部分；要提 recall 得改提示词 /
回执契约。

## 成本

| 项 | cap8 | cap16 | Δ |
|---|---:|---:|---:|
| 补漏非缓存+output | 150,730 | 298,371 | **+98.0%** |
| 占本臂非缓存+output | 30.4% | 43.7% | +13.3pp |
| 验证请求 | 10 | 20 | +10 |

补漏成本接近翻倍，换来的总盘 B 增益只有 +5.0pp，且其中大部分不能归因于补漏。

## 归因：cap 只解释 1 条 GT

`CR*` 补漏 finding：

| 臂 | CR findings | 命中 GT |
|---|---:|---:|
| cap8 | 6 | 3 |
| cap16 | 7 | 4 |

cap16 的 4 条 GT：

| session | id | severity | 位置 | cap8 同位置状态 | 归因 |
|---|---|---|---|---:|---|
| union | CR005 | P2 | `voyager/modules/state/movement/src/main.rs:148` | budget 跳过 | **cap 提升** |
| ollama | CR001 | P3 | `cmd/cmd.go:801` | 已由主检视 F005 覆盖，未命中 GT | 非 cap；repair 内容差异 |
| union | CR001 | P3 | `lib/voyager-core/src/lib.rs:336` | cap8 同行附近 CR001 已命中 | 同一条 finding，行号漂移 |
| ComfyUI | CR001 | P1 | `ruff.toml:9` | cap8 同位置 CR001 已命中 | 两臂都有 |

另有两条噪声：

- `union lib/voyager-message/src/module.rs:443`：cap8 的 CR002 判 GT，cap16 的
  CR003 同一行但 judge 判非 GT；同一条 finding 的 judge / 匹配波动。
- `union consensus/movement:145` 在 cap8 也是 budget 跳过，cap16 覆盖后出的
  CR006 未命中 GT。

因此 **明确由 maxRequests 8→16 带来的 GT 只有 1 条**（union state/movement:148）。

## 逐 session

| session | cap8 B（GT） | cap16 B（GT） | 预算跳过 8→16 | 备注 |
|---|---:|---:|---:|---|
| unionlabs/union | 31.6%（3/13） | 33.8%（4/13） | 16→0 | 唯一 cap 归因 GT |
| ollama/ollama | 27.3%（3/15） | 42.1%（5/15） | 12→0 | 涨幅主要来自 repair 内容差异，不是 cap |
| ComfyUI@4dcd698 | 27.6%（4/18） | 29.6%（4/18） | 7→0 | GT 不变 |
| ComfyUI@0bb6023 | 80.0%（3/3） | 80.0%（3/3） | 0→0 | 无缺口 |
| google-gemini/gemini-cli | 0%（0/1） | 0%（0/1） | 35→0 | 预算放开仍无 GT |
| sveltejs/svelte | 0%（0/4） | 0%（0/4） | 7→0 | generated 2→1，反而更少 |

总盘 +5.0pp 主要由 union（+2.2pp）和 ollama（+14.8pp）拉动；ollama 的 GT 增益
不是 cap 造成，所以不能把它算到“提高 maxRequests”的收益里。

## 结论

- `maxRequests=8` 确实丢了 77 个 hunk 的补漏机会，但其中只有 1 个能明确转成 GT；
- 从 8 提到 16：B +5.0pp、R +5.5pp，但补漏成本 +98.0%、非缓存总成本 +37.9%；
- 剩余 35 个 `no-signal` hunk 说明下一瓶颈是“模型不回执”，不是预算；
- **默认值维持 `maxRequests=8`。** 若再优化，优先改提示词 / 回执契约提高
  `no-signal` 覆盖率，或做多轮重复把主检视波动平均掉；不要直接改全局默认。

## 目录

| 路径 | 说明 |
|---|---|
| `cap8/` | 6 条，`maxRequests=8`；`results/`、`metrics.json`、`audit-summary.json`、`manifest.json`、脱敏 `config.jsonc` |
| `cap16/` | 6 条，`maxRequests=16`；同上 |
| `combined.json` | 总盘、逐 session、补漏漏斗、成本、CR 归因 |
| `iterS41-cap6.jsonl` | 本次 6 条数据集（含 GT） |

## 复现

```bash
python D:/Project/ReviewAgent-pi/bench/aacr-bench-v2/scripts/aacr_reviewpi_bridge.py \
  --dataset bench/experiments/2026-11-27-cap8-vs-16/iterS41-cap6.jsonl \
  --results-dir <out> \
  --repo-dir D:/Project/bench/aacr-bench/evaluation/repo \
  --concurrency 10 --timeout-minutes 30 \
  --config bench/experiments/2026-11-27-cap8-vs-16/cap8/config.jsonc \
  --review-pi-bin <worktree>/packages/review-pi/bin/review-pi.js
```

`config.jsonc` 里的 `reviewer.apiKey` 已写为 `[redacted]`；复现时需换成自己的
key。judge 命令同 `2026-11-27-mixed-onoff/README.md`。

## 限制

- 两臂各只跑一轮，主检视是随机的；总盘差值不能全部归因于 `maxRequests`。
- judge 单轮 `deepseek-v4-pro`，同一 finding 在两次运行中可能被判不同（本归档
  已出现 module.rs:443 的例子）。
- 只覆盖 6 条高缺口 MR，不是 iterS41 全量；结论用于“是否调默认值”，不是
  全量精度估计。
- 仅 MR 模式，不含 repo 分组模式。
