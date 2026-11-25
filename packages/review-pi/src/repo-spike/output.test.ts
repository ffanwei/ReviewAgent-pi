import { expect, test } from "vitest";

import { formatDuration, formatProgressLine } from "./output.js";

test("formatDuration：秒 / 分 / 时", () => {
  expect(formatDuration(0)).toBe("0s");
  expect(formatDuration(42_400)).toBe("42s");
  expect(formatDuration(60_000)).toBe("1m");
  expect(formatDuration(130_000)).toBe("2m10s");
  expect(formatDuration(3_600_000)).toBe("1h");
  expect(formatDuration(3_900_000)).toBe("1h05m");
});

test("formatProgressLine：完成数 / 在飞 / ETA / token 预算", () => {
  expect(
    formatProgressLine({
      completed: 3,
      total: 20,
      active: 2,
      elapsedMs: 130_000,
      etaMs: 520_000,
      spentTokens: 1234,
      maxTotalTokens: 5000,
    }),
  ).toBe(
    "[repo-review] progress completed=3/20 active=2 elapsed=2m10s eta=8m40s tokens=1234/5000",
  );
  expect(
    formatProgressLine({
      completed: 0,
      total: 2,
      active: 1,
      elapsedMs: 5_000,
    }),
  ).toBe("[repo-review] progress completed=0/2 active=1 elapsed=5s eta=calculating");
});
