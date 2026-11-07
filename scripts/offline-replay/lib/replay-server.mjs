import http from "node:http";
import { createHash } from "node:crypto";

import { sseBody } from "./sse.mjs";
import { buildRequestShape, diagnoseMiss, hashRequest, interactionMap } from "./trace.mjs";

/**
 * 本地回放服务（ADR-0048 决策 5）：
 *   GET  /v1/models             → 合成模型清单（不进 trace）
 *   POST /v1/chat/completions   → replay 按 requestHash 严格命中；record 现录
 *   POST /mcp                   → MCP stub（initialize / tools/call / 通知 202）
 *
 * 一个实例被所有 worker 共享：状态只有「hash → 已冻结响应」与「MCP 调用
 * 记录」，没有任何按连接/按 run 的游标，因此天然并发安全。
 */

const PROTOCOL_VERSION = "2025-06-18";

export async function startReplayServer(options) {
  const mode = options.mode;
  if (mode !== "replay" && mode !== "record") {
    throw new Error(`replay server: mode 必须是 replay / record（收到 ${String(mode)}）`);
  }
  const latencyProfile = options.latency ?? { mode: "none" };
  const mcpOptions = options.mcp ?? { mode: "off" };
  const byHash = mode === "replay" ? interactionMap(options.trace) : new Map();
  const interactions = [];
  const requestBodies = [];
  const misses = [];
  const mcpCalls = [];
  const cursor = { index: 0 };
  const replies = options.corpus ?? [];
  // `/v1/models` 必须回 trace 录制时的 model.id（ADR-0048 决策 4），否则 CLI
  // 的模型探针在回放期就换了口径。
  const modelId = options.modelId ?? options.trace?.model?.id ?? "deepseek-v4-flash";

  const server = http.createServer((request, response) => {
    void handle(request, response);
  });

  async function handle(request, response) {
    let raw = "";
    try {
      raw = await readBody(request);
    } catch (error) {
      sendJson(response, 400, { error: { message: `cannot read body: ${String(error)}` } });
      return;
    }
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;

    if (request.method === "GET" && path === "/v1/models") {
      sendJson(response, 200, { object: "list", data: [{ id: modelId, object: "model" }] });
      return;
    }

    if (request.method === "GET" && path === "/health") {
      sendJson(response, 200, { ok: true, mode, interactions: interactions.length });
      return;
    }

    if (request.method === "POST" && path === "/v1/chat/completions") {
      await handleChatCompletion(raw, response);
      return;
    }

    if (request.method === "POST" && path === "/mcp") {
      await handleMcp(raw, response);
      return;
    }

    sendJson(response, 404, {
      error: { message: `replay server: unexpected ${String(request.method)} ${path}` },
    });
  }

  async function handleChatCompletion(raw, response) {
    const body = safeParse(raw);
    const wantsStream = body?.stream === true;
    const kind = wantsStream ? "review" : "oneshot";

    if (mode === "replay") {
      const hash = hashRequest(raw);
      const interaction = byHash.get(hash);
      if (interaction === undefined) {
        misses.push({ hash, kind, at: Date.now() });
        const detail = diagnoseMiss(options.trace, raw);
        process.stderr.write(`${detail}\n`);
        sendJson(response, 500, {
          error: {
            message: "replay: request is not in the trace (see stderr for the nearest interaction)",
          },
        });
        return;
      }
      const waitMs = effectiveLatencyMs(latencyProfile, interaction);
      if (waitMs > 0) {
        await delay(waitMs);
      }
      sendRaw(response, interaction.response.status, interaction.response.contentType, interaction.response.body);
      return;
    }

    // record：v2 真网关代理优先；否则走 canned 语料
    const served = options.upstream !== undefined
      ? await proxyUpstream(raw)
      : cannedResponse(body, wantsStream);
    if (served === undefined) {
      sendJson(response, 500, { error: { message: "record: scripted replies exhausted" } });
      return;
    }
    const hash = hashRequest(raw);
    const shape = buildRequestShape(raw);
    const existing = byHash.get(hash);
    if (existing !== undefined && existing.response.body !== served.body) {
      throw new Error(
        `record: 同一请求体命中两次但响应不同（${hash.slice(0, 19)}…）——canned 语料与请求不同步`,
      );
    }
    if (existing === undefined) {
      const interaction = {
        kind,
        requestHash: hash,
        requestShape: shape,
        response: served,
      };
      interactions.push(interaction);
      byHash.set(hash, interaction);
    }
    requestBodies.push({ kind, requestHash: hash, body: raw });
    sendRaw(response, served.status, served.contentType, served.body);
  }

  function cannedResponse(body, wantsStream) {
    if (!wantsStream && body?.max_tokens === 1) {
      // smoke 探针（`review` 本身不发；保留同形语义，不消费语料）
      return {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          model: body?.model ?? modelId,
          choices: [
            { index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      };
    }
    const reply = replies[cursor.index];
    cursor.index += 1;
    if (reply === undefined) {
      return undefined;
    }
    if (wantsStream) {
      return { status: 200, contentType: "text/event-stream", body: sseBody(reply) };
    }
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: reply.text ?? "" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    };
  }

  async function proxyUpstream(raw) {
    const upstream = options.upstream;
    const response = await fetch(`${upstream.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${upstream.apiKey}`,
      },
      body: raw,
    });
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "application/json",
      body: await response.text(),
    };
  }

  async function handleMcp(raw, response) {
    if (mcpOptions.mode !== "stub") {
      sendJson(response, 404, { error: { message: "replay server: MCP stub 未启用" } });
      return;
    }
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      sendJson(response, 400, { error: { message: "MCP: body is not JSON" } });
      return;
    }
    if (mcpOptions.latencyMs !== undefined && mcpOptions.latencyMs > 0) {
      await delay(mcpOptions.latencyMs);
    }
    if (message?.id === undefined) {
      response.writeHead(202);
      response.end();
      return;
    }
    if (message.method === "initialize") {
      sendJson(response, 200, {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          serverInfo: { name: "replay-stub", version: "1" },
          capabilities: {},
        },
      });
      return;
    }
    if (message.method === "tools/call") {
      const name = String(message.params?.name ?? "");
      const args = (message.params?.arguments ?? {});
      mcpCalls.push({ name, args });
      const failTools = mcpOptions.failTools ?? [];
      sendJson(response, 200, {
        jsonrpc: "2.0",
        id: message.id,
        result: failTools.includes(name)
          ? { content: [{ type: "text", text: "tool rejected" }], isError: true }
          : { content: [{ type: "text", text: "ok" }] },
      });
      return;
    }
    sendJson(response, 404, {
      error: { message: `replay server: unexpected MCP method ${String(message.method)}` },
    });
  }

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    mcpUrl: `http://127.0.0.1:${String(port)}/mcp`,
    port,
    interactions,
    requestBodies,
    mcpCalls: () => mcpCalls.map((call) => ({ name: call.name, args: structuredClone(call.args) })),
    misses: () => [...misses],
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function sendJson(response, status, payload) {
  sendRaw(response, status, "application/json", JSON.stringify(payload));
}

function sendRaw(response, status, contentType, body) {
  if (response.writableEnded) {
    return;
  }
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body, "utf8"),
  });
  response.end(body);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 确定性抖动：hash + seed → [0,1) */
function pseudoRandom(key, seed) {
  const digest = createHash("sha256").update(`${String(seed)}:${key}`, "utf8").digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

export function effectiveLatencyMs(profile, interaction) {
  if (interaction.latencyMs !== undefined) {
    return interaction.latencyMs;
  }
  if (profile.mode !== "fixed") {
    return 0;
  }
  const base = profile.ms ?? 0;
  const jitter = profile.jitter ?? 0;
  if (jitter <= 0) {
    return base;
  }
  const spread = pseudoRandom(interaction.requestHash, profile.seed ?? 0);
  return Math.max(0, Math.round(base * (1 + (spread * 2 - 1) * jitter)));
}
