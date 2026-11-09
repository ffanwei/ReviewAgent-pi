# 0060. CLI 运行日志落到 session 同目录

**状态**：已接受（2026-11-09，用户决策）
**关联**：[ADR-0032](0032-run-artifact-layout.md)（运行产物目录）、[ADR-0033](0033-task-id-decides-output-root.md)（任务目录）、[ADR-0036](0036-cwd-session-index.md)（cwd session 索引）、[ADR-0059](0059-presentation-partial-degradation.md)（呈现投影部分降级）
**范围**：本仓 pi 线 0060。只新增一份**旁路日志**：把 CLI 写到 stderr 的内容镜像到 `<tasks 根>/<taskId>/runs/review-pi.log`。stdout 契约、审计、检视产物、退出码零改动。

## Context

CLI 的排障信息（配置告警、MCP 失败、呈现投影降级原因、未捕获异常等）只写 stderr。生产上经常只拿得到产物目录和 stdout，stderr 会随进程 / CI 任务消失；于是「为什么这次投影降级了」「MCP 哪一步失败」事后无法复核。

已有 `mcp.json`（业务调用留痕）与 `session-*.json`（模型转录），但都不覆盖 CLI 自身的告警与错误。用户明确要求：**把所有报错详情放到日志里，和 session 一个目录**。

## Decision

### 1. 固定文件：`<tasks 根>/<taskId>/runs/review-pi.log`

与 `session-<runId>.json`、`mcp.json` 同目录。每次 `review` 运行**截断重写**（文件名固定，内容对应当前这次运行）；文件头写 `startedAt` 与 `taskId`。

### 2. stderr 全量镜像 + 仅日志详情

- 挂一个 `process.stderr.write` 的 tee：所有原本写 stderr 的行（进度、告警、降级原因、收尾摘要）**原样**追加到日志，同时仍正常输出到 stderr；
- 额外提供 `detail()`：只写日志、不上 stderr——顶层未捕获异常的**完整堆栈**走这里（stderr 仍保持一行人类可读信息）。

不逐点改几十处 `process.stderr.write` 调用：tee 自动覆盖现在与将来的所有告警，避免「新加一处错误却忘了记日志」。

### 3. 旁路纪律

- 日志目录 / 文件打不开、写入失败：只打一行 stderr，**继续检视**，不改退出码；
- 同步写（`writeSync`）：进程异常退出或 `exitGracefully` 时内容已落盘，不依赖流刷缓冲；
- 进程退出时恢复 `process.stderr.write` 并关闭 fd。

## Options（为什么不是别的）

- **逐处调用记录器**：否。几十个 stderr 调用点都要改，且未来新错误容易漏。
- **写进 stdout**：否。stdout 是单 JSON 机器契约（ADR-0024），日志是排障面。
- **写到 cwd 的 session 索引旁边**：否。cwd 可能是只读 / CI 临时目录；任务目录才是本次 run 的产物根（ADR-0033），且与 session 转录天然同目录。
- **按 runId 命名（`review-<runId>.log`）**：否。runId 在首次模型请求后才有，而日志必须从预检 / 配置阶段就开始记；固定文件名 + 截断更简单，`mcp.json` 同此形态。
- **只记 error 级事件**：否。当前 CLI 没有日志级别，降级/告警都是一行 stderr；全量镜像不会漏，也保留上下文。

## Consequences

- 生产排障只需拿 `<tasks 根>/<taskId>/runs/review-pi.log`，不再依赖 stderr。
- 每次 run 多一个小文本文件；全量成功路径的 stdout / 审计 / 产物逐字节不变。
- 日志不含额外秘密：内容 = 原本就写到 stderr 的信息 + 异常堆栈。
- 测试面：`packages/review-pi/src/cli/run-log.test.ts` 锁定镜像、`detail` 隔离与 close 恢复；`bin.process.test.ts` 锁定既有行为不回归。
