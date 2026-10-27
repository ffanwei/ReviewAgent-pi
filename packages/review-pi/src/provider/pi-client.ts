import type { AssistantMessage, Context, FetchFunction, Model, TextContent } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ToolSchema, WireMessage } from "../contracts/llm.js";

/**
 * pi-ai 序列化缝（内核变量面）：真 provider + 真 openai SDK 序列化路径，
 * 传输层经注入的 FetchFunction（fake 适配器与真适配器同缝，零网络）。
 *
 * wireBody = onPayload 序列化点捕获的请求原文（JSON.stringify(payload)），
 * 与 DSH 线 wire-log 同语义（序列化点原文，一次逻辑调用一条）。
 * 请求面对齐 DSH deepseek 画像：不传 max_tokens（t 系列审计 wireBody 无此键）。
 * 口径记账（#3 票面「max_output=1K」）：该值为立项预算表口径，DSH 线 wire
 * 无对应键（根仓 src 亦无此常量），字节复刻面无可复刻物——按审计真源口径
 * 不落 wire，P2 字节门再议。
 * 锁档纪律（DSH 线 ADR-0002，逐项有测试）：
 * - effort 单档锁定：harness/审计标签恒 "default"，线上恒
 *   thinking {type:"enabled"} + reasoning_effort "high"；
 * - 请求不携带采样参数；config B 无工具（tools 不出场）。
 */

/** 钉住的评审模型（评测口径：单模型 deepseek-v4-flash） */
export const REVIEW_MODEL_ID = "deepseek-v4-flash";
/** 锁档 effort 标签（harness/审计面；与 DSH 线 wire.ts 同名单源） */
export const LOCKED_EFFORT_LABEL = "default";
/** 锁档线上档位：pi-ai reasoningEffort → wire reasoning_effort "high"（deepseek thinkingLevelMap） */
export const LOCKED_REASONING_EFFORT = "high";

/** onPayload 序列化点捕获（审计 requests[] 条目形状：model/effort/messages/tools + wireBody 原文） */
export interface WireCapture {
  readonly model: string;
  readonly effort: string;
  readonly messages: readonly WireMessage[];
  readonly tools: readonly ToolSchema[];
  /** JSON.stringify(payload) 原文（= 发往 provider 的请求体，可原样重放） */
  readonly wireBody: string;
}

export interface ReviewTurnInput {
  readonly context: Context;
  readonly apiKey: string;
  /**
   * 网关 base URL 覆盖（#4）：经 model.baseUrl 展开缝注入（openai-completions
   * 以 model.baseUrl 为 SDK baseURL），vendored pi 源码零改动。缺省官方
   * api.deepseek.com；企业网关（REVIEWER_URL）需自带 /v1——SDK 只追加
   * /chat/completions。
   */
  readonly baseUrl?: string;
  /**
   * 模型 id 覆盖（#45 自由 id 语义）：任意非空 id 均可发。序列化画像：
   * id 命中 deepseek 目录 → 该 id 自身画像；目录外 id → 钉住的评审模型
   * 画像作模板（见 reviewModelOf）。缺省钉住的评审模型。
   */
  readonly modelId?: string;
  /** 传输层注入；缺省线上 global fetch（离线测试恒注入 fake 适配器） */
  readonly fetch?: FetchFunction;
}

export interface ReviewTurnOutcome {
  readonly message: AssistantMessage;
  readonly wire: WireCapture;
}

const WIRE_ROLES: readonly string[] = ["system", "user", "assistant", "tool"];

export async function runReviewTurn(input: ReviewTurnInput): Promise<ReviewTurnOutcome> {
  const model = reviewModelOf(input.modelId, input.baseUrl);
  let wire: WireCapture | undefined;
  const stream = deepseekProvider().stream(model, input.context, {
    apiKey: input.apiKey,
    ...(input.fetch !== undefined ? { fetch: input.fetch } : {}),
    reasoningEffort: LOCKED_REASONING_EFFORT,
    onPayload: (payload) => {
      wire = captureWire(payload);
    },
  });
  const message = await stream.result();
  // pi-ai 对 provider 错误不 reject：resolve 出 stopReason "error" 的 AssistantMessage，
  // 缝必须显式拦截（错误永不静默成一次"成功"回合）。
  if (message.stopReason === "error") {
    throw new Error(
      `review turn failed: ${message.errorMessage ?? "provider returned an error stop reason"}`,
    );
  }
  if (wire === undefined) {
    throw new Error("pi-ai did not reach the onPayload serialization point (wire capture missing)");
  }
  return { message, wire };
}

/** assistant 回复纯文本（content text 块按 "\n" 连接；与 DSH joinTextBlocks 同口径） */
export function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/**
 * 评审模型解析：id 命中目录 → 原样用；目录外自由 id → 钉住的评审模型
 * 画像作模板覆写 id（#45）；baseUrl 非空则覆盖接入点（网关展开缝）。
 * 契约不变量：provider 恒为 deepseek（compat/锁档序列化不随 id 漂移）。
 * agentLoop 路径（#6 P3a）复用同一解析作为 Agent initialState.model。
 */
export function reviewModelOf(
  modelId: string | undefined,
  baseUrl: string | undefined,
): Model<"openai-completions"> {
  const requested = modelId ?? REVIEW_MODEL_ID;
  if (requested.trim() === "") {
    throw new Error("review model id must be a non-empty string");
  }
  const catalog = deepseekProvider().getModels();
  const exact = catalog.find((candidate) => candidate.id === requested);
  const template = exact ?? catalog.find((candidate) => candidate.id === REVIEW_MODEL_ID);
  if (template === undefined) {
    throw new Error(`review model "${REVIEW_MODEL_ID}" not found in the deepseek provider catalog`);
  }
  return {
    ...template,
    id: requested,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  };
}

/**
 * 评审流函数（Agent 驱动面单源）：真 provider + 锁档 effort + 注入的传输层。
 * 主会话与 skill 会话共用同一构造，保证「同一 Zone A + 同一序列化画像」。
 */
export function reviewStreamFn(input: {
  readonly apiKey: string;
  readonly fetch?: FetchFunction;
}): StreamFn {
  return (model, context, options) =>
    deepseekProvider().stream(model as Model<"openai-completions">, context, {
      ...options,
      apiKey: input.apiKey,
      ...(input.fetch !== undefined ? { fetch: input.fetch } : {}),
      reasoningEffort: LOCKED_REASONING_EFFORT,
    });
}

/** 校验并投影 onPayload payload（边界校验 fail fast；扩展字段透传不裁剪）。
 * agentLoop 路径（#6 P3a）复用同一投影作为审计 requests[] 条目来源。 */
export function captureWire(payload: unknown): WireCapture {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("onPayload payload is not an object");
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.model !== "string") {
    throw new Error("onPayload payload has no string model field");
  }
  if (!Array.isArray(record.messages)) {
    throw new Error("onPayload payload has no messages array");
  }
  const messages = record.messages.map(wireMessageOf);
  const tools = Array.isArray(record.tools) ? record.tools.map(toolSchemaOf) : [];
  return {
    model: record.model,
    effort: LOCKED_EFFORT_LABEL,
    messages,
    tools,
    wireBody: JSON.stringify(payload),
  };
}

function wireMessageOf(entry: unknown): WireMessage {
  if (typeof entry !== "object" || entry === null) {
    throw new Error("onPayload messages entry is not an object");
  }
  const record = entry as Record<string, unknown>;
  if (typeof record.role !== "string" || !WIRE_ROLES.includes(record.role)) {
    throw new Error(`onPayload messages entry has an unknown wire role: ${JSON.stringify(record.role)}`);
  }
  if (typeof record.content !== "string" && record.content !== null) {
    throw new Error("onPayload messages entry has no string content field");
  }
  // 审计口径：wire 的 null content（assistant 仅携带工具调用的消息）投影为 ""——
  // 与 DSH 审计 requests[].messages 同构；wireBody 原文保持 null（两线字节同形）。
  return record.content === null
    ? ({ ...(entry as Record<string, unknown>), content: "" } as WireMessage)
    : (entry as WireMessage);
}

/** wire function tool → DSH 审计口径 ToolSchema（config B 恒空数组，投影为将来工具配置就位） */
function toolSchemaOf(entry: unknown): ToolSchema {
  if (typeof entry !== "object" || entry === null) {
    throw new Error("onPayload tools entry is not an object");
  }
  const tool = entry as Record<string, unknown>;
  const fn = tool.function;
  if (typeof fn !== "object" || fn === null) {
    throw new Error("onPayload tools entry is not an openai function tool");
  }
  const fnRecord = fn as Record<string, unknown>;
  if (typeof fnRecord.name !== "string" || typeof fnRecord.description !== "string") {
    throw new Error("onPayload tools entry is not an openai function tool");
  }
  return {
    name: fnRecord.name,
    description: fnRecord.description,
    parametersJson: JSON.stringify(fnRecord.parameters ?? {}),
  };
}
