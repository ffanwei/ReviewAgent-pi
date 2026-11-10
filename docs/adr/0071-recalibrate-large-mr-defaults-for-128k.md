# 0071. 大 MR 缺省阈值按 128K 上下文实测重标定

**状态**：已接受（2026-11-10，用户决策：`maxDiffChars=1000000` / `maxShardChars=120000` / `maxShards=12` 落成缺省，`config init` 模板同步）
**关联**：[ADR-0039](0039-sharded-review-for-large-mrs.md)（按文件块分片；本 ADR 只改缺省数字）、[ADR-0070](0070-single-file-truncation-and-tighter-diff-limits.md)（本 ADR **取代其 §1 的三个数字**；其 §2–§4 的整 hunk 截取与留痕机制不变）、[ADR-0069](0069-configurable-diff-exclude-globs.md)（`excludeGlobs` 缺省不变）

**范围**：本仓 pi 线 0071。改三个缺省数字 + 模板注释 + 文档口径；不改任何机制、不加 CLI 旗标、不动分片/截取语义。

## Context

ADR-0070 把缺省值从 `maxDiffChars=1 500 000` / `maxShardChars=400 000` / `maxShards=12` 收紧到 `200 000` / `80 000` / `6`，理由是「实际接入的网关上下文更小」。但那组数字是**没有实测**的保守估计：`80 000` 对应「约 1 300–2 350 变更行」，它假设的是 64K 档位；接入的网关实际是 128K。

实测两根标尺（均为真实网关、真实模型 `deepseek-v4.1-flash`、带 `general-code-review` 规则包）：

| 数据源 | diff 字符 | 首次请求 | 峰值 prompt tokens | 占 128K |
|---|---:|---:|---:|---:|
| `testdata/traces/large-mr.json`（冻结 trace，逐条 request 记录了 `requestShape.messages[].chars` 与响应 `usage`） | 44 941 | 13 989 | 58 403 | 45% |
| 225 555 字符合成 MR（`large-mr` 夹具复制 5 份，2 片；本地留痕 `.tmp-gen/token-verify/`，gitignored） | 225 555 | 54 394（s1）/ 7 091（s2） | 101 649 | **79%** |

从两个点得到两条结论：

1. **换算比例**：代码 + JSON 混合负载实测 **≈3.2–3.9 字符/token**（首个请求 3.49–3.92），不是按「4 字符/token」估的乐观值；
2. **增长项近乎固定**：两次的「首次请求 → 峰值」增量分别是 **44 414 / 47 255 tokens**，几乎与 diff 大小无关。增量来自工具往返（27–44 次调用，60–90k 字符）与 assistant 输出，而 `MAX_TOOL_CALLS=100` 与工具结果 8 000 字符预算把它的上界钉住了。

因此峰值可以按加法模型预测：

```
峰值 tokens ≈ (shard 字符数 + 9 600) / 3.85 + 45 500
```

其中 9 600 是系统提示 + 工具 schema 的固定字符开销。

**200 000 的问题**：按该模型峰值 ≈ 100k，实测 101 649 —— 只剩 26k 余量。而规则 Skill 会话是以**主会话 Phase 5 结束时的 messages 快照**为种子（`loop/agent-review-loop.ts` 的 `runRoundSkillPasses(seedMessages)`），它继承主会话已经吃掉的 97k 后再自己探索；实测那次 skill 恰好 0 次工具调用（5 份重复代码），真实代码一旦让它多读十几个文件，峰值就会顶到 120k 以上。也就是说 `200 000` 属于「能跑通但贴脸」，不是安全值。

## Decision

### 1. 缺省值改为

```jsonc
"limits": {
  "boundary": { "maxFiles": 10, "maxDiffLines": 2000, "maxDiffChars": 1000000 },
  "split":    { "enabled": true, "maxShardChars": 120000, "maxShards": 12, "contextSummaryChars": 8000 }
}
```

`maxFiles` / `maxDiffLines` / `contextSummaryChars` 不变（前者只告警、后者不是证据源）。

### 2. 取值依据

| 阈值 | 旧（ADR-0070） | 新 | 预测峰值 | 占 128K |
|---|---:|---:|---:|---:|
| `maxShardChars` | 80 000 | **120 000** | ≈79k | 62% |
| （参考：150 000 的预测） | — | — | ≈87k | 68% |
| （参考：200 000 的实测） | — | — | 101.6k | 79% |
| `maxDiffChars` | 200 000 | **1 000 000** | — | 体积门，不发请求 |

- 安全线取「峰值 ≤ 90k（70% 窗口）」，故 `120 000` 而非 `150 000`；
- 不取更低（如 80 000）：固定增长项 45.5k 不随分片变小而消失，片数变多只会把同一份固定开销重复付多次；
- `maxDiffChars` 提到 1 000 000 才配得上 120 000 的分片线：`⌈1 000 000 / 120 000⌉ = 9 ≤ maxShards = 12`，留 3 片余量；若沿用 200 000 的体积门，分片几乎永不触发（`200 000 / 120 000 = 2`），大 MR 会被直接拒检。

### 3. 模板与文档同步

`DEFAULT_LIMITS`、`DEFAULT_CONFIG_TEMPLATE`（含注释块，写明「12 万字符 ≈ 3.1 万 tokens diff + 4.5 万固定增长 ≈ 8 万峰值」）、仓库根 `PiAgent.example.jsonc`、使用手册 / 运行手册 / 全链路流程图 / `CONTEXT.md` 同步为同一组数字。

## Consequences

- 1 000 000 字符以内的 MR 不再被体积门拒检（旧值 200 000 会拒掉大部分真实大 MR）；超过 1M 仍在预检期报错、零模型请求；
- 单片峰值从实测 79.4% 降到预测 62%，为「skill 会话多读十几个文件」留出余量；撞 128K 的行为本身不变（仍是 `review turn failed` → `exit 1`，无重试、无降级），本 ADR 只是把触发概率压低，**没有**引入 token 计量或上下文压缩；
- 成本：1.5M 级 MR 从「8 片」变「9 片」，总 prompt +10%~20%（每片重付固定开销）；典型 225k MR 仍是 2 片，成本不变（实测 $0.06 / 456s）；
- 已知未同步项：`docs/png/review-*.dot|svg` 里的阈值仍停留在 ADR-0070 之前的 `1 500 000 / 400 000 / 12`（这批图自 0070 起就没再生成），属历史遗留，本 ADR 不重绘；
- 回放不受影响：冻结 trace 的请求体只依赖提示词与 diff，与 `limits` 数字无关；`large-mr.diff`（44 941 字符）在 80k / 120k 两种缺省下都是单遍。
- **测试面**：`shared/config.test.ts` 的 boundary / split 缺省断言同步为 `1_000_000` / `120_000` / `12`；`PiAgent.example.jsonc` 逐字节同源断言继续覆盖模板。
