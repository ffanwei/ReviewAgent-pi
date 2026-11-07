# 0054. MCP 业务调用留痕写入 `runs/mcp.json`

**状态**：已接受（2026-11-07，用户决策）
**关联**：[ADR-0045](0045-mcp-business-task-tools.md)（四个业务 tool 的生命周期与顺序契约）、[ADR-0050](0050-mcp-business-tool-retry-and-timeout.md)（业务调用重试与超时）、[ADR-0053](0053-mcp-task-tool-fixed-settle-gap.md)（业务调用之间的固定沉降）、[ADR-0036](0036-cwd-session-index-and-export.md)（session 转录与索引）
**范围**：本仓 pi 线 0054。只新增一个排障产物 `<tasks 根>/<taskId>/runs/mcp.json`，记录 `startTask` / `mrReviewResult` / `saveReviewSummary` / `endTask` 四个业务调用的输入、输出与调用时间。不改报文内容、重试策略、顺序契约、事件通道与退出码。

## Context

ADR-0045 引入的四个 MCP 业务调用目前只有一个观察面：失败时 stderr 一行。事后排查「平台到底收到了什么、回了什么、哪个调用慢」时：

- `session-<ts>.json` 只记录检视会话的模型消息，完全不含 MCP 交互；
- 审计 / `run.json` 只记检视侧用量与配置，不含业务调用；
- 成功调用的服务端回包正文在 `callTaskTool` 内被丢弃（只留 `{ok:true}`）；
- 业务调用的总耗时（含 ADR-0050 的 3 次重试）没有任何落盘。

用户要求：**把四个 MCP 调用的情况、输入输出、调用时间都存到 `mcp.json`，和 session 文件放一起**。

## Decision

### 1. 位置与生成条件

- 路径：`<tasks 根>/<taskId>/runs/mcp.json`——与 `session-<ts>.json` 转录同目录（ADR-0032 的 run 产物目录）；
- 只在 `mcp.report.task` 开启且确有业务调用时生成；纯本地 run / 只开事件通道时不产这个文件；
- 每次 run 覆盖写（同 `--taskId` 重跑 = 覆盖），不做历史累积。

### 2. 文档形状（version 1）

```jsonc
{
  "version": 1,
  "taskId": "change-001",
  "calls": [
    {
      "tool": "mrReviewResult",
      "startedAt": "2026-11-07T09:12:34.567Z",
      "durationMs": 123,           // 含重试的总耗时
      "ok": true,
      "input": { "taskId": "change-001", "filePath": "src/Foo.java", "reviewTips": [] },
      "output": { "ok": true, "response": "<服务端 tools/call 回包文本>" }
    }
  ]
}
```

- `input` = MCP `tools/call.arguments` 原样（平铺参数）；
- `output.ok` 与顶层 `ok` 同值；失败带 `reason`；拿到回包时带 `response`（服务端 `text` 内容拼接，传输失败则缺席）；
- `mrReviewResult` 按实际调用次数逐条记录（每文件一条），不做聚合；
- 不写 `streamId` / 事件通道统计 / 任何秘密（业务参数本身只有 taskId、文件路径与 tips 正文）。

### 3. 采集点在 `createMcpReporter({ onTaskCall })`

- `mcp/report.ts` 的 `callTaskTool` 在**包含重试的完整调用**结束后回调一次 `TaskCallTrace`（tool / arguments / startedAt epoch / durationMs / ok / reason? / responseText?）；
- 回调是旁路：自身抛错被吞掉，绝不影响业务调用结果；
- 服务端原始回包文本来自 `client.callTool` 的 `text`（`isError` 时也记录，便于对照 `reason`）。

### 4. 写盘时机与失败语义

- CLI 在 `finally` 里、`endTask` 之后写（此时四个调用的最终结果都在内存）；
- 原子写（同目录临时文件 + rename）；
- 写失败只落一行 stderr（`mcp.json 写入失败（…），不影响检视结果`），**不改退出码**；
- 预检失败等早退路径也会写（目录按需创建），保证「调用发生过就有留痕」。

## Consequences

- **好**：单文件即可核对平台收到 / 返回 / 耗时；重试总耗时、`isError` 回包正文、逐文件报文输入都可追溯；不依赖当时捕获的 stderr。
- **代价**：文件可能较大（含 tips 正文与服务端回包），随 `--taskId` 目录一起被下次同 id 运行覆盖；不参与审计字节，也不做轮转。
- **测试面**：`mcp/report.test.ts` 覆盖 `onTaskCall` 的成功 / `isError` 留痕；`cli/mcp-call-log.test.ts` 覆盖文档形状与原子写；`cli/bin.process.test.ts` 的 MCP 业务 tool 用例断言 `runs/mcp.json` 含四个 tool、输入输出与时间字段。
