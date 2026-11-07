# 0055. 进度事件行缺省打印，移除 `--progress`

**状态**：已接受（2026-11-07，用户决策）
**关联**：[ADR-0016](0016-run-progress-projection.md)（运行进度投影机制；本 ADR 只改开关缺省档）、[ADR-0030](0030-run-summary-line.md)（收尾总结行恒定打印，不受本 ADR 影响）、[ADR-0043](0043-review-args-echo.md)（参数回显）
**范围**：本仓 pi 线 0055。只改 `review` 子命令的进度事件行开关：**缺省打印**，不再按 `stderr` 是否 TTY 自动判定；`--progress` 移除，静音只认 `--no-progress`。不动投影机制、事件字段、收尾总结行、stdout 契约与退出码。

## Context

ADR-0016 的缺省档是「`stderr` 是 TTY 才开」：交互终端能看到进度，重定向到日志文件时静默。实际使用里这个自动档造成两个问题：

1. **批跑 / CI / 管道场景默认看不到进度**，排查「卡住还是在跑」仍要显式改命令行；
2. **同一命令在不同环境输出不一致**（TTY 与否），日志消费方与用户对「正常输出」的预期分裂。

用户决策：**进度默认打印**；不需要打印时显式传 `--no-progress`。`--progress` 作为「打开」开关失去意义，一并移除。

## Decision

### 1. 缺省打印

`review` 启动进度投影不再检查 `stderr.isTTY`：

- 不传任何进度旗标 → **打印**阶段 / 模型请求 / 工具调用 / skill 会话事件行（`stderr`）；
- 传 `--no-progress` → 静音这些事件行（批跑收日志用）；
- TTY 与否只影响渲染形态（TTY 下有 `\r` 状态行与擦行），不影响「是否打印」。

### 2. `--progress` 移除并给迁移提示

- `--progress` 不再是已知旗标；继续传 = 用法错误（`exit 1`），但错误消息是专用迁移提示而非裸 `unknown flag`：
  `--progress 已移除（ADR-0055）：进度事件行缺省打印；不需要时传 --no-progress`；
- `--no-progress` 保留原语义；重复出现仍是 `duplicate flag --no-progress`；
- `smoke` 面继续不认这两个旗标（与 ADR-0016 一致）。

### 3. 参数回显

`--progress` 行改为 `--no-progress`：

- 未传 → `未启用（缺省打印）`；
- 传了 → `已启用（进度事件行静默）`。

### 4. 不动的面

- `stdout` 单 JSON 文档逐字节不变；
- 收尾总结行继续**恒定打印**（ADR-0030），与进度事件行开关解耦；
- 事件 / 审计 / 转录 / MCP 报文与本 ADR 无关。

## Consequences

- **好**：所有环境默认可见执行进展，命令行为不随 TTY 漂移；静音路径只剩一个显式旗标，脚本可读性更好。
- **代价**：批跑不传 `--no-progress` 时 `stderr` 会多出事件行；依赖「非 TTY 自动静默」的脚本需要补 `--no-progress`（本仓评估脚本已显式传该旗标）。
- **迁移**：`--progress` 给出人话提示，不是裸 unknown flag；仓库内脚本 / 文档同步改为缺省或 `--no-progress`。
- **测试面**：`cli/args.test.ts`（缺省省键、`--no-progress` → false、`--progress` 迁移提示、重复旗标、smoke 不认）、`cli/args-echo.test.ts`（回显行文案）、`cli/bin.process.test.ts`（非 TTY 缺省打印、`--no-progress` 静默且收尾行仍在、`--progress` exit 1）。
