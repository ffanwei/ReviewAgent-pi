import type { FetchFunction } from "@earendil-works/pi-ai";
import { extractChatUsage, type RawWireUsage } from "../provider/gateway-probe.js";

// 真跑传输 tee（#4，R2 断言真源）：包裹真 fetch，逐请求旁路捕获 SSE 流的
// 原始 usage（prompt/completion/cacheRead 三字段，未折算）与回显 model，
// 对 caller（pi-ai / openai SDK）完全透明——tee 分支直通，字节不变。
//
// e2e 对账口径：Σ fold(rawUsage_i) 与 RunRecord.baseline.usage 逐字段相等
// ——RunRecord 走 pi-ai parseChunkUsage → addUsage 路径，对账走本模块的
// 原始捕获 + 独立折算，两条解析路径读同一份线上字节，互为校验（R2 关闭）。
//
// 纪律：记录绝不携带 key（key 只在 Authorization 头，经底层 fetch 直通）；
// usage 帧 cacheRead 兜底口径与 gateway-probe 单源（extractChatUsage）。

/** 单请求捕获记录（按发起序；settle 后不可变） */
export interface RecordedRequest {
  readonly url: string;
  readonly status: number;
  /** SSE 帧回显的 model（逐请求静默错路由检测） */
  readonly respondedModel?: string;
  /** 最终 usage 帧的原始三字段（流里无 usage 帧则缺席——e2e 断言面可见） */
  readonly rawUsage?: RawWireUsage;
  /** 非 2xx：网关错误体摘录（诊断用；可能含网关回显的敏感路径，不含 key） */
  readonly errorBody?: string;
  /** 捕获侧自身失败（读流/解码异常）——降级入账，绝不打断 caller */
  readonly captureError?: string;
}

export interface RecordingFetch {
  /** 包裹后的传输层（直接当 FetchFunction 注入） */
  readonly fetch: FetchFunction;
  /** 等待全部在途捕获完成；按发起序返回记录快照（不可变） */
  readonly settle: () => Promise<readonly RecordedRequest[]>;
}

export function recordingFetch(underlying: FetchFunction): RecordingFetch {
  const captures: Array<Promise<RecordedRequest>> = [];
  const fetch: FetchFunction = async (input, init) => {
    const url = urlOf(input);
    const response = await underlying(input, init);
    if (response.body === null) {
      captures.push(Promise.resolve({ url, status: response.status }));
      return response;
    }
    const [forCaller, forCapture] = response.body.tee();
    captures.push(captureBody(forCapture, url, response.status));
    return new Response(forCaller, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  return {
    fetch,
    settle: async () => Promise.all(captures),
  };
}

/** 捕获分支读完 → 记录（自吞异常降级为 captureError；绝不影响 caller 分支） */
async function captureBody(
  stream: ReadableStream<Uint8Array>,
  url: string,
  status: number,
): Promise<RecordedRequest> {
  try {
    const text = await streamText(stream);
    if (status >= 400) {
      return { url, status, errorBody: excerpt(text) };
    }
    return { url, status, ...sseScan(text) };
  } catch (error) {
    return {
      url,
      status,
      captureError: error instanceof Error ? error.message : String(error),
    };
  }
}

/** SSE 文本 → 回显 model + 最终 usage 帧（坏帧跳过；usage 取最后一个有效帧） */
function sseScan(text: string): { respondedModel?: string; rawUsage?: RawWireUsage } {
  let respondedModel: string | undefined;
  let rawUsage: RawWireUsage | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const payload = line.slice("data:".length).trim();
    if (payload === "" || payload === "[DONE]") {
      continue;
    }
    const parsed = parseJsonOrNull(payload);
    if (parsed === null || typeof parsed !== "object") {
      continue;
    }
    const usage = extractChatUsage(parsed);
    if (usage !== null) {
      rawUsage = usage;
    }
    const model = (parsed as { model?: unknown }).model;
    if (typeof model === "string") {
      respondedModel = model;
    }
  }
  return {
    ...(respondedModel !== undefined ? { respondedModel } : {}),
    ...(rawUsage !== undefined ? { rawUsage } : {}),
  };
}

/** 流全文（逐块解码，CRLF/UTF-8 边界安全） */
async function streamText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

/** 底层 fetch 的首参类型（从 FetchFunction 本身推导，不依赖全局 lib 名） */
type FetchInput = Parameters<FetchFunction>[0];

function urlOf(input: FetchInput): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function excerpt(text: string, maxLength = 300): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= maxLength ? collapsed : `${collapsed.slice(0, maxLength)}…`;
}
