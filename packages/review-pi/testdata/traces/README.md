# 离线回放轨迹（ADR-0048 / ADR-0049）

本目录存放**冻结的 wire 轨迹**：每条记录 = 一次真实请求体的 SHA-256 指纹 +
当时原样返回的响应（检视回合是 SSE 原文，报文/总结是非流式 JSON 原文）。

回放时不调真实模型：本地 HTTP 服务按 `requestHash` 严格命中，命中即原样返回
响应字节。请求体默认不存（只用指纹匹配）；未命中直接失败并打印最近邻诊断。

完整用法与参数见 [`docs/运行手册-离线回放.md`](../../../docs/运行手册-离线回放.md)；决策背景见
[ADR-0048](../../../docs/adr/0048-offline-trace-replay-and-concurrency-ramp.md) 与
[ADR-0049](../../../docs/adr/0049-trace-schema-v2-and-upstream-recording.md)。

## 文件

| 文件 | 场景 | fixture | schema |
|---|---|---|---|
| `core-single-finding.json` | `core-lite`：一条 finding，无 MCP | `testdata/repos/sample` + `testdata/golden/vul4j-1.diff` | v1 |
| `core-no-finding.json` | `core-lite`：零 finding | 同上 | v1 |
| `reporting-single-finding.json` | `reporting`：MCP stub + 报文 + 总结 | 同上 | v1 |
| `rule-skill-single-finding.json` | 规则 Skill：主候选 + skill 候选 + Phase 6 联合裁定 | 同上 + `testdata/rule-skills/general-code-review` | v2 |
| `shard-two-file.json` | 两片串行：每片六相位、跨片 findings 合并 | 同上 + `testdata/golden/two-file-shard.diff` | v2 |

单文件约 22–42 KB；五个合计 < 150 KB。

## schema v2（ADR-0049）

v1 的 `tools` 是全 trace 共享一份；v2 改为：

```json
{
  "schemaVersion": 2,
  "toolsVariants": [{ "digest": "sha256:…", "tools": [ … ] }],
  "requestNormalization": { "placeholders": ["<lane>"] },
  "interactions": [{ "kind": "review", "toolsRef": "sha256:…", "requestHash": "sha256:…" }]
}
```

- 主会话七只工具、规则 Skill 会话八只（多 `bash`）→ 两个 variant；`toolsRef` 指向本条用的那份。
- `requestNormalization` 启用时，录制与回放都先把 lane 目录替换成 `<lane>` 再算指纹。规则 Skill 的 `location="…"` 带 lane 绝对路径，不归一化就不能跨 worker / 跨运行回放。
- v1 trace 没有该字段，继续按原样哈希；**不要手工把 v1 trace 改写成 v2**，需要新格式就重录。

## 用法

```bash
# 跑一遍（单 worker，latency 按场景声明）
pnpm replay:once core-single-finding

# 并发阶梯（本地探极限，不进 CI 门禁）
pnpm replay:ramp core-single-finding --steps 1,5,10,20,30

# CI 全场景
pnpm test:replay
```

产物落在 `replay-runs/<时间戳>-<场景>/`（gitignored）：每个 worker 有独立
`cwd/`、`home/`、`tasks/`，`report.json` / `report.md` 是结果。

## 什么时候必须重录

请求体的任何一个字节变了，指纹就变，回放会明确失败。常见触发：

- `packages/review-pi/src` 里的提示词、工具定义（`wireBody.tools`）、系统消息；
- `testdata/repos/sample` 夹具仓或 `testdata/golden/{vul4j-1,two-file-shard}.diff` 改动；
- `testdata/rule-skills/general-code-review/` 内容改动（规则包 digest / skill 会话提示词会变）；
- `REVIEW_MODEL_ID` / `max_tokens` 缺省值 / `reasoningEffort` 等请求参数；
- 会话消息拼装顺序（阶段推进、finding 反馈、skill 会话、分片）变化。

重录：

```bash
pnpm replay:record core-single-finding
pnpm replay:record core-no-finding
pnpm replay:record reporting-single-finding
pnpm replay:record rule-skill-single-finding
pnpm replay:record shard-two-file
```

`record` 先用 canned 语料跑一次真实 CLI（进程内回放服务当场记录请求/响应），
再**立即用同一份 trace 回放一次自检**，两步都通过才落盘覆盖原 trace。任何
语义断言（findings / tips / 审计阶段 / MCP 序列 / 分片 / 规则 Skill）失败则拒绝落盘。

要录真实网关的原始 SSE（trace 格式不变，只是响应字节来自线上）：

```bash
node scripts/offline-replay/run.mjs record --scenario core-single-finding \
  --upstream-base-url https://<gateway>/v1 \
  --upstream-api-key "$REPLAY_UPSTREAM_API_KEY"
```

key 只经参数或环境变量注入，不写进 trace；响应体与 `--store-requests` sidecar
在落盘前会做路径脱敏（`<lane>` / `<repo-root>` / `<home>` 等）。

需要看请求体原文排查指纹漂移时：

```bash
node scripts/offline-replay/run.mjs record --scenario core-single-finding --store-requests
```

会额外写出 `*.requests.json` sidecar（**不要提交**：含完整提示词与 diff）。

## 纪律

- trace 是产物，不是配置：不要手工编辑；要改就重录。
- 指纹严格匹配：除 trace 声明过的 `<lane>` 路径占位外，不做任何规范化、不做顺序回退——请求漂移必须显式暴露。
- 响应体是冻结字节（含 SSE 帧切分），改 `lib/sse.mjs` 渲染器**不会**改旧 trace。
