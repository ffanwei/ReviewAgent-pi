import { expect, test } from "vitest";
import { buildDiffScope } from "./diff-scope.js";

// 非 diff 区域过滤的位置解析（`limits.findingScope` 的判定底座）。
// 口径：新侧行号；hunk 区间可前后扩展 contextLines 行；文件不在 diff 即范围外；
// 空 diff / 删除文件 / 无 hunk 的文件 fail-open（不因解析不到位置而丢意见）。

function diffOf(...blocks: readonly string[]): string {
  return blocks.join("\n");
}

function fileBlock(path: string, hunkHeader: string, body: readonly string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    hunkHeader,
    ...body,
  ].join("\n");
}

const ALPHA = "src/main/java/com/example/Alpha.java";
const BETA = "src/main/java/com/example/Beta.java";

test("contextLines = 0：只保留 hunk 新侧区间内的行", () => {
  const scope = buildDiffScope(
    fileBlock(ALPHA, "@@ -10,3 +10,4 @@", [" keep", "+added", "+added", "+added", " keep", " keep"]),
    0,
  );
  expect(scope.fileCount).toBe(1);
  for (const line of [10, 11, 12, 13]) {
    expect(scope.classify(ALPHA, line), `line ${String(line)}`).toBe("in-scope");
  }
  expect(scope.classify(ALPHA, 9)).toBe("line-outside-hunks");
  expect(scope.classify(ALPHA, 14)).toBe("line-outside-hunks");
  expect(scope.classify(BETA, 10)).toBe("file-not-in-diff");
});

test("contextLines = 10：hunk 前后各放宽 10 行，且下界夹到 1", () => {
  const scope = buildDiffScope(
    fileBlock(ALPHA, "@@ -10,3 +10,4 @@", [" keep", "+added", "+added", "+added", " keep", " keep"]),
    10,
  );
  expect(scope.contextLines).toBe(10);
  expect(scope.classify(ALPHA, 1)).toBe("in-scope");
  expect(scope.classify(ALPHA, 23)).toBe("in-scope");
  expect(scope.classify(ALPHA, 24)).toBe("line-outside-hunks");
});

test("多个 hunk：任一区间命中即范围内", () => {
  const scope = buildDiffScope(
    diffOf(
      fileBlock(ALPHA, "@@ -5,2 +5,3 @@", [" keep", "+a", "+b", " keep"]),
      fileBlock(ALPHA, "@@ -100,2 +101,2 @@", [" keep", "+c", " keep"]),
    ),
    0,
  );
  expect(scope.fileCount).toBe(1);
  expect(scope.classify(ALPHA, 5)).toBe("in-scope");
  expect(scope.classify(ALPHA, 7)).toBe("in-scope");
  expect(scope.classify(ALPHA, 101)).toBe("in-scope");
  expect(scope.classify(ALPHA, 50)).toBe("line-outside-hunks");
});

test("纯删除 hunk（+start,0）：以 start 为锚点保留附近行", () => {
  const scope = buildDiffScope(fileBlock(ALPHA, "@@ -20,3 +19,0 @@", ["-gone", "-gone", "-gone"]), 2);
  expect(scope.classify(ALPHA, 17)).toBe("in-scope");
  expect(scope.classify(ALPHA, 21)).toBe("in-scope");
  expect(scope.classify(ALPHA, 16)).toBe("line-outside-hunks");
});

test("删除文件（+++ /dev/null）：整文件 fail-open", () => {
  const scope = buildDiffScope(
    [
      `diff --git a/${ALPHA} b/${ALPHA}`,
      `--- a/${ALPHA}`,
      "+++ /dev/null",
      "@@ -1,3 +0,0 @@",
      "-class Alpha {}",
      "-line",
      "-line",
    ].join("\n"),
    0,
  );
  expect(scope.fileCount).toBe(1);
  expect(scope.classify(ALPHA, 999)).toBe("in-scope");
});

test("只有 mode 变更、没有 hunk 的文件：文件在 diff 内，整文件 fail-open", () => {
  const scope = buildDiffScope(
    [
      `diff --git a/${ALPHA} b/${ALPHA}`,
      "old mode 100644",
      "new mode 100755",
    ].join("\n"),
    0,
  );
  expect(scope.fileCount).toBe(1);
  expect(scope.classify(ALPHA, 42)).toBe("in-scope");
  expect(scope.classify(BETA, 42)).toBe("file-not-in-diff");
});

test("空 diff / 非统一 diff：整体 fail-open（任何位置都算范围内）", () => {
  for (const diff of ["", "   \n", "not a unified diff at all"]) {
    const scope = buildDiffScope(diff, 10);
    expect(scope.fileCount).toBe(0);
    expect(scope.classify("any/File.java", 1)).toBe("in-scope");
  }
});

test("路径归一：finding 的反斜杠 / ./ 前缀与 diff 的新侧路径等价", () => {
  const scope = buildDiffScope(fileBlock(ALPHA, "@@ -1,1 +1,1 @@", ["-a", "+b"]), 0);
  expect(scope.classify(ALPHA.replace(/\//g, "\\"), 1)).toBe("in-scope");
  expect(scope.classify(`./${ALPHA}`, 1)).toBe("in-scope");
});

test("带引号 / 时间戳的 +++ 路径仍能识别", () => {
  const quoted = [
    `diff --git "a/${ALPHA}" "b/${ALPHA}"`,
    `--- "a/${ALPHA}"`,
    `+++ "b/${ALPHA}"`,
    "@@ -1,1 +1,1 @@",
    "-a",
    "+b",
  ].join("\n");
  expect(buildDiffScope(quoted, 0).classify(ALPHA, 1)).toBe("in-scope");

  const timestamped = [
    `--- a/${ALPHA}\t2026-01-01 00:00:00`,
    `+++ b/${ALPHA}\t2026-01-01 00:00:00`,
    "@@ -1,1 +1,1 @@",
    "-a",
    "+b",
  ].join("\n");
  expect(buildDiffScope(timestamped, 0).classify(ALPHA, 1)).toBe("in-scope");
});

test("多文件：各文件的 hunk 独立生效", () => {
  const scope = buildDiffScope(
    diffOf(
      fileBlock(ALPHA, "@@ -1,1 +1,1 @@", ["-a", "+b"]),
      fileBlock(BETA, "@@ -50,1 +50,1 @@", ["-a", "+b"]),
    ),
    0,
  );
  expect(scope.fileCount).toBe(2);
  expect(scope.classify(ALPHA, 1)).toBe("in-scope");
  expect(scope.classify(ALPHA, 50)).toBe("line-outside-hunks");
  expect(scope.classify(BETA, 50)).toBe("in-scope");
  expect(scope.classify("src/Other.java", 1)).toBe("file-not-in-diff");
});
