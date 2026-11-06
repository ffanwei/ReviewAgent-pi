import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { describe, expect, test } from "vitest";

import { ProtocolError } from "./protocol.js";
import { createHttpTransport } from "./transport.js";

// HTTP 传输（ADR-0037 决策 4）：真本地服务，验证请求形状、两种响应类型、
// 非 2xx 不抛错、超时中断。

interface LocalServer {
  readonly url: string;
  readonly close: () => Promise<void>;
}

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<LocalServer> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}/mcp`,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

describe("createHttpTransport", () => {
  test("POST JSON，Accept 同时带两种响应类型，body 原样发出", async () => {
    let seen: { method?: string; accept?: string; contentType?: string; body: string } | undefined;
    const server = await startServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        seen = {
          method: request.method,
          accept: request.headers.accept,
          contentType: request.headers["content-type"],
          body,
        };
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"jsonrpc":"2.0","id":1,"result":{}}');
      });
    });
    try {
      const transport = createHttpTransport({ url: server.url, timeoutMs: 2_000 });
      const response = await transport.send('{"jsonrpc":"2.0","id":1,"method":"ping"}', new AbortController().signal);

      expect(seen?.method).toBe("POST");
      expect(seen?.accept).toContain("application/json");
      expect(seen?.accept).toContain("text/event-stream");
      expect(seen?.contentType).toBe("application/json");
      expect(seen?.body).toBe('{"jsonrpc":"2.0","id":1,"method":"ping"}');
      expect(response.status).toBe(200);
      expect(response.contentType).toBe("application/json");
      expect(response.body).toContain('"result"');
    } finally {
      await server.close();
    }
  });

  test("text/event-stream 的 content-type 原样透传", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n');
    });
    try {
      const transport = createHttpTransport({ url: server.url, timeoutMs: 2_000 });
      const response = await transport.send("{}", new AbortController().signal);
      expect(response.contentType).toBe("text/event-stream");
      expect(response.body).toContain("data:");
    } finally {
      await server.close();
    }
  });

  test("非 2xx 不抛错（状态码交给 client 解释）", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(401, { "content-type": "text/plain" });
      response.end("unauthorized");
    });
    try {
      const transport = createHttpTransport({ url: server.url, timeoutMs: 2_000 });
      const response = await transport.send("{}", new AbortController().signal);
      expect(response.status).toBe(401);
      expect(response.body).toBe("unauthorized");
    } finally {
      await server.close();
    }
  });

  test("Mcp-Session-Id：initialize 响应头指派后，后续请求全部回带", async () => {
    const seenSessions: (string | undefined)[] = [];
    const server = await startServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        seenSessions.push(request.headers["mcp-session-id"] as string | undefined);
        const id = (JSON.parse(body) as { id?: number }).id ?? 0;
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (seenSessions.length === 1) {
          headers["mcp-session-id"] = "session-abc";
        }
        response.writeHead(200, headers);
        response.end(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
      });
    });
    try {
      const transport = createHttpTransport({ url: server.url, timeoutMs: 2_000 });
      await transport.send('{"jsonrpc":"2.0","id":1,"method":"initialize"}', new AbortController().signal);
      await transport.send('{"jsonrpc":"2.0","id":2,"method":"tools/call"}', new AbortController().signal);
      await transport.send('{"jsonrpc":"2.0","id":3,"method":"tools/call"}', new AbortController().signal);

      // 第一条不带；服务端指派后第二 / 三条必须回带同一个 id
      expect(seenSessions).toEqual([undefined, "session-abc", "session-abc"]);
    } finally {
      await server.close();
    }
  });

  test("服务端不指派会话：不带 Mcp-Session-Id（零影响）", async () => {
    const seenSessions: (string | undefined)[] = [];
    const server = await startServer((request, response) => {
      seenSessions.push(request.headers["mcp-session-id"] as string | undefined);
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"jsonrpc":"2.0","id":1,"result":{}}');
    });
    try {
      const transport = createHttpTransport({ url: server.url, timeoutMs: 2_000 });
      await transport.send('{"jsonrpc":"2.0","id":1,"method":"initialize"}', new AbortController().signal);
      await transport.send('{"jsonrpc":"2.0","id":2,"method":"tools/call"}', new AbortController().signal);
      expect(seenSessions).toEqual([undefined, undefined]);
    } finally {
      await server.close();
    }
  });

  test("超时中断为 ProtocolError(transport)，错误信息不含请求头", async () => {
    const server = await startServer(() => {
      // 永不响应
    });
    try {
      const transport = createHttpTransport({
        url: server.url,
        timeoutMs: 80,
        headers: { authorization: "Bearer super-secret-token" },
      });
      const error = await transport.send("{}", new AbortController().signal).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).code).toBe("transport");
      expect((error as Error).message).not.toContain("super-secret-token");
    } finally {
      await server.close();
    }
  });
});
