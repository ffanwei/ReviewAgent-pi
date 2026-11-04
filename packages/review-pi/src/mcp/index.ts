/**
 * MCP 上报模块出口（ADR-0037）。
 *
 * 只有 CLI（`cli/main.ts`）组装它：`loop/`、`run/`、`contracts/` 对本目录零 import
 * （由 `mcp/no-core-coupling.test.ts` 的 grep 断言把守）。
 */
export { MCP_CLIENT_NAME, SUPPORTED_PROTOCOL_VERSIONS, type McpClient, type ServerInfo, type ToolCallResult } from "./client.js";
export { resolveReportConfig, type ReportConfig } from "./config.js";
export { createMcpReporter, type CreateMcpReporterOptions, type McpReporter } from "./report.js";
export { createHttpTransport, type HttpTransportOptions, type Transport, type TransportResponse } from "./transport.js";
export { ProtocolError, type JsonRpcRequest, type JsonRpcSuccess, type JsonRpcFailure } from "./protocol.js";
