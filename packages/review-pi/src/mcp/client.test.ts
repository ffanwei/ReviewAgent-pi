import { describe, expect, test } from "vitest";

import { createMcpClient, MCP_CLIENT_NAME } from "./client.js";
import { ProtocolError } from "./protocol.js";
import type { Transport, TransportResponse } from "./transport.js";

// MCP 会话子集（ADR-0037 决策 4）：一次握手、严格版本协商、SSE 响应、
// 未握手调用 = 编程错误；只消费 text 内容块。

interface SentMessage {
  readonly jsonrpc: string;
  readonly id?: number;
  readonly method: string;
  readonly params?: unknown;
}

function transportWith(
  respond: (message: SentMessage) => TransportResponse | Promise<TransportResponse>,
): Transport & { readonly sent: SentMessage[] } {
  const sent: SentMessage[] = [];
  return {
    sent,
    async send(payload) {
      const message = JSON.parse(payload) as SentMessage;
      sent.push(message);
      return respond(message);
    },
    close() {
      return Promise.resolve();
    },
  };
}

function jsonResponse(result: unknown, id: number, status = 200): TransportResponse {
  return {
    status,
    contentType: "application/json",
    body: JSON.stringify({ jsonrpc: "2.0", id, result }),
  };
}

const INIT_RESULT = {
  protocolVersion: "2025-06-18",
  serverInfo: { name: "ops", version: "1.2.3" },
};

function client(transport: Transport) {
  return createMcpClient(transport, { clientName: MCP_CLIENT_NAME, clientVersion: "test" });
}

describe("createMcpClient", () => {
  test("initialize 只握手一次（重复调用返回缓存结果），并发出 initialized 通知", async () => {
    const transport = transportWith((message) =>
      message.method === "initialize"
        ? jsonResponse(INIT_RESULT, message.id ?? 0)
        : { status: 202, contentType: "", body: "" },
    );
    const mcp = client(transport);

    const first = await mcp.initialize(new AbortController().signal);
    const second = await mcp.initialize(new AbortController().signal);

    expect(first).toEqual({ name: "ops", version: "1.2.3", protocolVersion: "2025-06-18" });
    expect(second).toBe(first);
    expect(transport.sent.filter((message) => message.method === "initialize")).toHaveLength(1);
    expect(transport.sent.map((message) => message.method)).toEqual([
      "initialize",
      "notifications/initialized",
    ]);
    expect(transport.sent[0]?.params).toMatchObject({
      clientInfo: { name: MCP_CLIENT_NAME, version: "test" },
    });
  });

  test("服务端回不认识的协议版本 → unsupported-version", async () => {
    const transport = transportWith((message) =>
      jsonResponse({ ...INIT_RESULT, protocolVersion: "1999-01-01" }, message.id ?? 0),
    );
    await expect(client(transport).initialize(new AbortController().signal)).rejects.toMatchObject({
      code: "unsupported-version",
    });
  });

  test("未握手就 callTool = 编程错误（不做隐式握手）", async () => {
    const mcp = client(transportWith(() => jsonResponse({}, 0)));
    await expect(mcp.callTool("x", {}, new AbortController().signal)).rejects.toMatchObject({
      code: "not-initialized",
    });
  });

  test("tools/call 从 text/event-stream 正文取匹配 id 的响应", async () => {
    const transport = transportWith((message) => {
      if (message.method === "initialize") {
        return jsonResponse(INIT_RESULT, message.id ?? 0);
      }
      if (message.method === "notifications/initialized") {
        return { status: 202, contentType: "", body: "" };
      }
      return {
        status: 200,
        contentType: "text/event-stream",
        body:
          ": keep-alive\n" +
          // 无关通知（没有 id）与旧 id 都被忽略
          'data: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\n\n' +
          `data: {"jsonrpc":"2.0","id":${String(message.id)},"result":${JSON.stringify({
            content: [
              { type: "text", text: "line-1" },
              { type: "image", data: "AAA" },
              { type: "text", text: "line-2" },
            ],
            isError: false,
          })}}\n\n`,
      };
    });
    const mcp = client(transport);
    await mcp.initialize(new AbortController().signal);
    const result = await mcp.callTool("report_events", { a: 1 }, new AbortController().signal);

    expect(result).toEqual({
      text: "line-1\nline-2",
      isError: false,
      droppedContentBlocks: 1,
    });
    const call = transport.sent.find((message) => message.method === "tools/call");
    expect(call?.params).toEqual({ name: "report_events", arguments: { a: 1 } });
  });

  test("非 2xx 在 client 层报 http-status（不在 transport 层）", async () => {
    const transport = transportWith((message) =>
      message.method === "initialize"
        ? jsonResponse(INIT_RESULT, message.id ?? 0)
        : { status: 401, contentType: "text/plain", body: "unauthorized" },
    );
    const mcp = client(transport);
    await mcp.initialize(new AbortController().signal);
    await expect(mcp.callTool("t", {}, new AbortController().signal)).rejects.toMatchObject({
      code: "http-status",
    });
  });

  test("JSON-RPC error 回包 → server-error（带服务端 code 与 message）", async () => {
    const transport = transportWith((message) => {
      if (message.method === "initialize") {
        return jsonResponse(INIT_RESULT, message.id ?? 0);
      }
      if (message.method === "notifications/initialized") {
        return { status: 202, contentType: "", body: "" };
      }
      return {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "tool not found" },
        }),
      };
    });
    const mcp = client(transport);
    await mcp.initialize(new AbortController().signal);
    const failure = await mcp
      .callTool("missing", {}, new AbortController().signal)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProtocolError);
    expect((failure as ProtocolError).code).toBe("server-error");
    expect((failure as ProtocolError).message).toContain("tool not found");
  });
});
