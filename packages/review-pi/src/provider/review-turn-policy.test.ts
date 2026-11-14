import { expect, test } from "vitest";

import { DEFAULT_LIMITS } from "../shared/config.js";
import { DEFAULT_REVIEW_RUNTIME } from "../shared/review-runtime.js";
import { reviewTurnStreamOptions } from "./review-turn-policy.js";

// Agent 内会话的 stream 选项映射（ADR-0087）：两个调用点共用同一份。

function runtime(
  overrides: {
    readonly retry?: Partial<typeof DEFAULT_LIMITS.retry>;
    readonly reviewTurnMs?: number;
  } = {},
) {
  return {
    ...DEFAULT_REVIEW_RUNTIME,
    limits: {
      ...DEFAULT_LIMITS,
      retry: { ...DEFAULT_LIMITS.retry, ...overrides.retry },
      timeouts: {
        ...DEFAULT_LIMITS.timeouts,
        reviewTurnMs: overrides.reviewTurnMs ?? DEFAULT_LIMITS.timeouts.reviewTurnMs,
      },
    },
  };
}

test("缺省映射：总尝试次数 -1、Retry-After 上限、reviewTurnMs、replay 四字段", () => {
  expect(reviewTurnStreamOptions(runtime())).toEqual({
    maxRetries: DEFAULT_LIMITS.retry.reviewTurnAttempts - 1,
    maxRetryDelayMs: DEFAULT_LIMITS.retry.maxRetryAfterMs,
    timeoutMs: DEFAULT_LIMITS.timeouts.reviewTurnMs,
    replay: {
      attempts: DEFAULT_LIMITS.retry.streamAttempts,
      budgetMs: DEFAULT_LIMITS.retry.streamReplayBudgetMs,
      baseDelayMs: DEFAULT_LIMITS.retry.baseDelayMs,
      maxDelayMs: DEFAULT_LIMITS.retry.maxDelayMs,
    },
  });
});

test("单次尝试：reviewTurnAttempts = 1 → maxRetries = 0（不出现负数）", () => {
  const options = reviewTurnStreamOptions(
    runtime({ retry: { reviewTurnAttempts: 1 } }),
  );

  expect(options.maxRetries).toBe(0);
});

test("覆盖值逐字段透传", () => {
  const options = reviewTurnStreamOptions(
    runtime({
      retry: {
        reviewTurnAttempts: 5,
        maxRetryAfterMs: 1_234,
        streamAttempts: 7,
        streamReplayBudgetMs: 999,
        baseDelayMs: 11,
        maxDelayMs: 22,
      },
      reviewTurnMs: 42,
    }),
  );

  expect(options).toEqual({
    maxRetries: 4,
    maxRetryDelayMs: 1_234,
    timeoutMs: 42,
    replay: {
      attempts: 7,
      budgetMs: 999,
      baseDelayMs: 11,
      maxDelayMs: 22,
    },
  });
});
