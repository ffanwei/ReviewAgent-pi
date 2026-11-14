import path from "node:path";

import { expect, test } from "vitest";

import { auditPathOf, compatFileOf, runsDirOf } from "./run-artifacts.js";

// run 产物布局单源（ADR-0088）：确定性推导，缺 runs 段按错误处理。

const TASKS = path.resolve("/tasks/t1");
const RUNS = path.join(TASKS, "runs");

test("runsDirOf：最后一个 runs 段", () => {
  expect(runsDirOf(path.join(RUNS, "session-x.json"))).toBe(RUNS);
  expect(
    runsDirOf(path.join(RUNS, "shards", "attempt-1", "s01", "session-x.json")),
  ).toBe(RUNS);
});

test("auditPathOf：runs → audit、去 session- 前缀、保留分片目录", () => {
  expect(auditPathOf(path.join(RUNS, "session-20260101_000000_000.json"))).toBe(
    path.join(TASKS, "audit", "20260101_000000_000.json"),
  );
  expect(
    auditPathOf(path.join(RUNS, "shards", "attempt-1", "s01", "session-abc.json")),
  ).toBe(path.join(TASKS, "audit", "shards", "attempt-1", "s01", "abc.json"));
});

test("compatFileOf：同目录 opencode/ 子目录", () => {
  expect(compatFileOf(path.join(RUNS, "session-x.json"))).toBe(
    path.join(RUNS, "opencode", "session-x.json"),
  );
});

test("缺 runs 段：显式报错，不再返回同目录幻影", () => {
  const orphan = path.join(TASKS, "session-x.json");
  expect(() => auditPathOf(orphan)).toThrow(/no "runs" segment/);
  expect(() => runsDirOf(orphan)).toThrow(/no "runs" segment/);
});
