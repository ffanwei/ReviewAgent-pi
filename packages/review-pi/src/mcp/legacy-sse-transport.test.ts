import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, expect, test } from "vitest";

import { createLegacySseTransport } from "./legacy-sse-transport.js";

// 老式 HTTP+SSE 传输（ADR-0037 后续修订）：GET 长连接收 endpoint 事件 →
// 消息 POST 到该端点 → 响应从 SSE 流回来（按 id 关联）。用进程内假服务端
// 验证全链，不发真网络。

interface LegacyServer {
  readonly sseUrl: string;
  readonly close: () => Promise<void>;
}

interface LegacyServerOptions {
  /** 消息端点对某 method 的处置：stream（默认，响应走流）/ swallow（202 但不回）/ direct（响应直接回在 POST 体） */
  readonly mode?: "stream" | "swallow" | "direct";
  /** SSE 端点是否延迟发出 endpoint 事件（验证连接等待） */
  readonly delayEndpointMs?: number;
  /** GET /sse 是否回 404（验证连接失败路径） */
  readonly sseNotFound?: boolean;
}

function startLegacyServer(options: LegacyServerOptions = {}): Promise<LegacyServer> {
  const posts: { path: string; body: unknown }[] = [];
  let sseResponse: http.ServerResponse | undefined;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown;
      try {
        body = JSON.parse(raw) as unknown;
      } catch {
        body = undefined;
      }
      if (request.method === "GET" && request.url === "/sse") {
        if (options.sseNotFound === true) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end("{}");
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        sseResponse = response;
        const announce = (): void => {
          response.write("event: endpoint\ndata: /message?sessionId=42\n\n");
          response.write(": keep-alive comment is ignored\n\n");
        };
        if (options.delayEndpointMs !== undefined) {
          setTimeout(announce, options.delayEndpointMs);
        } else {
          announce();
        }
        return;
      }
      if (request.method === "POST" && request.url === "/message?sessionId=42") {
        posts.push({ path: request.url ?? "", body });
        const message = body as { id?: number; method?: string } | undefined;
        if (message?.id === undefined) {
          // 通知：202 即完成
          response.writeHead(202);
          response.end();
          return;
        }
        const reply = JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result:
            message.method === "initialize"
              ? { protocolVersion: "2024-11-05", serverInfo: { name: "legacy-stub", version: "1" } }
              : { content: [{ type: "text", text: "ok" }] },
        });
        if (options.mode === "direct") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(reply);
          return;
        }
        if (options.mode === "swallow") {
          response.writeHead(202);
          response.end();
          return;
        }
        // 规范形态：响应走 SSE 流，POST 回 202
        response.writeHead(202);
        response.end();
        sseResponse?.write(`data: ${reply}\n\n`);
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: `unexpected ${request.method} ${request.url}` } }));
    });
  });
  return new Promise<LegacyServer>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        sseUrl: `http://127.0.0.1:${port}/sse`,
        close: () =>
          new Promise<void>((closed) => {
            server.closeAllConnections?.();
            server.close(() => closed());
          }),
      });
    });
  });
}

const servers: LegacyServer[] = [];
afterAll(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

function spawn(options: LegacyServerOptions = {}): Promise<LegacyServer> {
  return startLegacyServer(options).then((server) => {
    servers.push(server);
    return server;
  });
}

const TIMEOUT_MS = 2_000;

test("规范形态：GET /sse 收 endpoint 事件 → POST 消息端点 → 响应从流回来（initialize + tools/call + 通知）", async () => {
  const server = await spawn();
  const transport = createLegacySseTransport({ url: server.sseUrl, timeoutMs: TIMEOUT_MS });
  try {
    const initialize = await transport.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
      }),
      AbortSignal.timeout(TIMEOUT_MS),
    );
    expect(initialize.status).toBe(200);
    expect(JSON.parse(initialize.body)).toMatchObject({
      result: { protocolVersion: "2024-11-05", serverInfo: { name: "legacy-stub" } },
    });

    // 通知（无 id）：POST 被接受即完成
    const notification = await transport.send(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      AbortSignal.timeout(TIMEOUT_MS),
    );
    expect(notification.status).toBe(202);

    const call = await transport.send(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "startTask", arguments: {} } }),
      AbortSignal.timeout(TIMEOUT_MS),
    );
    expect(call.status).toBe(200);
    expect(JSON.parse(call.body)).toMatchObject({ id: 2, result: { content: [{ type: "text" }] } });
  } finally {
    await transport.close();
  }
});

test("相对端点解析 + endpoint 事件延迟到达（连接等待）", async () => {
  const server = await spawn({ delayEndpointMs: 150 });
  const transport = createLegacySseTransport({ url: server.sseUrl, timeoutMs: TIMEOUT_MS });
  try {
    const response = await transport.send(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      AbortSignal.timeout(TIMEOUT_MS),
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ id: 1 });
  } finally {
    await transport.close();
  }
});

test("兼容直回实现：POST 回体直接带 id 匹配的 JSON-RPC 响应就不等流", async () => {
  const server = await spawn({ mode: "direct" });
  const transport = createLegacySseTransport({ url: server.sseUrl, timeoutMs: TIMEOUT_MS });
  try {
    const response = await transport.send(
      JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: {} }),
      AbortSignal.timeout(TIMEOUT_MS),
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ id: 7 });
  } finally {
    await transport.close();
  }
});

test("流上无响应 → 超时拒绝（no-response）；close 后 send 拒绝", async () => {
  const server = await spawn({ mode: "swallow" });
  const transport = createLegacySseTransport({ url: server.sseUrl, timeoutMs: 300 });
  try {
    await expect(
      transport.send(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: {} }), AbortSignal.timeout(2_000)),
    ).rejects.toThrow(/no JSON-RPC response/);
  } finally {
    await transport.close();
  }
  await expect(
    transport.send(JSON.stringify({ jsonrpc: "2.0", id: 10, method: "x", params: {} }), AbortSignal.timeout(100)),
  ).rejects.toThrow(/closed/);
});

test("SSE 端点 404 → 连接失败（http-status）", async () => {
  const notFound = await spawn({ sseNotFound: true });
  const deadTransport = createLegacySseTransport({ url: notFound.sseUrl, timeoutMs: TIMEOUT_MS });
  try {
    await expect(
      deadTransport.send(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
        AbortSignal.timeout(TIMEOUT_MS),
      ),
    ).rejects.toThrow(/HTTP 404/);
  } finally {
    await deadTransport.close();
  }
});
