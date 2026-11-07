# 0053. MCP 业务 tool 之间加固定 5 秒沉降间隔

**状态**：已接受（2026-11-07，用户决策；**临时措施**，见「Consequences」与待优化清单）
**关联**：[ADR-0045](0045-mcp-business-task-tools.md)（四个业务 tool 的生命周期与顺序契约）、[ADR-0050](0050-mcp-business-tool-retry-and-timeout.md)（业务调用重试）、[ADR-0037](0037-mcp-progress-reporting.md)（事件通道；本 ADR 不改事件面）
**范围**：本仓 pi 线 0053。只改 CLI 编排里业务调用的**发送时机**：在 `mrReviewResult` 全部结束后、`saveReviewSummary` 之前，以及 `saveReviewSummary` 结束后、`endTask` 之前，各插入一段固定 5 秒等待。报文内容、重试策略、退出码、事件通道与产物字节全部不动。

## Context

ADR-0045 的顺序契约是：`startTask` → 每片 / 每文件 `mrReviewResult` → `saveReviewSummary` → `endTask`。客户端侧这条链是**严格串行**的：每个业务调用都 `await`，重试（ADR-0050）也阻塞后续调用，因此 HTTP 请求的发出顺序与上面的契约一致。

但下游反馈的**实际到达前端的回调顺序**会错：`saveReviewSummary` / `endTask` 可能早于部分 `mrReviewResult` 出现在前端。排查结论：

1. 客户端发送顺序不是原因（逐调用串行已确认）；
2. `tools/call` 返回 2xx 只代表服务端**收到 / 入队**，落库与推送前端是异步的，多批片级结果可能在服务端并发处理；
3. 事件通道的 `run.end` 在 `review-run.ts` 内部就发出，也可能早于总结——但用户确认前端**以业务 tool 回调为准**，本次不改事件面。

可立即落地的缓解手段只有两种：给业务调用加序号 / 完成标记（需要服务端配合），或给相邻调用留固定间隔（纯客户端改动）。用户选择后者，且明确要求是**固定 5 秒**而不是「可配置最小间隔」。

## Decision

### 1. 两段固定等待，缺省 5 秒

- **第一段**：最后一条 `mrReviewResult` 发完后，等 `TASK_TOOL_SETTLE_MS`（5000 ms）再调用 `saveReviewSummary`；
- **第二段**：`saveReviewSummary` 调用结束后，再等 `TASK_TOOL_SETTLE_MS` 才调用 `endTask`。

实现位置：`packages/review-pi/src/cli/main.ts`（`waitTaskToolSettle`）；常量与解析函数在 `packages/review-pi/src/mcp/task-tools.ts`。

### 2. 只在业务调用实际发生时等待

- 两段都要求 `mcp.report.task = true` 且 MCP 可用（`taskToolsOn`）；业务关闭 / 建连失败时零等待；
- 第一段位于总结块内，自然只在「片级结果已发完、准备发总结」时执行；
- 第二段在 `finally` 里，额外要求 `startTask` 成功发出过，且**本次确实调用过 `saveReviewSummary`**（新增 `summaryCallCompleted` 标记）。预检失败、检视中途抛错等未走到总结的路径**不白等 5 秒**；
- 每一段都向 stderr 打一行 `MCP 固定等待 5000ms（… → …）`，让运行时长可解释。

### 3. 不开配置面，不写模板

固定间隔没有配置键，`PiAgent.example.jsonc` / `config init` 模板不新增任何内容——它不是一个可调参数，而是一个待删除的临时措施（见「Consequences」）。

### 4. 测试专用压缩：`PIAGENT_TEST_TASK_TOOL_SETTLE_MS`

进程级用例（`cli/bin.process.test.ts`）会 spawn 真 CLI，无法用假计时器或依赖注入。为满足「每条 MCP 用例不得因此多等 10 秒」：

- `resolveTaskToolSettleMs(env)` 读取专用环境变量 `PIAGENT_TEST_TASK_TOOL_SETTLE_MS`；
- 只接受**非负整数**（`0` = 关闭等待），非法值一律回落到 5000；
- 该变量**不是配置面**：不写文档模板、不参与 `config show` / 审计，生产环境不设置时行为恒为 5 秒；
- `bin.process.test.ts` 的 `runBin` 缺省注入 `"0"`；需要验证日志点的用例显式覆盖为 `"30"`。

## Consequences

- **好**：不改服务端契约就能给异步处理留排空时间；客户端发送顺序与报文字节零变化；失败路径不被无谓拖慢；等待行为在 stderr 可见。
- **代价**：启用业务上报的每次运行固定多约 10 秒；服务端处理延迟超过 5 秒时仍可能乱序，所以这是**缓解**而非**修复**。前端若直接消费事件通道（`run.end`），本 ADR 不解决其早到问题。
- **后续**：服务端支持序号 / 完成标记后，应删除固定等待与测试专用 env，改由契约保证顺序。该债务记入 [`docs/待优化维护清单.md`](../待优化维护清单.md)。
- **测试面**：`mcp/task-tools.test.ts` 覆盖缺省 5 秒、`0` / 合法整数与非法值回落；`cli/bin.process.test.ts` 的顺序用例用 30 ms 覆盖，断言两段等待的 stderr 行分别出现在「片级结果 → 总结」与「总结 → endTask」之间；其余 MCP 进程用例由 `runBin` 统一注入 `0`，不增加耗时。
