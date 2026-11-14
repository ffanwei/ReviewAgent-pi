import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

import { auditPathOf } from "./run-artifacts.js";

/**
 * opencode-trace 兼容导出（ADR-0074）：把一次 run 的**逐模型请求**导出成
 * `opencode-trace-viewer` 可 import 的 trace bundle（目录，zip 由使用方自行打包）。
 *
 * 结构对齐 opencode-trace 的 import ZIP：
 *   manifest.json                     ← { exportedAt, mainSession, sessions[], version }
 *   sessions/<sessionId>/metadata.json ← { sessionId, title?, parentID?, subSessions?, createdAt?, updatedAt? }
 *   sessions/<sessionId>/1.json … N.json ← 每条 = 一次请求的 TraceRecord
 *
 * 纪律：
 * - request.body = `audit.requests[i].wireBody` 原文（逐字节真源；method/url/headers 合成）；
 * - response.body = 从转录第 i 条 assistant **合成** OpenAI chat.completion（text/thinking/toolCall
 *   → content/reasoning_content/tool_calls）；这是「能看到每一轮问/答」的取舍，不是原始 SSE；
 * - 第 i 条 requests ↔ 第 i 条 assistant；重试导致 requests 多出时，多余请求记 response:null；
 * - 只导出主会话（有 wire）；skill 会话 v1 不产出（ADR-0074 决策 3）。
 */

/** opencode-trace 的 TraceRecord（对齐其 zod schema；字段名与大小写一致） */
export interface TraceRecord {
  readonly id: number;
  readonly purpose: string;
  readonly requestAt: string;
  readonly responseAt: string;
  readonly request: {
    readonly method: string;
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly body: unknown;
  };
  readonly response: {
    readonly status: number;
    readonly statusText: string;
    readonly headers: Record<string, string>;
    readonly body: unknown;
  } | null;
  readonly error: { readonly message: string } | null;
  readonly requestSentAt?: number;
}

export interface TraceSessionMetadata {
  readonly sessionId: string;
  readonly title?: string;
  readonly parentID?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface TraceManifest {
  readonly exportedAt: string;
  readonly mainSession: string;
  readonly sessions: readonly string[];
  readonly version: string;
}

export interface TraceSessionBundle {
  readonly metadata: TraceSessionMetadata;
  readonly records: readonly TraceRecord[];
}

export { auditPathOf, runsDirOf } from "./run-artifacts.js";

/** trace 目录名（run 时落盘：`<runs>/opencode-trace/`） */
export const TRACE_DIR = "opencode-trace";

/** 由一份原生转录 + 一份审计，构建一个 trace 会话（纯函数） */
export function buildTraceSession(
  transcript: { readonly info: Record<string, unknown>; readonly messages: readonly Record<string, unknown>[] },
  audit: { readonly requests?: readonly Record<string, unknown>[]; readonly model?: unknown },
): TraceSessionBundle {
  const info = transcript.info;
  const sessionId = String(info["id"] ?? "");
  const model = info["model"] as Record<string, unknown> | undefined;
  const modelId = String(model?.["id"] ?? audit.model ?? "");
  const baseUrl = String(model?.["baseUrl"] ?? "");
  const time = info["time"] as { created?: number; updated?: number } | undefined;

  const assistants = transcript.messages.filter((message) => message["role"] === "assistant");
  const requests = audit.requests ?? [];

  const records: TraceRecord[] = requests.map((request, index) =>
    buildTraceRecord(request, assistants[index], modelId, baseUrl, index + 1),
  );

  return {
    metadata: {
      sessionId,
      ...(typeof info["title"] === "string" ? { title: info["title"] } : {}),
      ...(time?.created !== undefined ? { createdAt: new Date(time.created).toISOString() } : {}),
      ...(time?.updated !== undefined ? { updatedAt: new Date(time.updated).toISOString() } : {}),
    },
    records,
  };
}

function buildTraceRecord(
  request: Record<string, unknown>,
  assistant: Record<string, unknown> | undefined,
  modelId: string,
  baseUrl: string,
  index: number,
): TraceRecord {
  const timestamp = typeof assistant?.["timestamp"] === "number" ? (assistant["timestamp"] as number) : 0;
  const body = parseWireBody(request["wireBody"]);
  return {
    id: index,
    purpose: "chat.completion",
    requestAt: new Date(timestamp).toISOString(),
    responseAt: new Date(timestamp + 1).toISOString(),
    request: {
      method: "POST",
      url: `${baseUrl.replace(/\/+$/, "")}/chat/completions`,
      headers: { "content-type": "application/json" },
      body,
    },
    response:
      assistant === undefined
        ? null
        : {
            status: 200,
            statusText: "OK",
            headers: { "content-type": "application/json" },
            body: synthesizeResponseBody(assistant, modelId),
          },
    error: null,
    ...(assistant !== undefined ? { requestSentAt: timestamp } : {}),
  };
}

function parseWireBody(wireBody: unknown): unknown {
  if (typeof wireBody !== "string" || wireBody === "") {
    return {};
  }
  try {
    return JSON.parse(wireBody) as unknown;
  } catch {
    return {};
  }
}

/** 转录 assistant → OpenAI chat.completion（合成 response body，非原始字节） */
function synthesizeResponseBody(assistant: Record<string, unknown>, modelId: string): unknown {
  const content = assistant["content"];
  const text: string[] = [];
  const reasoning: string[] = [];
  const toolCalls: unknown[] = [];
  if (Array.isArray(content)) {
    for (const block of content as Record<string, unknown>[]) {
      if (block["type"] === "text" && typeof block["text"] === "string") {
        text.push(block["text"]);
      } else if (block["type"] === "thinking" && typeof block["thinking"] === "string") {
        reasoning.push(block["thinking"]);
      } else if (block["type"] === "toolCall") {
        toolCalls.push({
          id: block["id"],
          type: "function",
          function: { name: block["name"], arguments: JSON.stringify(block["arguments"] ?? {}) },
        });
      }
    }
  }
  const message: Record<string, unknown> = { role: "assistant" };
  if (text.length > 0) {
    message["content"] = text.join("\n");
  }
  if (reasoning.length > 0) {
    message["reasoning_content"] = reasoning.join("\n");
  }
  if (toolCalls.length > 0) {
    message["tool_calls"] = toolCalls;
  }
  const usage = assistant["usage"] as Record<string, unknown> | undefined;
  const promptTokens =
    Number(usage?.["input"] ?? 0) + Number(usage?.["cacheRead"] ?? 0) + Number(usage?.["cacheWrite"] ?? 0);
  return {
    id: `chatcmpl-${String(assistant["responseId"] ?? "review")}`,
    object: "chat.completion",
    created: Math.floor((typeof assistant["timestamp"] === "number" ? (assistant["timestamp"] as number) : 0) / 1000),
    model: typeof assistant["model"] === "string" ? assistant["model"] : modelId,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReasonOf(assistant["stopReason"]),
      },
    ],
    usage: { prompt_tokens: promptTokens, completion_tokens: Number(usage?.["output"] ?? 0) },
  };
}

function finishReasonOf(stopReason: unknown): string {
  if (stopReason === "toolUse") {
    return "tool_calls";
  }
  if (stopReason === "stop" || stopReason === "error") {
    return stopReason;
  }
  return "stop";
}

/** 把多个 trace 会话写成 manifest.json + sessions/<id>/… 目录 */
export async function writeTraceBundle(
  dir: string,
  sessions: readonly { readonly sessionId: string; readonly bundle: TraceSessionBundle }[],
): Promise<string> {
  const resolved = resolve(dir);
  await mkdir(resolved, { recursive: true });
  for (const session of sessions) {
    const sessionDir = join(resolved, "sessions", session.sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "metadata.json"),
      `${JSON.stringify(session.bundle.metadata, null, 2)}\n`,
      "utf8",
    );
    for (const record of session.bundle.records) {
      await writeFile(join(sessionDir, `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");
    }
  }
  const manifest: TraceManifest = {
    exportedAt: new Date().toISOString(),
    mainSession: sessions[0]?.sessionId ?? "",
    sessions: sessions.map((session) => session.sessionId),
    version: "1.0",
  };
  await writeFile(join(resolved, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return resolved;
}

/** 从磁盘读原生转录 + 审计，构建一个 trace 会话（审计路径缺省由布局推导） */
export async function loadTraceSession(
  transcriptPath: string,
  auditPath: string = auditPathOf(transcriptPath),
): Promise<{ readonly sessionId: string; readonly bundle: TraceSessionBundle }> {
  const transcript = JSON.parse(await readFile(transcriptPath, "utf8")) as {
    info: Record<string, unknown>;
    messages: readonly Record<string, unknown>[];
  };
  const audit = JSON.parse(await readFile(auditPath, "utf8")) as {
    requests?: readonly Record<string, unknown>[];
    model?: unknown;
  };
  const bundle = buildTraceSession(transcript, audit);
  return { sessionId: bundle.metadata.sessionId, bundle };
}

/** 写者记录的一对产物路径（ADR-0088）：trace 不再从转录路径反推审计 */
export interface RunTraceArtifact {
  readonly transcriptPath: string;
  readonly auditPath: string;
}

/** run 时落盘整个 trace bundle：读各主转录 + 审计 → `<runsDir>/opencode-trace/` */
export async function writeRunTrace(
  runsDir: string,
  artifacts: readonly RunTraceArtifact[],
): Promise<string> {
  const sessions: { sessionId: string; bundle: TraceSessionBundle }[] = [];
  for (const artifact of artifacts) {
    sessions.push(
      await loadTraceSession(artifact.transcriptPath, artifact.auditPath),
    );
  }
  return writeTraceBundle(join(resolve(runsDir), TRACE_DIR), sessions);
}
