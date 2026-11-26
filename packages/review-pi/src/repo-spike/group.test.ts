import { expect, test } from "vitest";

import { groupRepoFiles } from "./group.js";
import type { RepoFile } from "./types.js";

function file(rel: string, size = 100): RepoFile {
  return { path: rel, size };
}

test("directory：按路径前两段分组，并受文件数上限切片", () => {
  const plan = groupRepoFiles(
    [
      file("src/a/one.ts"),
      file("src/a/two.ts"),
      file("src/b/three.ts"),
      file("root.ts"),
    ],
    { groupBy: "directory", maxFilesPerGroup: 2, maxGroupChars: 10_000 },
  );

  expect(plan.groups.map((group) => [group.key, group.files.map((f) => f.path)])).toEqual([
    ["<root>", ["root.ts"]],
    ["src/a", ["src/a/one.ts", "src/a/two.ts"]],
    ["src/b", ["src/b/three.ts"]],
  ]);
});

test("files：只按路径顺序切文件数桶", () => {
  const plan = groupRepoFiles(
    [file("a.ts"), file("b.ts"), file("c.ts")],
    { groupBy: "files", maxFilesPerGroup: 2, maxGroupChars: 10_000 },
  );

  expect(plan.groups.map((group) => group.files.map((f) => f.path))).toEqual([
    ["a.ts", "b.ts"],
    ["c.ts"],
  ]);
});

test("language：按扩展名分组", () => {
  const plan = groupRepoFiles(
    [file("a.ts"), file("b.py"), file("c.ts")],
    { groupBy: "language", maxFilesPerGroup: 10, maxGroupChars: 10_000 },
  );

  expect(plan.groups.map((group) => [group.key, group.files.map((f) => f.path)])).toEqual([
    [".py", ["b.py"]],
    [".ts", ["a.ts", "c.ts"]],
  ]);
});

test("none：一个文件一组；超过组上限的文件也单独成组", () => {
  const plan = groupRepoFiles(
    [file("a.ts", 10), file("b.ts", 10), file("huge.ts", 5_000)],
    { groupBy: "none", maxFilesPerGroup: 10, maxGroupChars: 1_000 },
  );

  expect(plan.groups.map((group) => group.files.map((f) => f.path))).toEqual([
    ["a.ts"],
    ["b.ts"],
    ["huge.ts"],
  ]);
  expect(plan.groups.at(-1)?.soloLarge).toBe(true);
  expect(plan.skipped).toEqual([]);
});

test("directory：超过组上限的单文件不再跳过，单独成组并标记 soloLarge", () => {
  const plan = groupRepoFiles(
    [
      file("src/a/small-one.ts", 1_000),
      file("src/a/small-two.ts", 1_000),
      file("src/a/large.ts", 5_000),
    ],
    { groupBy: "directory", maxFilesPerGroup: 5, maxGroupChars: 3_000 },
  );

  expect(plan.groups.map((group) => [group.files.map((f) => f.path), group.soloLarge])).toEqual([
    [["src/a/large.ts"], true],
    [["src/a/small-one.ts", "src/a/small-two.ts"], undefined],
  ]);
  expect(plan.skipped).toEqual([]);
});

test("边界：估算字符恰好等于上限时正常装箱，超过 1 字符即 solo", () => {
  const plan = groupRepoFiles(
    [file("src/a/exact.ts", 744), file("src/a/over.ts", 745)],
    { groupBy: "directory", maxFilesPerGroup: 5, maxGroupChars: 1_000 },
  );

  // estimateChars = size + 256（每个文件固定 diff 头开销）。
  expect(plan.groups.map((group) => [group.files.map((f) => f.path), group.soloLarge])).toEqual([
    [["src/a/exact.ts"], undefined],
    [["src/a/over.ts"], true],
  ]);
});

test("确定性：同输入两次分组结果一致", () => {
  const input = [file("src/a/x.ts"), file("src/b/y.ts"), file("src/a/z.ts")];
  const options = { groupBy: "directory" as const, maxFilesPerGroup: 2, maxGroupChars: 10_000 };
  expect(groupRepoFiles(input, options)).toEqual(groupRepoFiles(input, options));
});
