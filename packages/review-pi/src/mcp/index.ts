/**
 * MCP 上报模块出口（ADR-0037 事件面 + ADR-0045 业务调用面）。
 *
 * 只有 CLI（`cli/main.ts`）组装它：`loop/`、`run/`、`contracts/` 对本目录零 import
 * （由 `mcp/no-core-coupling.test.ts` 的 grep 断言把守）。
 */
export { MCP_CLIENT_NAME, SUPPORTED_PROTOCOL_VERSIONS, type McpClient, type ServerInfo, type ToolCallResult } from "./client.js";
export { resolveReportConfig, type ReportConfig } from "./config.js";
export { createMcpReporter, type CreateMcpReporterOptions, type McpReporter, type TaskCallResult } from "./report.js";
export { createHttpTransport, type HttpTransportOptions, type Transport, type TransportResponse } from "./transport.js";
export { ProtocolError, type JsonRpcRequest, type JsonRpcSuccess, type JsonRpcFailure } from "./protocol.js";
export {
  AGENT_REVIEW_CATEGORIES,
  AGENT_REVIEW_LEVELS,
  MCP_TASK_TOOL_NAMES,
  agentReviewTipFromUnknown,
  normalizeReportFilePath,
  type AgentReviewCategory,
  type AgentReviewLevel,
  type AgentReviewTip,
  type MrFileReport,
  type MrReviewResultArgs,
  type SaveReviewSummaryArgs,
  type TaskIdArgs,
  type TipParseOutcome,
} from "./task-tools.js";
