# Spec: 检视转录与检视意见导出为落盘产物

`Status: ready-for-agent`

- **Agent skills / domain docs**：`CONTEXT.md`（术语「检视转录」「检视意见导出」）、`docs/adr/0013-review-transcript-and-findings-export-as-run-artifacts.md`
- **来源**：grill-with-docs 五轮 grill（Q1–Q9 × 3 轮 + 收口 4 问）——所有决策均由用户逐项拍板；本 spec 是这些决策的落地契约
- **参考物**：`D:\Project\tmp\session-929c5031-3d68-45b3-bf04-d64c7a6b5a5d.json`（OpenCode 会话导出，仅作**骨架参考**，不是逐字段真源）

## Problem Statement

作为检视链的使用者与维护者，我现在拿不到两样东西：

- **完整现场**：一次 run 的交互全貌（系统提示词、每轮消息、`thinking`、工具调用与结果）**从未落盘**。磁盘上最近的等价物是审计的 `requests[].wireBody`（每请求重复的**发送面**，丢 Agent 侧语义）与 `toolCallLog`（只有 name/参数/摘要，**无时间戳**）。出现问题只能翻判级报告，无法像 OpenCode 会话那样「打开就复现现场」。
- **可对外消费的意见清单**：Finding 只存在于 `rep-N.json` 的 `baseline.findings`（快照口径）、审计的 `findings`（取证口径）与 CLI stdout（呈现口径）里；没有一份**明确给下游读**的文件，也没有中文版。

## Solution

在 run 收尾时**新增三个文件**（全部落在既有 run 输出树内、`runs/**` 已 gitignore）：

1. **检视转录** `session-<首次模型调用时刻>-<configId>-<caseId>.json`——与 `rep-N.json` **平铺**，含 `{ info, messages, view }`：`messages` 是 pi 原生真源，`view` 是 OpenCode 风格定形投影，`info` 为共用元数据。**每次 run 独立留档、不覆盖**。
2. **`reviews_en.json`** 与 **`reviews_zh.json`**——落在 `.../<configId>/rep-<N>/`，**按 rep 覆盖重写**。en 由内核写；zh 由**核外**在投影成功后写（未配置引擎／投影降级 ⇒ zh 缺席，且**主动删除**陈旧 zh）。

该能力**不触碰请求字节**（测量常量面零漂移），不进字节门／语义等价门／上线门；唯一新增的内核仪器是 loop 首个请求处的**一个时间戳** `firstRequestAt`。

## User Stories

1. As a **review maintainer**, I want the full agent transcript on disk after every tool-driven run, so that I can reconstruct the review session without replaying wire bodies.
2. As a maintainer, I want the system prompt recorded as the first message, so that the transcript is a complete, ordered interaction log.
3. As a maintainer, I want the transcript in a shape I can read side-by-side with an OpenCode session export, so that I can compare a review session with a coding session.
4. As a maintainer, I want the native pi message shape preserved verbatim alongside that view, so that answers can be traced back to a real source of truth.
5. As a maintainer, I want the transcript named with the first model-call time, so that I know when the agent actually started (not when the process started).
6. As a maintainer, I want every run to keep its own transcript file, so that repeated runs on one case don't overwrite evidence.
7. As a maintainer, I want a stable pairing key to the audit record, so that I can join transcript ↔ reviews ↔ audit ↔ run record.
8. As a maintainer, I want raw token and cost accounting per assistant turn preserved, so that I can inspect the provider's own numbers.
9. As an **evaluator**, I want request bytes and audit/record shapes unchanged, so that all frozen gates stay green and prior measurements stay valid.
10. As an evaluator, I want findings in the export in the same order as the run record, so that the export never reorders results.
11. As a **downstream consumer**, I want a findings file with provenance (source/caseId/configId/rep/runId/model), so that I don't have to infer origin from the path.
12. As a downstream consumer, I want an English source-of-truth file and a Chinese projection file, so that both machine and human readers are served.
13. As a downstream consumer, I want the Chinese file to be absent (not stale) when no translation happened, so that I never read a previous run's Chinese.
14. As a **review operator**, I want the Chinese export only when a presentation engine is configured, so that nothing about the review chain depends on translation.
15. As an operator, I want a failed write of the English/session artifacts to fail the run loudly, so that I never get a half-materialized output directory.
16. As an operator, I want engine/network failure to leave the run successful with the Chinese file absent, so that translation never breaks a review.
17. As an **auditor**, I want the deliberate deviations (host paths, system prompt, differing token accounting) recorded, so that nobody "fixes" them later.

## Implementation Decisions

### Artifacts, paths, naming

- **Transcript** (per run, never overwritten):
  `<runsRoot>/<experimentId>/runs/<source>/<safeCaseId>/<configId>/session-<firstRequestAtRunId>.json`,
  where `<firstRequestAtRunId> = buildRunId(firstRequestAt, configId, caseId)` — i.e. the stem is
  `"session-" + <audit runId shape>` recomputed from the **first model-request time**, not the run-entry time.
  e.g. `.../runs/vul4j/VUL4J-38/F/session-20261026T093241.017-F-VUL4J-38.json`
  (the millisecond `.` from the ISO timestamp is **kept**; the audit's `buildRunId` is the single source,
  `audit-writer.ts:68-72`, so the filename is byte-for-byte that convention with `session-` prepended).
- **Findings export** (per run directory, overwritten):
  `<runsRoot>/<experimentId>/runs/<source>/<safeCaseId>/<configId>/rep-<N>/reviews_en.json` and
  `<runsRoot>/<experimentId>/runs/<source>/<safeCaseId>/<configId>/rep-<N>/reviews_zh.json`.
  The `rep-<N>/` directory convention mirrors the audit tree's existing `rep-<N>/audit/` segment.
- **Coverage**: transcript only for **C/D/E/F** (A/B use the non-Agent `review-loop`; their equivalent is `requests[].messages` and is not re-materialized). `reviews_*` for **all configs** (A/B get `reviews_en.json`, no session file).
- **No `kind`/`version` keys.** JSON discipline matches existing artifacts: 2-space indent + trailing newline.

### Transcript content (`{ info, messages, view }`)

- **`messages`** = `agent.state.messages` **verbatim** (no truncation, no renames), **plus a synthesized `messages[0]`** `{ "role": "system", "content": <Zone A systemPrompt> }`. Key-omission discipline applies here (this is a real source, so absent means "the source has nothing").
- **`info`** (key-omission discipline):

  | key | value | source |
  |---|---|---|
  | `id` | file-name stem | file name |
  | `runId` | audit `runId` — **the pairing key** (repo extension) | `buildRunId(startedAt, configId, caseId)` |
  | `agent` | `"review"` | constant |
  | `configId` | `"C" \| "D" \| "E" \| "F"` | run input |
  | `model` | `{ "id": …, "baseUrl": … }` | call param / gateway resolution |
  | `tokens` | `{ input, output, reasoning, cache: { read, write } }` | sum over assistant `usage` |
  | `cost` | `{ input, output, cacheRead, cacheWrite, total }` | sum over assistant `usage.cost` |
  | `outcome` | `"succeeded" \| "truncated" \| "failed"` | see mapping below |
  | `time` | `{ "created": firstRequestAt, "completed": finishedAt }` | new capture + existing |
  | `title` | `caseId` | run input |
  | `location.directory` | `repoPath` (absolute) | run input |
  | `perMessageTimestamps` | `"unavailable"` | constant (see Deviations) |

  **Excluded on purpose**: `projectID` (no such concept here), `kind`/`version` (see above), `durationMs` at `info.time` (run duration and agent-start duration are different clocks; don't mix), `systemPrompt` (it lives in `messages[0]`).
  `outcome` mapping: `truncated === true` ⇒ `"truncated"`; else `complete === false` ⇒ `"failed"`; else `"succeeded"`.
  **Verified during step A**: `"failed"` is **unreachable** in the current wiring — the loop's `complete === !truncated`
  holds on every reachable stop point (`advancePhase` stops only on `complete === true` or `round >= MAX_ROUNDS`;
  provider errors throw before an outcome is returned), and the one path that could set `complete === false` is an
  aborted turn, for which no caller currently passes an `AbortSignal`. The three-value mapping is kept as a
  **defensive** projection; the constant `outcome: "succeeded"` for a normal C/D/E/F run is asserted in the S1 test.
- **`view`** = OpenCode-shaped projection with **`null` placeholders** (it is a fixed-shape rendering, the opposite discipline from `messages`/`info`):

  | OpenCode | mapping |
  |---|---|
  | `messages[].type` | `"user"` / `"assistant"` from role; system message rendered as `type: "system"` |
  | `messages[].id` / `messages[].time` | `null` (no per-message id/time source) |
  | user `text` / `files` / `agents` | `text` ← user message text (array content ⇒ text blocks joined by `\n`); `files` / `agents` → `[]` (no attachments in this chain) |
  | assistant `agent` / `id` | `agent: "review"` (constant); `id` ← pi `responseId`, else `null` |
  | `reasoning` part | pi `thinking` (`text`), `time: {created: null, completed: null}` |
  | `text` part | pi `text` |
  | `tool` part | **merge** assistant `toolCall` + following `toolResult` (join on `toolCall.id` ↔ `toolResult.toolCallId`); same batch ⇒ one part per call, each with `id` |
  | `tool.state.status` | `"completed"`; `toolResult.isError === true` ⇒ `"error"` with `state.error.message` = result text; no matching result ⇒ `"pending"` with `state.content: null` |
  | `tool.state.input` | parsed `toolCall.arguments` |
  | `tool.state.content` | `toolResult.content` |
  | `tool.state.metadata` | `null` (no source) |
  | `tool.time{created,ran,completed}` | all `null` (no source — deliberate, see ADR-0013) |
  | `model{id,providerID,variant}` | `id`/`provider` from pi; `variant: null` |
  | `tokens` / `cost` | `usage` per assistant (pi-ai `Usage`) |
  | `finish` / `rawFinish` | `stopReason` / `rawStopReason` (`rawFinish` ⇒ `null` when pi leaves `rawStopReason` undefined) |
  | `snapshot` | `null` (no source; fixed-shape rendering) |
- **No truncation and no redaction.** The transcript is a complete on-disk crime scene; `runs/**` is gitignored.

### Findings export content

- Envelope (not a bare array):
  `{ "generatedAt": <ISO>, "runId": …, "source": …, "caseId": …, "configId": …, "rep": <N>, "model": …, "findings": [ … ] }`
- `findings` = full `Finding` objects, **order preserved** (identical order to `record.baseline.findings`), **always English**.
- `reviews_zh.json` = same envelope with natural-language fields projected to Chinese **plus the projection footprint** (`language`, `terminologyVersion`, `findingLinks`; `degraded` never appears because a degraded projection does not produce the file).

### Kernel/out-of-kernel split

- **Kernel** (`packages/review-pi`): expose the transcript from the C/D/E/F loop outcome; capture `firstRequestAt` at the first request; build `view` (pure function, no network/keys); write session + `reviews_en.json`; own the path layout.
- **Out of kernel** (ADR-0010 boundary): only `reviews_zh.json`, written by the CLI **after a successful projection** (reusing the same projection result that feeds stdout — no extra gateway call). The root-side runner has no projection seam and does **not** produce zh.

### Failure semantics

| situation | result |
|---|---|
| en / session write fails | **throw** (run fails; matches audit/record write discipline) |
| zh required (projection succeeded) but write fails | **throw** |
| presentation engine not configured | zh **absent**, run succeeds (exit 0) |
| projection degraded (engine error / shape mismatch) | zh **absent**, run succeeds, one stderr line |
| zh absent this run but a stale `reviews_zh.json` exists | **delete it** (stderr note), so disk matches the run |

### Deliberate deviations (do not "fix")

- The transcript contains the **Zone A system prompt**, **host absolute paths**, and reviewed-repo file bodies.
- `session-*.json` token/cost numbers **differ from** the audit / `rep-N.json` `usage` (pi-ai `Usage` vs kernel `LlmUsage`).
- pi message `timestamp` is `0` for loop-constructed user/assistant messages (only tool results carry `Date.now()`); it is **kept as-is** and announced via `info.perMessageTimestamps`.
- Adding `view` changes the session file shape; no version key is used (see rollout).

## Testing Decisions

- **What makes a good test**: assert only **externally observable** outcomes — the files on disk, their shapes, and the exit code/stderr. No assertions on private helpers or call ordering.
- **Seams**: **S1 = the public run entry** (`runReview`, already supports transport injection) for the whole file-materialization matrix; **S2 = the CLI process seam** (`bin.process.test.ts` pattern, stub gateway + injected engine module) for the zh lifecycle (present / absent / stale-deleted / throws).
- **Byte-freeze guards (must stay green, unchanged)**: A–F phase goldens, system-prompt golden, tool-face goldens, byte gate, semantic-parity gate. New assertions: **audit file shape and `RunRecord` shape gain no new keys** (transcript paths are returned, not embedded).
- **Transcript golden (S1, offline)**: for C/D/E/F, assert `info` field set exactly (no `version`, no `projectID`), `messages[0].role === "system"` and equals the Zone A prompt, `messages` beyond `[0]` equals the loop transcript, `view` merges each tool pair into one part, unpaired `toolCall` ⇒ `status:"pending"` + `content:null`, `isError` ⇒ `status:"error"` + `error.message`, all no-source fields are `null`, `info.runId` equals the audit `runId`, and file name/path match the documented shape.
- **Coexistence**: two runs of the same case/config produce two distinct session files (different `firstRequestAt`), both present.
- **Findings export (S1)**: envelope keys exact; `findings` deep-equals `record.baseline.findings` **in order**; A/B produce `reviews_en.json` but **no** session file.
- **zh lifecycle (S2)**: engine injected ⇒ `reviews_zh.json` exists with footprint and Chinese natural-language fields, disk write happens after en; no engine ⇒ file absent, exit 0; engine throws ⇒ absent, exit 0, one stderr line; a pre-seeded stale zh is **deleted** when the run produces none; simulated write failure ⇒ non-zero exit.
- **Runner path (S1)**: root-side runner persists `reviews_en.json` at the runner's `runs/.../rep-<N>/` layout and **never** produces zh.
- **No drift**: a run with transcript disabled/absent (A/B) still yields byte-identical requests to today.

## Out of Scope

- Per-message / per-tool **timing instrumentation** (`tool.time` stays `null`; adding timings is a separate kernel-variable-face project).
- Any transcript for A/B beyond the existing `requests[].messages`.
- Truncation, redaction, size caps, or retention/cleanup policy for accumulated session files.
- A version key or schema-evolution mechanism for these artifacts.
- zh export from the root-side experiment runner.
- Feeding the transcript back into any evaluation metric (it is a crime scene, not a metric source).
- Changing the audit file's or `RunRecord`'s shape to carry transcript data.

## Further Notes

- **Rollout order** (two steps, each independently verifiable):
  - **Step A** — kernel native transcript + `firstRequestAt` capture + `session-*.json` (`info` + `messages` only) + `reviews_en.json` + S1 tests. No network, no keys, no new dependency. *Known transient (superseded by Step B)*: at the end of step A the session file had no `view` key.
  - **Step B** — `view` projection into the session file + `reviews_zh.json` at the CLI seam + the full zh lifecycle matrix (present / absent / stale-deleted / degraded / write-failure).
- **Discipline**: the measurement-constant face is untouched (Zone A prompt, phase instructions, tool face, finding/evidence contract, request bytes). The only new kernel instrumentation is one timestamp.
- **Terminology**: 检视转录 ≠ pi 内核 `Session` 子系统 ≠ 审计文件（发送面字节）≠ 运行记录（指标快照）；`reviews_*` ≠ `REPORT.md`（人写结论）。用语见 `CONTEXT.md`。
- **Pairing key**: `info.runId` ↔ audit file name ↔ `reviews_*.runId` ↔ `record.baseline.audit.auditPath`. The transcript's own timestamp is `firstRequestAt`, which is **not** `runId`'s `startedAt`.
