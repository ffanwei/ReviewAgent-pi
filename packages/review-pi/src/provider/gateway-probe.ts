import type { FetchFunction } from "@earendil-works/pi-ai";

// 冒烟双探针（#4，R4「网关 + 自由 id」关闭面）：
// - 探针 1 网关健康：传输层可达（任何 HTTP 响应 = 网关活着；不判鉴权/模型）。
// - 探针 2 模型可达：最小 chat completion 一次验证鉴权 + 模型 id + 请求体
//   + 响应回显（跨族回显不一致 = 静默错路由签名，本机 2026-09-19 实测：缺 /v1
//   的 baseUrl 会把 deepseek 请求 id 静默路由到 glm-5.3-flash；同日实测
//   网关还会把别名合法解析为版本化 GA 快照 deepseek-v4-flash-ga-260731——
//   modelEchoMatches 区分这两类，只拦跨族错路由）。
// 每类失败一条人话诊断（错误码 → 归因 → 下一步动作）。
//
// 纪律：key 只进 Authorization 头，绝不进诊断/异常/留痕（哨兵测试断言）；
// 探针不走过 pi-ai 序列化缝——探针请求是最小诊断请求，分类需要原始
// HTTP 状态码与错误体（pi-ai 会把 provider 错误折叠成 error stopReason）；
// 全链序列化路径由真跑冒烟本体验证。

export type ProbeFailureKind =
  | "UNREACHABLE"
  | "AUTH_REJECTED"
  | "MODEL_NOT_FOUND"
  | "MODEL_MISMATCH"
  | "REQUEST_REJECTED"
  | "RATE_LIMITED"
  | "SERVER_ERROR"
  | "MALFORMED_RESPONSE";

export const DEFAULT_HEALTH_TIMEOUT_MS = 15_000;
export const DEFAULT_MODEL_TIMEOUT_MS = 120_000;

export interface HealthProbeInput {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetch?: FetchFunction;
  readonly healthTimeoutMs?: number;
}

export interface GatewayHealthResult {
  readonly reachable: boolean;
  readonly diagnostic: string;
  readonly detail?: string;
}

export interface ModelProbeInput {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly modelId: string;
  readonly fetch?: FetchFunction;
  readonly modelTimeoutMs?: number;
}

/** 网关原始 usage（chat completion 响应 usage 字段，未经口径折算） */
export interface RawWireUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cacheReadTokens: number;
  /** prompt_tokens_details.cache_write_tokens（OpenRouter 系；缺席 = 0，pi-ai 折算同口径） */
  readonly cacheWriteTokens?: number;
}

export interface ModelProbeResult {
  readonly ok: boolean;
  readonly failureKind?: ProbeFailureKind;
  readonly diagnostic: string;
  readonly detail?: string;
  readonly respondedModel?: string;
  readonly rawUsage?: RawWireUsage;
}

export interface SmokeProbeInput {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly modelId: string;
  readonly fetch?: FetchFunction;
  readonly healthTimeoutMs?: number;
  readonly modelTimeoutMs?: number;
}

export interface SmokeProbesResult {
  readonly baseUrl: string;
  readonly modelId: string;
  readonly health: GatewayHealthResult;
  readonly model: ModelProbeResult;
  readonly ok: boolean;
}

export async function probeGatewayHealth(input: HealthProbeInput): Promise<GatewayHealthResult> {
  const timeoutMs = input.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const fetch = input.fetch ?? globalThis.fetch;
  try {
    const response = await withTimeout(
      fetch(`${input.baseUrl}/models`, {
        method: "GET",
        headers: { authorization: `Bearer ${input.apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
      }),
      timeoutMs,
      "gateway health probe",
    );
    return {
      reachable: true,
      diagnostic: `gateway is up at ${input.baseUrl} (HTTP ${response.status})`,
      ...(await healthDetail(response)),
    };
  } catch (error) {
    const detail = errorSummary(error);
    return {
      reachable: false,
      diagnostic: unreachableDiagnostic(input.baseUrl, error),
      ...(detail !== undefined ? { detail } : {}),
    };
  }
}

export async function probeModelReachability(input: ModelProbeInput): Promise<ModelProbeResult> {
  const timeoutMs = input.modelTimeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS;
  const fetch = input.fetch ?? globalThis.fetch;
  const body = JSON.stringify({
    model: input.modelId,
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 1,
    stream: false,
  });
  let response: Response;
  try {
    response = await withTimeout(
      fetch(`${input.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${input.apiKey}` },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      }),
      timeoutMs,
      "model reachability probe",
    );
  } catch (error) {
    const detail = errorSummary(error);
    return {
      ok: false,
      failureKind: "UNREACHABLE",
      diagnostic: unreachableDiagnostic(input.baseUrl, error),
      ...(detail !== undefined ? { detail } : {}),
    };
  }
  return classifyModelResponse(input, response, await response.text());
}

export async function runSmokeProbes(input: SmokeProbeInput): Promise<SmokeProbesResult> {
  const fetch = input.fetch ?? globalThis.fetch;
  const health = await probeGatewayHealth({
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    fetch,
    ...(input.healthTimeoutMs !== undefined ? { healthTimeoutMs: input.healthTimeoutMs } : {}),
  });
  const model = health.reachable
    ? await probeModelReachability({
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        modelId: input.modelId,
        fetch,
        ...(input.modelTimeoutMs !== undefined ? { modelTimeoutMs: input.modelTimeoutMs } : {}),
      })
    : skippedModelProbe();
  return {
    baseUrl: input.baseUrl,
    modelId: input.modelId,
    health,
    model,
    ok: health.reachable && model.ok,
  };
}

/** 双探针结果 → 多行人话报告（e2e 失败时整体抛出/成功时打摘要） */
export function formatSmokeDiagnostics(result: SmokeProbesResult): string {
  const lines = [
    `smoke probes at ${result.baseUrl} (model ${result.modelId}): ${result.ok ? "OK" : "FAILED"}`,
    `[1/2] gateway health: ${result.health.diagnostic}`,
    ...(result.health.detail !== undefined ? [`      ${result.health.detail}`] : []),
    `[2/2] model reachability: ${result.model.diagnostic}`,
    ...(result.model.detail !== undefined ? [`      ${result.model.detail}`] : []),
  ];
  return lines.join("\n");
}

function skippedModelProbe(): ModelProbeResult {
  return {
    ok: false,
    failureKind: "UNREACHABLE",
    diagnostic: "skipped: the gateway is unreachable (fix the health probe findings first)",
  };
}

/** 200 + 可解析模型清单 → 可见 id 摘要；其余状态只注明健康口径只看传输层 */
async function healthDetail(response: Response): Promise<{ detail?: string }> {
  if (response.status !== 200) {
    return { detail: `health only requires any HTTP response; GET /models returned ${response.status}` };
  }
  const parsed = parseJsonOrNull(await response.text());
  const ids = modelListIds(parsed);
  if (parsed === null || ids === null) {
    return { detail: "GET /models returned 200 (model list not parseable — not required for health)" };
  }
  const shown = ids.slice(0, 8).join(", ");
  return {
    detail: `models visible at the gateway (first 8 of ${ids.length}): ${shown}${ids.length > 8 ? ", …" : ""}`,
  };
}

function modelListIds(parsed: unknown): string[] | null {
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { data?: unknown }).data)) {
    return null;
  }
  const entries = (parsed as { data: unknown[] }).data;
  const ids = entries
    .map((entry) => (typeof entry === "object" && entry !== null ? (entry as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string");
  return ids.length > 0 ? ids : null;
}

function classifyModelResponse(
  input: ModelProbeInput,
  response: Response,
  bodyText: string,
): ModelProbeResult {
  const parsed = parseJsonOrNull(bodyText);
  const bodyError = errorTextOf(parsed) ?? excerpt(bodyText);

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      failureKind: "AUTH_REJECTED",
      diagnostic:
        `authentication failed at ${input.baseUrl} (HTTP ${response.status}): the gateway rejected the API key. ` +
        "Check reviewer.apiKey in your PiAgent.json (review-pi config show) — environment variables are " +
        "no longer read, and the key is never logged or persisted.",
      detail: `gateway error body: ${bodyError}`,
    };
  }
  if (response.status === 429) {
    return {
      ok: false,
      failureKind: "RATE_LIMITED",
      diagnostic:
        `rate limited at ${input.baseUrl} (HTTP 429): the gateway is up and the key is valid, ` +
        "but requests are being throttled. Retry the smoke later.",
      detail: `gateway error body: ${bodyError}`,
    };
  }
  if (response.status === 404) {
    return {
      ok: false,
      failureKind: "MODEL_NOT_FOUND",
      diagnostic:
        `model "${input.modelId}" was not found (HTTP 404) at ${input.baseUrl}. Either the gateway does not ` +
        "serve this model id, or the endpoint path is wrong — this gateway family requires the /v1 " +
        "prefix in reviewer.baseUrl (the OpenAI-compatible path is <baseUrl>/chat/completions).",
      detail: `gateway error body: ${bodyError}`,
    };
  }
  if (response.status >= 500) {
    return {
      ok: false,
      failureKind: "SERVER_ERROR",
      diagnostic:
        `gateway server error (HTTP ${response.status}) at ${input.baseUrl}: the endpoint is reachable ` +
        "and authenticated but failed server-side. Retry later or contact the gateway operator.",
      detail: `gateway error body: ${bodyError}`,
    };
  }
  if (response.status >= 400) {
    if (isModelNotExistText(bodyError)) {
      return {
        ok: false,
        failureKind: "MODEL_NOT_FOUND",
        diagnostic:
          `model "${input.modelId}" was rejected by the gateway: ${bodyError} The model id is not served ` +
          "at this endpoint; check the gateway's model list or the model id in use.",
        detail: `gateway error body: ${bodyError}`,
      };
    }
    return {
      ok: false,
      failureKind: "REQUEST_REJECTED",
      diagnostic:
        `the gateway rejected the request body (HTTP ${response.status}) at ${input.baseUrl}: the endpoint ` +
        "is reachable and authenticated, but does not accept the request as sent.",
      detail: `gateway error body: ${bodyError}`,
    };
  }

  const usage = extractChatUsage(parsed);
  const hasChoices =
    typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { choices?: unknown }).choices);
  if (usage === null || !hasChoices) {
    return {
      ok: false,
      failureKind: "MALFORMED_RESPONSE",
      diagnostic:
        `the gateway responded HTTP ${response.status} but not with a chat completion carrying choices and ` +
        "usage (usage reporting is required for the token accounting): " + excerpt(bodyText),
    };
  }
  const respondedModel = typeof (parsed as { model?: unknown }).model === "string"
    ? (parsed as { model: string }).model
    : undefined;
  if (respondedModel !== undefined && !modelEchoMatches(input.modelId, respondedModel)) {
    return {
      ok: false,
      failureKind: "MODEL_MISMATCH",
      diagnostic:
        `the gateway silently routed to a different model: requested "${input.modelId}" but the response ` +
        `reports "${respondedModel}". This is the misrouting signature of a wrong reviewer.baseUrl path ` +
        "(e.g. missing the /v1 prefix); do not trust any run against this endpoint until it is fixed.",
      detail: `responded model field: ${JSON.stringify(respondedModel)}`,
    };
  }
  return {
    ok: true,
    diagnostic:
      `model "${input.modelId}" is reachable at ${input.baseUrl}` +
      (respondedModel !== undefined && respondedModel !== input.modelId
        ? ` (response model field resolves to the versioned build "${respondedModel}")`
        : respondedModel !== undefined
          ? ` (response model field echoes "${respondedModel}")`
          : "") +
      `; probe usage: input ${usage.promptTokens - usage.cacheReadTokens}, output ${usage.completionTokens}, ` +
      `cacheRead ${usage.cacheReadTokens}.`,
    ...(respondedModel !== undefined ? { respondedModel } : {}),
    rawUsage: usage,
  };
}

/**
 * 模型回显匹配口径（探针与真跑逐请求断言单源）：精确相等，或互为
 * 「分隔符后缀的版本化构建」（deepseek-v4-flash → deepseek-v4-flash-ga-260731，
 * 火山引擎网关的别名→GA 快照解析）。已知局限（探针只拦跨族静默错路由）：
 * 同族层级漂移（glm-5.3 → glm-5.3-flash）不判错；回显缺席（响应无
 * model 字段）时调用面（探针与真跑）不比对——不回显的网关可绕过检测。
 */
export function modelEchoMatches(requested: string, responded: string): boolean {
  return (
    requested === responded ||
    isVersionedBuildOf(requested, responded) ||
    isVersionedBuildOf(responded, requested)
  );
}

/** extended = base + 分隔符（- . :）开头的版本后缀（黏连不算，如 deepseek-v4-flashy） */
function isVersionedBuildOf(base: string, extended: string): boolean {
  return extended.length > base.length && /^[-.:]/.test(extended.slice(base.length));
}

/** deepseek 口径「Model Not Exist」等模型不存在文案（错误码不总是 404） */
function isModelNotExistText(text: string): boolean {
  return /model[^\n]{0,60}(not\s*exist|not\s*found|does\s*not\s*exist|doesn'?t\s*exist)|(unknown|invalid|no\s*such)[^\n]{0,30}model/i.test(
    text,
  );
}

/**
 * chat 响应 usage 投影（探测与真跑 recording-fetch 的单源提取器）：
 * 缺 usage 视为不可用（返回 null）。choices 有效性由各调用面自判
 * （SSE usage 帧合法地携带空 choices，不能在这里一并要求）。
 */
export function extractChatUsage(parsed: unknown): RawWireUsage | null {
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as { usage?: unknown };
  if (typeof record.usage !== "object" || record.usage === null) {
    return null;
  }
  const usage = record.usage as {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    prompt_cache_hit_tokens?: unknown;
    cached_tokens?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown; cache_write_tokens?: unknown };
  };
  const promptTokens = numberOf(usage.prompt_tokens);
  const completionTokens = numberOf(usage.completion_tokens);
  if (promptTokens === null || completionTokens === null) {
    return null;
  }
  const cacheReadTokens =
    numberOf(usage.prompt_tokens_details?.cached_tokens) ??
    numberOf(usage.prompt_cache_hit_tokens) ??
    numberOf(usage.cached_tokens) ??
    0;
  const cacheWriteTokens = numberOf(usage.prompt_tokens_details?.cache_write_tokens);
  return {
    promptTokens,
    completionTokens,
    cacheReadTokens,
    ...(cacheWriteTokens !== null ? { cacheWriteTokens } : {}),
  };
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function errorTextOf(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const error = (parsed as { error?: unknown }).error;
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }
  const message = (parsed as { message?: unknown }).message;
  return typeof message === "string" && message.length > 0 ? message : null;
}

function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function excerpt(text: string, maxLength = 200): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= maxLength ? collapsed : `${collapsed.slice(0, maxLength)}…`;
}

function unreachableDiagnostic(baseUrl: string, error: unknown): string {
  const timedOut = isTimeoutError(error);
  const cause = timedOut ? `request timed out` : networkCauseText(error);
  return (
    `gateway unreachable at ${baseUrl}: ${cause}. Check reviewer.baseUrl (OpenAI-compatible gateways ` +
    "usually need the /v1 path prefix), network connectivity, and any proxy settings."
  );
}

function isTimeoutError(error: unknown): boolean {
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return true;
  }
  return error instanceof Error && /timed out/.test(error.message);
}

/** 网络错误 → 人话归因（DNS / 拒连 / 超时 / 原始消息） */
function networkCauseText(error: unknown): string {
  const cause = (error as { cause?: unknown })?.cause;
  const code = (cause as { code?: unknown } | undefined)?.code;
  if (code === "ENOTFOUND") {
    return "DNS lookup failed (the hostname does not resolve)";
  }
  if (code === "ECONNREFUSED") {
    return "connection refused (nothing is listening on that host and port)";
  }
  if (code === "ETIMEDOUT") {
    return "connection timed out";
  }
  const message = error instanceof Error ? error.message : String(error);
  return message;
}

/** 异常摘要（detail 行；网络错误带 cause 链；不含 key——网络层错误天然不含 */
function errorSummary(error: unknown): string | undefined {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    const causeText =
      cause instanceof Error ? ` (cause: ${cause.message})` : cause !== undefined ? ` (cause: ${String(cause)})` : "";
    return `${error.name}: ${error.message}${causeText}`;
  }
  return String(error);
}

/**
 * 有界等待：fetch 自身经 AbortSignal 自毁（真 fetch 尊重 signal）；对不
 * 尊重 signal 的实现（注入适配器）再兜一层 race——两侧任一超时即判超时。
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
