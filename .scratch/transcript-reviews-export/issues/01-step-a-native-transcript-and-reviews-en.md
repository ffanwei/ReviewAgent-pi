# 01 — Step A：内核原生转录 + `reviews_en.json`

`Status: ready-for-agent`

- **Spec**: `.scratch/transcript-reviews-export/spec.md`（Step A 范围）
- **ADR**: `docs/adr/0013-review-transcript-and-findings-export-as-run-artifacts.md`
- **术语**: `CONTEXT.md` → 「检视转录」「检视意见导出」
- **前置**: 无（本票不碰网络、不碰密钥、不引入新依赖）

## 目标

让每次**工具驱动**检视（C/D/E/F）在收尾时落两个新文件，且**不动请求字节、不动审计与 `RunRecord` 形状**：

1. **检视转录** `session-<compactFirstRequestAt>-<configId>-<caseId>.json`，与 `rep-<N>.json` 平铺；本票只含 `{ info, messages }`（`view` 属 Step B）。
2. **`reviews_en.json`** 落在 `.../<configId>/rep-<N>/`。

## 交付物

### D1 — 内核捕获 `firstRequestAt`

- `packages/review-pi/src/loop/agent-review-loop.ts`：在 **首次模型请求**处记录一个时间戳（唯一新增仪器；**不是**逐请求/逐工具耗时）。
- **不要**改 `WireRequest` / `ToolCallRecord` / `PhaseRecord` 的形状。
- **不要**改 `review-run.ts` 入口的 `startedAt` 语义。

### D2 — 内核导出转录

- `AgentReviewLoopOutcome`（同文件 76-84 行）新增一个字段把 **`agent.state.messages` 原样**（pi-ai `Message[]`）与本票的 `firstRequestAt` 带出来。A/B 路径（`loop/review-loop.ts`）**不改**。
- 新模块（建议 `packages/review-pi/src/export/`）负责组装落盘文档：
  - `messages` = `[{ "role": "system", "content": <Zone A systemPrompt> }, ...transcript]`（**合成 `messages[0]`**；转录其余部分逐字原样，不截断、不改名）。
  - `info` = **恰好**这些键（**省键纪律**，不得出现 `version` / `projectID` / `kind` / `info.time.durationMs` / `info.systemPrompt`）：
    `id`（文件名 stem）· `runId`（审计 `runId`，配对键）· `agent`(`"review"`) · `configId` · `model{id,baseUrl}` · `tokens{input,output,reasoning,cache{read,write}}`（逐条 assistant `usage` 求和）· `cost{input,output,cacheRead,cacheWrite,total}`（逐条 `usage.cost` 求和）· `outcome` · `time{created: firstRequestAt, completed: finishedAt}` · `title`(=caseId) · `location{directory: repoPath}` · `perMessageTimestamps`(`"unavailable"`)。
  - **`usage` 口径**：`info` 与 `messages` 里的 usage 走 **pi-ai `Usage` 全量**（含 `cost`/`reasoning`/`cacheWrite1h`），**不是**内核 `LlmUsage`。
  - 文件名/路径格式见 spec；`compactFirstRequestAt` 复用 `audit-writer.ts:68-72` 的时间戳写法。

### D3 — `reviews_en.json`

- 落 `.../<configId>/rep-<N>/reviews_en.json`；**全配置**（A/B 也写；A/B 无 session 文件）。
- 信封：`{ generatedAt, runId, source, caseId, configId, rep, model, findings }`。
- `findings` = 完整 `Finding` 对象，**保序**（与 `record.baseline.findings` 同序、深相等），恒英文。

### D4 — 路径与落盘

- 复用既有 `runsRoot` / `experimentId` / `source` / `caseId` 布局（`run-record.ts:137-149`、`review-run.ts:206-218` 是路径构建先例）。
- **写失败抛错**（与 `writeAuditFile` / `writeRunRecord` 同档），不静默。
- CLI 与根侧 runner **都不需要改**：两者都经内核 `runReview`，内核写即两处都有（runner 的 `persistRecord:false` 只关记录落盘，不影响本票）。

### D5 — 测试（S1 = `runReview` 公共入口）

- **零漂移**：A–F phase golden / system-prompt golden / 工具面 golden / 字节门 / 语义等价门 **全绿不改**。
- **审计与 `RunRecord` 形状零漂移**：断言无新键（转录路径只出现在返回结果里，不嵌进审计/记录）。
- **转录 golden**（离线 fake transport，C/D/E/F 各一）：`info` 键集合**恰好**等于 D2 清单；`messages[0].role === "system"` 且内容 = Zone A 提示词；`messages[1..]` 逐字等于 loop 转录；`info.runId` 等于审计 `runId`；文件名/路径符合 spec；**无 `version`/`projectID`/`view` 键**。
- **共存**：同 case/config 跑两次 → 两个不同的 session 文件都在（`firstRequestAt` 不同）。
- **`reviews_en.json`**：信封键精确；`findings` 与 `record.baseline.findings` 同序深相等；A/B → 有 `reviews_en.json`、**无** session 文件。

## 验收（本票完成的判据）

- [ ] C/D/E/F 离线跑各产出 1 份 session + 1 份 `reviews_en.json`，路径与文件名符合 spec。
- [ ] A–F 请求字节零漂移；审计与 `RunRecord` 无新键。
- [ ] `info` 键集合精确匹配（无 `version`/`projectID`）；`messages[0]` 为 Zone A 系统提示词。
- [ ] 两次同 case/config 跑出的 session 文件互不覆盖。
- [ ] A/B 有 `reviews_en.json`、无 session 文件。
- [ ] `pnpm --filter review-pi test` / `pnpm --filter review-pi typecheck` 全绿；根 `pnpm test` / `pnpm typecheck` 全绿。

## 待核实（实现时必须先确认，可能微调 spec）

1. **`outcome` 映射**：spec 按 `truncated → "truncated"`、否则 `!complete → "failed"`、否则 `"succeeded"` 写；请核实 `AgentReviewLoopOutcome.complete` 的真实语义（截断/失败/正常完成的实际取值组合），若不符则回改 spec 与本票。
2. **`messages[0]` 是否可能重复**：确认 `agent.state.messages` 里确实不含 system（`agent.state.systemPrompt` 是独立字段），避免合成出两份 system。
3. **`details` 形状**：确认 `toolResult.details` 在本仓恒为 `{}`（Step B 的 `view` 里要原样记 `{}`）。

## 不在本票范围

- `view` 投影、`reviews_zh.json`、CLI 投影缝（→ 票 02）。
- 逐工具/逐消息耗时仪器；截断/脱敏；保留期与清理策略；版本键。
- A/B 的转录（其等价物是既有 `requests[].messages`，不另造）。
