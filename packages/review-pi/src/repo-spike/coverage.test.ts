import { expect, test } from "vitest";

import { buildRepoCoverage, coverageIsConsistent, normalizeReason } from "./coverage.js";
import type {
  RepoFile,
  RepoSpikeGroupOutcome,
  SkippedFile,
  SyntheticGroup,
} from "./types.js";

function file(path: string): RepoFile {
  return { path, size: 100 };
}

function group(files: readonly string[], skipped: readonly SkippedFile[] = []): SyntheticGroup {
  return {
    group: {
      index: 1,
      key: "test",
      files: files.map(file),
      estimatedChars: files.length * 100,
    },
    diff: "",
    files,
    snapshot: files.map((path) => ({ path, content: "" })),
    chars: 0,
    skipped,
  };
}

function reviewed(files: readonly string[], findings: RepoSpikeGroupOutcome["findings"]): RepoSpikeGroupOutcome {
  return {
    index: 1,
    key: "test",
    files,
    diffChars: 0,
    status: "reviewed",
    findingsCount: findings?.length ?? 0,
    findings,
  };
}

test("覆盖：reviewed 组按 finding 分 candidate / no-issue，按 selected 顺序输出", () => {
  const coverage = buildRepoCoverage({
    selected: [file("src/b.ts"), file("src/a.ts")],
    groupedSkipped: [],
    groups: [group(["src/b.ts", "src/a.ts"])],
    outcomes: [
      reviewed(["src/b.ts", "src/a.ts"], [
        {
          id: "F001",
          severity: "P1",
          category: "可靠性",
          file: "src/b.ts",
          line: 1,
          title: "x",
          description: "x",
          evidence: ["x"],
          rule: "R",
          confidence: 0.9,
          tips: { review: "x", suggestion: "x", subcategory: "x" },
        },
        {
          id: "F002",
          severity: "P2",
          category: "可靠性",
          file: "src/b.ts",
          line: 2,
          title: "y",
          description: "y",
          evidence: ["y"],
          rule: "R",
          confidence: 0.8,
          tips: { review: "y", suggestion: "y", subcategory: "y" },
        },
      ]),
    ],
  });

  // 顺序跟 selected 走，不跟组 / finding 顺序走
  expect(coverage.files.map((item) => item.path)).toEqual(["src/b.ts", "src/a.ts"]);
  expect(coverage.files[0]).toEqual({
    path: "src/b.ts",
    state: "candidate",
    findingIds: ["F001", "F002"],
  });
  expect(coverage.files[1]).toEqual({ path: "src/a.ts", state: "no-issue" });
  expect(coverage.summary).toEqual({ selected: 2, candidate: 1, noIssue: 1, notReached: 0 });
  expect(coverageIsConsistent(coverage)).toBe(true);
});

test("覆盖：失败组 → failed-group；跳过组 → 原因；分组/合成跳过 → 对应原因", () => {
  const coverage = buildRepoCoverage({
    selected: [file("src/fail.ts"), file("src/skip.ts"), file("src/large.ts"), file("src/read.ts")],
    groupedSkipped: [{ path: "src/large.ts", reason: "group-too-large" }],
    groups: [
      group(["src/fail.ts"]),
      group(["src/skip.ts"]),
      group([], [{ path: "src/read.ts", reason: "read-failed" }]),
    ],
    outcomes: [
      { index: 1, key: "a", files: ["src/fail.ts"], diffChars: 0, status: "failed", findingsCount: 0, error: "boom" },
      {
        index: 2,
        key: "b",
        files: ["src/skip.ts"],
        diffChars: 0,
        status: "skipped",
        findingsCount: 0,
        skipReason: "no-reviewable-files",
      },
    ],
  });

  expect(coverage.files).toEqual([
    { path: "src/fail.ts", state: "not-reached", reason: "failed-group" },
    { path: "src/skip.ts", state: "not-reached", reason: "no-reviewable-files" },
    { path: "src/large.ts", state: "not-reached", reason: "group-too-large" },
    { path: "src/read.ts", state: "not-reached", reason: "read-failed" },
  ]);
  expect(coverage.summary).toEqual({ selected: 4, candidate: 0, noIssue: 0, notReached: 4 });
  expect(coverageIsConsistent(coverage)).toBe(true);
});

test("覆盖：reason 归一化（too-large(N>M) → too-large，未知 → unknown）", () => {
  expect(normalizeReason("too-large(1000>100)")).toBe("too-large");
  expect(normalizeReason("group-too-large")).toBe("group-too-large");
  expect(normalizeReason("budget-exhausted")).toBe("budget-exhausted");
  expect(normalizeReason("something-new")).toBe("unknown");
});

test("覆盖：三态之和恒等于 selected，重复路径不重复计数", () => {
  const coverage = buildRepoCoverage({
    selected: [file("a.ts"), file("a.ts"), file("b.ts")],
    groupedSkipped: [],
    groups: [group(["a.ts", "b.ts"])],
    outcomes: [reviewed(["a.ts", "b.ts"], [])],
  });
  expect(coverage.files).toHaveLength(2);
  expect(coverage.summary.selected).toBe(2);
  expect(coverageIsConsistent(coverage)).toBe(true);
});

test("覆盖：同一输入两次输出字节一致", () => {
  const input = {
    selected: [file("b.ts"), file("a.ts")],
    groupedSkipped: [] as SkippedFile[],
    groups: [group(["b.ts", "a.ts"])],
    outcomes: [reviewed(["b.ts", "a.ts"], [])],
  };
  expect(JSON.stringify(buildRepoCoverage(input))).toBe(JSON.stringify(buildRepoCoverage(input)));
});
