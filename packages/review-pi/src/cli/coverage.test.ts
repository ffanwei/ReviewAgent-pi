import { expect, test } from "vitest";

import { planCoverageReport } from "./coverage.js";

// 覆盖补报计划（ADR-0061 / ADR-0068）：变更文件全集 − 已上报文件。

test("变更文件减去已上报文件，保持变更顺序并规范化已上报路径", () => {
  const plan = planCoverageReport(
    ["src/a.ts", "src/b.ts", "src/c.ts"],
    ["src/a.ts", "src\\b.ts", "src/c.ts"],
  );

  expect(plan.files).toEqual([]);
  expect(plan.reported.has("src/b.ts")).toBe(true);
});

test("非法已上报路径不参与排除", () => {
  const plan = planCoverageReport(
    ["src/a.ts"],
    ["/abs/a.ts", "../a.ts", "", "./a.ts", "C:/repo/a.ts"],
  );

  expect(plan.files).toEqual(["src/a.ts"]);
  expect(plan.reported.size).toBe(0);
});

test("重复已上报只登记一次，未上报文件保持原序", () => {
  const plan = planCoverageReport(["z.ts", "a.ts", "m.ts"], ["a.ts", "a.ts"]);

  expect(plan.files).toEqual(["z.ts", "m.ts"]);
  expect([...plan.reported]).toEqual(["a.ts"]);
});
