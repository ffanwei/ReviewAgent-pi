# 0048. 离线 trace 回放与进程级并发阶梯（`replay` 工具）

**状态**：已接受（2026-11-07，用户逐题决策 Q1–Q23）
**关联**：ADR-0009（pi 内核从 0 重写）、ADR-0024（评测仪器层废止——本 ADR 只做回归与容量，不产指标）、ADR-0025（配置面）、ADR-0032 / ADR-0033（任务目录与运行留痕）、ADR-0039（分片串行）、ADR-0045（MCP 业务面）、ADR-0046（`limits.loop.maxRounds`）、ADR-0047（解析失败可见）

## Context

现状盘点：

| 既有件 | 位置 | 能力 | 并发下的问题 |
|---|---|---|---|
| `fakeFetch` | `src/provider/fake-fetch.ts` | 进程内位置队列回放 | 全局计数器 `replies[calls-1]`，N 个 run 互相偷回复 |
| `LoopbackStub` | `src/cli/bin.process.test.ts` | 真 HTTP 网关 stub（`/v1/models` + `/v1/chat/completions`） | 共享 FIFO `queue.shift()`，按到达序而非录制序 |
| `McpStub` | 同上 | `initialize` + `tools/call`（无条件成功） | 不可配延迟/失败，不落盘 |
| `recordingFetch` | `src/e2e/recording-fetch.ts` | tee 出 usage | 只抓 usage，响应体丢弃，无回放、无落盘 |

需求与约束：

- 不调真实模型完成一次完整检视（LLM 走回放），支撑快速回归。
- 进程级并发 ramp，探索机器可承受的并发上限。
- 回放时注入模拟 LLM 延迟，让并发测量接近真实用户视角。
- **产品 CLI 零新增面**（Q1）：只靠 `reviewer.baseUrl` / `mcp.servers.*.url` 指向本机。

决定性的既有事实：

- 检视主循环**每进程严格串行**（分片 `run/review-run.ts:415-442`、工具、skill 会话皆串行）；唯一的进程内并行是呈现引擎 suggestion 扇出（缺省 4、最大 16），统一 tips 路径下 `skipTips: true` 会关掉它。因此「机器并发」= N 个独立进程的负载，进程内并发没有意义。
- `taskToolsOn = reporter !== null && reportConfig !== null && reportConfig.task`（`cli/main.ts:180`）：MCP 一关，统一 tips、`reviews_tips_zh.json`、`saveReviewSummary`、报文生成全部关闭。core 场景因此不是完整出厂路径。
- 并发隔离必须**同时**独立 cwd（`.review-pi-session.json` / `review-result.json`）与独立 `--tasks-dir`（固定名 `runs/run.json` / `reviews_en.json` / `reviews_tips_zh.json`，以及**无锁**的 `.cache/rule-skills/<digest>` 解压）。
- `--out` 已移除，`--tasks-dir` + cwd 是唯一隔离手段。
- 审计 `requests[].wireBody` 是可重放的完整请求体；实测不含 runId / 时间戳，`tools` 在 12 次请求里逐字节相同；真实归档里 `audit.requests[]` 与 `session` assistant messages 按序一一对应（12↔12、14↔14）。
- 非官方 `reviewer.baseUrl` 缺省带 `max_tokens: 32768`；回放时 pin 同值，否则请求体第 1 轮就失配。

## Decision

### 1. 归属与入口（Q1、Q10）

仓库工具链，不放进产品包：

```text
scripts/offline-replay/
├── run.mjs                  # 编排入口（record / once / ramp）
├── lib/replay-server.mjs    # hash-keyed HTTP 回放服务 + MCP stub
├── lib/trace.mjs            # trace 读写、请求指纹、未命中诊断
├── lib/lane.mjs             # 每 worker 的 cwd / tasks-dir / 断言
├── lib/record.mjs           # 录制（v1 对本地 canned 模型 / v2 对真网关）
└── scenarios/*.json         # S1 / S2 / S3

packages/review-pi/testdata/traces/*.json
```

根 `package.json` 新增：

- `replay:record` —— 录制一条 trace
- `replay:once` —— 单次回放 + 语义断言
- `replay:ramp` —— 进程级并发阶梯
- `test:replay` —— CI 门（S1–S3 各一次）

场景 = JSON 描述 + 命令行覆盖（`--trace` / `--workers` / `--steps` / `--latency-ms` / `--fail-fast`）。产品代码零改动。

### 2. trace 格式（Q8、Q15）

```json
{
  "schemaVersion": 1,
  "id": "core-single-finding",
  "fixture": {
    "repo": "packages/review-pi/testdata/repos/sample",
    "mrDiff": "packages/review-pi/testdata/golden/vul4j-1.diff"
  },
  "model": { "id": "deepseek-v4-flash" },
  "tools": [],
  "interactions": [
    {
      "kind": "review",
      "requestHash": "sha256:…",
      "response": { "status": 200, "contentType": "text/event-stream", "body": "…" }
    }
  ]
}
```

- `tools` 只存一份（12 次请求逐字节相同）。
- 响应**必存原文**；请求体默认不存，只存 `requestHash`；`--store-requests` 写 sidecar `<trace>.requests.json`（gitignore）。
- 可选 `latencyMs` per interaction；`kind` = `"review"`（`stream:true`）或 `"oneshot"`（`stream:false`，报文/总结/呈现）。
- 预算：单场景 ≤ 300 KB，`testdata/traces/` 总量 ≤ 1 MB。大归档继续 gitignore。

### 3. trace 来源与 fixture 绑定（Q7、Q16）

**v1（本 ADR 落地）= 录制式离线跑**：用现有 canned 语料（`oneFindingCorpus` 等）+ 已提交 fixture，经「录制代理」包住真 `review-pi` 进程落一条 trace。
**v2 = 真网关录制代理**：同一个录制器换成真 `reviewer.baseUrl`，录原始 SSE 字节，提升保真度，不改 trace 格式。

收窄说明：Q7(a) 的字面方案是「从现有真实归档合成」，但 `run1/` 等归档的 fixture 在 `.cache/datasets/vul4j-repos/`（`.gitignore:59`），VUL4J-38 快照 0.61 MB / 167 文件；不入库则 CI 无法重建同样的工具结果 → 第 2 轮起请求体必然漂移、指纹全 miss。**trace 与 fixture 强绑定**，v1 因此选「已提交 fixture + 可复现录制」。真实归档留作本地 S4/S5 素材。

录制纪律：一次录制只跑一个 run（一个代理实例 = 一条 trace；请求体无 runId，无法从流量自动切分）；不存 `Authorization`；绝对路径落盘前换成 fixture 相对路径；trace 记下 `model.id` 与 `max_tokens` 口径供回放 pin 值。

### 4. 匹配与未命中（Q3、Q9）

- 指纹 = 原始请求体 UTF-8 的 `sha256:` 全量 hash；**不规范化**。
- 命中 = 严格相等；未命中 → 该 run 失败（退出码非 0），stderr 打印当前请求体、最近邻记录的 `requestHash` 与首个差异 JSON 路径（最近邻 = 首个差异路径最浅的那条）。
- 不做「顺序回退」：回退会把请求体漂移这个真问题掩盖掉。
- `GET /v1/models` 由服务端合成（回 trace 的 `model.id`），不进 `interactions`。

### 5. 回放服务（Q17）

一个 hash-keyed、无状态的本地 HTTP 服务，所有 worker 共享：

- `GET /v1/models` → `{ data: [{ id: <trace.model.id> }] }`
- `POST /v1/chat/completions` → 按指纹取 interaction；先 `sleep(latency)`，再一次性写完整 `response.body`（`contentType` 原样）。`stream:true/false` 都不分帧模拟（Q20）。
- 未在 trace 中的请求 → 500 + 一行诊断（不静默）。
- 同一端口另挂 MCP 端点（reporting 场景）：`initialize`、`tools/call`、通知 202；记录 `{name, args}`；可配 `latencyMs` / `failTools`，其延迟缺省 0 ms。

### 6. mock 边界（Q4、Q6）

| 依赖 | 处理 |
|---|---|
| LLM（检视回合 / 报文 / 总结 / 呈现投影） | replay（服务端返回 trace 原文） |
| 本地工具（`get_diff` / `get_file` / grep / `call_chain` …） | **保留真实**，跑在固定 fixture 上 |
| MCP 业务 tool | core 场景整体省略；reporting 场景指向上面的 MCP stub |

### 7. 并发隔离（Q5、Q17）

进程级阶梯，不用进程内并发。每个 worker = 一个 **lane**：

- 独立 cwd：`<runDir>/workers/<n>/cwd`
- 独立 `--tasks-dir`：`<runDir>/workers/<n>/tasks`
- `--taskId t-1` 固定
- 配置文件只读共享（`--config`），`reviewer.baseUrl` / MCP url 指向共享回放服务
- `--model` 固定为 trace 的 `model.id`；`reviewer.maxOutputTokens` 与录制口径一致

只隔离其中一个仍会撞（见 Context）。

### 8. 模拟延迟（Q20、Q21）

```json
"latency": { "mode": "none" | "fixed", "ms": 1500, "jitter": 0.2, "seed": 42 }
```

- 语义 = 每个 interaction 的**总耗时**，不是逐帧 TTFT。v1 合成 SSE 只有 4–6 帧，逐帧模拟是假精细；归档也没有逐帧时间。
- `replay:once` 缺省 `mode: "none"`；`replay:ramp` 缺省 `mode: "fixed", ms: 1500, jitter: 0.2, seed: 42`。
- 抖动按 seed 确定性生成，保证同一轮 ramp 可复现。
- per-interaction `latencyMs` 覆盖全局（报文/总结这类短调用可给 300 ms）。
- MCP stub 缺省 0 ms，reporting 场景可单独配。

### 9. ramp 方法学（Q11）

- 档位：缺省 `[1, 2, 4, 8, 16, 32]`，可配（如 `[1, 5, 10, 20, 30]`，上限即最后一个档位）。
- 每档：1 次 warmup（不计入）+ 3 次测量；每次 = 同时 spawn N 个 worker 跑同一场景。
- 基线：单 run × 3，取 wall 中位数。
- 停止条件（任一命中即停）：某 worker 失败 / 语义断言失败 / p95 > 基线 2× / 到达配置上限 / 峰值 RSS 或句柄数超过告警阈值。
- 「极限」= 满足「全部成功且 p95 ≤ 2× 基线」的最大档位；**必须与延迟档位一起报告**。
- 输入：ramp 复用同一 fixture 重复 N 次（隔离并发效应）；mixed 场景只做正确性、不做计时。
- 每档记录：success、wall median/p95、进程树峰值 RSS、CPU、失败原因与 stderr 尾巴。

### 10. 安全阀（Q23）

- 启动前校验：`latencyMs × (1 + jitter) < 0.5 ×` 对应产品超时。oneshot / 报文 / 总结用 `limits.timeouts.presentationRequestMs`（缺省 90 s）；MCP stub 用对应 `mcp.servers.*.timeoutMs`；**检视回合没有产品超时**，用 runner 侧硬上限 60 s。违反 → 拒绝启动，一行原因。
- 整轮 ramp 全局超时 = `最高档位 × 单 run 上限 × 1.5`（单 run 上限可配，缺省取基线 × 3）。

### 11. 场景集与断言（Q12、Q14、Q18）

v1 = 3 条 trace：

| id | MCP | 覆盖 |
|---|---|---|
| `core-single-finding` | 省略 | 主循环、单 finding、stdout、退出码 |
| `core-no-finding` | 省略 | 空 findings、无 tips、无总结 |
| `reporting-single-finding` | stub | 完整路径 + 上报序列 + 统一 tips |

- 通用断言：exit 0；`runs/reviews_en.json` 的 findings 集合（`file` / `line` / `severity` / `title` / `rule`）；审计阶段序列与轮次数；`reviews_tips_zh.json` 的有/无与 12 键。
- core 场景：MCP stub 收到的业务调用数 = 0。
- reporting 场景：tool 名序列 = `startTask → mrReviewResult → saveReviewSummary → endTask`；每个 `filePath` 集合；`reviewTips` 条数；8 字段类型/枚举；有意见/无意见文件覆盖。**不逐字匹配文案**。
- 逐字节比对留待冻结 `runId` / `generatedAt`（v2），v1 不做。
- S4（分片）/ S5（rule-skill）留 v2。

### 12. CI 与产物（Q19）

- `pnpm test:replay` 作为**独立 job**（S1–S3 各一次，`latency: none`），不进 `pnpm test`。
- `replay:ramp` 只在本地或 nightly，**不作为性能门禁**（CI runner 的并发上限与开发机不同，红绿不可解释）。
- 运行产物落 `replay-runs/<timestamp>/`（gitignore）：`report.json` / `report.md` / `workers/<n>/{cwd,tasks,stdout,stderr}`。

## Options（为什么不是别的）

- **产品内建 `--replay`**：要给产品加长期兼容面，replay 数据还要排除出 tarball；现有 `baseUrl` 已经够用。
- **语义层回放（跳过 HTTP）**：最快，但测不到 SDK 序列化 / SSE 分帧 / usage 解析；并发探索要测的正是真进程 + 真 HTTP。
- **顺序队列按 worker 复制**：并发下到达序 ≠ 录制序，必然错配；指纹是无状态的。
- **每 worker 一个回放服务**：端口与进程数线性膨胀，还掩盖了「共享网关」这一真实拓扑。
- **逐帧 TTFT 延迟**：v1 合成 SSE 只有 4–6 帧，逐帧只是假精细；v2 有真实录制再上。
- **ramp 作 CI 性能门禁**：CI runner 规格不稳定，红绿不可解释。

## Consequences

- **正**：离线可跑完整检视（含 reporting 路径）；单 run 与 N run 用同一套 trace；并发上限可量化且可复现；产品零改动。
- **负 / 风险**：trace 与 fixture 强绑定，改 fixture 必须重录；v1 响应来自 canned 语料，保真度低于真实模型（但回归测的是行为，不是模型质量）；ramp 数字只对录制时的延迟档位与机器有效。
- **中性**：`CONTEXT.md` 新增 6 个术语；`docs/adr/README.md` 增一行；`.gitignore` 增 `replay-runs/`；CI 增一个 job。

## 验收标准

1. `node scripts/offline-replay/run.mjs once --scenario core-single-finding` 在断网、无真实 key 的机器上 exit 0，findings 与断言一致。
2. reporting 场景断言 `startTask → mrReviewResult → saveReviewSummary → endTask`；core 场景断言 0 次业务调用。
3. `--latency-ms 1500` 下 wall 时间 ≥ interaction 数 × 1500 ms（延迟确实生效）。
4. 篡改一条 trace 的 `requestHash` → 未命中报错、退出码非 0，stderr 含当前请求体与最近邻 hash。
5. `node scripts/offline-replay/run.mjs ramp --steps 1,2,4` 输出三档 success / p95 / 峰值 RSS，且档位与延迟档位在报告里可见。
6. `latencyMs` 超过对应超时 50% → 拒绝启动。
7. `node --check` 全部脚本通过；`pnpm -r typecheck`、`pnpm test` 全绿（脚本是 `.mjs`，不进 TS 编译）。

## 后续修订

（正文按决策时点保留，不改写；落地与正文的差异记在这里。）

1. **文件布局**：`lib/record.mjs` 未独立成文件——录制逻辑合在 `run.mjs record` 子命令与 `lib/replay-server.mjs` 的 `record` 模式里（录制器与回放器共用同一套请求/响应路径，拆开反而要复制一遍命中/落盘逻辑）。实际新增：`lib/{sse,corpora,scenario,cli,assert,metrics,report}.mjs`、`test-all.mjs`（`test:replay` 入口）。`lib/lane.mjs` 只负责隔离目录与 CLI 参数，断言在 `lib/assert.mjs`。
2. **未命中诊断形态**：决策 4 写的是「首个差异 JSON 路径」；落地按 `requestShape`（model / stream / max_tokens / tools digest / 每条消息角色+字符数+hash）找最近邻，打印首个不同的 `messages[i]`、两侧字符数与当前请求体前 2000 字符。比 JSON path 粗，但不存请求体也能定位漂移。
3. **ramp 缺省延迟**：场景 `latency.mode === "none"` 且命令行未显式给 `--latency-mode` / `--latency-ms` 时，`ramp` 自动注入 `fixed 1500ms / jitter 0.2 / seed 42`；要一组无延迟基线就显式 `--latency-mode none`（此时 harness 开销基线也跳过，不再重复跑同一档）。
4. **场景可声明 `ramp.steps`**：`scenario.ramp.steps` 与 `--steps` 同语义，命令行优先。
5. **无 `--fail-fast`**：ramp 的停止条件本来就含「某 worker 失败即停当前档并结束阶梯」，单独开关没有新增语义。
6. **`/v1/models`**：回放模式取 `trace.model.id`（录制模式取场景 `model`），保证模型探针口径与录制时一致。
7. **已识别的 v2 schema 约束（S5 rule-skill）**：skill 会话的工具面是七检视工具 + `bash`（八只），当前 `tools` 为全 trace 共享一份且要求逐字节一致；S5 落地前必须先决定「per-interaction `tools`（schemaVersion 2）」还是「按会话拆 trace」。S4 分片不需要改 schema；真网关录制也不需要（只换录制源）。
8. **v2 已落地**：S5 / S4 / 真网关录制代理均已完成，trace schema 升到 2（`toolsVariants[]` + 每 interaction 的 `toolsRef`，兼容读 v1），并新增 lane 路径归一化与 `--upstream-*` 录制参数。见 [ADR-0049](0049-trace-schema-v2-and-upstream-recording.md)。
