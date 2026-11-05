import { describe, expect, test } from "vitest";
import {
  CODE_LANGUAGES,
  SUPPORTED_LANGUAGE_IDS,
  detectLanguages,
  languageGlobs,
  languageLabel,
  noSourceFilesMessage,
  resolveFileLanguage,
  resolveLanguages,
} from "./language-support.js";

// 语言注册表（ADR-0040 / ADR-0041）：未实现的条目在配置装载期就告警丢弃，
// 运行时只看到真语言；一门语言可以有多个语法变体（.ts/.tsx）。

describe("语言注册表", () => {
  test("当前版本登记 Java / TypeScript-JavaScript / Python", () => {
    expect(CODE_LANGUAGES.map((language) => language.id)).toEqual([
      "java",
      "typescript",
      "python",
    ]);
    expect(SUPPORTED_LANGUAGE_IDS).toEqual(["java", "typescript", "python"]);
    expect(CODE_LANGUAGES[0]?.displayName).toBe("Java");
    expect(languageGlobs([CODE_LANGUAGES[0]!])).toEqual(["*.java"]);
  });

  test("resolveLanguages：auto = 全部已实现；数组 = 只保留已实现项；未知语言被忽略", () => {
    expect(resolveLanguages("auto").map((language) => language.id)).toEqual([
      "java",
      "typescript",
      "python",
    ]);
    expect(resolveLanguages(["java"]).map((language) => language.id)).toEqual(["java"]);
    expect(resolveLanguages(["kotlin", "java"])).toEqual(resolveLanguages(["java"]));
    expect(resolveLanguages(["kotlin"])).toEqual([]);
    expect(resolveLanguages([])).toEqual([]);
  });

  test("languageGlobs 去重保序；languageLabel 用逗号连接", () => {
    const all = resolveLanguages("auto");
    expect(languageGlobs(all)).toEqual([
      "*.java",
      "*.ts",
      "*.mts",
      "*.cts",
      "*.js",
      "*.mjs",
      "*.cjs",
      "*.tsx",
      "*.jsx",
      "*.py",
    ]);
    expect(languageGlobs([])).toEqual([]);
    expect(languageLabel(all)).toBe("Java, TypeScript/JavaScript, Python");
    expect(languageLabel([])).toBe("");
  });

  test("resolveFileLanguage：按扩展名归属语言与语法变体；未登记语言返回 undefined", () => {
    const all = resolveLanguages("auto");
    expect(resolveFileLanguage("src/main/java/A.java", all)?.variant.id).toBe("java");
    expect(resolveFileLanguage("web/src/a.ts", all)?.language.id).toBe("typescript");
    expect(resolveFileLanguage("web/src/a.tsx", all)?.variant.id).toBe("tsx");
    expect(resolveFileLanguage("web/src/a.jsx", all)?.variant.id).toBe("tsx");
    expect(resolveFileLanguage("web/src/a.js", all)?.variant.id).toBe("ts");
    expect(resolveFileLanguage("pkg/mod.py", all)?.language.id).toBe("python");
    expect(resolveFileLanguage("src/A.kt", all)).toBeUndefined();
    expect(resolveFileLanguage("src/ajava", all)).toBeUndefined();
  });

  test("detectLanguages：只列仓库里真实存在的语言（auto 不虚报）", () => {
    const all = resolveLanguages("auto");
    expect(detectLanguages(["src/main/java/A.java"], all).map((l) => l.id)).toEqual(["java"]);
    expect(
      detectLanguages(["a.ts", "b.py", "c.java"], all).map((language) => language.id),
    ).toEqual(["java", "typescript", "python"]);
    expect(detectLanguages([], all)).toEqual([]);
  });

  test("noSourceFilesMessage：区分「仓库没有该语言源码」与「配置显式关闭」", () => {
    expect(noSourceFilesMessage(resolveLanguages(["java"]))).toBe(
      "no supported source files detected in this repository (code intelligence languages: Java)",
    );
    expect(noSourceFilesMessage([])).toBe(
      "no supported source files detected in this repository (code intelligence is disabled by codeintel.languages)",
    );
  });

  test("createParser：懒加载三种语言的解析器均可用", async () => {
    for (const language of CODE_LANGUAGES) {
      for (const variant of language.variants) {
        const parser = await variant.createParser();
        expect(parser).toBeDefined();
      }
    }
  });
});
