import { expect, test } from "vitest";

import { parseHunkHeader, parseHunkHeaderStrict } from "./hunk.js";
import { normalizeDiffPath, normalizeDiffPathForRegex, parseGitHeaderPaths, parseHeaderPath } from "./paths.js";
import { parseUnifiedDiff, sortParsedFiles } from "./parse.js";
import { scanDiffHeaders } from "./scan.js";

// diff 统一解析层：三种视图（块切分见 blocks.test.ts / 宽松解析 / 头扫描）
// 共用同一套路径与 hunk 语法。这里锁定语法与宽松视图的语义。

test("hunk 头：省略计数按 1 行；严格视图要求整行", () => {
  expect(parseHunkHeader("@@ -5 +5,2 @@ fn")).toEqual({
    oldStart: 5,
    oldCount: 1,
    newStart: 5,
    newCount: 2,
  });
  expect(parseHunkHeader("@@ -0,0 +1,2 @@")).toEqual({
    oldStart: 0,
    oldCount: 0,
    newStart: 1,
    newCount: 2,
  });
  expect(parseHunkHeader("not a hunk")).toBeNull();
  expect(parseHunkHeaderStrict("@@ -1 +1 @@ trailing")).not.toBeNull();
  expect(parseHunkHeaderStrict("@@ -1 +1 @@@")).toBeNull();
});

test("路径：git 引号 + 八进制解码，a/ b/ 前缀与时间戳剥离", () => {
  expect(normalizeDiffPathForRegex('"b/\\344\\270\\255\\346\\226\\207.md"')).toBe("中文.md");
  expect(normalizeDiffPath('"a/\\344\\270\\255.md"')).toBe("中.md");
  expect(normalizeDiffPath("./src/a.ts")).toBe("src/a.ts");
  expect(parseHeaderPath('+++ b/src/a.ts\t2026-01-01 00:00:00', "+++ ")).toEqual({
    path: "src/a.ts",
    deleted: false,
  });
  expect(parseHeaderPath("--- /dev/null", "--- ")).toEqual({ path: null, deleted: true });
});

test("diff --git 头：成对引号 / 带空格路径 / 普通路径", () => {
  expect(parseGitHeaderPaths('diff --git "a/\\344\\270\\255.md" "b/\\344\\270\\255.md"')).toEqual({
    oldPath: "中.md",
    newPath: "中.md",
  });
  expect(parseGitHeaderPaths("diff --git a/foo bar b/foo bar")).toEqual({
    oldPath: "foo bar",
    newPath: "foo bar",
  });
  expect(parseGitHeaderPaths("diff --git a/src/a.ts b/src/a.ts")).toEqual({
    oldPath: "src/a.ts",
    newPath: "src/a.ts",
  });
});

test("宽松解析：三种文件类型 + hunk 计数与两侧内容行", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,3 @@",
    " context",
    "-old",
    "+new",
    "+extra",
    "diff --git a/new.ts b/new.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/new.ts",
    "@@ -0,0 +1 @@",
    "+hello",
    "diff --git a/old.ts b/old.ts",
    "deleted file mode 100644",
    "--- a/old.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-gone",
  ].join("\n");
  const parsed = parseUnifiedDiff(diff);
  expect(parsed.unattributedHunks).toBe(0);
  expect(parsed.files.map((file) => [file.path, file.kind, file.added, file.removed])).toEqual([
    ["src/a.ts", "modified", 2, 1],
    ["new.ts", "added", 1, 0],
    ["old.ts", "deleted", 0, 1],
  ]);
  expect(parsed.files[0]?.hunks[0]).toMatchObject({
    oldStart: 1,
    oldCount: 2,
    newStart: 1,
    newCount: 3,
    oldLines: ["context", "old"],
    newLines: ["context", "new", "extra"],
  });
});

test("宽松解析：无 diff --git 的多文件裸头各自成节", () => {
  const diff = [
    "--- a/B.java",
    "+++ b/B.java",
    "@@ -1,1 +1,2 @@",
    " context",
    "+added",
    "--- a/A.java",
    "+++ b/A.java",
    "@@ -10,1 +10,1 @@",
    "-old",
    "+new",
  ].join("\n");
  const parsed = parseUnifiedDiff(diff);
  expect(parsed.files.map((file) => file.path)).toEqual(["B.java", "A.java"]);
  expect(parsed.files[1]?.kind).toBe("modified");
});

test("宽松解析：hunk 先于文件头计入 unattributed，不误归属", () => {
  const parsed = parseUnifiedDiff("@@ -1 +1 @@\n-x\n+y");
  expect(parsed.files).toEqual([]);
  expect(parsed.unattributedHunks).toBe(1);
});

test("块查看与头扫描共用路径归一：删除文件回退旧侧", () => {
  const diff = [
    "diff --git a/gone.ts b/gone.ts",
    "--- a/gone.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-x",
  ].join("\n");
  expect(parseUnifiedDiff(diff).files[0]?.path).toBe("gone.ts");
  expect(scanDiffHeaders(diff).files[0]?.file).toBe("gone.ts");
});

test("头扫描：不消费体行，体行计数不一致也只看结构行", () => {
  const diff = [
    "diff --git a/A.java b/A.java",
    "--- a/A.java",
    "+++ b/A.java",
    "@@ -10,2 +10,2 @@",
    "-old",
    "+new",
    "--- a/C.java",
    "+++ b/C.java",
    "@@ -1 +1 @@",
    "-x",
    "+y",
  ].join("\n");
  const scan = scanDiffHeaders(diff);
  expect(scan.files.map((file) => file.file)).toEqual(["A.java", "C.java"]);
  expect(scan.files[1]?.hunks).toEqual([{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 }]);
});

test("排序：按路径稳定升序", () => {
  const files = parseUnifiedDiff(
    [
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ].join("\n"),
  ).files;
  expect(sortParsedFiles(files).map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
});
