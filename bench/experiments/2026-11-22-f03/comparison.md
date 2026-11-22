# F-03 分片并行：串行 vs 并行（`concurrency=3`）

> 2026-11-22 · 网关 `deepseek-v4.1-flash` · 不跑 judge · 同 3 条多片样本、同配置（仅 `limits.split.concurrency` 不同）

## 方法

- 数据集：`bench/aacr-bench-v2/configs/iterF91.jsonl` 中 3 条实际多片样本。
- 分片：`maxDiffChars=8000` / `maxShardChars=10000` / `maxShards=12`，merge-base diff。
- 串行：`concurrency=1`；并行：`concurrency=3`。
- 桥接进程级并发恒为 1，避免批次间互相干扰。
- 未跑 judge；findings 数为模型原始输出，不作为 P/R/B。
- 首跑 typescript-go 串行被桥接默认 30 分钟超时截断（1803.6s），已用 60 分钟超时重跑，下表用重跑结果。

## 结果

| 样本 | 片数 | 串行 | 并行 | 加速 | 串行 token | 并行 token | 429（串/并） |
|---|---:|---:|---:|---:|---:|---:|---:|
| immich | 6 | 1091.9s | 603.4s | **1.81×** | 5.23M | 9.35M | 0 / 0 |
| elasticsearch | 7 | 1288.3s | 513.1s | **2.51×** | 4.75M | 5.58M | 0 / 0 |
| typescript-go | 9 | 2918.7s | 995.3s | **2.93×** | 13.43M | 17.92M | 0 / 0 |
| **合计** | **22** | **5298.9s** | **2111.8s** | **2.51×** | **23.41M** | **32.86M** | **0 / 0** |

- 墙钟：**5298.9s → 2111.8s，2.51×**；单样本 1.81–2.93×，片越多收益越大。
- 429：两批均为 **0**；attempts 串行 793 / 并行 696，没有因并发出现限流尖峰。
- 片计划：两批完全一致（6/7/9 片），并行没有改变分片结果。

## token 为什么涨了

并行 token 总量比串行高 **40%**，主要来自 `cache_read`：

| 样本 | input Δ | output Δ | cache_read Δ |
|---|---:|---:|---:|
| immich | +24% | +35% | +83% |
| elasticsearch | +0.3% | +8% | +19% |
| typescript-go | +16% | −5% | +35% |

这是 **live 采样噪声 + 缓存命中差异**，不是并行调度本身改变请求字节：

- 两批是独立模型会话，轮次/工具调用/输出长度都会不同（immich findings 12 vs 7，elasticsearch 18 vs 15，typescript-go 19 vs 14）；
- 并发发起请求会降低前缀缓存复用，`cache_read` 上升；
- 要证明 token 等价，必须用 replay（同一 trace）而不是 live 对比。

## 结论

- F-03 的核心收益成立：多片大 MR 的分片阶段墙钟约 **2.5×**，片越多越接近线性。
- 429 没有增加，失败语义未触发。
- **质量等价不能用本次 live 数据证明**：findings 数有采样差异，token 也受缓存影响。下一步用 replay 在同一 trace 上跑 `c=1` vs `c=3`，断言 findings/coverage/usage 逐字节一致。
- `concurrency` 默认仍为 1；本次只证明开启 3 的墙钟收益与限流安全，不改默认值。

## 文件

- `serial/`：串行结果、审计摘要、日志、manifest
- `parallel/`：并行结果、审计摘要、日志、manifest
- `comparison.json`：机器可读对比
- `compare_runs.py`：对比脚本
