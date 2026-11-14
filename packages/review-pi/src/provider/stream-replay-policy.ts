/**
 * 流中断重放的纯策略（ADR-0077 / ADR-0089）：
 * 只回答「还能不能再发起一次」与「下次之前等多久」，不睡、不碰 IO。
 */

export interface ReplayPolicyShape {
  /** 总墙钟预算（毫秒，含退避；0 = 不设上限） */
  readonly budgetMs: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

/** 预算内才允许再发起一次（`budgetMs <= 0` = 不设上限） */
export function withinReplayBudget(
  startedAt: number,
  budgetMs: number,
  now: () => number,
): boolean {
  return budgetMs <= 0 || now() - startedAt < budgetMs;
}

/** 第 `replay` 次重放前的退避：`base * 2^replay`，`maxDelayMs` 封顶 */
export function replayDelayMs(
  policy: ReplayPolicyShape,
  replay: number,
): number {
  const exponential = policy.baseDelayMs * 2 ** Math.max(0, replay);
  return Math.max(0, Math.min(exponential, policy.maxDelayMs));
}
