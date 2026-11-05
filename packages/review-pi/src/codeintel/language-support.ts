import type { Parser } from "web-tree-sitter";

/**
 * 代码智能语言注册表（ADR-0040）：把「哪些语言有符号层」从五处 `*.java`
 * 硬编码收口成一张表。
 *
 * 只登记**当前版本真正实现了符号解析器**的语言。配置里写了未实现的条目会在
 * 装载期告警并跳过——宁可响一声，也不让工具静默返回空结果。
 *
 * 本模块只含元数据：`createParser` 走动态 import，未启用的语言永不触碰 wasm；
 * `shared/config.ts` 因此可以安全地只引用语言 id 做装载期校验。
 */

export type CodeLanguageId = "java";

export interface CodeLanguage {
  readonly id: CodeLanguageId;
  /** 面向人读的名字（工具输出里的 "across N <label> file(s)"） */
  readonly displayName: string;
  /** ripgrep `-g` 模式；同一语言的多个扩展名在这里列出 */
  readonly globs: readonly string[];
  /** 懒加载该语言的 tree-sitter 解析器（进程级 memoization 由实现方负责） */
  createParser(): Promise<Parser>;
}

/**
 * 已实现符号层的语言（顺序 = 展示顺序）。
 *
 * 新增语言的最小改动：在 `symbols.ts` 补 extractor，然后往这里加一行。
 * 调用方（repo-context / rg / tools）不再出现具体扩展名。
 */
export const CODE_LANGUAGES: readonly CodeLanguage[] = [
  {
    id: "java",
    displayName: "Java",
    globs: ["*.java"],
    createParser: async () => {
      const module = await import("./java-parser.js");
      return module.getJavaParser();
    },
  },
];

/** 装载期校验用的已实现语言 id（`codeintel.languages` 的合法条目） */
export const SUPPORTED_LANGUAGE_IDS: readonly string[] = CODE_LANGUAGES.map(
  (language) => language.id,
);

/**
 * 配置取值：`"auto"` = 跟随本版本已实现的解析器（升级后自动扩语言）；
 * 数组 = 只启用列出的语言（空数组 = 显式关闭代码智能）。
 */
export type LanguageSelection = "auto" | readonly string[];

export function resolveLanguages(selection: LanguageSelection): readonly CodeLanguage[] {
  if (selection === "auto") {
    return CODE_LANGUAGES;
  }
  const wanted = new Set(selection);
  return CODE_LANGUAGES.filter((language) => wanted.has(language.id));
}

/** 全部启用语言的 ripgrep 模式（去重；顺序稳定 = 注册表顺序） */
export function languageGlobs(languages: readonly CodeLanguage[]): readonly string[] {
  return [...new Set(languages.flatMap((language) => language.globs))];
}

/** 人读语言名（多个用 ", " 连接；空 = "supported" 占位由调用方处理） */
export function languageLabel(languages: readonly CodeLanguage[]): string {
  return languages.map((language) => language.displayName).join(", ");
}

/**
 * 0 源文件时的统一提示（工具输出是英文，与既有工具文案同一语言域）。
 *
 * 覆盖两种真实场景：非本语言仓库（配置支持 Java 但仓里 0 个 .java）与
 * 用户显式用 `codeintel.languages = []` 关掉代码智能。旧文案
 * "across 0 Java file(s)" 技术上诚实但看起来像故障。
 */
export function noSourceFilesMessage(languages: readonly CodeLanguage[]): string {
  const label = languageLabel(languages);
  return label === ""
    ? "no supported source files detected in this repository (code intelligence is disabled by codeintel.languages)"
    : `no supported source files detected in this repository (code intelligence languages: ${label})`;
}

/** 按文件扩展名归属语言（仅用于给符号索引挑解析器） */
export function languageForFile(
  file: string,
  languages: readonly CodeLanguage[],
): CodeLanguage | undefined {
  const name = file.slice(file.lastIndexOf("/") + 1);
  return languages.find((language) =>
    language.globs.some((glob) => glob.startsWith("*.") && name.endsWith(glob.slice(1))),
  );
}
