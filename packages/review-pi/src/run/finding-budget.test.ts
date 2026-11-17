import { describe, expect, test } from "vitest";
import type { Finding } from "../contracts/finding.js";
import { capFindings, rankFindings, renumberFindings } from "./finding-budget.js";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F001",
    severity: "P2",
    category: "bug",
    file: "src/A.java",
    line: 10,
    title: "Null check missing",
    description: "desc",
    evidence: ["line 10: foo()"],
    rule: "no-null-deref",
    confidence: 0.7,
    ...overrides,
  };
}

describe("rankFindings", () => {
  test("严重级优先，同级按 confidence 降序，再按文件/行号", () => {
    const ranked = rankFindings([
      finding({ id: "F1", severity: "P3", confidence: 0.99, file: "a", line: 1 }),
      finding({ id: "F2", severity: "P1", confidence: 0.5, file: "b", line: 2 }),
      finding({ id: "F3", severity: "P1", confidence: 0.9, file: "c", line: 3 }),
      finding({ id: "F4", severity: "P0", confidence: 0.1, file: "d", line: 4 }),
    ]);

    expect(ranked.map((entry) => entry.id)).toEqual(["F4", "F3", "F2", "F1"]);
  });
});

describe("capFindings", () => {
  test("limit <= 0 不限制", () => {
    const findings = [finding(), finding({ id: "F002" })];
    expect(capFindings(findings, 0)).toEqual({ findings, dropped: 0 });
  });

  test("超限时保留高严重级/高置信度，返回丢弃数", () => {
    const result = capFindings(
      [
        finding({ id: "F1", severity: "P2", confidence: 0.9 }),
        finding({ id: "F2", severity: "P1", confidence: 0.4 }),
        finding({ id: "F3", severity: "P0", confidence: 0.2 }),
        finding({ id: "F4", severity: "P3", confidence: 0.99 }),
      ],
      2,
    );

    expect(result.findings.map((entry) => entry.id)).toEqual(["F3", "F2"]);
    expect(result.dropped).toBe(2);
  });

  test("未超限保持原顺序不变", () => {
    const findings = [finding({ id: "F2" }), finding({ id: "F1" })];
    expect(capFindings(findings, 5).findings).toEqual(findings);
  });
});

describe("renumberFindings", () => {
  test("按当前顺序重编号 F001…，其它字段不变", () => {
    const renamed = renumberFindings([
      finding({ id: "F007", title: "a" }),
      finding({ id: "F003", title: "b" }),
    ]);
    expect(renamed.map((entry) => entry.id)).toEqual(["F001", "F002"]);
    expect(renamed.map((entry) => entry.title)).toEqual(["a", "b"]);
  });
});
