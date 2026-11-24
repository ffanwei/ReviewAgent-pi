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

test("none：一个文件一组；超过字符上限的文件跳过", () => {
  const plan = groupRepoFiles(
    [file("a.ts", 10), file("b.ts", 10), file("huge.ts", 5_000)],
    { groupBy: "none", maxFilesPerGroup: 10, maxGroupChars: 1_000 },
  );

  expect(plan.groups.map((group) => group.files.map((f) => f.path))).toEqual([["a.ts"], ["b.ts"]]);
  expect(plan.skipped).toContainEqual({
    path: "huge.ts",
    reason: "group-too-large(5256>1000)",
  });
});

test("确定性：同输入两次分组结果一致", () => {
  const input = [file("src/a/x.ts"), file("src/b/y.ts"), file("src/a/z.ts")];
  const options = { groupBy: "directory" as const, maxFilesPerGroup: 2, maxGroupChars: 10_000 };
  expect(groupRepoFiles(input, options)).toEqual(groupRepoFiles(input, options));
});
