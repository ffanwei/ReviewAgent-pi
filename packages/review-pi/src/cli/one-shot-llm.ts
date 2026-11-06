import type { FetchFunction } from "@earendil-works/pi-ai";

/**
 * 一次性模型调用缝（ADR-0045）：报文 / 总结生成用的最小 chat completion。
 *
 * 不走 pi-ai 序列化缝（那是检视会话的七工具循环）也不走呈现引擎（那是可注入
 * 的核外模块）——这里是 CLI 自有的一次性请求：system + user 两条消息、非流式、
 * 期望纯文本或 JSON 回包。与 `provider/gateway-probe.ts` 同款裸 fetch 形态
 * （OpenAI 兼容：`<baseUrl>/chat/completions`，baseUrl 需自带 `/v1`）。
 *
 * 纪律：**绝不抛错**（失败收敛为 `{ok:false, reason}`，调用方决定降级）；
 * key 只进 Authorization 头，绝不进 reason / 任何留痕。
 */

export interface OneShotLlmInput {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly modelId: string;
  readonly system: string;
  readonly user: string;
  readonly timeoutMs: number;
  /** 输出预算（生成 Markdown / JSON 的上限；缺席 = 服务端缺省） */
  readonly maxTokens?: number;
  /** 传输层注入（测试确定性）；缺省 globalThis.fetch */
  readonly fetch?: FetchFunction;
}

export type OneShotLlmResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string };

export async function completeOneShot(input: OneShotLlmInput): Promise<OneShotLlmResult> {
  const fetch = input.fetch ?? globalThis.fetch;
  const body = JSON.stringify({
    model: input.modelId,
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ],
    ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
    stream: false,
  });
  let response: Response;
  try {
    response = await fetch(`${input.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${input.apiKey}` },
      body,
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch (error) {
    return { ok: false, reason: `request failed: ${errorMessage(error)}` };
  }
  if (response.status < 200 || response.status >= 300) {
    const detail = await response.text().catch(() => "");
    return {
      ok: false,
      reason: `HTTP ${String(response.status)}${truncate(detail)}`,
    };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(await response.text()) as unknown;
  } catch {
    return { ok: false, reason: "response is not valid JSON" };
  }
  const text = readContentText(payload);
  if (text === undefined) {
    return { ok: false, reason: "response has no message content text" };
  }
  return { ok: true, text };
}

/**
 * 从回包挑文本：`choices[0].message.content`（string 或分段数组取 text 拼接）。
 * 思维链（`reasoning_content`）不计入。
 */
function readContentText(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return undefined;
  }
  const message = (choices[0] as Record<string, unknown> | null)?.message;
  if (typeof message !== "object" || message === null) {
    return undefined;
  }
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as Record<string, unknown>).type === "text" &&
        typeof (block as Record<string, unknown>).text === "string"
      ) {
        parts.push((block as Record<string, unknown>).text as string);
      }
    }
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }
  return undefined;
}

/**
 * 宽松 JSON 提取（模型常把 JSON 包进 ```json 代码栅栏或前后白话）：剥栅栏后
 * 取第一个平衡的 `{…}`。解析失败返回 null（调用方按「报文调用失败」处理）。
 */
export function extractJsonObject(text: string): unknown | null {
  const stripped = text.replace(/^[ \t]*```[a-zA-Z0-9_-]*\s*\n?/, "").replace(/\n?```\s*$/, "");
  const start = stripped.indexOf("{");
  if (start < 0) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < stripped.length; index += 1) {
    const char = stripped[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      if (inString) {
        escaped = true;
      }
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(stripped.slice(start, index + 1)) as unknown;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") {
    return "";
  }
  return flat.length <= max ? `: ${flat}` : `: ${flat.slice(0, max - 1)}…`;
}
