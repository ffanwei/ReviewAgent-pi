import { describe, expect, test } from "vitest";
import { isTestFilePath } from "./test-file.js";

describe("isTestFilePath：确定性测试文件识别", () => {
  test.each([
    "src/test/java/com/example/Foo.java",
    "test/unit/helper.ts",
    "tests/integration/flow.py",
    "web/__tests__/button.tsx",
    "spec/models/user_spec.rb",
    "src/main/java/com/example/FooTest.java",
    "src/main/java/com/example/FooTests.java",
    "src/main/kotlin/com/example/FooTest.kt",
    "web/src/button.test.ts",
    "web/src/button.test.tsx",
    "web/src/button.spec.js",
    "web/src/button.test.mjs",
    "scripts/test_release.py",
    "scripts/release_test.py",
    "internal/store/store_test.go",
  ])("识别测试文件：%s", (file) => {
    expect(isTestFilePath(file)).toBe(true);
  });

  test.each([
    "src/main/java/com/example/Foo.java",
    "src/main/java/com/example/Contest.java",
    "src/testdata/sample.json",
    "src/test-fixtures/helper.ts",
    "src/latest/notes.md",
    "scripts/attest.py",
    "web/src/button.ts",
    "internal/store/store.go",
    "",
    "   ",
  ])("不误判：%s", (file) => {
    expect(isTestFilePath(file)).toBe(false);
  });

  test("反斜杠与首尾空白归一", () => {
    expect(isTestFilePath("  src\\test\\java\\Foo.java  ")).toBe(true);
    expect(isTestFilePath("src\\main\\java\\Foo.java")).toBe(false);
  });
});
