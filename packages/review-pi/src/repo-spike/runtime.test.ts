import { expect, test } from "vitest";

import { buildSpikeRuntime, computeSpikeToolBudget } from "./runtime.js";

test("computeSpikeToolBudget：8 次/文件，5 文件封顶 40，尝试预算 +10", () => {
  expect(computeSpikeToolBudget(1, 8, 40)).toEqual({ maxToolCalls: 8, maxToolAttempts: 18 });
  expect(computeSpikeToolBudget(3, 8, 40)).toEqual({ maxToolCalls: 24, maxToolAttempts: 34 });
  expect(computeSpikeToolBudget(5, 8, 40)).toEqual({ maxToolCalls: 40, maxToolAttempts: 50 });
  expect(computeSpikeToolBudget(8, 8, 40)).toEqual({ maxToolCalls: 40, maxToolAttempts: 50 });
});

test("computeSpikeToolBudget：组上限可低于文件数乘积", () => {
  expect(computeSpikeToolBudget(5, 8, 30)).toEqual({ maxToolCalls: 30, maxToolAttempts: 40 });
});

test("buildSpikeRuntime：工具预算进入运行时", () => {
  const runtime = buildSpikeRuntime(
    1,
    false,
    undefined,
    computeSpikeToolBudget(5, 8, 40),
  );
  expect(runtime.maxToolCalls).toBe(40);
  expect(runtime.maxToolAttempts).toBe(50);
});

test("buildSpikeRuntime：用户配置的 genericReview 覆盖内置缺省", () => {
  const genericReview = {
    suppress: { severities: [], categories: [] },
  } as const;
  const runtime = buildSpikeRuntime(
    1,
    false,
    undefined,
    computeSpikeToolBudget(5, 8, 40),
    genericReview,
  );
  expect(runtime.limits.genericReview).toEqual(genericReview);
});
