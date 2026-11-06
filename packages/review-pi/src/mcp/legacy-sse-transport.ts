import { ProtocolError } from "./protocol.js";
import type { Transport, TransportResponse } from "./transport.js";

/**
 * 老式 HTTP+SSE 传输（MCP 2024-11-05 规范形态；ADR-0037 后续修订）。
 *
 * 与 Streamable HTTP（`transport.ts`，单端点 POST、响应直接回在 POST 上）的
 * 差异：**响应不走 POST 回体**——
 * 1. `GET {url}`（Accept: text/event-stream）建立长连接；
 * 2. 服务端在流上发 `event: endpoint` 事件，`data` 是后续消息的 POST 端点
 *    （相对路径按 SSE URL 解析，如 `/message?sessionId=…`）；
 * 3. 客户端把 JSON-RPC 消息 POST 到该端点（规范回 202）；
 * 4. **响应从 SSE 流回来**（按 JSON-RPC id 关联），POST 回体是空的。
 *
 * 适配方式：`Transport` 接口不变——`send` 在 POST 之后等待流上 id 匹配的
 * 响应再 resolve（合成 `application/json` 的 TransportResponse），上层
 * client/reporter 零感知。兼容少数实现直接在 POST 回体给结果：回体里能解出
 * id 匹配的 JSON-RPC 响应就直接用。
 *
 * 生命周期：GET 长连接贯穿整个 reporter 会话；`close` 断开并拒绝所有在途
 * 等待。断流 = 传输错误（上层按旁路失败处理，不重连）。
 */

export interface LegacySseTransportOptions {
  /** SSE 端点（GET 长连接的 URL；消息端点由服务端的 `endpoint` 事件给出） */
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** 传输层注入（测试确定性）；缺省 globalThis.fetch */
  readonly fetch?: typeof fetch;
}

interface PendingWait {
  readonly resolve: (body: string) => void;
  readonly reject: (error: Error) => void;
}

interface SseFrame {
  readonly event?: string;
  readonly data: string;
}

export function createLegacySseTransport(options: LegacySseTransportOptions): Transport {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  let closed = false;
  let messageEndpoint: string | undefined;
  let connectPromise: Promise<void> | undefined;
  const pending = new Map<number, PendingWait>();

  function combineSignal(signal: AbortSignal): AbortSignal {
    return typeof AbortSignal.any === "function" ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  }

  /** 连接：GET SSE 流 → 等 `endpoint` 事件；之后后台持续读流并按 id 分发 */
  function connect(signal: AbortSignal): Promise<void> {
    const endpointArrived = new Promise<void>((resolveEndpoint, rejectEndpoint) => {
      void (async () => {
        let response: Response;
        try {
          response = await fetchImpl(options.url, {
            method: "GET",
            headers: {
              accept: "text/event-stream",
              ...options.headers,
            },
            signal: combineSignal(signal),
          });
        } catch (error) {
          rejectEndpoint(transportError(`SSE connect failed: ${errorMessage(error)}`));
          return;
        }
        if (response.status < 200 || response.status >= 300) {
          rejectEndpoint(
            new ProtocolError("http-status", `MCP server responded with HTTP ${String(response.status)} (SSE endpoint)`),
          );
          return;
        }
        if (response.body === null) {
          rejectEndpoint(transportError("SSE endpoint returned no body"));
          return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let currentEvent: string | undefined;
        let currentData: string[] = [];
        const dispatchFrame = (frame: SseFrame): void => {
          if (frame.event === "endpoint" && frame.data.trim() !== "" && messageEndpoint === undefined) {
            try {
              messageEndpoint = new URL(frame.data.trim(), options.url).toString();
            } catch {
              messageEndpoint = frame.data.trim();
            }
            resolveEndpoint();
            return;
          }
          // JSON-RPC 响应帧：按 id 分发给在途等待（event 名缺省 = 消息本体）
          if (frame.event !== undefined) {
            return; // endpoint / ping 等命名事件不是 JSON-RPC 消息
          }
          const id = responseIdOf(frame.data);
          if (id !== undefined) {
            const wait = pending.get(id);
            if (wait !== undefined) {
              pending.delete(id);
              wait.resolve(frame.data);
            }
          }
        };
        const consumeLine = (line: string): void => {
          if (line === "") {
            if (currentData.length > 0) {
              dispatchFrame({ ...(currentEvent !== undefined ? { event: currentEvent } : {}), data: currentData.join("\n") });
              currentData = [];
            }
            currentEvent = undefined;
            return;
          }
          if (line.startsWith(":")) {
            return; // 注释 / keep-alive
          }
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          const value = colon === -1 ? "" : line.slice(colon + 1);
          const trimmed = value.startsWith(" ") ? value.slice(1) : value;
          if (field === "data") {
            currentData.push(trimmed);
          } else if (field === "event") {
            currentEvent = trimmed;
          }
          // id: / retry: 忽略
        };
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r\n|\r|\n/);
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              consumeLine(line);
            }
          }
          // 流正常结束：残余帧冲刷 + 在途等待全部失败（连接没了）
          if (buffer !== "") {
            consumeLine(buffer);
          }
          if (currentData.length > 0) {
            dispatchFrame({ ...(currentEvent !== undefined ? { event: currentEvent } : {}), data: currentData.join("\n") });
          }
          failAllPending(transportError("SSE stream ended before the response arrived"));
        } catch (error) {
          if (controller.signal.aborted) {
            failAllPending(new ProtocolError("transport", "legacy SSE transport closed"));
            return;
          }
          failAllPending(transportError(`SSE stream failed: ${errorMessage(error)}`));
        }
      })();
    });
    return endpointArrived;
  }

  async function send(payload: string, signal: AbortSignal): Promise<TransportResponse> {
    if (closed) {
      throw new ProtocolError("transport", "legacy SSE transport is closed");
    }
    if (connectPromise === undefined) {
      connectPromise = connect(signal);
      connectPromise.catch(() => {
        connectPromise = undefined; // 连接失败可重连（reporter 只在建连期试一次，这里只是不留死状态）
      });
    }
    await connectPromise;

    let message: { readonly id?: number };
    try {
      message = JSON.parse(payload) as { readonly id?: number };
    } catch {
      throw new ProtocolError("invalid-json", "outgoing payload is not valid JSON");
    }
    const hasId = typeof message.id === "number";
    let response: Response;
    try {
      response = await fetchImpl(messageEndpoint as string, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...options.headers,
        },
        body: payload,
        signal: combineSignal(signal),
      });
    } catch (error) {
      throw transportError(`POST to message endpoint failed: ${errorMessage(error)}`);
    }
    const body = await response.text().catch(() => "");
    // 少数实现直接在 POST 回体给结果：能解出 id 匹配的 JSON-RPC 响应就用它
    if (hasId && responseIdOf(body) === message.id) {
      return { status: 200, contentType: "application/json", body };
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ProtocolError(
        "http-status",
        `MCP server responded with HTTP ${String(response.status)} (message endpoint)`,
      );
    }
    if (!hasId) {
      // 通知：POST 被接受即完成（响应不期待）
      return { status: response.status, contentType: "", body: "" };
    }
    // 规范形态：响应从 SSE 流回来
    return await waitForStreamResponse(message.id as number, signal);
  }

  function waitForStreamResponse(id: number, signal: AbortSignal): Promise<TransportResponse> {
    return new Promise<TransportResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        pending.delete(id);
        reject(new ProtocolError("no-response", `no JSON-RPC response for request ${String(id)} on the SSE stream`));
      }, options.timeoutMs);
      timeout.unref?.();
      const onAbort = (): void => {
        cleanup();
        pending.delete(id);
        reject(transportError("request aborted while waiting on the SSE stream"));
      };
      const combined = combineSignal(signal);
      combined.addEventListener("abort", onAbort, { once: true });
      function cleanup(): void {
        clearTimeout(timeout);
        combined.removeEventListener("abort", onAbort);
      }
      pending.set(id, {
        resolve: (body) => {
          cleanup();
          resolve({ status: 200, contentType: "application/json", body });
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
    });
  }

  function failAllPending(error: Error): void {
    for (const [id, wait] of pending) {
      pending.delete(id);
      wait.reject(error);
    }
  }

  return {
    send,
    close(): Promise<void> {
      closed = true;
      controller.abort();
      failAllPending(new ProtocolError("transport", "legacy SSE transport closed"));
      return Promise.resolve();
    },
  };
}

/** 从一段文本里取 JSON-RPC 响应 id（不是合法响应 / 无 id → undefined） */
function responseIdOf(text: string): number | undefined {
  try {
    const message = JSON.parse(text) as { readonly id?: unknown };
    return typeof message.id === "number" ? message.id : undefined;
  } catch {
    return undefined;
  }
}

function transportError(message: string): ProtocolError {
  return new ProtocolError("transport", message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
