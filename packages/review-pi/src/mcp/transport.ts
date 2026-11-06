import { ProtocolError } from "./protocol.js";

/**
 * 传输接口（ADR-0037 决策 4）。
 *
 * v1 的唯一实现是 HTTP（Streamable HTTP / JSON-RPC over POST）。接口留一层
 * 不是为了现在支持 stdio，而是为了将来加 stdio 时不动 `client.ts` 与 `report.ts`。
 */
export interface TransportResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

export interface Transport {
  /** 发送一条已编码的 JSON-RPC 消息；网络 / 超时错误原样抛出 */
  send(payload: string, signal: AbortSignal): Promise<TransportResponse>;
  /** 幂等（HTTP 无长连接，v1 是空实现） */
  close(): Promise<void>;
}

export interface HttpTransportOptions {
  readonly url: string;
  /** 秘密：绝不写进错误信息、日志或审计 */
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** 测试注入点；缺省全局 fetch */
  readonly fetch?: typeof fetch;
}

/**
 * HTTP 传输。
 *
 * 契约：
 * - `Accept` 固定带 `application/json, text/event-stream`（服务端可二选一）；
 * - **非 2xx 不在这里抛错**：交给 `client.ts` 区分「服务端拒绝」与「网络不通」；
 * - 超时用 `AbortSignal.timeout`，与调用方传入的 signal 合并；
 * - 错误信息只带状态码 / 传输层原因，不带 headers。
 */
export function createHttpTransport(options: HttpTransportOptions): Transport {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  /**
   * 服务端指派的会话 id（Streamable HTTP 规范）：`initialize` 响应的
   * `Mcp-Session-Id` 响应头，后续**所有**请求必须回带——有会话的服务端
   * （Spring AI 系）对无会话头的请求按「无此会话」回 404。只在未持有时
   * 捕获（服务端不会中途换发）；服务端不用会话时恒为 undefined，零影响。
   */
  let sessionId: string | undefined;

  return {
    async send(payload, signal) {
      const timeout = AbortSignal.timeout(options.timeoutMs);
      const combined =
        typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await fetchImpl(options.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...options.headers,
            // 会话头放最后：服务端指派的值压过任何用户静态配置
            ...(sessionId !== undefined ? { "mcp-session-id": sessionId } : {}),
          },
          body: payload,
          signal: combined,
        });
      } catch (error) {
        throw new ProtocolError("transport", describeTransportFailure(error));
      }
      if (sessionId === undefined) {
        const assigned = response.headers.get("mcp-session-id");
        if (assigned !== null && assigned.trim() !== "") {
          sessionId = assigned.trim();
        }
      }
      let body: string;
      try {
        body = await response.text();
      } catch (error) {
        throw new ProtocolError("transport", describeTransportFailure(error));
      }
      return {
        status: response.status,
        contentType: response.headers.get("content-type") ?? "",
        body,
      };
    },
    close() {
      // 规范允许客户端在终止时 DELETE 会话（Mcp-Session-Id 头）；v1 不做——
      // 服务端按超时回收会话即可，多一发 DELETE 只增加收尾失败面
      return Promise.resolve();
    },
  };
}

/** 只报事实（名称 / 超时），绝不回显请求头或 body */
function describeTransportFailure(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return "request timed out";
    }
    return `request failed: ${error.message}`;
  }
  return "request failed";
}
