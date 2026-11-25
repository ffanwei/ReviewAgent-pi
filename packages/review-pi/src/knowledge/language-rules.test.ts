import { describe, expect, test } from "vitest";

import {
  astLanguageOf,
  buildLanguageRulesText,
} from "./language-rules.js";

describe("astLanguageOf：扩展名 → AST 语言", () => {
  test("5 种支持的语言", () => {
    expect(astLanguageOf("src/A.java")).toBe("java");
    expect(astLanguageOf("web/src/a.tsx")).toBe("typescript");
    expect(astLanguageOf("web/src/a.js")).toBe("typescript");
    expect(astLanguageOf("service/a.py")).toBe("python");
    expect(astLanguageOf("service/a.go")).toBe("go");
    expect(astLanguageOf("native/a.cpp")).toBe("cpp");
    expect(astLanguageOf("native/a.h")).toBe("cpp");
  });

  test("大小写、Windows 分隔符与不支持的类型", () => {
    expect(astLanguageOf("src\\A.JAVA")).toBe("java");
    expect(astLanguageOf("README.md")).toBeUndefined();
    expect(astLanguageOf("Makefile")).toBeUndefined();
    expect(astLanguageOf(".gitignore")).toBeUndefined();
  });
});

describe("buildLanguageRulesText：按文件分组", () => {
  test("单语言：带 <rules for> 与 repo 约束", () => {
    const text = buildLanguageRulesText(["src/A.java"], "repo");
    expect(text).toContain("以下是与本组文件语言相关的缺陷检查清单。");
    expect(text).toContain('<rules for="src/A.java">');
    expect(text).toContain("#### 空值与契约");
    expect(text).not.toContain("#### 可变默认值");
  });

  test("混合语言：按语言分块，块内路径排序", () => {
    const text = buildLanguageRulesText(
      ["web/b.ts", "src/B.java", "web/a.ts", "README.md"],
      "mr",
    );
    expect(text).toBeDefined();
    const javaIndex = text?.indexOf('<rules for="src/B.java">') ?? -1;
    const tsIndex = text?.indexOf('<rules for="web/a.ts, web/b.ts">') ?? -1;
    expect(javaIndex).toBeGreaterThan(-1);
    expect(tsIndex).toBeGreaterThan(javaIndex);
    expect(text).toContain("以下是与本次变更文件语言相关的缺陷检查清单。");
    expect(text).toContain("只把清单用于本次新增/修改行");
  });

  test("无支持语言 / 空集合 → undefined", () => {
    expect(buildLanguageRulesText(["README.md"], "repo")).toBeUndefined();
    expect(buildLanguageRulesText([], "repo")).toBeUndefined();
  });

  test("java 与 cpp 共用 h 扩展名时按 cpp 处理", () => {
    const text = buildLanguageRulesText(["native/a.h"], "repo");
    expect(text).toContain('<rules for="native/a.h">');
    expect(text).toContain("#### 资源与所有权");
  });
});
