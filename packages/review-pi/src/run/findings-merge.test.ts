import { describe, expect, test } from "vitest";
import type { Finding } from "../contracts/finding.js";
import { mergeShardFindings, normalizeFindingKeyPart } from "./findings-merge.js";

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

describe("mergeShardFindings：确定性合并，不做模糊聚类", () => {
  test("同键跨片合并：严重度 / confidence 取最高，evidence 并集，id 重编号", () => {
    const merged = mergeShardFindings([
      [finding({ id: "F001", severity: "P2", confidence: 0.6, evidence: ["e1"] })],
      [finding({ id: "F001", severity: "P0", confidence: 0.9, evidence: ["e2", "e1"] })],
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.severity).toBe("P0");
    expect(merged[0]?.confidence).toBe(0.9);
    expect(merged[0]?.evidence).toEqual(["e1", "e2"]);
    expect(merged[0]?.id).toBe("F001");
  });

  test("同键并列 confidence：description 取更长，title / rule 取首次出现", () => {
    const merged = mergeShardFindings([
      [finding({ title: "Same Spot", description: "short", rule: "first" })],
      [finding({ title: "same   spot", description: "a much longer description", rule: "second" })],
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.title).toBe("Same Spot");
    expect(merged[0]?.rule).toBe("first");
    expect(merged[0]?.description).toBe("a much longer description");
  });

  test("同文件相邻行不合并（宁可多报，不误合并）", () => {
    const merged = mergeShardFindings([
      [finding({ line: 10 }), finding({ line: 11, id: "F002" })],
    ]);
    expect(merged).toHaveLength(2);
    expect(merged.map((entry) => entry.line)).toEqual([10, 11]);
  });

  test("同标题不同文件不合并", () => {
    const merged = mergeShardFindings([[finding(), finding({ file: "src/B.java" })]]);
    expect(merged).toHaveLength(2);
  });

  test("文件路径 / 标题归一化后同键合并（展示保留原文）", () => {
    const merged = mergeShardFindings([
      [finding({ file: " src/A.java " })],
      [finding({ file: "SRC/a.java", title: "null   CHECK missing" })],
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.file).toBe(" src/A.java ");
  });

  test("排序：文件首次出现顺序 → 行号升序 → 严重度降序 → title", () => {
    const merged = mergeShardFindings([
      [
        finding({ file: "src/A.java", line: 20, title: "a2" }),
        finding({ file: "src/B.java", line: 5, title: "b1" }),
      ],
      [
        finding({ file: "src/A.java", line: 3, title: "a1-low", severity: "P3" }),
        finding({ file: "src/A.java", line: 3, title: "a1-high", severity: "P0" }),
      ],
    ]);
    expect(merged.map((entry) => entry.title)).toEqual(["a1-high", "a1-low", "a2", "b1"]);
    expect(merged.map((entry) => entry.id)).toEqual(["F001", "F002", "F003", "F004"]);
  });

  test("空输入返回空数组", () => {
    expect(mergeShardFindings([])).toEqual([]);
    expect(mergeShardFindings([[], []])).toEqual([]);
  });

  test("normalizeFindingKeyPart：trim + 空白折叠 + 小写", () => {
    expect(normalizeFindingKeyPart("  Foo\t BAR  ")).toBe("foo bar");
  });
});
