import { expect, test } from "vitest";

import {
  filterGenericSuggestions,
  mergeGenericReviewSuppressions,
} from "./generic-review-policy.js";

const POLICY = {
  suppress: {
    severities: ["P3"] as const,
    categories: ["可维护", "可读性"] as const,
  },
};

test("命中 severity + category 才丢弃；P3 安全类保留", () => {
  const out = filterGenericSuggestions(
    [
      { id: "A", severity: "P3", category: "可维护" },
      { id: "B", severity: "P3", category: "安全" },
      { id: "C", severity: "P2", category: "可维护" },
      { id: "D", severity: "P3", category: "可读性" },
    ],
    POLICY,
  );
  expect(out.kept.map((item) => item.id)).toEqual(["B", "C"]);
  expect(out.suppression).toMatchObject({
    dropped: 2,
    bySeverity: { P3: 2 },
    byCategory: { 可维护: 1, 可读性: 1 },
  });
});

test("categories 为空 = 只按 severity 压；severities 为空 = 不过滤", () => {
  const bySeverity = filterGenericSuggestions(
    [{ id: "A", severity: "P3", category: "安全" }],
    { suppress: { severities: ["P3"], categories: [] } },
  );
  expect(bySeverity.kept).toEqual([]);

  const off = filterGenericSuggestions(
    [{ id: "A", severity: "P3", category: "可维护" }],
    { suppress: { severities: [], categories: ["可维护"] } },
  );
  expect(off.kept).toEqual([{ id: "A", severity: "P3", category: "可维护" }]);
  expect(off.suppression).toBeUndefined();
});

test("多轮 / 补漏留痕可合并", () => {
  const left = filterGenericSuggestions(
    [{ id: "A", severity: "P3", category: "可维护" }],
    POLICY,
  ).suppression;
  const right = filterGenericSuggestions(
    [{ id: "B", severity: "P3", category: "可读性" }],
    POLICY,
  ).suppression;
  expect(mergeGenericReviewSuppressions(left, right)).toMatchObject({
    dropped: 2,
    bySeverity: { P3: 2 },
    byCategory: { 可维护: 1, 可读性: 1 },
  });
});
