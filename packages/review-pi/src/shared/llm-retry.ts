import type { RetryLimits } from "./config.js";

/**
 * LLM 调用重试（ADR-0051）：本仓**核外一次性调用**（片级报文 / 收尾总结 /
 * 内置呈现引擎 / smoke 探针）的统一重试原语。
 *
 * 边界纪律：
 * - Agent 内会话（主检视回合 / 规则 Skill 会话）不走本模块——它们的重试在
 *   pi-ai `stream()` 的 `maxRetries` / `timeoutMs` 上，由 `reviewStreamFn`
 *   透传（ADR-0035：不 fork 上游）；
 * - 本模块只重试**每次尝试完整重建的请求**（裸 fetch），不做流中断续传；
 * - 分类只看结构化信号：传输异常、HTTP 状态码、`x-should-retry`、
 *   `Retry-After`、配额文案。**绝不靠字符串猜状态码**；
 * - 台词口径：`maxAttempts` 是**总尝试次数（含首次）**；pi-ai 的
 *   `maxRetries` 是重试次数，换算见 `reviewStreamFn` 调用方（attempts - 1）。
 */

/** 一次 LLM 调用的重试策略（全部来自 `limits.retry` 配置快照） */
export interface RetryPolicy {
  /** 总尝试次数（含首次），>= 1；1 = 不重试 */
  readonly maxAttempts: number;
  /** 指数退避基准毫秒数；0 = 立即重试 */
  readonly baseDelayMs: number;
  /** 单次退避上限毫秒数（指数退避封顶） */
  readonly maxDelayMs: number;
  /** 服务端 `Retry-After` 上限毫秒数；0 = 不设上限（照服务端要求等） */
  readonly maxRetryAfterMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
  maxRetryAfterMs: 30_000,
});

/** 显式单次尝试（smoke 缺省 / 回放 lane / 测试） */
export const SINGLE_ATTEMPT_POLICY: RetryPolicy = Object.freeze({
  maxAttempts: 1,
  baseDelayMs: 0,
  maxDelayMs: 0,
  maxRetryAfterMs: 0,
});

/** 配置面按路径取策略（路径名与 `limits.retry.*Attempts` 对应） */
export type RetryPath = "reviewTurn" | "oneShot" | "smoke";

export function retryPolicyFor(limits: RetryLimits, path: RetryPath): RetryPolicy {
  const maxAttempts =
    path === "reviewTurn"
      ? limits.reviewTurnAttempts
      : path === "oneShot"
        ? limits.oneShotAttempts
        : limits.smokeAttempts;
  return {
    maxAttempts,
    baseDelayMs: limits.baseDelayMs,
    maxDelayMs: limits.maxDelayMs,
    maxRetryAfterMs: limits.maxRetryAfterMs,
  };
}

/** 失败归因（结构化，调用方据此决定是否重试与如何落痕） */
export type RetryFailureKind = "transport" | "timeout" | "http" | "malformed";

export interface RetryFailure {
  readonly retryable: boolean;
  readonly kind: RetryFailureKind;
  /** 人话原因（不含密钥；可直接进 stderr） */
  readonly reason: string;
  /** HTTP 状态码（kind = "http" 时在场） */
  readonly status?: number;
  /** 服务端建议等待毫秒数（`Retry-After` / `retry-after-ms`） */
  readonly retryAfterMs?: number;
  /** 已读取的错误响应体（探针分类复用；已截断） */
  readonly bodyText?: string;
  /** 原始异常（探针诊断用；不落盘） */
  readonly cause?: unknown;
}

export type RetryAttempt<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: RetryFailure };

export type RetryOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly attempts: number }
  | { readonly ok: false; readonly failure: RetryFailure; readonly attempts: number };

export interface RetryHooks {
  /** 退避等待注入（测试用；缺省 setTimeout） */
  readonly sleep?: (ms: number) => Promise<void>;
  /** 每次决定重试时回调（进度 / 诊断钩子） */
  readonly onRetry?: (info: {
    readonly attempt: number;
    readonly nextAttempt: number;
    readonly maxAttempts: number;
    readonly delayMs: number;
    readonly failure: RetryFailure;
  }) => void;
}

/**
 * 有界重试：每次尝试独立重建请求（调用方保证 attempt 无跨次状态）。
 * 不可重试 / 次数耗尽时返回最后一次失败，绝不抛出——上层按既有降级链处理。
 */
export async function runWithRetry<T>(
  policy: RetryPolicy,
  attempt: (attemptNumber: number) => Promise<RetryAttempt<T>>,
  hooks: RetryHooks = {},
): Promise<RetryOutcome<T>> {
  const maxAttempts = Math.max(1, Math.floor(policy.maxAttempts));
  const sleep = hooks.sleep ?? defaultSleep;
  for (let attemptNumber = 1; ; attemptNumber += 1) {
    const result = await attempt(attemptNumber);
    if (result.ok) {
      return { ok: true, value: result.value, attempts: attemptNumber };
    }
    if (!result.failure.retryable || attemptNumber >= maxAttempts) {
      return { ok: false, failure: result.failure, attempts: attemptNumber };
    }
    const delayMs = retryDelayMsFor(policy, attemptNumber - 1, result.failure);
    hooks.onRetry?.({
      attempt: attemptNumber,
      nextAttempt: attemptNumber + 1,
      maxAttempts,
      delayMs,
      failure: result.failure,
    });
    await sleep(delayMs);
  }
}

/** 第 `retryIndex` 次重试前等待：优先服务端要求，否则指数退避封顶 */
export function retryDelayMsFor(
  policy: RetryPolicy,
  retryIndex: number,
  failure: RetryFailure,
): number {
  if (failure.retryAfterMs !== undefined) {
    return Math.max(0, failure.retryAfterMs);
  }
  const exponential = policy.baseDelayMs * 2 ** Math.max(0, retryIndex);
  return Math.max(0, Math.min(exponential, policy.maxDelayMs));
}

/** 传输层异常分类：超时与网络错误都可重试（请求本身尚未建立） */
export function classifyThrownFailure(error: unknown, prefix: string): RetryFailure {
  const message = error instanceof Error ? error.message : String(error);
  const timedOut =
    error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
  return {
    retryable: true,
    kind: timedOut ? "timeout" : "transport",
    reason: `${prefix}: ${message}`,
    cause: error,
  };
}

/**
 * HTTP 失败分类（结构化）：
 * - `x-should-retry: false/true` 优先；
 * - 408 / 409 / 429 / 5xx 可重试；429 命中配额文案则不重试（重试只会再烧一次）；
 * - 其余 4xx 不可重试；
 * - `Retry-After` 超过 `maxRetryAfterMs`（且上限 > 0）不可重试。
 */
export function classifyHttpFailure(
  status: number,
  headers: Headers,
  bodyText: string,
  policy: RetryPolicy,
): RetryFailure {
  const retryAfterMs = retryAfterFromHeaders(headers);
  const base = {
    kind: "http" as const,
    status,
    reason: `HTTP ${String(status)}${truncateDetail(bodyText)}`,
    bodyText,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
  const shouldRetry = headers.get("x-should-retry");
  if (shouldRetry === "false") {
    return { ...base, retryable: false };
  }
  if (shouldRetry === "true") {
    return { ...base, retryable: true };
  }
  if (
    retryAfterMs !== undefined &&
    policy.maxRetryAfterMs > 0 &&
    retryAfterMs > policy.maxRetryAfterMs
  ) {
    return { ...base, retryable: false };
  }
  if (status === 429 && isQuotaExhausted(bodyText)) {
    return { ...base, retryable: false };
  }
  return {
    ...base,
    retryable: status === 408 || status === 409 || status === 429 || status >= 500,
  };
}

/** 确定性非法输出（非 JSON / 缺 content / 空 completion）：默认不重试 */
export function malformedFailure(reason: string): RetryFailure {
  return { retryable: false, kind: "malformed", reason };
}

/** `Retry-After` / `retry-after-ms` → 毫秒（无法解析 = undefined，交给指数退避） */
export function retryAfterFromHeaders(headers: Headers): number | undefined {
  const retryAfterMs = headers.get("retry-after-ms");
  if (retryAfterMs !== null) {
    const value = Number.parseFloat(retryAfterMs);
    if (!Number.isNaN(value) && value >= 0) {
      return value;
    }
  }
  const retryAfter = headers.get("retry-after");
  if (retryAfter === null) {
    return undefined;
  }
  const seconds = Number.parseFloat(retryAfter);
  if (!Number.isNaN(seconds)) {
    return Math.max(0, seconds * 1_000);
  }
  const date = Date.parse(retryAfter);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** 配额 / 余额类 429 的文案指纹（命中即不重试；保守匹配，避免吞掉普通限流） */
function isQuotaExhausted(bodyText: string): boolean {
  return /insufficient[_\s-]?quota|quota[_\s-]?(?:exceeded|exhausted|reached|limit)|insufficient[_\s-]?balance|balance[_\s-]?(?:is[_\s-]?)?(?:too[_\s-]?low|exhausted|depleted|insufficient)|billing[_\s-]?(?:hard[_\s-]?limit|quota|issue)|欠费|额度(?:不足|已用尽|用尽)|配额(?:不足|用尽)/i.test(
    bodyText,
  );
}

function truncateDetail(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") {
    return "";
  }
  return flat.length <= max ? `: ${flat}` : `: ${flat.slice(0, max - 1)}…`;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}
