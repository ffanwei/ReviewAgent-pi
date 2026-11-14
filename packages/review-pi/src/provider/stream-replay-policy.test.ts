import { expect, test } from "vitest";

import { replayDelayMs, withinReplayBudget } from "./stream-replay-policy.js";

// 流中断重放策略（ADR-0089）：纯函数，不睡、不碰 IO。

test("withinReplayBudget：0 = 不限；未到预算 true；到点 false", () => {
  expect(withinReplayBudget(1_000, 0, () => 999_999)).toBe(true);
  expect(withinReplayBudget(1_000, 500, () => 1_499)).toBe(true);
  expect(withinReplayBudget(1_000, 500, () => 1_500)).toBe(false);
  expect(withinReplayBudget(1_000, 500, () => 2_000)).toBe(false);
});

test("replayDelayMs：指数退避 + maxDelay 封顶", () => {
  const policy = { budgetMs: 0, baseDelayMs: 100, maxDelayMs: 250 };

  expect(replayDelayMs(policy, 0)).toBe(100);
  expect(replayDelayMs(policy, 1)).toBe(200);
  expect(replayDelayMs(policy, 2)).toBe(250);
  expect(replayDelayMs(policy, 10)).toBe(250);
  expect(replayDelayMs({ ...policy, baseDelayMs: 0 }, 5)).toBe(0);
});
