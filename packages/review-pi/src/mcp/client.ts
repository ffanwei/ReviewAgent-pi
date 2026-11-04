import {
  decodeMessage,
  encodeMessage,
  parseSseFrames,
  ProtocolError,
  type JsonRpcFailure,
  type JsonRpcRequest,
  type JsonRpcSuccess,
} from "./protocol.js";
import type { Transport } from "./transport.js";

/**
 * MCP 会话（ADR-0037 决策 4）：`initialize` → `tools/call` → `close`。
 *
 * 只做 client 侧子集：不做 resources / prompts / sampling / roots，不做
 * `tools/list`（工具名来自配置，服务端说「工具不存在」按普通调用失败处理），
 * 不做 OAuth，不做长连接 GET 流。
 */

/** 我们认识的服务端协议版本（从新到旧；握手回包不在其中即明确报错） */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

/** `clientInfo.name`：服务端在 `initialize` 里看到的调用方标识 */
export const MCP_CLIENT_NAME = "review-pi";

export interface ServerInfo {
  readonly name: string;
  readonly version: string;
  readonly protocolVersion: string;
}

export interface ToolCallResult {
  /** 只取 `text` 内容块并按 `\n` 连接；其他类型丢弃并计数 */
  readonly text: string;
  readonly isError: boolean;
  readonly droppedContentBlocks: number;
}

export interface McpClient {
  /** 幂等：重复调用返回缓存结果 */
  initialize(signal: AbortSignal): Promise<ServerInfo>;
  /** 未 initialize 就调用 = 编程错误（不做隐式握手） */
  callTool(name: string, args: unknown, signal: AbortSignal): Promise<ToolCallResult>;
  close(): Promise<void>;
}

export interface McpClientOptions {
  readonly clientName: string;
  readonly clientVersion: string;
}

export function createMcpClient(transport: Transport, options: McpClientOptions): McpClient {
  let nextId = 1;
  let initialized: Promise<ServerInfo> | undefined;

  async function request(
    method: string,
    params: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const id = nextId;
    nextId += 1;
    const payload: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const response = await transport.send(encodeMessage(payload), signal);
    if (response.status < 200 || response.status >= 300) {
      throw new ProtocolError(
        "http-status",
        `MCP server responded with HTTP ${String(response.status)}`,
      );
    }
    const message = pickResponse(response.contentType, response.body, id);
    if ("error" in message) {
      const failure: JsonRpcFailure = message;
      throw new ProtocolError(
        "server-error",
        `MCP error ${String(failure.error.code)}: ${failure.error.message}`,
      );
    }
    return message.result;
  }

  return {
    initialize(signal) {
      initialized ??= (async (): Promise<ServerInfo> => {
        const result = await request(
          "initialize",
          {
            protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0],
            capabilities: {},
            clientInfo: { name: options.clientName, version: options.clientVersion },
          },
          signal,
        );
        const protocolVersion = readProtocolVersion(result);
        if (!(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(protocolVersion)) {
          throw new ProtocolError(
            "unsupported-version",
            `MCP server protocol version ${protocolVersion} is not supported ` +
              `(supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")})`,
          );
        }
        const serverInfo = readServerInfo(result, protocolVersion);
        // 通知没有响应体（HTTP 上通常是 202）；失败不影响后续调用
        try {
          await transport.send(
            encodeMessage({ jsonrpc: "2.0", method: "notifications/initialized" }),
            signal,
          );
        } catch {
          // best effort：握手本身已经成功
        }
        return serverInfo;
      })();
      return initialized;
    },
    async callTool(name, args, signal) {
      if (initialized === undefined) {
        throw new ProtocolError("not-initialized", "callTool() requires initialize() first");
      }
      await initialized;
      const result = await request("tools/call", { name, arguments: args }, signal);
      return readToolResult(result);
    },
    close() {
      return transport.close();
    },
  };
}

/**
 * 从响应体里挑出与请求 id 匹配的那条消息。
 *
 * `text/event-stream` 正文里可能先出现无关通知或旧消息：逐帧解析，只认 id 匹配的
 * 响应；全是噪声时报最后一处解析错误，否则报「没有响应」。
 */
function pickResponse(contentType: string, body: string, id: number): JsonRpcSuccess | JsonRpcFailure {
  const isSse = contentType.toLowerCase().includes("text/event-stream");
  const frames = isSse ? parseSseFrames(body) : [body];
  let lastError: ProtocolError | undefined;
  for (const frame of frames) {
    if (frame.trim() === "") {
      continue;
    }
    try {
      const message = decodeMessage(frame);
      if (message.id === id) {
        return message;
      }
    } catch (error) {
      if (error instanceof ProtocolError) {
        lastError = error;
      }
    }
  }
  throw lastError ?? new ProtocolError("no-response", `no JSON-RPC response for request ${String(id)}`);
}

function readProtocolVersion(result: unknown): string {
  if (typeof result !== "object" || result === null) {
    throw new ProtocolError("invalid-message", "initialize result must be an object");
  }
  const version = (result as Record<string, unknown>).protocolVersion;
  if (typeof version !== "string" || version === "") {
    throw new ProtocolError("invalid-message", "initialize result must carry protocolVersion");
  }
  return version;
}

function readServerInfo(result: unknown, protocolVersion: string): ServerInfo {
  const record = (result ?? {}) as Record<string, unknown>;
  const info = (typeof record.serverInfo === "object" && record.serverInfo !== null
    ? record.serverInfo
    : {}) as Record<string, unknown>;
  return {
    name: typeof info.name === "string" ? info.name : "unknown",
    version: typeof info.version === "string" ? info.version : "unknown",
    protocolVersion,
  };
}

function readToolResult(result: unknown): ToolCallResult {
  if (typeof result !== "object" || result === null) {
    throw new ProtocolError("bad-tool-result", "tools/call result must be an object");
  }
  const record = result as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : [];
  const texts: string[] = [];
  let dropped = 0;
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as Record<string, unknown>).type === "text" &&
      typeof (block as Record<string, unknown>).text === "string"
    ) {
      texts.push((block as Record<string, unknown>).text as string);
    } else {
      dropped += 1;
    }
  }
  return { text: texts.join("\n"), isError: record.isError === true, droppedContentBlocks: dropped };
}
