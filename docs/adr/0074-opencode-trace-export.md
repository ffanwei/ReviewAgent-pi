# 0074. opencode-trace 兼容导出（供 opencode-trace-viewer 消费）

**状态**：已接受（2026-11-11，随代码落地）
**关联**：ADR-0037（`audit.requests[]` 逐请求 wire 捕获）、ADR-0072（OpenCode 会话导出）、ADR-0013（检视转录原生真源）、ADR-0036（`review-pi export`）
**跨仓**：本 ADR 为本仓 pi 线序列 0074；引用 DSH 兄弟仓决策须写全限定语「DSH 线 ADR-XXXX」。

## Context

目标工具是 `opencode-trace-viewer`（`aixmoyu/opencode-trace` 的 `@opencode-trace/viewer`）。它读的是 **per-request 原始 wire trace**，不是 ADR-0072 的 `{info, messages}` 会话导出。两者是 OpenCode 生态里两套不同数据：会话导出是「对话消息投影」，trace 是「每次模型请求的原始 request/response」。

其 import 是 ZIP（或含 `manifest.json` 的目录），结构：

```text
manifest.json                          ← { exportedAt, mainSession, sessions: string[], version: "1.0" }
sessions/<session-id>/metadata.json     ← { sessionId, title?, parentID?, subSessions?, createdAt?, updatedAt? }
sessions/<session-id>/1.json … N.json   ← 每条 = 一次请求的 TraceRecord
sessions/<session-id>/1.sse …           ← 可选（SSE 流，本仓不产）
```

`TraceRecord`（zod schema，`id` 正整数、`purpose` 字符串、`requestAt`/`responseAt` 字符串、`request{method,url,headers,body}`、`response{status,statusText,headers,body}|null`、`error{message}|null`、可选的 `requestSentAt`/`firstTokenAt`/`lastTokenAt`）。

viewer 靠 `request.body.messages`（每次请求携带的累计历史，逐条 diff 出「新增/删除」）与 `response.body.choices[0].message`（本轮模型回复的 text/thinking/tool_call 分块）渲染「每一轮问/答」。

## Decision

### 1. run 时默认落盘 `<runs>/opencode-trace/`，`export --trace` 只复制

trace 在 **run 时默认生成**（与 ADR-0072 兼容版同族）：`review` 成功后在 `<runs>/opencode-trace/` 落一份与 opencode-trace import 同构的目录：

```text
<runs>/opencode-trace/manifest.json
<runs>/opencode-trace/sessions/<sessionId>/metadata.json
<runs>/opencode-trace/sessions/<sessionId>/1.json … N.json
```

读本次 run 的**原生转录** + **审计 `requests[]`**（纯文件系统，不加载配置、不调模型）。`review-pi export --trace <dir>` 只把这份已落盘目录复制到 `<dir>`（供 zip 后喂 import）。

`manifest.json`：`{ exportedAt, mainSession, sessions: [主会话 id…], version: "1.0" }`。单遍 = 1 个主会话；分片 = N 个 shard 主会话（`mainSession` = 首片，`sessions` = 各片按片序）。

### 2. request = 真实 wire；response = 合成（非逐字节）

- **request.body** = `audit.requests[i].wireBody` 原文（`JSON.parse` 回对象——含 `model/messages/tools/stream/max_tokens/…`，即发往网关的 OpenAI 请求体，逐字节真源）；`method="POST"`、`url=<baseUrl>/chat/completions`、`headers={"content-type":"application/json"}`。
- **response.body** = 从转录里第 i 条 assistant 合成 OpenAI `chat.completion`：`text`→`content`、`thinking`→`reasoning_content`、`toolCall`→`tool_calls`（`arguments` 为 `JSON.stringify`）；`finish_reason` 由 `stopReason` 映射（`toolUse`→`tool_calls`）；`usage` 从 `usage.input/output/cacheRead/cacheWrite` 折算。`status=200`。
- 请求与响应的对应关系 = **第 i 条 `requests[]` ↔ 第 i 条 assistant**（正常 run 恒 1:1；重试会 `requests > assistant`，此时多余请求记 `response:null`，`error` 留空）。

这是「能看到每一轮问/答成什么」的取舍：request 侧逐字节真实，response 侧是「解析后的内容」重放，不是原始 SSE 字节（本仓不捕获响应 wire / SSE——ADR-0002 字节兼容冻结线，不碰）。

### 3. 范围：只导出主会话；skill 会话 v1 不产出 trace

主会话有 `audit.requests[]`（真实 wire）+ 转录（合成 response 的原料）。skill 子会话是「非测量档」（ADR-0014），无 wire——v1 **不**为 skill 生成 trace（manifest.sessions 只含主会话）。skill 会话仍可用 ADR-0072 的 `{info,messages}` 兼容版查看。列为已知缺口，需要时另议。

### 4. `metadata.json` 与主会话 id 复用既有约定

- `sessionId` = 主会话 `info.id`（`session-<runId>`）；`title` = `info.title`（caseId）；`createdAt`/`updatedAt` = `info.time`；无 `parentID`（主会话顶层）。
- 分片时各 shard 主会话独立成一条 trace session（id = `session-<shardRunId>`），不做父子关系（trace 语义与 ADR-0073 的 lifecycle 会话父子关系是两套东西，不混用）。

## Options（为什么不是别的）

- **响应侧真捕获原始 wire**：需在 pi-ai 流式序列化上新增响应侧捕获，碰 ADR-0002 字节兼容冻结线、且要重看流式语义。否（本轮明确「看到问/答」即可）。
- **skill 也合成 request+response**：可从转录双向合成，但 request 侧变成「pi 消息 → wire 格式」的损失投影，且工作量大。v1 否，留缺口。
- **改用 `{info,messages}` 让 viewer 直接读**：viewer 不读这个格式（它读 per-request wire）。否。
- **新增 zip 依赖打包**：Node 无内置 zip，viewer 的 import 接受含 `manifest.json` 的目录（用户自行 zip 或前端目录导入）。否（只产目录，零依赖）。

## Consequences

- **正**：review 会话可被 `opencode-trace-viewer` 逐请求检视（时间线、token 用量、逐请求 diff、text/thinking/tool_call 分块）。
- **负 / 风险**：
  - response 是合成重放（非原始字节）；重试场景下请求↔响应错位时多余请求 `response:null`；
  - skill 会话无 trace（v1 缺口）；
  - `request.url` 依赖 `info.model.baseUrl`（网关地址），若 baseUrl 缺失则退化为占位。
- **中性**：原生转录 / 审计 / 既有 `{info,messages}` 兼容版全部不变；trace 是纯导出视图。

## 验收标准

1. **单遍**：`review-pi export --trace <dir>` 产出 `manifest.json` + `sessions/<sessionId>/{metadata.json, 1..N.json}`；`N` = 审计 `requests[]` 条数；`N.json.request.body` 与审计 `wireBody` 逐字节一致；`response.body.choices[0].message` 含本轮 text/tool_calls。
2. **分片**：`manifest.sessions` = N 个 shard 主会话（片序），各 shard 目录有各自的 `N.json`。
3. **可消费**：`opencode-trace-viewer -d <dir>/sessions`（或把 `<dir>` 打成 zip 走 import）能列出会话、渲染逐请求时间线与 text/thinking/tool_call 分块。

## 实施记录（2026-11-11）

| 文件 | 内容 |
|---|---|
| `packages/review-pi/src/export/trace-export.ts` | `buildTraceSession`（request=wireBody 原文、response 合成）、`auditPathOf`、`writeTraceBundle`、`loadTraceSession`、`writeRunTrace`（run 时落盘 `<runs>/opencode-trace/`）、`runsDirOf`、`TraceRecord`/`TraceManifest` 类型 |
| `packages/review-pi/src/cli/main.ts` | 收尾 `writeRunTrace`（与 lifecycle 留痕同块，失败只警告） |
| `packages/review-pi/src/cli/args.ts` | `--trace <dir>` 旗标与 usage |
| `packages/review-pi/src/cli/export-command.ts` | `--trace` 复制已落盘的 `<runs>/opencode-trace/` |
| 测试 | `trace-export.test.ts`（auditPathOf 变换 + 映射/合成形态） |

### 真机验证（2026-11-11）

用分片 run `large-mr-shard-mcp-probe` 真跑导出 + viewer 实读：

- `review-pi export --trace` 产出 `manifest.json`（mainSession=s01、sessions=5 个 shard 主会话、version 1.0）+ 各 shard `sessions/<id>/{metadata.json, 1..N.json}`（N=13/10/10/11/13，与审计 `requests[]` 一致）；
- `request.body` = 审计 `wireBody` 原文（model/messages/tools/stream/max_tokens…），`response.body.choices[0].message` 含 content/reasoning_content/tool_calls（合成）；
- `npx @opencode-trace/viewer -d <dir>/sessions` 成功列出 5 个会话、`/api/sessions/:id/timeline` 返回 13 条请求的逐请求 diff、`/api/sessions/:id/records/1` 返回完整 request/response。
