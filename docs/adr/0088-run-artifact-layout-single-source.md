# 0088. run 产物布局单源：写者记录主转录路径，读者不再反推

**状态**：已接受（2026-11-14，用户决策：允许单遍 `baseline.transcriptPath`；布局收进一个 module；两片迁移）
**关联**：[ADR-0013](0013-transcript-alignment.md)（转录是 run 产物）、[ADR-0032](0032-run-output-flat-layout-and-timestamp-runid.md)（run 输出布局 / `run.json`）、[ADR-0036](0036-cwd-session-index-and-export.md)（session 索引与 export）、[ADR-0039](0039-sharded-review-for-large-mrs.md)（分片记录）、[ADR-0072](0072-opencode-compatible-session-export.md) / [ADR-0073](0073-lifecycle-session-recording.md) / [ADR-0074](0074-opencode-trace-export.md)（导出/留痕）
**范围**：本仓 pi 线 0088。只改 run 产物**路径的来源与推导**：写者记录单遍主转录路径；读者消费记录路径；布局推导收进一个 module；缺 `runs` 段显式报错。不改产物文件名、目录布局、导出内容或现有进程面。

## Context

同一套 `session-<runId>` / `runs↔audit` / `opencode/` 命名分散在四个模块：

- `trace-export.ts` 用 `auditPathOf` 从转录路径反推审计路径；缺 `runs` 段时**静默返回同目录路径**，随后在 `loadTraceSession` 变成 ENOENT，把「布局不对」伪装成「文件丢了」；
- `session-export.ts` 从 `run.json.baseline.auditPath` 反推 runId，再拼 `session-<runId>.json`；缺该键时兜底「最新 session 文件」（猜文件）；
- `lifecycle.ts` 用 `compatFileOf` 做同目录 `opencode/` 推导；
- `opencode-compat.ts` 另有 `OPENCODE_DIR` / `openCodeSessionFile`。

`run.json` / 审计此前被测试断言「不携带 transcript / reviews 路径」（`run/review-run-artifacts.test.ts` 的 key 列表），但该纪律只在测试注释里，不在 ADR 正文；`auditPath` 本身已经是绝对路径。

## Decision

### 1. 布局单源 `export/run-artifacts.ts`

```ts
runsDirOf(artifactPath): string;      // 最后一个 runs 段；没有则报错
auditPathOf(transcriptPath): string;  // runs → audit + 去 session- 前缀；没有 runs 段报错
compatFileOf(nativePath): string;     // 同目录 opencode/<原文件名>
```

`OPENCODE_DIR` / `openCodeSessionFile` 继续来自 `opencode-compat.ts`，不复制。`trace-export` 保留 re-export 以兼容既有导入。

### 2. 写者记录单遍主转录路径（用户决策 B）

- `RunResult` / `RunSnapshot` 增加可选 `transcriptPath`（绝对路径）。
- **只在单遍 `executeSinglePass` 写入**；分片不写（`record.shards[].transcriptFile` 已有每片路径，避免重复/歧义）。
- `toRunSnapshot` 原样复制；旧记录缺席兼容。
- `run.json.baseline` 因此多一个键；`run/review-run-artifacts.test.ts` 的 key 列表与注释同步更新。这是**对既有测试纪律的有意修订**，记录在 ADR-0032 的后续修订注记里。

### 3. 读者消费记录路径

- `writeRunTrace(runsDir, artifacts: { transcriptPath; auditPath }[])`：调用方从 `RunRecord` 组装（单遍 `baseline.transcriptPath` + `auditPath`；分片 `shards[]`）。
- `loadTraceSession(transcriptPath, auditPath?)`：传了 auditPath 就用；没传才走 legacy `auditPathOf`，缺 `runs` 段直接报错。
- `session-export`：优先 `baseline.transcriptPath`；旧记录由 `baseline.auditPath` 的 runId 推 `runs/session-<runId>.json`（唯一 legacy 分支）；两者都没有即人话报错，**删除「最新 session 文件」兜底**。
- `lifecycle` 的 `compatFileOf` 改用 artifacts module。

### 4. 两片迁移

1. artifacts module + 写者记录 + 记录形状测试更新。
2. 读者消费 + loud fail；trace/export/lifecycle 测试与进程面验收。

## Options（为什么不是别的）

- **不改记录，只收推导 helper**：否（用户决策 B）。仍无法让 `--taskId` 模式消费写者记录；本轮明确选择允许一个路径键。
- **沿用「最新 session 文件」兜底**：否。猜文件会把「记录缺路径」伪装成「用了正确的转录」。
- **`auditPathOf` 缺段时继续返回同目录路径**：否。幻影路径已被证实会把布局错误变成 ENOENT。
- **把所有布局函数塞进 `opencode-compat.ts`**：否。那是 OpenCode 兼容层，不是 run 产物总布局。

## Consequences

- **好**：布局推导只有一处；`runs` 段缺失直接报错；`--taskId` 导出消费写者记录；trace 不再反推审计；`run.json` 多一个键，换掉两处猜路径。
- **代价 / 风险**：`run.json` 记录一个绝对路径（记录可移植性下降）；旧记录仍需 legacy shim；`writeRunTrace` 的调用方要多组装一对路径。
- **测试面**：`export/run-artifacts.test.ts` 4 条（推导 + 缺段报错）；`session-export.test.ts` 12 条（新增记录路径优先、双缺 loud fail）；`trace-export.test.ts` / `lifecycle.test.ts` / `run/review-run-artifacts.test.ts` 更新；全量 vitest 1057 passed、`pnpm test:replay` 6/6。
