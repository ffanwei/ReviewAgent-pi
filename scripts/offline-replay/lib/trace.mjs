import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";

/**
 * trace 读写与指纹（ADR-0048）。
 *
 * 指纹 = 原始请求体 UTF-8 的全量 SHA-256，不做任何规范化：请求体漂移
 * （fixture / 配置 / 提示词变化）必须显式暴露，而不是被「聪明地」抹平。
 *
 * `requestShape` 是给未命中诊断用的紧凑结构摘要（每条约 0.3 KB）：只存
 * 消息角色 / 字符数 / 单条 hash，不存正文——这样既能指出「第几条消息开始
 * 不同」，又不破坏「请求体默认不入库」的体积预算。
 */

export const TRACE_SCHEMA_VERSION = 1;

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function hashRequest(bodyText) {
  return `sha256:${sha256(bodyText)}`;
}

export function buildRequestShape(bodyText) {
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return {
      malformed: true,
      chars: bodyText.length,
      hash: hashRequest(bodyText),
    };
  }
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return {
    model: typeof body?.model === "string" ? body.model : null,
    stream: body?.stream === true,
    maxTokens: typeof body?.max_tokens === "number" ? body.max_tokens : null,
    toolsDigest: body?.tools === undefined ? null : `sha256:${sha256(JSON.stringify(body.tools))}`,
    messageCount: messages.length,
    messages: messages.map((message) => {
      const content = message?.content;
      const text = typeof content === "string" ? content : JSON.stringify(content ?? null);
      return {
        role: typeof message?.role === "string" ? message.role : "",
        chars: text.length,
        hash: `sha256:${sha256(JSON.stringify(message))}`,
      };
    }),
  };
}

/** 从请求体数组里取共享 tools（第一次出现的那份；并校验后续逐字节一致） */
export function extractSharedTools(requestBodies) {
  let tools;
  let toolsText;
  for (const raw of requestBodies) {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      continue;
    }
    if (body?.tools === undefined) {
      continue;
    }
    const text = JSON.stringify(body.tools);
    if (toolsText === undefined) {
      toolsText = text;
      tools = body.tools;
    } else if (text !== toolsText) {
      throw new Error(
        "trace 录制失败：不同请求的 tools 不一致（共享 tools 只能存一份，请检查请求构造）",
      );
    }
  }
  return tools ?? [];
}

export function buildTrace({ id, fixture, model, tools, interactions }) {
  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    id,
    fixture,
    model,
    tools,
    interactions,
  };
}

export function validateTrace(trace, source = "trace") {
  if (trace === null || typeof trace !== "object") {
    throw new Error(`${source}: 不是对象`);
  }
  if (trace.schemaVersion !== TRACE_SCHEMA_VERSION) {
    throw new Error(
      `${source}: schemaVersion=${String(trace.schemaVersion)}，本工具只支持 ${String(TRACE_SCHEMA_VERSION)}`,
    );
  }
  if (typeof trace.id !== "string" || trace.id.trim() === "") {
    throw new Error(`${source}: 缺少 id`);
  }
  if (!Array.isArray(trace.interactions) || trace.interactions.length === 0) {
    throw new Error(`${source}: interactions 为空`);
  }
  if (!Array.isArray(trace.tools)) {
    throw new Error(`${source}: tools 必须是数组`);
  }
  const seen = new Map();
  for (const [index, interaction] of trace.interactions.entries()) {
    if (typeof interaction?.requestHash !== "string" || !interaction.requestHash.startsWith("sha256:")) {
      throw new Error(`${source}: interactions[${index}] 缺少合法 requestHash`);
    }
    if (typeof interaction?.response?.body !== "string") {
      throw new Error(`${source}: interactions[${index}] 缺少 response.body`);
    }
    const kind = interaction.kind;
    if (kind !== "review" && kind !== "oneshot") {
      throw new Error(`${source}: interactions[${index}] 的 kind 必须是 review / oneshot`);
    }
    if (interaction.latencyMs !== undefined && !(Number.isFinite(interaction.latencyMs) && interaction.latencyMs >= 0)) {
      throw new Error(`${source}: interactions[${index}] 的 latencyMs 必须是非负数`);
    }
    const previous = seen.get(interaction.requestHash);
    if (previous !== undefined && previous.response.body !== interaction.response.body) {
      throw new Error(
        `${source}: requestHash ${interaction.requestHash.slice(0, 19)}… 重复且响应不同（指纹冲突或录制被污染）`,
      );
    }
    seen.set(interaction.requestHash, interaction);
  }
  return trace;
}

export async function loadTrace(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`读不到 trace：${path}（${error.message}）`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`trace 不是合法 JSON：${path}（${error.message}）`);
  }
  return validateTrace(parsed, path);
}

export async function saveTrace(path, trace, options = {}) {
  validateTrace(trace, path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(trace, null, 2)}\n`, "utf8");
  if (options.storeRequests === true && options.requests !== undefined) {
    const sidecar = path.replace(/\.json$/u, ".requests.json");
    const docs = options.requests.map((request) => ({
      requestHash: request.requestHash,
      kind: request.kind,
      body: request.body,
    }));
    await writeFile(sidecar, `${JSON.stringify(docs, null, 2)}\n`, "utf8");
    return { path, sidecar };
  }
  return { path, sidecar: undefined };
}

export function interactionMap(trace) {
  const map = new Map();
  for (const interaction of trace.interactions) {
    map.set(interaction.requestHash, interaction);
  }
  return map;
}

/**
 * 未命中诊断：找出与当前请求最接近的记录（消息前缀最长的），指出首个差异
 * 位置。返回人读多行文本，调用方直接落 stderr。
 */
export function diagnoseMiss(trace, bodyText) {
  const live = buildRequestShape(bodyText);
  const liveHash = hashRequest(bodyText);
  let best;
  let bestScore = -1;
  for (const interaction of trace.interactions) {
    const shape = interaction.requestShape;
    if (shape === undefined) {
      continue;
    }
    let score = 0;
    if (shape.model === live.model) score += 1;
    if (shape.stream === live.stream) score += 1;
    if (shape.maxTokens === live.maxTokens) score += 1;
    if (shape.toolsDigest === live.toolsDigest) score += 1;
    const common = Math.min(shape.messages?.length ?? 0, live.messages.length);
    for (let index = 0; index < common; index += 1) {
      if (shape.messages[index]?.hash !== live.messages[index]?.hash) {
        break;
      }
      score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = interaction;
    }
  }

  const lines = [
    `replay: 请求未命中 trace（${liveHash.slice(0, 19)}…）`,
  ];
  if (best === undefined) {
    lines.push("  trace 里没有任何可比较的 interaction（是否漏录了这条请求？）");
  } else {
    const shape = best.requestShape;
    lines.push(`  最近邻：${best.requestHash.slice(0, 19)}…（kind=${best.kind}）`);
    if (shape.model !== live.model) {
      lines.push(`  model：live=${String(live.model)} / trace=${String(shape.model)}`);
    }
    if (shape.stream !== live.stream) {
      lines.push(`  stream：live=${String(live.stream)} / trace=${String(shape.stream)}`);
    }
    if (shape.maxTokens !== live.maxTokens) {
      lines.push(`  max_tokens：live=${String(live.maxTokens)} / trace=${String(shape.maxTokens)}`);
    }
    if (shape.toolsDigest !== live.toolsDigest) {
      lines.push(`  tools：live=${String(live.toolsDigest)} / trace=${String(shape.toolsDigest)}`);
    }
    const common = Math.min(shape.messages?.length ?? 0, live.messages.length);
    let diverged = -1;
    for (let index = 0; index < common; index += 1) {
      if (shape.messages[index]?.hash !== live.messages[index]?.hash) {
        diverged = index;
        break;
      }
    }
    if (diverged >= 0) {
      const before = live.messages[diverged];
      const after = shape.messages[diverged];
      lines.push(
        `  messages[${String(diverged)}] 首次不同：live(role=${before.role}, ${String(before.chars)} chars) ` +
          `vs trace(role=${after.role}, ${String(after.chars)} chars)`,
      );
      const prev = diverged > 0 ? live.messages[diverged - 1] : undefined;
      if (prev !== undefined) {
        lines.push(`  该条之前（messages[${String(diverged - 1)}], role=${prev.role}）仍一致`);
      }
    } else if (live.messages.length !== (shape.messages?.length ?? 0)) {
      lines.push(
        `  messages 数量：live=${String(live.messages.length)} / trace=${String(shape.messages?.length ?? 0)}`,
      );
    } else {
      lines.push("  消息逐条一致但整体 hash 不同：检查字段顺序或额外字段（model/stream/max_tokens/tools 之外）");
    }
  }
  lines.push("  当前请求体（前 2000 字符）：");
  lines.push(indent(bodyText.slice(0, 2000)));
  return lines.join("\n");
}

function indent(text) {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}
