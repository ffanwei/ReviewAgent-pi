import type { AssistantMessage, Context, FetchFunction, Model, TextContent } from "@review-agent-pi/pi-ai";
import { deepseekProvider } from "@review-agent-pi/pi-ai/providers/deepseek";
import type { StreamFn } from "@review-agent-pi/pi-agent-core";
import type { ToolSchema, WireMessage } from "../contracts/llm.js";
import {
  DEFAULT_GATEWAY_MAX_TOKENS,
  isOfficialReviewerBaseUrl,
  type ModelOverride,
} from "../shared/config.js";

/**
 * pi-ai 序列化缝（内核变量面）：真 provider + 真 openai SDK 序列化路径，
 * 传输层经注入的 FetchFunction（fake 适配器与真适配器同缝，零网络）。
 *
 * wireBody = onPayload 序列化点捕获的请求原文（JSON.stringify(payload)），
 * 与 DSH 线 wire-log 同语义（序列化点原文，一次逻辑调用一条）。
 * 请求面对齐 DSH deepseek 画像：官方直连不传 max_tokens（t 系列审计 wireBody
 * 无此键）；经配置 `reviewer.baseUrl` 的网关档例外，显式发送输出预算（见
 * maxTokensFor）——不发送即继承网关请求默认值，实测默认 2048 会把思维链吃光
 * 并静默截断。
 * 口径记账（#3 票面「max_output=1K」）：该值为立项预算表口径，DSH 线 wire
 * 无对应键（根仓 src 亦无此常量），字节复刻面无可复刻物——按审计真源口径
 * 不落 wire，P2 字节门再议。
 * 锁档纪律（DSH 线 ADR-0002，逐项有测试）：
 * - effort 单档锁定：harness/审计标签恒 "default"，线上恒
 *   thinking {type:"enabled"} + reasoning_effort "high"；
 * - 请求不携带采样参数；本用例无工具（tools 不出场）。
 */

/** 钉住的评审模型（评测口径：单模型 deepseek-v4-flash） */
export const REVIEW_MODEL_ID = "deepseek-v4-flash";
/** 锁档 effort 标签（harness/审计面；与 DSH 线 wire.ts 同名单源） */
export const LOCKED_EFFORT_LABEL = "default";
/** 锁档线上档位：pi-ai reasoningEffort → wire reasoning_effort "high"（deepseek thinkingLevelMap） */
export const LOCKED_REASONING_EFFORT = "high";

/**
 * 网关档缺省输出预算（单源在 `config.DEFAULT_GATEWAY_MAX_TOKENS`）。deepseek-v4
 * 系 max_tokens 含思维链（实测单回合 reasoning 峰值 5,600、回答峰值 1,081），
 * 32768 留足 4× 余量。显式发送的理由：不发送即继承网关的请求默认值——企业
 * 网关实测补 2048，思维链吃光预算后静默截断。
 */
export const GATEWAY_MAX_TOKENS = DEFAULT_GATEWAY_MAX_TOKENS;

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
   * api.deepseek.com；企业网关（配置 `reviewer.baseUrl`）需自带 /v1——SDK
   * 只追加 /chat/completions。
   */
  readonly baseUrl?: string;
  /**
   * 模型 id 覆盖（#45 自由 id 语义）：任意非空 id 均可发。序列化画像：
   * id 命中 deepseek 目录 → 该 id 自身画像；目录外 id → 钉住的评审模型
   * 画像作模板（见 reviewModelOf）。缺省钉住的评审模型。
   */
  readonly modelId?: string;
  /** 模型元数据覆盖（ADR-0025：`models{}` 按 id 深合并；序列化方言不可覆盖） */
  readonly modelOverrides?: Readonly<Record<string, ModelOverride>>;
  /** 输出预算（ADR-0025：`reviewer.maxOutputTokens`；null/缺席 = 按接入点自动判档） */
  readonly maxOutputTokens?: number | null;
  /** 传输层注入；缺省线上 global fetch（离线测试恒注入 fake 适配器） */
  readonly fetch?: FetchFunction;
}

export interface ReviewTurnOutcome {
  readonly message: AssistantMessage;
  readonly wire: WireCapture;
}

const WIRE_ROLES: readonly string[] = ["system", "user", "assistant", "tool"];

export async function runReviewTurn(input: ReviewTurnInput): Promise<ReviewTurnOutcome> {
  const model = reviewModelOf(input.modelId, input.baseUrl, input.modelOverrides);
  // 网关档显式输出预算（官方直连不发，见 maxTokensFor）
  const maxTokens = maxTokensFor(model.baseUrl, input.maxOutputTokens);
  let wire: WireCapture | undefined;
  const stream = deepseekProvider().stream(model, input.context, {
    apiKey: input.apiKey,
    ...(input.fetch !== undefined ? { fetch: input.fetch } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
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
 *
 * ADR-0025：`overrides` = 用户配置的 `models{}`（按 id 深合并到上面选中的
 * 模板）。只允许覆盖元数据叶子（contextWindow / maxTokens / cost / input）——
 * 序列化方言（api/provider/compat/...）在配置层已 fail fast，这里不再有缝。
 */
export function reviewModelOf(
  modelId: string | undefined,
  baseUrl: string | undefined,
  overrides?: Readonly<Record<string, ModelOverride>>,
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
  const model: Model<"openai-completions"> = {
    ...template,
    id: requested,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  };
  const override = overrides?.[requested];
  return override === undefined ? model : applyModelOverride(model, override);
}

/** 元数据深合并（cost 逐项合并；只覆写写到的叶子，其余沿用内置目录） */
function applyModelOverride(
  model: Model<"openai-completions">,
  override: ModelOverride,
): Model<"openai-completions"> {
  return {
    ...model,
    ...(override.contextWindow !== undefined ? { contextWindow: override.contextWindow } : {}),
    ...(override.maxTokens !== undefined ? { maxTokens: override.maxTokens } : {}),
    ...(override.input !== undefined ? { input: [...override.input] } : {}),
    ...(override.cost !== undefined
      ? {
          cost: {
            ...model.cost,
            ...(override.cost.input !== undefined ? { input: override.cost.input } : {}),
            ...(override.cost.output !== undefined ? { output: override.cost.output } : {}),
            ...(override.cost.cacheRead !== undefined ? { cacheRead: override.cost.cacheRead } : {}),
            ...(override.cost.cacheWrite !== undefined ? { cacheWrite: override.cost.cacheWrite } : {}),
          },
        }
      : {}),
  };
}

/**
 * 输出预算注入判据（字节面守门人）：
 * - 配置了 `reviewer.maxOutputTokens` → 用它（配置层已校验为正整数）；
 * - 未配置（null/undefined）→ 官方直连 `undefined`：wire 永不含 max_tokens，
 *   与 DSH 语料逐字节对齐（ADR-0002）；网关档 → 显式 `GATEWAY_MAX_TOKENS`：
 *   不发送即继承网关请求默认值（实测 2048 → 思维链耗尽、静默截断）。
 *
 * 判档谓词单源 `isOfficialReviewerBaseUrl`（ADR-0026）：scheme/host 大小写与
 * 尾斜杠都不改变档位——否则 `HTTPS://API.DEEPSEEK.COM/` 会被当成网关，官方
 * 直连也会发 max_tokens，字节对齐悄悄破掉。
 */
export function maxTokensFor(
  baseUrl: string | undefined,
  configured?: number | null,
): number | undefined {
  if (configured !== undefined && configured !== null) {
    return Math.floor(configured);
  }
  return isOfficialReviewerBaseUrl(baseUrl) ? undefined : GATEWAY_MAX_TOKENS;
}

/**
 * 评审流函数（Agent 驱动面单源）：真 provider + 锁档 effort + 注入的传输层。
 * 主会话与 skill 会话共用同一构造，保证「同一 Zone A + 同一序列化画像」。
 * 输出预算由调用方从配置快照传入（ADR-0025：请求期零 env 读取）。
 */
export function reviewStreamFn(input: {
  readonly apiKey: string;
  readonly fetch?: FetchFunction;
  readonly maxOutputTokens?: number | null;
}): StreamFn {
  return (model, context, options) => {
    // model.baseUrl 由 reviewModelOf 落值（目录缺省 = 官方直连），网关档在此
    // 注入显式输出预算——两类会话共用本构造，改一处即覆盖两会话。
    const maxTokens = maxTokensFor(model.baseUrl, input.maxOutputTokens);
    return deepseekProvider().stream(model as Model<"openai-completions">, context, {
      ...options,
      apiKey: input.apiKey,
      ...(input.fetch !== undefined ? { fetch: input.fetch } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      reasoningEffort: LOCKED_REASONING_EFFORT,
    });
  };
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

/** wire function tool → DSH 审计口径 ToolSchema（无工具时恒空数组，投影为将来工具配置就位） */
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
