# MCP 上报模块接口草案

**性质**：形状记录稿。初稿是**只有类型签名与契约注释**的评审稿；2026-11-04 实现落地后已按代码回填（不参与编译——`docs/` 不被 `tsc` 收录）。权威决策仍以 ADR-0037 为准，本文只记模块形状。
**依据**：[ADR-0037](../adr/0037-mcp-progress-reporting.md)（上报定位、HTTP-only、机器流水语义）、[ADR-0016](../adr/0016-run-progress-projection.md)（进度投影三条纪律）、[ADR-0032](../adr/0032-run-output-flat-layout-and-timestamp-runid.md)（`runId` = 首次模型请求时刻）、[ADR-0038](../adr/0038-retire-byte-gates-for-capability-assertions.md)（字节门退役）。
**日期**：2026-11-04

## 1. 文件布局

```text
packages/review-pi/src/contracts/mcp-report.ts   出站契约（事件类型全集 / 信封 / 统计）
packages/review-pi/src/shared/version.ts         产品版本单源（clientInfo.version）

packages/review-pi/src/mcp/
├── protocol.ts     JSON-RPC 2.0 编解码 + SSE 分帧（纯函数，无 I/O）
├── transport.ts    传输接口 + HTTP 实现（唯一实现）
├── client.ts       会话生命周期：initialize → tools/call → close
├── config.ts       mcp 配置块 → 类型化 ReportConfig（装载期已校验，这里只做取值）
├── report.ts       事件 → 出站 DTO → 队列 → 批量 → 重试 → flush
└── index.ts        对外出口
```

依赖方向（不许反向）：

```text
cli/main.ts ──> mcp/index.ts ──> {report, client, config, transport, protocol}
                                     │
contracts/{progress,mcp-report}.ts <─┘   （mcp/ 只读这两个契约，核心不 import mcp）
```

`loop/`、`run/`、`contracts/` **不得** import `mcp/**`——由 `mcp/no-core-coupling.test.ts` 的 grep 断言把守（验收标准 11）。

## 2. `contracts/progress.ts` 的新增（核心侧唯一改动）

```ts
/** 运行级事件：开始与结束。与既有四类一样，只是既有留痕的投影。 */
export type RunProgressEvent =
  | /* ...既有 phase / request / tool / skill 不变... */
  | {
      readonly kind: "run";
      readonly state: "start";
      readonly caseId: string;
      readonly model: string;
      /** ISO-8601 */ readonly startedAt: string;
    }
  | {
      readonly kind: "run";
      readonly state: "end";
      readonly status: "ok" | "failed";
      readonly durationMs: number;
      /** 产物 id（buildRunId(firstRequestAt)）；首次请求之前就失败时缺席 */
      readonly runId?: string;
      /** 成功路径才有 */ readonly usage?: LlmUsage;
      readonly truncated?: boolean;
      /** 成功路径才有；正文永不出现在这里 */
      readonly findings?: {
        readonly count: number;
        readonly bySeverity: Readonly<Record<"P0" | "P1" | "P2" | "P3", number>>;
      };
    };
```

契约：

- 不新增审计键、不改 wire 字节、不改退出码（ADR-0016 原样继承）；
- **`run.start` 不带 `runId`**：`runId` = 首次模型请求时刻（ADR-0032），起点发出时它还不存在；异常路径的 `run.end` 同样可能没有；
- 异常路径由 `runReview` 的 `catch` 发 `run.end(status="failed")` 后**原样重抛**；
- `progress-render.ts` 对 `kind === "run"` **不渲染**（其 `switch` 无 `default`，未知 kind 自然忽略——CLI 显示面零变化）；
- `run.end` **不含** `dropped` / `failed`——那是上报层的状态，由 reporter 在出站映射时注入。

## 3. `protocol.ts`（纯函数）

```ts
export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

/** 通知（无 id）：只用于 `notifications/initialized` */
export interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcSuccess {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result: unknown;
}

export interface JsonRpcFailure {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly error: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export class ProtocolError extends Error {
  /** 我们的分类，不是 JSON-RPC 错误码 */
  readonly code: string;
}

/** 序列化为单行 JSON（不换行——stdio 兼容形态，虽然 v1 只用 HTTP） */
export function encodeMessage(message: JsonRpcRequest | JsonRpcNotification): string;

/** 解析一条 JSON-RPC **响应**；通知（无 id）与非法结构一律抛 ProtocolError */
export function decodeMessage(raw: string): JsonRpcSuccess | JsonRpcFailure;

/** 从 text/event-stream 正文里提取每条 `data:` 载荷（按规范拼接多行 data） */
export function parseSseFrames(body: string): readonly string[];
```

`ProtocolError.code` 的取值：`invalid-json` / `invalid-message` / `invalid-version` /
`invalid-id` / `ambiguous` / `invalid-error` / `transport` / `http-status` /
`no-response` / `server-error` / `unsupported-version` / `bad-tool-result` /
`not-initialized`。

契约：

- **不做** 请求批（JSON-RPC batch array）——MCP 的批量在我们的语义里是「一个 `tools/call` 的 `events` 数组」，不是协议层批量；
- 解析必须**严格**：缺 `jsonrpc` / `id` 类型不符 / 同时有 `result` 与 `error` 都抛 `ProtocolError`，不猜。

## 4. `transport.ts`

```ts
export interface TransportResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

export interface Transport {
  /** 发送一条已编码的 JSON-RPC 消息；网络/超时错误原样抛出 */
  send(payload: string, signal: AbortSignal): Promise<TransportResponse>;
  close(): Promise<void>;
}

export interface HttpTransportOptions {
  readonly url: string;
  /** 秘密：不得出现在任何日志/错误信息里 */
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** 测试注入点；缺省用全局 fetch */
  readonly fetch?: typeof fetch;
}

export function createHttpTransport(options: HttpTransportOptions): Transport;
```

契约：

- 响应 `content-type` **原样透传**给 `client.ts`（由它决定按 JSON 还是 SSE 解析）；transport 不做内容协商判断；
- `Accept` 头固定带 `application/json, text/event-stream`；
- 非 2xx **不**在 transport 层抛错（交给 `client.ts` 按 JSON-RPC error 或状态码报错），便于区分「服务端说不行」与「网络不通」；
- 网络错误 / 超时统一抛 `ProtocolError("transport")`，**错误信息只带事实**（名称 / 超时），绝不回显 headers 或 body；
- `close()` 只需幂等（HTTP 无长连接，v1 是空实现）；
- **接口留一层是为将来加 stdio**，v1 不实现。

## 5. `client.ts`

```ts
/** 我们认识的服务端协议版本（从新到旧；握手回包不在其中即明确报错） */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
/** clientInfo.name：服务端在 initialize 里看到的调用方标识 */
export const MCP_CLIENT_NAME = "review-pi";

export interface ServerInfo {
  readonly name: string;
  readonly version: string;
  readonly protocolVersion: string;
}

export interface ToolCallResult {
  /** 只取 text 内容块并按 "\n" 连接；其他类型丢弃并计数 */
  readonly text: string;
  readonly isError: boolean;
  readonly droppedContentBlocks: number;
}

export interface McpClient {
  /** 幂等：重复调用返回缓存结果；版本不接受抛 ProtocolError("unsupported-version") */
  initialize(signal: AbortSignal): Promise<ServerInfo>;
  /** 未 initialize 就调用 = 编程错误，抛错（不做隐式握手） */
  callTool(name: string, args: unknown, signal: AbortSignal): Promise<ToolCallResult>;
  close(): Promise<void>;
}

export function createMcpClient(
  transport: Transport,
  options: { readonly clientName: string; readonly clientVersion: string },
): McpClient;
```

契约：

- **一次 run 一次握手**：`initialize` 只在 reporter 创建时调用一次，随后发 `notifications/initialized`（失败不影响后续）；
- 握手失败 → reporter 创建失败 → CLI 降级（不建 sink），**不影响检视**；
- `callTool` 不重试（重试归 `report.ts`，因为它知道批次边界与幂等键）；
- SSE 响应逐帧解析，**只认 id 匹配的那条**响应；无关通知 / 旧消息被跳过；
- 不做 `tools/list` 校验：v1 直接用配置里的工具名，服务端返回「工具不存在」按普通调用失败处理。

## 6. `config.ts`

```ts
export interface ReportConfig {
  /** 已解析的服务端连接（url / headers / timeoutMs 都来自 shared/config） */
  readonly server: McpServerSettings;
  readonly tool: string;
  readonly include: ReadonlySet<McpReportEventType>;
  readonly batch: { readonly maxEvents: number; readonly maxDelayMs: number };
  readonly queue: { readonly maxEvents: number };
  readonly flushTimeoutMs: number;
  readonly findings: "none" | "summary";
}

/** mcp 配置块 → 运行期形状；未配置返回 null。结构与取值范围已在装载期校验 */
export function resolveReportConfig(config: ResolvedConfig): ReportConfig | null;
```

`ConfigError` 定义在 `shared/config.ts`（不在本目录）：形状/取值/版本/禁配字段的失败都在**装载期** fail fast，退出码 1。

契约：

- 缺 `mcp` 或 `mcp.report` → 返回 `null`（= 不上报），**不是**错误；
- 有 `report` 但缺 `server` / `tool` / server 名字不存在 → `ConfigError`，退出码 1；
- `include` 里的未知类型 → `ConfigError`（fail fast，不静默忽略）；
- 数值缺省：`maxEvents=50`、`maxDelayMs=2000`、`queue.maxEvents=1000`、`flushTimeoutMs=5000`、`findings="summary"`；
- `include` 缺省 `["run.start", "run.end", "phase", "request.end"]`；
- `findings` 只接受 `none` / `summary`：写 `full` 直接 `ConfigError`（正文出口只有 `reviews_en.json`）；
- `mcp.servers.<name>.headers` 是秘密：只进 `configSnapshot().secret`（`set` / `missing`），永不进 `values`。

## 7. `report.ts`（核心逻辑）

```ts
export interface McpReportEnvelope {
  readonly schemaVersion: 1;
  /** 上报流标识（reporter 生成）：runId 在 run 结束前不可知，不能当流键 */
  readonly streamId: string;
  readonly seq: number;
  readonly at: string;
  readonly event: McpReportEvent;
}

export interface McpReportStats {
  readonly sent: number;    // 已被服务端成功接收的事件条数
  readonly failed: number;  // 重试耗尽后放弃的条数
  readonly dropped: number; // 队列溢出丢弃的条数
  readonly batches: number; // 实际发出的 tools/call 次数（含重试）
}

export interface McpReporter {
  /** 上报流标识（与信封里的 streamId 同源） */
  readonly streamId: string;
  /** 直接传给 runReview({ onProgress })；调用必须 O(1) 且绝不抛错 */
  readonly sink: RunProgressSink;
  /** 等待队列排空，最多 timeoutMs；超时返回当前统计，不抛错 */
  flush(timeoutMs?: number): Promise<McpReportStats>;
  /** 排空（预算 min(flushTimeoutMs,1000)）+ abort 在飞请求 + close；幂等 */
  close(): Promise<void>;
}

export async function createMcpReporter(options: {
  readonly config: ReportConfig;
  readonly clientVersion: string;
  /** 测试注入：时钟 / 传输 / 流 id */
  readonly now?: () => number;
  readonly transport?: Transport;
  readonly streamId?: string;
}): Promise<McpReporter>;
```

契约：

- `sink` **绝不抛错**（内部 `try/catch` 吞掉），否则会从 `emitProgress` 冒到主链；
- `sink` 不做 I/O，只入队；`setTimeout` 驱动的 drain 也是「到点触发一次 send」，不阻塞调用方；
- 出站映射**只挑白名单字段**（ADR-0037 决策 3 的表）；未列入 `include` 的事件在入队前就丢弃，不占队列；
- `seq` 由 reporter 分配（入队时），保证「先进先出 + 严格递增」；
- `run.end` 映射时注入 `dropped` / `failed`，并在**发送前**用最终计数覆盖（使 `dropped` 含本次入队自身引起的丢弃）；
- 背压：队列上限 `queue.maxEvents`，溢出丢最旧；
- 重试：单批最多 3 次（100 / 400 / 1600 ms），耗尽计入 `failed`；
- `flush()` 之后仍可继续 `sink`（异常路径兜底），`close()` 之后 `sink` 静默丢弃（但不影响排空队内事件）。

## 8. 组装（`cli/main.ts`）

```ts
// 伪代码，展示顺序与失败边界（与 cli/main.ts 一致）
const reportConfig = resolveReportConfig(config);            // 装载期已校验；这里只取值
let reporter: McpReporter | null = null;
if (reportConfig !== null) {
  try {
    reporter = await createMcpReporter({ config: reportConfig, clientVersion: REVIEW_PI_VERSION });
  } catch (error) {                                          // 建连 / 握手失败 = 降级
    process.stderr.write(`review-pi: MCP 上报不可用（${describeReportFailure(error)}），继续检视\n`);
  }
}
const activeReporter = reporter;
const onProgress = activeReporter === null
  ? progress?.onEvent
  : (event: RunProgressEvent) => { progress?.onEvent(event); activeReporter.sink(event); };

try {
  const result = await runReview({ ...input, ...(onProgress !== undefined ? { onProgress } : {}) });
  // ... stdout 写出 ...
} finally {
  if (activeReporter !== null && reportConfig !== null) {
    const stats = await activeReporter.flush(reportConfig.flushTimeoutMs);   // 内部 try/catch
    process.stderr.write(`review-pi: MCP 上报 sent ${stats.sent} / failed ${stats.failed} / dropped ${stats.dropped}\n`);
    await activeReporter.close().catch(() => undefined);
  }
}
```

契约：

- 上报的失败**永远**只影响这一行 stderr，不影响 `exitCode`；
- `flush` 在 `finally` 里，保证异常路径也尝试把已入队的事件发出去；
- 不配置 `mcp.report` 时，`onProgress` 就是今天那个函数，字节面零变化。

## 9. 测试面（实现时按此建文件）

| 文件 | 覆盖 |
|---|---|
| `mcp/protocol.test.ts` | 编解码往返、非法消息抛错、SSE 多行 `data:` 拼接 / CRLF / 空正文 |
| `mcp/transport.test.ts` | 本地 HTTP 假服务：请求形状、JSON 与 `text/event-stream` 响应、非 2xx 不抛、超时且不回显 headers |
| `mcp/client.test.ts` | 握手一次、版本不接受、未握手调用报错、SSE 响应挑选、非 2xx、JSON-RPC error、非 text 内容块丢弃 |
| `mcp/report.test.ts` | 顺序/seq、include 过滤、批量触发、背压丢最旧、重试、**sink 永不抛错**、flush 超时、close 幂等、`run.end` 注入 |
| `mcp/no-core-coupling.test.ts` | 核心目录零 `mcp/` import；组装点唯一（`cli/main.ts`） |
| `run/progress.test.ts` | 新增 `run.start` / `run.end` 的发射时点、字段、findings 摘要与正文不外泄 |
| `shared/config.test.ts` | mcp 缺省值、secret 映射、server 不存在 / include 未知 / stdio / `findings=full`、模板解析为 null |
| `shared/version.test.ts` | `REVIEW_PI_VERSION` 与 `package.json` 同源 |

## 10. 已决议（v1 边界）

1. **`run.start` 的发射时点**：`runReview` 入口发；在它之前的失败（参数 / 配置 / 路径）**不上报**（已确认）。异常路径由 `catch` 补 `run.end(status="failed")` 后原样重抛。
2. **心跳**：v1 **不做** `status` 事件；需要判活时由接收端用「事件间隔 + `run.end`」判断，后续再议。
3. **多 report 块**：接收端**现在只有一个**；将来要同时报多个系统时把配置形状改成数组，`include` 各自独立。
4. **信封键**：用 reporter 生成的 `streamId`（见决策 3 的说明），`runId` 只在 `run.end` 出现。
5. **`findings`**：只有 `none` / `summary`；`full` 在装载期拒绝。
6. **投递**：单 writer FIFO、3 次重试、背压丢最旧、`flush(timeout)` 轮询、`close` 先排空再 abort；**v1 无磁盘 spool**。
