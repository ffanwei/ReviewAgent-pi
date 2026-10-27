# 02 — Step B：`view` 投影 + `reviews_zh.json`

`Status: resolved`
`Blocked by: 01`

- **Spec**: `.scratch/transcript-reviews-export/spec.md`（Step B 范围）
- **ADR**: `docs/adr/0013-review-transcript-and-findings-export-as-run-artifacts.md`（尤其 `Options` 与 `Consequences`）
- **依赖票**: `.scratch/transcript-reviews-export/issues/01-step-a-native-transcript-and-reviews-en.md`（本票在其产出上叠加）

> **历史注记（ADR-0015，2026-10-27）**：正文的「无源字段一律 `null`」与「`tool.time` 恒 `null`」已被修订——`messages[].id` / `messages[].time` / `tool.time.completed` 改为**有源就填**，仍无源的只有 `streamed`/`completed`(assistant)、`created`/`ran`(tool)、`reasoning.time`、`snapshot`、`state.metadata`、`model.variant`；`info.time` 改 epoch 毫秒 `{created, updated}`。其余（合并规则、pending/error 语义、`details` 原样）不变，以 ADR-0015 为准。

## 目标

两件互不耦合、但同属"呈现面扩张"的事：

1. 给 `session-*.json` 补 **`view`**：OpenCode 风格**定形投影**（`null` 占位、工具调用与结果**合并**），让这份文件能与 OpenCode 会话导出并排阅读。
2. 由**核外**（CLI）产出 **`reviews_zh.json`**，并实现它的**缺席/陈旧/降级**生命周期。

## 交付物

### D1 — `view` 投影（内核，纯函数）

- 与 Step A 同一次组装里追加 `view` 键：`{ "view": { "messages": [...] } }`。
- **定形纪律（与 `messages`/`info` 相反）**：OpenCode 参考格式里**无源的字段一律 `null` 占位**，不得省键。
- 映射（见 spec 的 `view` 表）：`reasoning ← thinking`；`tool` part ← **合并** assistant `toolCall` 与紧随的 `toolResult`（`toolCall.id` ↔ `toolResult.toolCallId`）。
  - 同批多个 toolCall → **拆成多个 `tool` part**，各带 `id`。
  - `toolResult.isError === true` → `state.status:"error"`，`state.error.message` = 结果文本。
  - 只有 call 无 result（截断/异常中止）→ `state.status:"pending"`、`state.content:null`。
  - `state.metadata`、`tool.time{created,ran,completed}`、`snapshot`、`model.variant` → `null`（**无源，刻意**）。
  - `details` 原样记 `{}`（空内容，非无源）。
  - `finish`/`rawFinish` ← `stopReason`/`rawStopReason`；`tokens`/`cost` ← 该 assistant 的 pi-ai `usage`。
- 本票**不新增**任何耗时仪器（`tool.time` 恒 `null`）。

### D2 — `reviews_zh.json`（核外，CLI 缝）

- 位置：`packages/review-pi/src/cli/main.ts` 的投影缝（现 91-108 行）。
- **复用同一次投影结果**：把已经喂 stdout 的那份投影结果**同时**写入 `.../<configId>/rep-<N>/reviews_zh.json`（信封与 `findings` 同 `reviews_en.json`，另带投影留痕 `language`/`terminologyVersion`/`findingLinks`）。**不得**为写文件再调一次网关。
- 根侧 runner **不产 zh**（无投影缝）；本票不改 runner。

### D3 — zh 生命周期（本票的硬骨头）

| 情形 | 期望 |
|---|---|
| 引擎未配置（`REVIEW_PI_PRESENTATION_ENGINE` 缺席/空） | zh **不产**；run exit 0 |
| 投影降级（引擎抛错/形状不符） | zh **不产**；run exit 0；stderr 一行原因（沿用 ADR-0010 降级纪律） |
| 投影成功但**写盘失败** | **抛错**（run 失败） |
| 本次不产 zh，但同目录**已存在陈旧** `reviews_zh.json` | **主动删除** + stderr 一行人话，使磁盘与本次 run 一致 |
| `reviews_en.json` / session 写失败 | **抛错**（Step A 已定，本票不得弱化） |

### D4 — 测试

- **S1（`runReview` 公共入口）**：`view` golden —— 每个工具对合并成一个 part；未配对 → `pending`+`content:null`；`isError` → `error`+`error.message`；所有无源字段为 `null`；`view.messages[0]` 与系统提示词一致；**无 `version` 键**。同时复跑**零漂移**断言（A–F 请求字节、审计与 `RunRecord` 无新键）。
- **S2（CLI 进程缝，参照 `packages/review-pi/src/cli/bin.process.test.ts` 的 stub 网关 + 注入引擎模块模式）**：投影成功 ⇒ zh 存在且带留痕与中文自然语言字段、写序在 en 之后；无引擎 ⇒ 缺席 + exit 0；引擎抛错 ⇒ 缺席 + exit 0 + 一行 stderr；**预置陈旧 zh** ⇒ 被删除；写盘失败（只读目录等）⇒ 非零退出。

## 验收（本票完成的判据）

- [x] `session-*.json` 同时含 `info` / `messages` / `view`；`view` 的定形与合并规则逐条对上，全部无源字段为 `null`。
- [x] 配了引擎：`reviews_zh.json` 与 `reviews_en.json` 同目录同 run，zh 带留痕；stdout 行为**不变**（仍是投影后中文）。
- [x] 未配引擎或降级：zh 缺席、exit 0；**陈旧 zh 被清除**。
- [x] zh 写盘失败 ⇒ 非零退出；en/session 写盘失败仍抛错。
- [x] runner 侧：只有 `reviews_en.json`，永不产 zh。
- [x] A–F 请求字节零漂移；审计与 `RunRecord` 无新键。
- [x] `pnpm --filter review-pi test` / `typecheck`、根 `pnpm test` / `pnpm typecheck` 全绿。

## 待核实

1. **陈旧 zh 的判定范围**：只删「同 `rep-<N>/` 目录」还是也清理更早 rep？按 spec 只处理**本次 run 的 `rep-<N>/`**（不得跨 rep 越权删除）——实现时请确认目录解析方式与现有 `runRecordPath` 同源。
2. **`view` 里 system 消息的 `type`**：spec 记为 `"system"`；确认 OpenCode 参考格式无此值时的取舍（可选：`type:"synthetic"` 或 `info` 内承载）。若与参考物冲突，回改 spec。
3. **zh 信封的 `findings` 是否保留 `id` 前缀**（`RULE-CHECK@…`）：留痕 `findingLinks` 已建立源关联，`id` 属结构化字段应字节直通——确认不要译。

## 不在本票范围

- 请求字节/提示词/工具面的任何改动；逐工具耗时仪器；截断脱敏；版本键；runner 侧 zh。

## Comments

**实现完成（pi 线切面）。** 交付落在：`export/transcript.ts`（`view` 定形投影纯函数
`buildView`）、`cli/reviews-zh.ts`（新，zh 信封/写/清陈旧）、`cli/main.ts`（投影缝复用同一
投影结果编排 zh）、`run/review-run-artifacts.test.ts`（view golden + `buildView` 单元面）、
`cli/bin.process.test.ts`（zh 生命周期矩阵）、`tests/experiment/runner-pi-offline.test.ts`
（runner 侧断言）。

三条待核实处置：

1. **陈旧 zh 的判定范围**：只删「本次 run 的 `rep-<N>/`」。`cli/main.ts` 用
   `dirname(reviewsPath)`（`reviewsPath` 来自内核 `runReview`，与 `runRecordPath` 同源布局）
   解析目录，`removeStaleReviewsZh` 只 `rm` 该目录下的 `reviews_zh.json`，**不跨 rep**。
2. **`view` 里 system 消息的 `type`**：保持 spec 的 `"system"`（OpenCode 参考导出不含
   system，属本仓扩展；已在 spec 的 `view` 表与 ADR-0013 记明）。无需回改。
3. **zh 信封 `findings` 的 `id`**：结构化字段**字节直通不译**（`id` 原样，含 `RULE-CHECK@…`
   形态）；留痕 `findingLinks` 另建源关联。S2 断言 `id`/`severity`/`file`/`line` 直通、
   `title`/`description` 已译。

**测试证据（全绿）**：

- `pnpm --filter review-pi typecheck` → exit 0；`pnpm --filter review-pi test` → 52 files /
  417 passed / 10 skipped（Step A 为 411 passed，本票 +6）。
- `pnpm --filter review-pi test:gate` → control gate 3 passed（T1–T5 因 gitignored 真源缺席
  skip，与「CI 绿 ≠ 重型验收」口径一致）；`src/bytegate` 5 个 `.test.ts`（含 wire-parity /
  semantic-parity）随主套件全绿。
- 根 `tsc --noEmit` → exit 0；根 `pnpm test` → 72 passed / 961 passed / 2 skipped。
- **零漂移**：字节门 control gate 正/负对照绿；审计与 `RunRecord` 键表断言无新增。
