import { describe, expect, test } from "vitest";
import {
  assertDiffWithinCharLimit,
  filterDiffForReview,
  formatMrFilterNotice,
  listChangedFilePaths,
  toMrFilterRecord,
} from "./mr-input.js";

const SOURCE = [
  "diff --git a/src/A.java b/src/A.java",
  "--- a/src/A.java",
  "+++ b/src/A.java",
  "@@ -1,2 +1,3 @@",
  " class A {",
  "+  int x;",
  " }",
].join("\n");

const LOCKFILE = [
  "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml",
  "--- a/pnpm-lock.yaml",
  "+++ b/pnpm-lock.yaml",
  "@@ -1,2 +1,2 @@",
  "-lockfileVersion: '5.4'",
  "+lockfileVersion: '6.0'",
].join("\n");

function block(path: string, body: readonly string[] = ["@@ -1 +1 @@", "-a", "+b"]): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    ...body,
  ].join("\n");
}

describe("filterDiffForReview：整块剔除噪声（绝不切 hunk）", () => {
  test("lockfile：源码块逐字节保留，剔除块记账", () => {
    const input = `${SOURCE}\n${LOCKFILE}`;
    const result = filterDiffForReview(input);
    expect(result.diff).toBe(SOURCE);
    expect(result.dropped).toEqual([{ path: "pnpm-lock.yaml", reason: "lockfile" }]);
    expect(result.droppedChars).toBe(input.length - SOURCE.length);
  });

  test("生成目录 / 生成代码后缀：reason = generated", () => {
    const input = [SOURCE, block("node_modules/pkg/index.js"), block("src/Api.generated.java")].join("\n");
    const result = filterDiffForReview(input);
    expect(result.dropped).toEqual([
      { path: "node_modules/pkg/index.js", reason: "generated" },
      { path: "src/Api.generated.java", reason: "generated" },
    ]);
    expect(result.diff).toBe(SOURCE);
  });

  test("minified：reason = minified（优先于 generated）", () => {
    const result = filterDiffForReview(block("dist/app.min.js"));
    expect(result.dropped).toEqual([{ path: "dist/app.min.js", reason: "minified" }]);
    expect(result.diff).toBe("");
  });

  test("二进制块：reason = binary", () => {
    const input = [
      "diff --git a/assets/logo.png b/assets/logo.png",
      "Binary files a/assets/logo.png and b/assets/logo.png differ",
    ].join("\n");
    const result = filterDiffForReview(input);
    expect(result.dropped).toEqual([{ path: "assets/logo.png", reason: "binary" }]);
    expect(result.diff).toBe("");
  });

  test("hunk 体里以 `--- ` / `+++ ` 开头的增删行不误判为新文件头", () => {
    const input = block("src/A.java", [
      "@@ -1,3 +1,3 @@",
      "--- old comment",
      "+++ new comment",
      " context",
    ]);
    const result = filterDiffForReview(input);
    expect(result.dropped).toEqual([]);
    expect(result.diff).toBe(input);
  });

  test("无命中：返回原串（调用方可用 === 判零介入）", () => {
    const result = filterDiffForReview(SOURCE);
    expect(result.diff).toBe(SOURCE);
    expect(result.dropped).toEqual([]);
    expect(result.droppedChars).toBe(0);
  });

  test("没有 diff --git 头时退回 `--- `/`+++ `/`@@ ` 文件头对", () => {
    const plain = ["--- a/yarn.lock", "+++ b/yarn.lock", "@@ -1 +1 @@", "-a", "+b"].join("\n");
    const result = filterDiffForReview(plain);
    expect(result.dropped).toEqual([{ path: "yarn.lock", reason: "lockfile" }]);
    expect(result.diff).toBe("");
  });
});

describe("assertDiffWithinCharLimit：入口体积门", () => {
  test("界内放行、超限抛人话错误、null 关门", () => {
    expect(() => assertDiffWithinCharLimit("x".repeat(10), 10)).not.toThrow();
    expect(() => assertDiffWithinCharLimit("x".repeat(11), 10)).toThrow(/MR diff 过大/);
    expect(() => assertDiffWithinCharLimit("x".repeat(11), 10)).toThrow(/maxDiffChars/);
    expect(() => assertDiffWithinCharLimit("x".repeat(1_000), null)).not.toThrow();
  });
});

describe("toMrFilterRecord / formatMrFilterNotice", () => {
  test("无剔除 => undefined（审计缺席省键）", () => {
    expect(toMrFilterRecord(filterDiffForReview(SOURCE))).toBeUndefined();
  });

  test("计数、固定原因键序、paths 截断 20 条", () => {
    const input = Array.from({ length: 25 }, (_, index) => block(`pkg-${String(index)}/yarn.lock`)).join("\n");
    const record = toMrFilterRecord(filterDiffForReview(input));
    expect(record).toBeDefined();
    expect(record?.droppedFiles).toBe(25);
    expect(record?.paths).toHaveLength(20);
    expect(record?.reasons).toEqual({ lockfile: 25, generated: 0, minified: 0, binary: 0, test: 0 });
    expect(formatMrFilterNotice(record!)).toContain("lockfile=25");
  });
});

describe("测试文件跳过（limits.testFiles.skip）", () => {
  const TEST_FILE = block("src/test/java/com/example/FooTest.java");
  const SPEC_FILE = block("web/src/button.spec.tsx");
  const PROD_FILE = block("src/main/java/com/example/Foo.java");

  test("缺省 skip=true：测试文件整块剔除，生产文件逐字节保留", () => {
    const input = [PROD_FILE, TEST_FILE, SPEC_FILE].join("\n");
    const result = filterDiffForReview(input);
    expect(result.diff).toBe(PROD_FILE);
    expect(result.dropped).toEqual([
      { path: "src/test/java/com/example/FooTest.java", reason: "test" },
      { path: "web/src/button.spec.tsx", reason: "test" },
    ]);
  });

  test("skip=false：测试文件原样保留（零介入）", () => {
    const input = [PROD_FILE, TEST_FILE, SPEC_FILE].join("\n");
    const result = filterDiffForReview(input, { skipTestFiles: false });
    expect(result.diff).toBe(input);
    expect(result.dropped).toEqual([]);
    expect(result.droppedChars).toBe(0);
  });

  test("非测试目录（testdata / test-fixtures）不被误剔除", () => {
    const fixture = block("src/testdata/sample.json");
    const helpers = block("src/test-fixtures/helper.ts");
    const result = filterDiffForReview([fixture, helpers].join("\n"));
    expect(result.dropped).toEqual([]);
    expect(result.diff).toBe([fixture, helpers].join("\n"));
  });

  test("审计 reasons 固定含 test 键", () => {
    const record = toMrFilterRecord(filterDiffForReview([PROD_FILE, TEST_FILE].join("\n")));
    expect(record?.reasons).toEqual({ lockfile: 0, generated: 0, minified: 0, binary: 0, test: 1 });
    expect(formatMrFilterNotice(record!)).toContain("test=1");
  });
});

describe("listChangedFilePaths：过滤前的变更文件全集（ADR-0068）", () => {
  test("含被预过滤剔除的文件，按 diff 顺序去重", () => {
    const input = [
      block("src/main/java/Foo.java"),
      block("src/test/java/FooTest.java"),
      block("pnpm-lock.yaml"),
      block("src/main/java/Foo.java"),
      block("assets/logo.png"),
    ].join("\n");
    expect(listChangedFilePaths(input)).toEqual([
      "src/main/java/Foo.java",
      "src/test/java/FooTest.java",
      "pnpm-lock.yaml",
      "assets/logo.png",
    ]);
    // 过滤后只剩生产文件，但变更全集仍是 4 个
    expect(filterDiffForReview(input).dropped.map((entry) => entry.path)).toEqual([
      "src/test/java/FooTest.java",
      "pnpm-lock.yaml",
    ]);
  });

  test("删除文件退回旧侧路径；无法识别的块不进结果", () => {
    const deleted = [
      "diff --git a/old/Removed.java b/old/Removed.java",
      "deleted file mode 100644",
      "--- a/old/Removed.java",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-class Removed {}",
    ].join("\n");
    expect(listChangedFilePaths(deleted)).toEqual(["old/Removed.java"]);
    expect(listChangedFilePaths("")).toEqual([]);
    expect(listChangedFilePaths("not a diff")).toEqual([]);
  });

  test("二进制块按块头取路径", () => {
    const binary = [
      "diff --git a/assets/logo.png b/assets/logo.png",
      "new file mode 100644",
      "index 0000000..1111111",
      "Binary files /dev/null and b/assets/logo.png differ",
    ].join("\n");
    expect(listChangedFilePaths(binary)).toEqual(["assets/logo.png"]);
  });
});
