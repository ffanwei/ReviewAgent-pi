import { describe, expect, test } from "vitest";
import {
  CODE_LANGUAGES,
  SUPPORTED_LANGUAGE_IDS,
  languageForFile,
  languageGlobs,
  languageLabel,
  noSourceFilesMessage,
  resolveLanguages,
} from "./language-support.js";

// 语言注册表（ADR-0040）：未实现的条目在配置装载期就告警丢弃，运行时只看到真语言。

describe("语言注册表", () => {
  test("当前版本只登记 Java（后续语言在这里逐条追加）", () => {
    expect(CODE_LANGUAGES.map((language) => language.id)).toEqual(["java"]);
    expect(SUPPORTED_LANGUAGE_IDS).toEqual(["java"]);
    expect(CODE_LANGUAGES[0]?.displayName).toBe("Java");
    expect(CODE_LANGUAGES[0]?.globs).toEqual(["*.java"]);
  });

  test("resolveLanguages：auto = 全部已实现；数组 = 只保留已实现项；未知语言被忽略", () => {
    expect(resolveLanguages("auto").map((language) => language.id)).toEqual(["java"]);
    expect(resolveLanguages(["java"]).map((language) => language.id)).toEqual(["java"]);
    expect(resolveLanguages(["kotlin", "java"])).toEqual(
      resolveLanguages(["java"]),
    );
    expect(resolveLanguages(["kotlin"])).toEqual([]);
    expect(resolveLanguages([])).toEqual([]);
  });

  test("languageGlobs 去重保序；languageLabel 用逗号连接", () => {
    const java = resolveLanguages("auto");
    expect(languageGlobs(java)).toEqual(["*.java"]);
    expect(languageGlobs([])).toEqual([]);
    expect(languageLabel(java)).toBe("Java");
    expect(languageLabel([])).toBe("");
  });

  test("languageForFile：按扩展名归属；未登记语言返回 undefined", () => {
    const java = resolveLanguages("auto");
    expect(languageForFile("src/main/java/A.java", java)?.id).toBe("java");
    expect(languageForFile("A.java", java)?.id).toBe("java");
    expect(languageForFile("src/A.kt", java)).toBeUndefined();
    expect(languageForFile("src/ajava", java)).toBeUndefined();
  });

  test("noSourceFilesMessage：区分「仓库没有该语言源码」与「配置显式关闭」", () => {
    expect(noSourceFilesMessage(resolveLanguages("auto"))).toBe(
      "no supported source files detected in this repository (code intelligence languages: Java)",
    );
    expect(noSourceFilesMessage([])).toBe(
      "no supported source files detected in this repository (code intelligence is disabled by codeintel.languages)",
    );
  });

  test("createParser：懒加载 Java 解析器可用", async () => {
    const parser = await CODE_LANGUAGES[0]!.createParser();
    expect(parser).toBeDefined();
  });
});
