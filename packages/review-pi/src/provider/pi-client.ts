import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  FetchFunction,
  Model,
  OpenAICompletionsOptions,
  TextContent,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { LlmUsage, ToolSchema, WireMessage } from "../contracts/llm.js";
import {
  createTimelineRecorder,
  describeThrownError,
  hasRequestTimelineSink,
  nextTimelineRequestId,
  truncateTimelineMessage,
  type TimelineError,
  type TimelineRecorder,
  type TimelineShard,
} from "../observability/request-timeline.js";
import {
  DEFAULT_GATEWAY_MAX_TOKENS,
  isOfficialReviewerBaseUrl,
} from "../shared/config.js";
import { piUsageToLlmUsage } from "./usage-map.js";

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

const WIRE_ROLES: readonly string[] = ["system", "user", "assistant", "tool"];

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
 * 画像只有两个来源：内置目录，或目录外 id 借用钉住模型的画像。没有用户侧
 * 元数据覆盖缝（`models{}` 已删除，见 ADR-0025 修订）。
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
/** 请求时间线的作用域（每次请求发前求值；由调用方闭包提供当前阶段） */
export interface StreamTimelineScope {
  readonly site: "main" | "skill";
  readonly skill?: string;
  readonly shard?: TimelineShard;
  readonly round?: number;
  readonly phase?: string;
  readonly phaseIndex?: number;
}

/** 流中断重放策略（ADR-0077）；由调用方从配置快照传入 */
export interface StreamReplayPolicy {
  /** 总尝试次数（含首次）；1 = 不重放 */
  readonly attempts: number;
  /** 总墙钟预算（毫秒，含退避；从首次尝试发出起算）；0 = 不设上限 */
  readonly budgetMs: number;
  /** 退避基准 / 单次上限（复用 `limits.retry.baseDelayMs` / `maxDelayMs`） */
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export function reviewStreamFn(input: {
  readonly apiKey: string;
  readonly fetch?: FetchFunction;
  readonly maxOutputTokens?: number | null;
  /** 请求建立阶段最多重试次数（pi-ai 语义：0 = 不重试；2 = 共 3 次尝试） */
  readonly maxRetries?: number;
  /** 服务端 Retry-After 上限毫秒数（pi-ai `maxRetryDelayMs`） */
  readonly maxRetryDelayMs?: number;
  /** 单次请求（流开始前）超时毫秒数 */
  readonly timeoutMs?: number;
  /**
   * 请求时间线作用域（ADR-0076）。只有装了全局观测器时才真正采集：
   * 未安装 = 不包 body / 不碰流，零行为变化。
   */
  readonly timeline?: {
    readonly scope: () => StreamTimelineScope;
    /** 时钟注入（测试确定性；缺省 Date.now） */
    readonly now?: () => number;
  };
  /** 流中断重放（ADR-0077）；缺席 = 单次尝试（今天的零漂移行为） */
  readonly replay?: StreamReplayPolicy;
}): StreamFn {
  // requestId 由 request-timeline 的进程级计数器分配（ADR-0089）：同一 JSONL
  // 内 agent 与 one-shot 不撞号。
  return (model, context, options) => {
    // model.baseUrl 由 reviewModelOf 落值（目录缺省 = 官方直连），网关档在此
    // 注入显式输出预算——两类会话共用本构造，改一处即覆盖两会话。
    const maxTokens = maxTokensFor(model.baseUrl, input.maxOutputTokens);
    const providerOptions: OpenAICompletionsOptions = {
      ...options,
      apiKey: input.apiKey,
      ...(input.fetch !== undefined ? { fetch: input.fetch } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      reasoningEffort: LOCKED_REASONING_EFFORT,
      ...(input.maxRetries !== undefined ? { maxRetries: input.maxRetries } : {}),
      ...(input.maxRetryDelayMs !== undefined
        ? { maxRetryDelayMs: input.maxRetryDelayMs }
        : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    };

    const replay = normalizeReplayPolicy(input.replay);
    const observing = input.timeline !== undefined && hasRequestTimelineSink();
    const typedModel = model as Model<"openai-completions">;
    const baseFetch = input.fetch ?? (globalThis.fetch as FetchFunction);

    const params: StreamDriveParams = {
      model: typedModel,
      context,
      providerOptions,
      replay,
      now: input.timeline?.now ?? Date.now,
      requestId: nextTimelineRequestId(),
      scope: input.timeline?.scope(),
      baseFetch,
    };
    // 零漂移：无观测器且不重放 → 原样返回 provider 流
    if (!observing && replay.attempts <= 1) {
      return deepseekProvider().stream(typedModel, context, providerOptions);
    }
    // 不重放（回放 lane / 显式关闭）→ 保持真流式，只旁挂时间线
    if (replay.attempts <= 1) {
      return driveSingleAttempt(params);
    }
    return driveWithReplay(params);
  };
}

interface StreamDriveParams {
  readonly model: Model<"openai-completions">;
  readonly context: Context;
  readonly providerOptions: OpenAICompletionsOptions;
  readonly replay: StreamReplayPolicy;
  readonly now: () => number;
  readonly requestId: number;
  readonly scope: StreamTimelineScope | undefined;
  readonly baseFetch: FetchFunction;
}

function normalizeReplayPolicy(policy: StreamReplayPolicy | undefined): StreamReplayPolicy {
  if (policy === undefined) {
    return { attempts: 1, budgetMs: 0, baseDelayMs: 0, maxDelayMs: 0 };
  }
  return {
    attempts: Math.max(1, Math.floor(policy.attempts)),
    budgetMs: Math.max(0, Math.floor(policy.budgetMs)),
    baseDelayMs: Math.max(0, Math.floor(policy.baseDelayMs)),
    maxDelayMs: Math.max(0, Math.floor(policy.maxDelayMs)),
  };
}

/** 单次尝试（真流式）：覆盖 `push` 旁挂时间线，事件原样转发。 */
function driveSingleAttempt(params: StreamDriveParams): AssistantMessageEventStream {
  const recorder = createRecorder(params, 0);
  const options: OpenAICompletionsOptions = {
    ...params.providerOptions,
    fetch: wrapFetchWithTimeline(params.baseFetch, recorder),
  };
  let stream: AssistantMessageEventStream;
  try {
    stream = deepseekProvider().stream(params.model, params.context, options);
  } catch (error) {
    // 同步失败（如缺 key）：逻辑请求行照样要有一条，否则失败现场是空白
    recorder.finish({ error: describeThrownError(error, "provider") });
    throw error;
  }
  const originalPush = stream.push.bind(stream);
  stream.push = (event: AssistantMessageEvent): void => {
    observeTimelineEvent(recorder, event);
    originalPush(event);
  };
  return stream;
}

import { replayDelayMs, withinReplayBudget } from "./stream-replay-policy.js";

/**
 * 缓冲重放（ADR-0077）：每次尝试的事件只进本地缓冲；失败则丢弃并重发，
 * 成功（或重放耗尽）才把该次事件原样推给消费者。
 */
function driveWithReplay(params: StreamDriveParams): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  void (async (): Promise<void> => {
    const startedAt = params.now();
    for (let replay = 0; ; replay += 1) {
      const recorder = createRecorder(params, replay);
      const options: OpenAICompletionsOptions = {
        ...(replay === 0
          ? params.providerOptions
          : withoutProviderCallbacks(params.providerOptions)),
        fetch: wrapFetchWithObservedBody(params.baseFetch, recorder),
      };

      const events: AssistantMessageEvent[] = [];
      let terminal: AssistantMessageEvent | null = null;
      let syncError: unknown = null;
      let inner: AssistantMessageEventStream | null = null;
      try {
        inner = deepseekProvider().stream(params.model, params.context, options);
      } catch (error) {
        syncError = error;
      }

      if (inner !== null) {
        const ended = new Promise<void>((resolve) => {
          inner!.push = (event: AssistantMessageEvent): void => {
            events.push(event);
            observeTimelineEvent(recorder, event);
            if (event.type === "done" || event.type === "error") {
              resolve();
            }
          };
        });
        await ended;
        terminal = events[events.length - 1] ?? null;
      }

      if (syncError !== null) {
        const error = describeThrownError(syncError, "provider");
        recorder.finish({ error });
        out.end(syntheticErrorMessage(params.model, syncError));
        return;
      }

      const failed =
        terminal !== null && terminal.type === "error" && terminal.reason !== "aborted";
      // 只有「响应体真的读失败」才重放：确定性 provider 拦截（content_filter）
      // 走同一条 error 事件，但 body 是正常读完的。
      const shouldReplay =
        failed &&
        recorder.bodyError !== null &&
        replay + 1 < params.replay.attempts &&
        withinReplayBudget(startedAt, params.replay.budgetMs, params.now);

      if (shouldReplay) {
        await sleep(replayDelayMs(params.replay, replay));
        continue;
      }

      for (const event of events) {
        out.push(event);
      }
      out.end();
      return;
    }
  })().catch((error: unknown) => {
    // 兜底：驱动自身异常绝不能让 agent 挂死（result() 永不 resolve）
    out.end(syntheticErrorMessage(params.model, error));
  });
  return out;
}

/** 重放必须重新走「建连 + 流」，但 `onPayload` / `onResponse` 只该在首次触发 */
function withoutProviderCallbacks(options: OpenAICompletionsOptions): OpenAICompletionsOptions {
  const {
    onPayload: _onPayload,
    onResponse: _onResponse,
    ...rest
  } = options as OpenAICompletionsOptions & {
    onPayload?: unknown;
    onResponse?: unknown;
  };
  return rest;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 同步失败时给消费者的错误消息（agent-loop 会读 `stopReason` / `errorMessage`） */
function syntheticErrorMessage(
  model: Model<"openai-completions">,
  error: unknown,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "deepseek",
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}

/** 一次逻辑请求的 recorder（重放时每次 replay 一个，requestId 相同） */
function createRecorder(
  params: StreamDriveParams,
  replay: number,
): TimelineRecorder {
  return createTimelineRecorder({
    scope: params.scope ?? { site: "main" },
    model: params.model.id,
    ...(params.model.baseUrl !== undefined ? { baseUrl: params.model.baseUrl } : {}),
    replay,
    now: params.now,
    requestId: params.requestId,
  });
}

/**
 * fetch 包裹（ADR-0076）：pi-ai 的 `retryProviderRequest` 只重发 `create(...)`，
 * 每次尝试都会重新调用注入的 fetch——这是**尝试级**留痕的唯一观察点
 * （`onPayload` 在重试循环外只调一次）。
 *
 * 绝不替换 / 改写异常：原样 rethrow，pi-ai 的重试判定与最终 `errorMessage`
 * 行为零变化。
 */
function wrapFetchWithTimeline(
  underlying: FetchFunction,
  recorder: TimelineRecorder,
): FetchFunction {
  return async (input, init) => {
    const probe = recorder.beginAttempt();
    try {
      const response = await underlying(input, init);
      recorder.endAttempt(probe, {
        headersAt: recorder.now(),
        status: response.status,
        responseHeaders: response.headers,
      });
      return response;
    } catch (error) {
      recorder.endAttempt(probe, { error: describeThrownError(error) });
      throw error;
    }
  };
}

/**
 * fetch 包裹 + 响应体观察（ADR-0077）：流内 `terminated` 不会 reject fetch
 * （`await fetch` 在响应头到达时就已 resolve），只会在读 body 时抛。手包一层
 * `ReadableStream`（`pull` 天然保留背压）才能拿到**结构化的** `cause` 与真实字节数。
 */
function wrapFetchWithObservedBody(
  underlying: FetchFunction,
  recorder: TimelineRecorder,
): FetchFunction {
  return async (input, init) => {
    const probe = recorder.beginAttempt();
    let response: Response;
    try {
      response = await underlying(input, init);
    } catch (error) {
      recorder.endAttempt(probe, { error: describeThrownError(error) });
      throw error;
    }
    recorder.endAttempt(probe, {
      headersAt: recorder.now(),
      status: response.status,
      responseHeaders: response.headers,
    });
    return observeResponseBody(response, recorder);
  };
}

/** 响应体计数 + 错误捕获（回压由 `pull` 保留；不改传输语义） */
function observeResponseBody(response: Response, recorder: TimelineRecorder): Response {
  const body = response.body;
  if (body === null) {
    return response;
  }
  const reader = body.getReader();
  const counted = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          return;
        }
        if (chunk.value !== undefined) {
          recorder.markBytes(chunk.value.byteLength);
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        recorder.markBodyError(describeThrownError(error));
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(counted, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function observeTimelineEvent(
  recorder: TimelineRecorder,
  event: AssistantMessageEvent,
): void {
  switch (event.type) {
    case "start": {
      recorder.markStreamStarted();
      return;
    }
    case "text_delta":
    case "thinking_delta":
    case "toolcall_delta": {
      recorder.markDelta(event.delta.length);
      return;
    }
    case "done": {
      recorder.setUsage(piUsageToLlmUsage(event.message.usage));
      recorder.finish({ stopReason: event.reason });
      return;
    }
    case "error": {
      recorder.finish({
        stopReason: event.reason,
        error:
          event.reason === "aborted"
            ? { kind: "timeout", message: "request aborted" }
            : (recorder.bodyError ?? {
                kind: "provider",
                message: truncateTimelineMessage(event.error.errorMessage),
              }),
      });
      return;
    }
    default: {
      return;
    }
  }
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
