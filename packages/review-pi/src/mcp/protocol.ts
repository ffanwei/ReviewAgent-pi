/**
 * JSON-RPC 2.0 编解码与 SSE 分帧（ADR-0037 决策 4）。
 *
 * 纯函数、无 I/O、无状态：传输与重试都不在这里。
 * 解析**严格**：结构不合法抛 `ProtocolError`，不猜也不返回 undefined。
 */

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcFailureBody {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcSuccess {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result: unknown;
}

export interface JsonRpcFailure {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly error: JsonRpcFailureBody;
}

/**
 * 协议层错误。`code` 是**我们**的分类（不是 JSON-RPC 错误码）：
 * `invalid-json` / `invalid-message` / `invalid-version` / `invalid-id` /
 * `ambiguous` / `invalid-error` / `http-status` / `no-response` / `server-error` /
 * `unsupported-version` / `bad-tool-result`。
 */
export class ProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

/** 单行 JSON：与将来可能的 stdio 传输兼容（v1 只用 HTTP） */
export function encodeMessage(message: JsonRpcRequest | JsonRpcNotification): string {
  return JSON.stringify(message);
}

/** 解析一条 JSON-RPC **响应**；通知（无 `id`）与非法结构一律抛错 */
export function decodeMessage(raw: string): JsonRpcSuccess | JsonRpcFailure {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProtocolError("invalid-json", "response is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProtocolError("invalid-message", "response must be a JSON object");
  }
  const message = parsed as Record<string, unknown>;
  if (message.jsonrpc !== "2.0") {
    throw new ProtocolError("invalid-version", 'response jsonrpc must be "2.0"');
  }
  if (typeof message.id !== "number" || !Number.isFinite(message.id)) {
    throw new ProtocolError("invalid-id", "response id must be a number");
  }
  const hasResult = Object.prototype.hasOwnProperty.call(message, "result");
  const hasError = Object.prototype.hasOwnProperty.call(message, "error");
  if (hasResult === hasError) {
    throw new ProtocolError("ambiguous", "response must have exactly one of result / error");
  }
  if (hasError) {
    const error = message.error;
    if (
      typeof error !== "object" ||
      error === null ||
      typeof (error as Record<string, unknown>).code !== "number" ||
      typeof (error as Record<string, unknown>).message !== "string"
    ) {
      throw new ProtocolError("invalid-error", "error must carry a numeric code and a string message");
    }
    return {
      jsonrpc: "2.0",
      id: message.id,
      error: error as JsonRpcFailureBody,
    };
  }
  return { jsonrpc: "2.0", id: message.id, result: message.result };
}

/**
 * 从 `text/event-stream` 正文里提取每条事件的数据载荷。
 *
 * 按 SSE 规范：`data:` 行可重复（以 `\n` 拼接），空行结束一个事件；
 * `:comment` / `event:` / `id:` / `retry:` 字段忽略。空事件不产出。
 */
export function parseSseFrames(body: string): readonly string[] {
  const frames: string[] = [];
  let data: string[] = [];
  const flush = (): void => {
    if (data.length > 0) {
      frames.push(data.join("\n"));
      data = [];
    }
  };
  for (const rawLine of body.split(/\r\n|\r|\n/)) {
    if (rawLine === "") {
      flush();
      continue;
    }
    if (rawLine.startsWith(":")) {
      continue;
    }
    const colon = rawLine.indexOf(":");
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    if (field !== "data") {
      continue;
    }
    const value = colon === -1 ? "" : rawLine.slice(colon + 1);
    data.push(value.startsWith(" ") ? value.slice(1) : value);
  }
  flush();
  return frames;
}
