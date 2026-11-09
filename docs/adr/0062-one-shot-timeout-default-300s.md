# 0062. 一次性模型调用缺省超时 90 s → 300 s

**状态**：已接受（2026-11-09，用户决策）
**关联**：[ADR-0051](0051-llm-call-retry-and-timeout.md)（分层重试与请求建立超时，本 ADR 改的是其超时缺省值）、[ADR-0045](0045-mcp-business-task-tools.md)（片级报文 / 收尾总结）、[ADR-0058](0058-shard-report-splits-and-retries-on-failure.md)（报文失败后的二分重试）、[ADR-0061](0061-every-diff-file-reported-before-summary.md)（每文件必报，放大了报文失败的可见代价）
**范围**：本仓 pi 线 0062。只改**缺省值**：`limits.timeouts.oneShotMs`（片级报文 / 收尾总结 / tips 的一次性调用）从 `90000` 改为 `300000`。机制、重试语义、`reviewTurnMs`、`presentationRequestMs`、MCP 超时全部不动；显式配置仍然覆盖缺省。

## Context

ADR-0051 给核外一次性调用定的缺省是 90 s，当时依据是「一次报文 / 总结的 completion 在几十秒内」。这个假设在**大 MR + 推理模型**下失效。

`large-mr` 真实 e2e（>1000 行 diff、9 文件、61 findings；见 `scripts/e2e-mcp/`）实测：

| 一次性调用 | 输出 tokens | 耗时 | 吞吐 |
|---|---|---|---|
| 报文 / tips | 10,602（含 2,199 reasoning） | 61.2 s | ~173 tok/s |
| 收尾总结 | 4,107（含 1,807 reasoning） | 29.5 s | ~139 tok/s |
| 规则 Skill 主输出（对照） | 9,037 | 47.8 s | ~189 tok/s |

同一网关的另两个请求分别只有 123 tok/s 与 125 tok/s，即**单次 1.6 万 tokens 的正常区间是 85–130 s**，慢网关（50–80 tok/s）会到 200–320 s。90 s 的缺省刚好卡在乐观值上。

这不是「慢一点」的问题——`shared/one-shot-llm.ts` 用 `AbortSignal.timeout(timeoutMs)` 包住**非流式整次生成**（首字节 + 全部输出）：

- 超时 → `TimeoutError` → 退避重试，每次都是**从零重新生成全部 tokens**，成本 ×`oneShotAttempts`；
- 客户端断开而网关继续生成时，代理侧收全的响应会被判为截断 JSON / malformed；
- 片级报文失败会触发 ADR-0058 的二分缩片，最坏 `1 + 2 + 4 = 7` 次调用，且部分文件按 ADR-0061 退化为空列表。

录制 `large-mr` 回放轨迹时就撞上了这条路径：90 s 断开 → 录制走二分重试、回放走全量，指纹漂移。当时的处置是场景里钉 `timeouts.oneShotMs = 600000`（继续保留）。但产品缺省仍留在 90 s，等于让每个跑大 MR 的用户默认踩一次。

## Decision

### 1. 缺省 `oneShotMs` 改为 `300000`

- `DEFAULT_LIMITS.timeouts.oneShotMs` = `300_000`；
- `config init` 模板与仓库根 `PiAgent.example.jsonc` 同步为 `300000`（两者仍逐字节相等）；
- 用户显式配置继续覆盖缺省，无迁移动作。

### 2. 为什么是 300 s 而不是 600 s

300 s 对 1.6 万 tokens 相当于容忍 **~53 tok/s**，覆盖本次实测最慢吞吐（123 tok/s）的两倍以上余量；同时把「网关真挂死」的最坏墙钟从 `3 × 90 s = 4.5 min` 抬到 `3 × 300 s = 15 min`，仍在人工可接受的排障窗口内。600 s 留给**回放录制场景**显式声明（`large-mr` 已钉），不设为产品缺省。

### 3. 只动一次性调用，不动流式回合

`reviewTurnMs`（180 s）是 pi-ai 流式请求的**建立阶段**超时，输出总时长不受它约束；`presentationRequestMs`（90 s）逐 finding 输出量级小。两者不改，避免把「大报文」的结论错误外推到其它路径。

### 4. 回放侧默认口径同步

`scripts/offline-replay` 的安全阀在场景未声明 `timeouts.oneShotMs` 时按产品缺省估算，默认值同步改为 `300_000`，避免「lane 用 300 s、校验按 90 s」的错位。

## Options（为什么不是别的）

- **保持 90 s，只写文档让用户自己调**：否。大 MR 是产品明确支持的场景（ADR-0039 分片），缺省值让它在正常吞吐下就触发失败路径，文档提醒无法消除默认踩坑。
- **直接上 600 s**：否。对 1.6 万 tokens 余量过大，把挂死请求的最坏墙钟拉到 30 min；600 s 更适合作为回放录制的显式配置。
- **改成流式 + 增量超时**：否。一次性调用是核外裸 `fetch` + 完整 JSON 解析，改流式会牵动报文解析、重试与回放指纹，超出本次范围。
- **超时后自动缩片而不是调大超时**：否。缩片是失败后的降级路径（ADR-0058），把它常态化会放大调用数与成本，还会让 tips 分片碎片化。

## Consequences

- **好**：大 MR 在正常网关吞吐下不再因缺省超时而走重试 / 缩片；`config init` 生成的新配置直接可用。
- **代价 / 风险**：真正挂死的网关会多占时间，最坏 `3 × 300 s + 退避`；需要更快失败的环境可显式调低 `oneShotMs` 或 `oneShotAttempts`。
- **文档面**：`docs/使用手册-安装与运行.md`、`docs/运行手册-离线回放.md`、`packages/review-pi/testdata/traces/README.md`、`scripts/e2e-mcp/README.md` 同步口径。
- **测试面**：`shared/config.test.ts` 的模板逐字节同源断言继续覆盖；回放安全阀缺省值随 `scripts/offline-replay/lib/scenario.mjs` 更新。
- **与 ADR-0051 的关系**：只改其超时缺省值，分层重试、只重试请求建立阶段、回放 lane 单次尝试等决策全部有效。ADR-0051 顶部加后续修订注记。
