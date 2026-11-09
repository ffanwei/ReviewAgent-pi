/**
 * 测试文件识别（`limits.testFiles.skip` 的判定源）：确定性、纯字符串、零 IO。
 *
 * 纪律：
 * - 只认**目录段 + 文件名**两类约定，不做内容嗅探；
 * - 目录段必须整段命中（`testdata` / `test-fixtures` 不算测试目录）；
 * - 大小写不敏感（Java / C# 的 `*Tests.java` 与 TS 的 `*.test.ts` 同口径）；
 * - 跳过检视时按文件块整块剔除（`run/mr-input.ts`），本模块只回答「是不是测试文件」。
 */

/** 目录段即测试目录（整段匹配，大小写不敏感） */
const TEST_DIR_SEGMENTS: ReadonlySet<string> = new Set([
  "test",
  "tests",
  "__tests__",
  "spec",
  "specs",
]);

/** 文件名约定（只看 basename） */
const TEST_BASENAME_PATTERNS: readonly RegExp[] = [
  // Java / Kotlin / Scala / C# / Groovy：FooTest.java、FooTests.kt、FooTest.cs
  // 大小写敏感：`Contest.java` / `Latest.java` 不是测试文件。
  /[^/]*Tests?\.(?:java|kt|kts|scala|cs|groovy)$/,
  // JS / TS 生态：foo.test.ts、foo.spec.tsx、foo.test.mjs
  /[^/]*\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/i,
  // Python：test_foo.py、foo_test.py
  /test_.*\.py$/,
  /.*_test\.py$/,
  // Go：foo_test.go
  /.*_test\.go$/,
  // Ruby：foo_spec.rb、foo_test.rb
  /.*_(?:spec|test)\.rb$/,
];

/**
 * 是否测试文件（repo 相对 POSIX 路径；反斜杠与首尾空白先归一）。
 *
 * 判定顺序：目录段优先，再看文件名。空串 / 目录路径 → false。
 */
export function isTestFilePath(file: string): boolean {
  const normalized = file.replace(/\\/g, "/").trim();
  if (normalized === "") {
    return false;
  }
  const segments = normalized.split("/").filter((segment) => segment !== "");
  if (segments.length === 0) {
    return false;
  }
  const basename = segments.at(-1) ?? "";
  const directories = segments.slice(0, -1).map((segment) => segment.toLowerCase());
  if (directories.some((segment) => TEST_DIR_SEGMENTS.has(segment))) {
    return true;
  }
  return TEST_BASENAME_PATTERNS.some((pattern) => pattern.test(basename));
}
