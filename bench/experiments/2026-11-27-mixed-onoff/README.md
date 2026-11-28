# iterM20 混合样本 repair on/off（2026-11-27）

回答一个问题：**coverage repair 是否应该默认 on？**

用 20 条混合 MR（15 小 + 5 大，103 条 GT），同一模型、同一 worktree 构建、
同一 judge，唯一差异是 `limits.coverage.repair.enabled`。

## 口径

- 数据集：`bench/aacr-bench-v2/configs/iterM20.jsonl`（15 小 + 5 大）。
- 指标：`file_semantic`，单轮 judge `deepseek-v4-pro`；`matched_generated`
  按 `hit_new_gt` 计。
- 代码：worktree `exp-repo-review`，commit `732eff4`，干净构建。
- on 臂：`maxRequests=8`、`maxChars=24000`、`maxHunksPerRequest=6`，独立验证开启。
- off 臂：`enabled=false`，其余配置相同。
- 两臂顺序执行，10 并发；两臂各 20/20 ok。

## 总体结果

| 指标 | off | on | Δ |
|---|---:|---:|---:|
| Precision | 39.0% | **41.7%** | +2.7pp |
| Recall | 29.1% | **35.0%** | +5.8pp |
| Balanced | 33.3% | **38.1%** | +4.7pp |
| generated | 59 | 60 | +1 |
| matched generated | 23 | 25 | +2 |
| covered GT | 30 / 103 | 36 / 103 | +6 |
| 墙钟合计 | 3,533.3s | 5,007.6s | +41.7% |
| 非缓存 input+output | 865,304 | 1,102,297 | +27.4% |

## 分组：收益表面集中在大 diff

| 组 | off P/R/B | on P/R/B | ΔB |
|---|---|---|---:|
| 小 diff（15 条，60 GT） | 35.6 / 28.3 / 31.5 | 35.7 / 25.0 / 29.4 | **-2.1pp** |
| 大 diff（5 条，43 GT） | 50.0 / 30.2 / 37.7 | 55.6 / 48.8 / 52.0 | **+14.3pp** |

大 diff 的涨幅不能直接归因于 repair：

- 5 条大 diff 只多出 1 条补漏 GT（gofr `ctx_logger.go:38`，P2）。
- FreeCAD@699 从 0 覆盖 GT 变成 6 条，react 从 0 变 1 条，但这两条样本没有
  任何 `CR*` 补漏 finding，是主检视轮次波动。
- PowerShell@ec952ce 从 2 条 GT 降到 1 条。

## 补漏漏斗

| 项 | off | on |
|---|---:|---:|
| 补漏请求 | 0 | 74 |
| 送出 hunk | 0 | 136 |
| 覆盖 hunk | 0 | 105 |
| no-issue | 0 | 99 |
| 预算跳过 hunk | 0 | 37（小 6 / 大 31） |
| 候选 | 0 | 19 |
| 接受 finding | 0 | 6 |
| 验证拒绝 | 0 | 13 |

补漏成本：

- 非缓存 + output **360,929** token，占 on 臂非缓存成本 **32.7%**；
- 补漏 + 验证输出 251,203 token，占 on 臂 output **38.5%**；
- 补漏本身 74 请求，验证 19 请求。

## 归因：repair 自身只贡献 2 条 GT

on 臂 6 条 `CR*` finding，仅 2 条命中 GT：

| session | id | severity | 位置 | GT |
|---|---|---|---:|---|
| Checkmate@29e03a6 | CR001 | P3 | `.github/scripts/download-translations.js:8` | ✅ |
| gofr@5e284ae | CR002 | P2 | `pkg/gofr/logging/ctx_logger.go:38` | ✅ |
| spring-ai-alibaba@3555a95 | CR002 | P3 | `AliTranslateService.java:63` | ❌ |
| cline@d0a8db8 | CR001 | P3 | `useApiConfigurationHandlers.ts:22` | ❌ |
| cline@d0a8db8 | CR002 | P3 | `src/core/storage/state.ts:461` | ❌ |
| ollama@af112d6 | CR002 | P2 | `server/create.go:56` | ❌ |

把 on 臂 6 条 `CR*` 全部拿掉，仅保留主检视 findings：

| | off | on（去掉 CR） | on（实际） |
|---|---:|---:|---:|
| Precision | 39.0% | 42.6% | 41.7% |
| Recall | 29.1% | 33.0% | 35.0% |
| Balanced | 33.3% | 37.2% | 38.1% |

即：

- 主检视轮次波动贡献约 **+3.9pp balanced**；
- repair 自身贡献约 **+0.8pp balanced / +1.9pp recall**（2 条 GT）；
- 代价是补漏 360.9k 非缓存 token、整轮墙钟 +41.7%。

## 结论

**单轮混合结果表面支持 on，但拆到 finding 级不足以支持“全局默认 on”。**

- repair 是真实有效的，但产出很低：20 条样本、6 条接受 finding，仅 2 条 GT；
- 大 diff 的高涨幅主要来自主检视波动，不能作为 repair 的收益；
- 小 diff 组 balanced 反而 -2.1pp；
- 补漏成本占 on 臂非缓存成本 32.7%，换来 +0.8pp balanced；
- 与 8 vs 16 定向实验的结论一致：加预算只多约 1 条可归因 GT，补漏成本接近翻倍。

**默认值暂维持 off。** 若要走“条件默认 on”，先做至少 3 轮 on/off 重复把主
检视波动平均掉，并优先压 P3 文档/配置类候选噪声；不要直接改全局默认。

## 目录

| 路径 | 说明 |
|---|---|
| `off/` | 20 条，repair 关闭；`metrics.json` / `results/` / `audit-summary.json` / `manifest.json` |
| `on/` | 20 条，repair 开启；同上 |
| `combined.json` | 总盘、分组、补漏漏斗、成本与归因 |

## 复现

```bash
python D:/Project/ReviewAgent-pi/bench/aacr-bench-v2/scripts/aacr_reviewpi_bridge.py \
  --dataset bench/aacr-bench-v2/configs/iterM20.jsonl \
  --results-dir <out> \
  --repo-dir D:/Project/bench/aacr-bench/evaluation/repo \
  --concurrency 10 --timeout-minutes 30 \
  --config <repair-on|repair-off>.jsonc \
  --review-pi-bin <worktree>/packages/review-pi/bin/review-pi.js
```

judge：

```bash
cd D:/Project/bench/aacr-bench/evaluation
JUDGE_MODEL=deepseek-v4-pro JUDGE_CONCURRENCY=10 \
python -m pipeline run --stage eval --reviewer claude \
  --dataset <iterM20.jsonl> --results-dir <out> --eval-rounds 1
```

## 限制

- 两臂各只跑一轮，主检视是随机的；总体 P/R/B 差值不能全部归因于 repair。
- judge 单轮 `deepseek-v4-pro`，存在 judge 波动；本归档的关键证据是 CR finding
  级的 2 条 GT / 6 条 finding。
- 仅覆盖 MR 模式，不含 repo 分组模式；repo 的补漏成本仍是未测项。
