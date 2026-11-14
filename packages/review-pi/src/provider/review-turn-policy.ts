import { retryPolicyFor } from "../shared/llm-retry.js";
import type { ReviewRuntime } from "../shared/review-runtime.js";
import type { StreamReplayPolicy } from "./pi-client.js";

/**
 * Agent 内会话（主检视回合 / 规则 Skill 会话）共用的 `reviewStreamFn` 选项块
 * （ADR-0087）：
 *
 * - pi-ai `maxRetries` 是**重试次数**，配置面是**总尝试次数（含首次）**，故 -1；
 * - `maxRetryDelayMs` 复用 `Retry-After` 上限；
 * - replay 四字段来自 ADR-0077 的 `limits.retry`。
 *
 * 两个调用点只保留各自的 `timeline` 作用域；重试/超时/重放的映射只在这里。
 */
export interface ReviewTurnStreamOptions {
  readonly maxRetries: number;
  readonly maxRetryDelayMs: number;
  readonly timeoutMs: number;
  readonly replay: StreamReplayPolicy;
}

export function reviewTurnStreamOptions(
  runtime: ReviewRuntime,
): ReviewTurnStreamOptions {
  const policy = retryPolicyFor(runtime.limits.retry, "reviewTurn");
  return {
    maxRetries: Math.max(0, policy.maxAttempts - 1),
    maxRetryDelayMs: policy.maxRetryAfterMs,
    timeoutMs: runtime.limits.timeouts.reviewTurnMs,
    replay: {
      attempts: runtime.limits.retry.streamAttempts,
      budgetMs: runtime.limits.retry.streamReplayBudgetMs,
      baseDelayMs: runtime.limits.retry.baseDelayMs,
      maxDelayMs: runtime.limits.retry.maxDelayMs,
    },
  };
}
