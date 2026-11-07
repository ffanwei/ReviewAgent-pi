# 0049. trace schema v2、lane 路径归一化与真网关录制

**状态**：已接受（2026-11-07，v2 实施）
**关联**：ADR-0014（规则 Skill 独立会话）、ADR-0018（`--rule-skill` 目录装载与缓存）、ADR-0039（大 MR 分片）、ADR-0045（MCP 业务面）、ADR-0048（离线回放 v1）

## Context

ADR-0048 的 v1 只覆盖「单遍检视、无规则 Skill、无分片」。把三条生产路径纳入回放时，暴露了三个硬约束：

1. **工具面不再唯一**：主检视会话发七只检视工具；规则 Skill 会话发七只 + `bash`（`knowledge/skill-pass.ts:33`）。v1 的 `tools` 是全 trace 共享一份，录制时校验「所有请求逐字节一致」，S5 必然报错。
2. **规则 Skill 请求含运行期绝对路径**：`@earendil-works/pi-agent-core` 的 `formatSkillInvocation` 生成
   `<skill name="…" location="<filePath>">\nReferences are relative to <dirname>…`；
   而 `--rule-skill` 会先把包复制到 `<tasksDir>/<taskId>/.cache/rule-skills/dir-<digest>/`（`knowledge/rule-skill.ts:361`），`filePath` 因此带 **lane 自己的绝对路径**。指纹若直接哈希原始字节，trace 就绑死一次运行的目录：换 worker、换一次运行、CI 全部未命中。
3. **录制源只有 canned 语料**：v1 的响应由 `lib/corpora.mjs` 渲染，行为对但字节不对（SSE 分帧、usage 字段、真实工具调用都测不到）。

S4 分片本身不需要改 schema：两个片是同一进程内的两套六相位，工具面与主会话一致，只是消息内容不同。

## Decision

### 1. trace schemaVersion 2：`toolsVariants[]` + `toolsRef`

```json
{
  "schemaVersion": 2,
  "toolsVariants": [
    { "digest": "sha256:…", "tools": [ /* 主会话七只 */ ] },
    { "digest": "sha256:…", "tools": [ /* skill 会话八只（含 bash） */ ] }
  ],
  "interactions": [
    { "kind": "review", "requestHash": "sha256:…", "toolsRef": "sha256:…", "response": { … } }
  ]
}
```

- `tools` 按 `JSON.stringify(tools)` 的 SHA-256 **去重**；同一 digest 若内容不同则录制直接失败（污染检测）。
- 每条 `review` interaction 必须带 `toolsRef`；`oneshot` 可为 `null`（报文/总结不携带工具面）。
- `validateTrace` 兼容读 v1：v1 仍按共享 `tools` 校验，回放时不做任何归一化，历史 trace 不受影响。
- 未命中诊断会说明「该工具面在 trace 里存在 / 不存在」，便于区分「漏录某类会话」与「消息漂移」。

### 2. lane 路径归一化（只抹运行期目录，不抹请求内容）

- trace 增加可选字段 `requestNormalization: { "placeholders": ["<lane>"] }`。
- 录制时 `run.mjs` 把 lane 目录注册给回放服务（`addPathRoot(lane.dir, "<lane>")`），**先**把请求体里的 lane 绝对路径替换成占位符，**再**算 `requestHash` / `requestShape`。
- 回放时同样按 trace 声明启用归一化；每个 lane 建好后注册自己的目录。因为所有 lane 都映射到同一个 `<lane>`，同一 trace 可以跨 worker、跨运行、跨机器（只要路径结构由 lane 根派生）命中。
- 归一化只替换**显式注册的根**，且同时覆盖原生反斜杠、正斜杠与 JSON 转义形态；模型、消息、工具、参数、diff 内容仍全量参与哈希——请求漂移照旧显式失败。
- 没有 `requestNormalization` 的 v1 trace 保持原样哈希，不启用任何替换。

### 3. 落盘脱敏（不参与指纹）

录制时对**响应体**与 `--store-requests` sidecar 做 `sanitizeText`：lane 目录、规则包源目录、夹具仓、仓库根、`$HOME` 分别替换为 `<lane>` / `<rule-skill>` / `<fixture-repo>` / `<repo-root>` / `<home>`。指纹在替换前已按第 2 条算好，脱敏只影响可提交的字节，不会让回放失配。

### 4. 真网关录制代理（trace 格式不变）

`record` 新增：

| 选项 | 说明 |
|---|---|
| `--upstream-base-url <url>`（或 `REPLAY_UPSTREAM_BASE_URL`） | 与 `reviewer.baseUrl` 同口径（含 `/v1`、`/api/v3` 等前缀）；给了就代理真网关，忽略 canned `corpus` |
| `--upstream-api-key <key>`（或 `REPLAY_UPSTREAM_API_KEY`） | 作为 `Authorization: Bearer` 注入；不写进 trace、不落盘 |
| `--upstream-timeout-ms <n>` | 单次上游请求超时（默认 120000）；超时回 500，录制失败 |

上下游都是**原样转发**：请求体直接送上游，响应体（含 SSE 原文与 `content-type`）原样冻结。录制完仍会立即用同一份 trace 回放自检，通过才覆盖。

### 5. 新增场景与语料

| 场景 | 覆盖 | trace 规模 |
|---|---|---|
| `rule-skill-single-finding` | 1 个规则 Skill：主候选 + skill 候选 + Phase 6 联合裁定；审计 `ruleSkill` / `skillPassLog`、skill 转录、`.cache/rule-skills/dir-<digest>` | 7 interactions / 2 toolsVariants |
| `shard-two-file` | `limits.split.maxShardChars = 10000` 触发两片；每片六相位、跨片 findings 合并、`run.json.shards[]`、`[sN/M]` stderr | 12 interactions / 1 toolsVariant |

新增夹具 `testdata/golden/two-file-shard.diff`（11,545 字符，两块各 ~5.8 KB，变更行 164 < 200），不造 400 KB 大文件。

### 6. 断言面扩展

`lib/assert.mjs` 新增：

- `expect.shards: [1,2]` —— `run.json.shards[].index`、每片 `transcriptFile` / `auditFile` 可寻址、聚合审计 `audit.shards[].index`；
- `expect.stderrContains: ["…"]` —— stderr 必须包含的片段（如分片提示）；
- `expect.ruleSkill: { name, kind }` —— 审计 `ruleSkill` 条数、名称、`kind`、64 位 digest；
- `expect.skillPassLog: N` —— 审计 `skillPassLog` 条数与 `skill` 字段；
- `expect.skillTranscript: "<name>"` —— 存在 `*-skill-<name>-r1.json`，且转录含 `Host platform:`；
- `expect.ruleSkillCache: true` —— `.cache/rule-skills/dir-<digest>/{SKILL.md,.rule-skill-ready,rules/}` 存在。

## Consequences

- v1 trace 继续可读、可回放；v2 trace 才带 `toolsVariants` 与归一化。旧 trace 不重录也能跑。
- 归一化的范围刻意很窄：只处理**运行期目录**。如果未来请求体引入其他每次运行都变的字段（时间戳、runId），必须显式加占位符，而不是放宽成模糊匹配。
- 脱敏后的响应体是提交进仓库的字节；如果模型回复里包含被替换掉的绝对路径，回放会返回占位符。对当前 canned 语料与规则 Skill 候选（相对文件路径）没有影响；真网关录制需要人工检查一次。
- trace 体积：S5 约 35 KB、S4 约 41 KB（含源文件摘要与 skill 候选），单场景仍远低于 300 KB、总预算 1 MB。
- 真网关录制需要真实 key 与网络，只能本地录；`--upstream-api-key` 只存在于进程环境/参数，不写 trace。真实 SSE 体积会大于 canned，重录后要重新量预算。

## 验收

1. `pnpm test:replay` 五个场景全 PASS（3 个 v1 + S5 + S4）。
2. v1 三个场景在 schema v2 代码上回放结果不变（未命中 0、断言全过）。
3. `rule-skill-single-finding --workers 3` 与 `shard-two-file --workers 3` 全 PASS：归一化后同一 trace 可被多个 lane 同时命中。
4. S5 审计含 `ruleSkill[0] = { kind: "dir", name: "general-code-review", digest: 64hex }` 与 `skillPassLog` 1 条；skill 转录与规则包缓存文件存在。
5. S4 `run.json.shards` 为 `[1,2]`，两份片转录/片审计可寻址，stderr 含「分片检视 2 片」，findings 合并为 Alpha.java / Beta.java 两条。
6. 篡改 `requestHash` 仍退出 1 并给最近邻诊断；`requestNormalization` 只在 trace 声明时启用。
7. 真网关代理：本地假上游端到端录一条 trace 并通过回放自检；`--upstream-timeout-ms 800` 对不响应的上游在 ~1 s 内失败；落盘 trace 不含本机绝对路径。
