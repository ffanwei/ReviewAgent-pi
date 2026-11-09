#!/usr/bin/env node
/**
 * Real (but tiny) MCP server used by the large-MR end-to-end harness.
 *
 * It speaks just enough of the MCP Streamable HTTP transport for review-pi:
 *   - POST /mcp     JSON-RPC: initialize / notifications/initialized /
 *                   tools/list / tools/call / ping
 *   - GET  /        the dashboard page
 *   - GET  /api/state   current state as JSON (used by the harness assertions)
 *   - GET  /events      Server-Sent Events, full snapshot per change
 *   - POST /api/reset   clear state before a run
 *   - POST /api/expect  declare the diff file list the run is expected to cover
 *
 * Every business tool call is kept in memory, so the dashboard can render the
 * exact payloads review-pi sent. Nothing leaves the machine.
 *
 * Usage:
 *   node scripts/e2e-mcp/server.mjs [--port 7317] [--host 127.0.0.1]
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_FILE = join(HERE, "dashboard.html");

const argv = process.argv.slice(2);
function argValue(name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
}
const PORT = Number(argValue("--port", process.env.E2E_MCP_PORT ?? "7317"));
const HOST = argValue("--host", "127.0.0.1");

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "e2e-review-mcp", version: "0.1.0" };

const TOOLS = [
  {
    name: "startTask",
    description: "Start a review task.",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
    },
  },
  {
    name: "mrReviewResult",
    description: "Report the review findings for one changed file.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        filePath: { type: "string" },
        reviewTips: { type: "array" },
      },
      required: ["taskId", "filePath", "reviewTips"],
    },
  },
  {
    name: "saveReviewSummary",
    description: "Save the Markdown review summary.",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" }, markdownContent: { type: "string" } },
      required: ["taskId", "markdownContent"],
    },
  },
  {
    name: "endTask",
    description: "Finish a review task.",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
    },
  },
  {
    name: "report_events",
    description: "Batch progress events.",
    inputSchema: {
      type: "object",
      properties: {
        schemaVersion: { type: "number" },
        streamId: { type: "string" },
        events: { type: "array" },
      },
      required: ["schemaVersion", "streamId", "events"],
    },
  },
];

/** @type {any} */
let state = freshState();
let callSeq = 0;
const sseClients = new Set();
let broadcastTimer = null;

function freshState() {
  return {
    startedAt: new Date().toISOString(),
    protocolVersion: PROTOCOL_VERSION,
    serverInfo: SERVER_INFO,
    handshakes: 0,
    tasks: new Set(),
    calls: [],
    files: new Map(),
    summary: null,
    progress: [],
    streams: new Set(),
    expected: null,
    order: [],
    violations: [],
  };
}

function resetState() {
  state = freshState();
  callSeq = 0;
  broadcast();
}

// ---------------------------------------------------------------- snapshots

function snapshot() {
  const files = [...state.files.values()];
  const tipCount = files.reduce((sum, file) => sum + file.reviewTips.length, 0);
  const emptyFiles = files.filter((file) => file.reviewTips.length === 0).length;
  const expected = state.expected;
  const reportedPaths = new Set(files.map((file) => file.filePath));
  const missing = expected === null ? [] : expected.files.filter((file) => !reportedPaths.has(file));
  const unexpected = expected === null ? [] : files
    .map((file) => file.filePath)
    .filter((file) => !expected.files.includes(file));
  return {
    startedAt: state.startedAt,
    now: new Date().toISOString(),
    protocolVersion: state.protocolVersion,
    serverInfo: state.serverInfo,
    handshakes: state.handshakes,
    callCount: state.calls.length,
    taskIds: [...state.tasks],
    expected,
    coverage: {
      expectedFiles: expected === null ? null : expected.files.length,
      reportedFiles: files.length,
      missing,
      unexpected,
    },
    counts: {
      files: files.length,
      tips: tipCount,
      emptyFiles,
      progressEvents: state.progress.length,
      progressStreams: state.streams.size,
    },
    order: state.order,
    violations: state.violations,
    files,
    summary: state.summary,
    calls: state.calls.map((call) => ({
      seq: call.seq,
      tool: call.tool,
      at: call.at,
      ok: call.ok,
      filePath: call.filePath ?? null,
      tipCount: call.tipCount ?? null,
    })),
    progress: state.progress.slice(-200),
  };
}

function broadcast() {
  if (broadcastTimer !== null) {
    return;
  }
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    const payload = `event: state\ndata: ${JSON.stringify(snapshot())}\n\n`;
    for (const response of sseClients) {
      try {
        response.write(payload);
      } catch {
        sseClients.delete(response);
      }
    }
  }, 40);
  broadcastTimer.unref?.();
}

// ---------------------------------------------------------------- recording

function noteOrder(tool) {
  const order = state.order;
  const last = order[order.length - 1];
  if (tool === "startTask") {
    if (order.length > 0) {
      state.violations.push(`startTask arrived after ${order.join(", ")}`);
    }
    order.push(tool);
    return;
  }
  if (tool === "endTask") {
    if (!order.includes("startTask")) {
      state.violations.push("endTask arrived before startTask");
    }
    if (!order.includes("saveReviewSummary")) {
      state.violations.push("endTask arrived before saveReviewSummary");
    }
    order.push(tool);
    return;
  }
  if (tool === "saveReviewSummary") {
    if (!order.includes("startTask")) {
      state.violations.push("saveReviewSummary arrived before startTask");
    }
    if (order.includes("saveReviewSummary")) {
      state.violations.push("saveReviewSummary called more than once");
    }
    order.push(tool);
    return;
  }
  if (tool === "mrReviewResult") {
    if (!order.includes("startTask")) {
      state.violations.push("mrReviewResult arrived before startTask");
    }
    if (order.includes("saveReviewSummary")) {
      state.violations.push("mrReviewResult arrived after saveReviewSummary");
    }
    if (last !== "startTask" && last !== "mrReviewResult") {
      state.violations.push(`mrReviewResult arrived after ${last}`);
    }
    order.push(tool);
  }
}

function recordBusinessCall(tool, args) {
  callSeq += 1;
  const call = {
    seq: callSeq,
    tool,
    at: new Date().toISOString(),
    ok: true,
    args,
  };
  state.calls.push(call);
  noteOrder(tool);

  if (tool === "startTask") {
    const taskId = String(args?.taskId ?? "");
    if (taskId !== "") {
      state.tasks.add(taskId);
    }
  } else if (tool === "mrReviewResult") {
    const filePath = typeof args?.filePath === "string" ? args.filePath : "(missing)";
    const reviewTips = Array.isArray(args?.reviewTips) ? args.reviewTips : [];
    if (state.files.has(filePath)) {
      state.violations.push(`duplicate mrReviewResult for ${filePath}`);
    }
    const existing = state.files.get(filePath);
    state.files.set(filePath, {
      filePath,
      reviewTips: existing === undefined ? reviewTips : [...existing.reviewTips, ...reviewTips],
      at: call.at,
      seq: call.seq,
      raw: args,
    });
    call.filePath = filePath;
    call.tipCount = reviewTips.length;
    if (state.expected !== null && !state.expected.files.includes(filePath)) {
      state.violations.push(`mrReviewResult for unexpected file ${filePath}`);
    }
  } else if (tool === "saveReviewSummary") {
    state.summary = {
      at: call.at,
      seq: call.seq,
      markdownContent: typeof args?.markdownContent === "string" ? args.markdownContent : "",
    };
  }
  broadcast();
}

function recordProgress(args) {
  if (!Array.isArray(args?.events)) {
    return;
  }
  const streamId = typeof args.streamId === "string" ? args.streamId : "(missing)";
  state.streams.add(streamId);
  for (const envelope of args.events) {
    state.progress.push({
      streamId,
      seq: envelope?.seq ?? null,
      at: envelope?.at ?? null,
      type: envelope?.event?.type ?? "unknown",
      event: envelope?.event ?? null,
    });
  }
  broadcast();
}

// ---------------------------------------------------------------- HTTP glue

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function handleRpc(request, response) {
  let message;
  try {
    message = JSON.parse(await readBody(request));
  } catch {
    json(response, 400, rpcError(null, -32700, "parse error"));
    return;
  }
  if (Array.isArray(message)) {
    json(response, 400, rpcError(null, -32600, "batch requests are not supported"));
    return;
  }
  const id = message?.id;
  const method = message?.method;

  // Notifications carry no id and must not get a JSON-RPC response body.
  if (id === undefined || id === null) {
    if (method === "notifications/initialized") {
      response.writeHead(202);
      response.end();
      return;
    }
    response.writeHead(202);
    response.end();
    return;
  }

  if (method === "initialize") {
    state.handshakes += 1;
    json(
      response,
      200,
      rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: "Local harness server: records review-pi calls for the dashboard.",
      }),
    );
    broadcast();
    return;
  }

  if (method === "ping") {
    json(response, 200, rpcResult(id, {}));
    return;
  }

  if (method === "tools/list") {
    json(response, 200, rpcResult(id, { tools: TOOLS }));
    return;
  }

  if (method === "tools/call") {
    const name = message?.params?.name;
    const args = message?.params?.arguments ?? {};
    const known = TOOLS.some((tool) => tool.name === name);
    if (!known) {
      json(response, 200, rpcError(id, -32602, `unknown tool: ${String(name)}`));
      return;
    }
    if (name === "report_events") {
      recordProgress(args);
      console.log(`[mcp] ${name} events=${Array.isArray(args?.events) ? args.events.length : 0}`);
    } else {
      recordBusinessCall(name, args);
      const extra =
        name === "mrReviewResult"
          ? ` file=${args?.filePath ?? "?"} tips=${Array.isArray(args?.reviewTips) ? args.reviewTips.length : "?"}`
          : "";
      console.log(`[mcp] #${callSeq} ${name}${extra}`);
    }
    json(response, 200, rpcResult(id, { content: [{ type: "text", text: "ok" }] }));
    return;
  }

  json(response, 200, rpcError(id, -32601, `method not found: ${String(method)}`));
}

function serveEvents(request, response) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.write(`retry: 2000\n\n`);
  response.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
  sseClients.add(response);
  const heartbeat = setInterval(() => {
    try {
      response.write(`: ping\n\n`);
    } catch {
      clearInterval(heartbeat);
    }
  }, 15_000);
  heartbeat.unref?.();
  request.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(response);
  });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const path = url.pathname;

  try {
    if (request.method === "POST" && path === "/mcp") {
      await handleRpc(request, response);
      return;
    }
    if (request.method === "GET" && (path === "/" || path === "/dashboard.html")) {
      const html = readFileSync(DASHBOARD_FILE);
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": html.length,
        "cache-control": "no-store",
      });
      response.end(html);
      return;
    }
    if (request.method === "GET" && path === "/api/state") {
      json(response, 200, snapshot());
      return;
    }
    if (request.method === "GET" && path === "/events") {
      serveEvents(request, response);
      return;
    }
    if (request.method === "POST" && path === "/api/reset") {
      resetState();
      console.log("[mcp] state reset");
      json(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && path === "/api/expect") {
      const body = await readBody(request);
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        json(response, 400, { ok: false, error: "invalid json" });
        return;
      }
      const files = Array.isArray(parsed?.files) ? parsed.files.map(String) : [];
      state.expected = {
        files,
        taskId: typeof parsed?.taskId === "string" ? parsed.taskId : null,
        caseId: typeof parsed?.caseId === "string" ? parsed.caseId : null,
        at: new Date().toISOString(),
      };
      console.log(`[mcp] expect ${files.length} files`);
      broadcast();
      json(response, 200, { ok: true, files: files.length });
      return;
    }
    if (request.method === "GET" && path === "/api/health") {
      json(response, 200, { ok: true, port: PORT });
      return;
    }
    json(response, 404, { ok: false, error: "not found", path });
  } catch (error) {
    console.error("[mcp] handler error", error);
    if (!response.headersSent) {
      json(response, 500, { ok: false, error: String(error) });
    } else {
      response.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[mcp] e2e MCP server listening on http://${HOST}:${PORT}`);
  console.log(`[mcp] dashboard: http://${HOST}:${PORT}/`);
  console.log(`[mcp] MCP endpoint: http://${HOST}:${PORT}/mcp`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`[mcp] ${signal} received, shutting down`);
    for (const response of sseClients) {
      try {
        response.end();
      } catch {
        // ignore
      }
    }
    server.close(() => process.exit(0));
  });
}
