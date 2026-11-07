import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";

/**
 * trace 读写与指纹（ADR-0048 / ADR-0049）。
 *
 * 指纹 = 原始请求体 UTF-8 的全量 SHA-256，不做任何规范化：请求体漂移
 * （fixture / 配置 / 提示词变化）必须显式暴露，而不是被「聪明地」抹平。
 *
 * `requestShape` 是给未命中诊断用的紧凑结构摘要（每条约 0.3 KB）：只存
 * 消息角色 / 字符数 / 单条 hash，不存正文——这样既能指出「第几条消息开始
 * 不同」，又不破坏「请求体默认不入库」的体积预算。
 *
 * schemaVersion 2（ADR-0049）：`tools` 从「全 trace 共享一份」改为
 * `toolsVariants[]`（按 digest 去重）+ 每条 interaction 的 `toolsRef`。
 * 起因是规则 Skill 会话的工具面是「七检视工具 + bash」（八只），与主会话
 * 的七只不同，共享一份的旧格式必然冲突。v1 trace 仍可读。
 */

export const TRACE_SCHEMA_VERSION = 2;
export const LEGACY_TRACE_SCHEMA_VERSION = 1;

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * 路径在请求体里的几种形态：原生（Windows 反斜杠）、正斜杠、以及 JSON 转义
 * 后的两种（请求体是 JSON 文本，`D:\x` 会写成 `D:\\x`）。
 */
export function pathVariants(path) {
  const forward = path.replaceAll("\\", "/");
  const variants = new Set([
    path,
    forward,
    JSON.stringify(path).slice(1, -1),
    JSON.stringify(forward).slice(1, -1),
  ]);
  return [...variants].filter((variant) => variant !== "");
}

/**
 * 请求体归一化（ADR-0049）：把**运行期才确定**的绝对路径（lane 目录）替换
 * 成固定占位符，再算指纹。仅用于已显式注册的根；没有注册就是原样哈希。
 *
 * 动机：规则 Skill 会话的首条消息带 `<lane>/tasks/t-1/.cache/rule-skills/…`
 * 的真实绝对路径（`formatSkillInvocation` 的 location）。lane 每个 worker、
 * 每次运行都不同，不归一化就会让 trace 绑死一次运行的目录，并发与 CI 必然
 * 全部未命中。归一化只抹掉「同一台机器上无法复现的目录名」，不抹任何
 * 请求内容（模型、消息、工具、参数仍全量比较）。
 */
export function normalizeRequestText(bodyText, roots = []) {
  let text = bodyText;
  for (const root of roots) {
    if (root === undefined || root === null || typeof root.path !== "string" || root.path === "") {
      continue;
    }
    for (const variant of pathVariants(root.path)) {
      text = text.split(variant).join(root.placeholder);
    }
  }
  return text;
}

export function hashRequest(bodyText, roots = []) {
  return `sha256:${sha256(normalizeRequestText(bodyText, roots))}`;
}

export function toolsDigest(tools) {
  return `sha256:${sha256(JSON.stringify(tools))}`;
}

export function buildRequestShape(bodyText, roots = []) {
  const normalized = normalizeRequestText(bodyText, roots);
  let body;
  try {
    body = JSON.parse(normalized);
  } catch {
    return {
      malformed: true,
      chars: normalized.length,
      hash: hashRequest(bodyText, roots),
    };
  }
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return {
    model: typeof body?.model === "string" ? body.model : null,
    stream: body?.stream === true,
    maxTokens: typeof body?.max_tokens === "number" ? body.max_tokens : null,
    toolsDigest: body?.tools === undefined ? null : toolsDigest(body.tools),
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

/**
 * 从请求体数组里提取 tools 变体（v2）：按 digest 去重，同一 digest 必须
 * 逐字节一致（否则是录制被污染）。没有 tools 的请求（一次性调用）ref 为 null。
 *
 * 返回 `refByHash`（requestHash → digest|null），调用方据此给 interaction
 * 填 `toolsRef`。
 */
export function extractToolsVariants(requestBodies) {
  const variants = [];
  const byDigest = new Map();
  const refByHash = new Map();
  for (const record of requestBodies) {
    let body;
    try {
      body = JSON.parse(record.body);
    } catch {
      refByHash.set(record.requestHash, null);
      continue;
    }
    if (body?.tools === undefined) {
      refByHash.set(record.requestHash, null);
      continue;
    }
    const text = JSON.stringify(body.tools);
    const digest = toolsDigest(body.tools);
    const existing = byDigest.get(digest);
    if (existing === undefined) {
      byDigest.set(digest, text);
      variants.push({ digest, tools: body.tools });
    } else if (existing !== text) {
      throw new Error(
        `trace 录制失败：tools digest 冲突（${digest.slice(0, 19)}…）但内容不同`,
      );
    }
    refByHash.set(record.requestHash, digest);
  }
  return { variants, refByHash };
}

/** v1 兼容：从请求体数组里取共享 tools（并校验后续逐字节一致） */
export function extractSharedTools(requestBodies) {
  let tools;
  let toolsText;
  for (const record of requestBodies) {
    let body;
    try {
      body = JSON.parse(record.body ?? record);
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

export function buildTrace({ id, fixture, model, toolsVariants, interactions, requestNormalization }) {
  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    id,
    fixture,
    model,
    toolsVariants,
    ...(requestNormalization !== undefined ? { requestNormalization } : {}),
    interactions,
  };
}

export function toolsVariantCount(trace) {
  if (Array.isArray(trace.toolsVariants)) {
    return trace.toolsVariants.length;
  }
  return Array.isArray(trace.tools) && trace.tools.length > 0 ? 1 : 0;
}

export function validateTrace(trace, source = "trace") {
  if (trace === null || typeof trace !== "object") {
    throw new Error(`${source}: 不是对象`);
  }
  const version = trace.schemaVersion;
  if (version !== TRACE_SCHEMA_VERSION && version !== LEGACY_TRACE_SCHEMA_VERSION) {
    throw new Error(
      `${source}: schemaVersion=${String(version)}，本工具支持 ${String(LEGACY_TRACE_SCHEMA_VERSION)} / ${String(TRACE_SCHEMA_VERSION)}`,
    );
  }
  if (typeof trace.id !== "string" || trace.id.trim() === "") {
    throw new Error(`${source}: 缺少 id`);
  }
  if (!Array.isArray(trace.interactions) || trace.interactions.length === 0) {
    throw new Error(`${source}: interactions 为空`);
  }

  const digests = new Set();
  if (trace.requestNormalization !== undefined) {
    const placeholders = trace.requestNormalization?.placeholders;
    if (
      !Array.isArray(placeholders) ||
      placeholders.length === 0 ||
      placeholders.some((placeholder) => typeof placeholder !== "string" || placeholder === "")
    ) {
      throw new Error(`${source}: requestNormalization.placeholders 必须是非空字符串数组`);
    }
  }
  if (version === TRACE_SCHEMA_VERSION) {
    if (!Array.isArray(trace.toolsVariants) || trace.toolsVariants.length === 0) {
      throw new Error(`${source}: toolsVariants 必须是非空数组`);
    }
    for (const [index, variant] of trace.toolsVariants.entries()) {
      if (typeof variant?.digest !== "string" || !variant.digest.startsWith("sha256:")) {
        throw new Error(`${source}: toolsVariants[${index}] 缺少合法 digest`);
      }
      if (!Array.isArray(variant.tools)) {
        throw new Error(`${source}: toolsVariants[${index}].tools 必须是数组`);
      }
      if (digests.has(variant.digest)) {
        throw new Error(`${source}: toolsVariants 出现重复 digest ${variant.digest.slice(0, 19)}…`);
      }
      if (toolsDigest(variant.tools) !== variant.digest) {
        throw new Error(
          `${source}: toolsVariants[${index}] 的 digest 与 tools 内容不一致（被手工改过？）`,
        );
      }
      digests.add(variant.digest);
    }
  } else if (!Array.isArray(trace.tools)) {
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
    if (version === TRACE_SCHEMA_VERSION) {
      const ref = interaction.toolsRef;
      if (kind === "review" && ref === undefined) {
        throw new Error(`${source}: interactions[${index}]（review）缺少 toolsRef`);
      }
      if (ref !== undefined && ref !== null && !digests.has(ref)) {
        throw new Error(`${source}: interactions[${index}].toolsRef 指向不存在的变体 ${String(ref)}`);
      }
      const shapeDigest = interaction.requestShape?.toolsDigest;
      if (ref !== undefined && shapeDigest !== undefined && shapeDigest !== ref) {
        throw new Error(
          `${source}: interactions[${index}] 的 toolsRef 与 requestShape.toolsDigest 不一致`,
        );
      }
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
 * 真网关录制时的脱敏：把本机绝对路径换成固定占位符。
 *
 * 只用于**落盘的响应体与请求体 sidecar**，绝不参与 requestHash 计算——
 * 指纹必须基于线上真实字节，否则回放永远匹配不上。
 *
 * JSON 里的反斜杠会被转义（`D:\\Project\\…`），所以原生与转义两种形态
 * 都要替换；正斜杠形态一并处理。
 */
export function sanitizeText(text, roots) {
  let output = text;
  for (const entry of roots) {
    const root = typeof entry === "string" ? entry : entry?.path;
    const placeholder = typeof entry === "string" ? "<path>" : `<${entry.placeholder ?? "path"}>`;
    if (root === undefined || root === "") {
      continue;
    }
    for (const variant of pathVariants(root)) {
      output = output.split(variant).join(placeholder);
    }
  }
  return output;
}

/**
 * 未命中诊断：找出与当前请求最接近的记录（消息前缀最长的），指出首个差异
 * 位置。返回人读多行文本，调用方直接落 stderr。
 *
 * `roots` 必须与回放时算指纹用的一致，否则诊断会在「已归一化」的 shape 与
 * 归一化的 live 之间错位。
 */
export function diagnoseMiss(trace, bodyText, roots = []) {
  const live = buildRequestShape(bodyText, roots);
  const liveHash = hashRequest(bodyText, roots);
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
      if (live.toolsDigest !== null) {
        const known = Array.isArray(trace.toolsVariants)
          ? trace.toolsVariants.some((variant) => variant.digest === live.toolsDigest)
          : false;
        lines.push(
          known
            ? "        （该工具面在 trace 里存在，只是这条消息序列没录过）"
            : "        （该工具面在 trace 里不存在：可能漏录了某类会话）",
        );
      }
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
