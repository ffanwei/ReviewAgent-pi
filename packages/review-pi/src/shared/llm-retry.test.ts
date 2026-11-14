import { expect, test } from "vitest";

import {
  DEFAULT_RETRY_POLICY,
  SINGLE_ATTEMPT_POLICY,
  classifyHttpFailure,
  classifyThrownFailure,
  malformedFailure,
  retryAfterFromHeaders,
  retryDelayMsFor,
  retryPolicyFor,
  runWithRetry,
  type RetryAttempt,
  type RetryFailure,
  type RetryPolicy,
} from "./llm-retry.js";
import { DEFAULT_LIMITS, type RetryLimits } from "./config.js";

// ADR-0051：核外一次性 LLM 调用的统一重试原语。
// 纪律：次数口径「总尝试次数」；只有结构化可重试信号才重试；绝不靠字符串猜状态码。

const NO_WAIT: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 0,
  maxDelayMs: 0,
  maxRetryAfterMs: 30_000,
};

function httpFailure(status: number, headers: Record<string, string> = {}, body = ""): RetryFailure {
  return classifyHttpFailure(status, new Headers(headers), body, NO_WAIT);
}

test("runWithRetry：首次成功 = 一次尝试，不放大请求", async () => {
  let calls = 0;
  const outcome = await runWithRetry(NO_WAIT, async (): Promise<RetryAttempt<string>> => {
    calls += 1;
    return { ok: true, value: "done" };
  });
  expect(outcome).toEqual({ ok: true, value: "done", attempts: 1 });
  expect(calls).toBe(1);
});

test("runWithRetry：前两次可重试失败后成功 → attempts = 3", async () => {
  const delays: number[] = [];
  let calls = 0;
  const outcome = await runWithRetry(
    { ...NO_WAIT, baseDelayMs: 10, maxDelayMs: 1_000 },
    async (): Promise<RetryAttempt<string>> => {
      calls += 1;
      if (calls < 3) {
        return { ok: false, failure: httpFailure(503) };
      }
      return { ok: true, value: "ok" };
    },
    { sleep: async (ms) => void delays.push(ms) },
  );
  expect(outcome).toEqual({ ok: true, value: "ok", attempts: 3 });
  expect(calls).toBe(3);
  // 指数退避：10 → 20
  expect(delays).toEqual([10, 20]);
});

test("runWithRetry：可重试失败耗尽次数 → 返回最后一次失败，绝不抛出", async () => {
  let calls = 0;
  const outcome = await runWithRetry(NO_WAIT, async (): Promise<RetryAttempt<string>> => {
    calls += 1;
    return { ok: false, failure: httpFailure(500) };
  });
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) {
    expect(outcome.attempts).toBe(3);
    expect(outcome.failure.status).toBe(500);
  }
  expect(calls).toBe(3);
});

test("runWithRetry：不可重试的失败立即返回（不做无意义重放）", async () => {
  let calls = 0;
  const outcome = await runWithRetry(NO_WAIT, async (): Promise<RetryAttempt<string>> => {
    calls += 1;
    return { ok: false, failure: httpFailure(400) };
  });
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) {
    expect(outcome.attempts).toBe(1);
  }
  expect(calls).toBe(1);
});

test("runWithRetry：maxAttempts = 1 = 单次尝试（回放 lane / smoke 缺省）", async () => {
  let calls = 0;
  const outcome = await runWithRetry(SINGLE_ATTEMPT_POLICY, async (): Promise<RetryAttempt<string>> => {
    calls += 1;
    return { ok: false, failure: httpFailure(502) };
  });
  expect(outcome.ok).toBe(false);
  expect(calls).toBe(1);
});

test("runWithRetry：onRetry 只在实际重试前回调，带延迟与次数", async () => {
  const seen: { attempt: number; nextAttempt: number; delayMs: number }[] = [];
  let calls = 0;
  await runWithRetry(
    { ...NO_WAIT, baseDelayMs: 5, maxDelayMs: 1_000 },
    async (): Promise<RetryAttempt<string>> => {
      calls += 1;
      return calls === 1 ? { ok: false, failure: httpFailure(503) } : { ok: true, value: "ok" };
    },
    {
      sleep: async () => {},
      onRetry: (info) => seen.push({ attempt: info.attempt, nextAttempt: info.nextAttempt, delayMs: info.delayMs }),
    },
  );
  expect(seen).toEqual([{ attempt: 1, nextAttempt: 2, delayMs: 5 }]);
});

test("classifyHttpFailure：408 / 409 / 429 / 5xx 可重试，其余 4xx 不可重试", () => {
  expect(httpFailure(408).retryable).toBe(true);
  expect(httpFailure(409).retryable).toBe(true);
  expect(httpFailure(429).retryable).toBe(true);
  expect(httpFailure(500).retryable).toBe(true);
  expect(httpFailure(503).retryable).toBe(true);
  expect(httpFailure(400).retryable).toBe(false);
  expect(httpFailure(401).retryable).toBe(false);
  expect(httpFailure(404).retryable).toBe(false);
  expect(httpFailure(422).retryable).toBe(false);
});

test("classifyHttpFailure：x-should-retry 优先于状态码", () => {
  expect(httpFailure(400, { "x-should-retry": "true" }).retryable).toBe(true);
  expect(httpFailure(503, { "x-should-retry": "false" }).retryable).toBe(false);
});

test("classifyHttpFailure：配额 / 余额类 429 不重试（重试只会再烧一次）", () => {
  const quota = httpFailure(429, {}, '{"error":{"message":"insufficient_quota: balance exhausted"}}');
  expect(quota.retryable).toBe(false);
  const throttle = httpFailure(429, {}, '{"error":{"message":"rate limit reached, slow down"}}');
  // 「rate limit」是普通限流，不在配额指纹里 → 可重试
  expect(throttle.retryable).toBe(true);
  // 「load balancer」含 balance 子串，不能被误判为余额不足
  const balancer = httpFailure(429, {}, '{"error":{"message":"upstream load balancer is busy"}}');
  expect(balancer.retryable).toBe(true);
  const balanceLow = httpFailure(429, {}, '{"error":{"message":"credit balance is too low"}}');
  expect(balanceLow.retryable).toBe(false);
});

test("classifyHttpFailure：Retry-After 超过 maxRetryAfterMs 不重试（避免长期挂起）", () => {
  const capped = classifyHttpFailure(429, new Headers({ "retry-after": "120" }), "", {
    ...NO_WAIT,
    maxRetryAfterMs: 30_000,
  });
  expect(capped.retryable).toBe(false);
  expect(capped.retryAfterMs).toBe(120_000);

  const accepted = classifyHttpFailure(429, new Headers({ "retry-after": "1" }), "", {
    ...NO_WAIT,
    maxRetryAfterMs: 30_000,
  });
  expect(accepted.retryable).toBe(true);
});

test("classifyHttpFailure：maxRetryAfterMs = 0 = 不设上限（照服务端要求等）", () => {
  const failure = classifyHttpFailure(429, new Headers({ "retry-after": "120" }), "", {
    ...NO_WAIT,
    maxRetryAfterMs: 0,
  });
  expect(failure.retryable).toBe(true);
});

test("retryAfterFromHeaders：retry-after-ms / 秒 / HTTP 日期", () => {
  expect(retryAfterFromHeaders(new Headers({ "retry-after-ms": "1500" }))).toBe(1500);
  expect(retryAfterFromHeaders(new Headers({ "retry-after": "2.5" }))).toBe(2500);
  const future = new Date(Date.now() + 5_000).toUTCString();
  const ms = retryAfterFromHeaders(new Headers({ "retry-after": future }));
  expect(ms).toBeGreaterThan(0);
  expect(ms).toBeLessThanOrEqual(6_000);
  expect(retryAfterFromHeaders(new Headers())).toBeUndefined();
});

test("retryDelayMsFor：服务端要求优先，否则指数退避封顶", () => {
  const policy: RetryPolicy = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 250, maxRetryAfterMs: 30_000 };
  expect(retryDelayMsFor(policy, 0, malformedFailure("x"))).toBe(100);
  expect(retryDelayMsFor(policy, 1, malformedFailure("x"))).toBe(200);
  // 400 封顶到 250
  expect(retryDelayMsFor(policy, 2, malformedFailure("x"))).toBe(250);
  expect(retryDelayMsFor(policy, 0, { ...httpFailure(429), retryAfterMs: 40 })).toBe(40);
});

test("classifyThrownFailure：超时与传输异常都可重试，且不泄漏异常外的信息", () => {
  const timeout = Object.assign(new Error("The operation timed out"), { name: "TimeoutError" });
  const t = classifyThrownFailure(timeout, "probe");
  expect(t.retryable).toBe(true);
  expect(t.kind).toBe("timeout");
  expect(t.reason).toContain("probe");

  const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
  expect(classifyThrownFailure(aborted, "probe").kind).toBe("timeout");

  const network = new TypeError("fetch failed");
  expect(classifyThrownFailure(network, "probe").kind).toBe("transport");
});

test("malformedFailure：确定性非法输出不重试", () => {
  const failure = malformedFailure("response has no message content text");
  expect(failure.retryable).toBe(false);
  expect(failure.kind).toBe("malformed");
  expect(failure.reason).toContain("no message content");
});

test("retryPolicyFor：按路径取次数，退避参数全局共享", () => {
  const limits: RetryLimits = {
    ...DEFAULT_LIMITS.retry,
    maxAttempts: 4,
    baseDelayMs: 120,
    maxDelayMs: 900,
    maxRetryAfterMs: 5_000,
    reviewTurnAttempts: 2,
    oneShotAttempts: 3,
    smokeAttempts: 1,
  };
  expect(retryPolicyFor(limits, "reviewTurn")).toEqual({
    maxAttempts: 2,
    baseDelayMs: 120,
    maxDelayMs: 900,
    maxRetryAfterMs: 5_000,
  });
  expect(retryPolicyFor(limits, "oneShot").maxAttempts).toBe(3);
  expect(retryPolicyFor(limits, "smoke").maxAttempts).toBe(1);
});

test("缺省策略：总尝试 3 次，退避 500ms→10s", () => {
  expect(DEFAULT_RETRY_POLICY.maxAttempts).toBe(3);
  expect(DEFAULT_RETRY_POLICY.baseDelayMs).toBe(500);
  expect(DEFAULT_RETRY_POLICY.maxDelayMs).toBe(10_000);
  expect(SINGLE_ATTEMPT_POLICY.maxAttempts).toBe(1);
});
