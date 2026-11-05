import type { Parser } from "web-tree-sitter";
import type { CodeSymbol, SymbolExtractor } from "../zoneb/symbols.js";
import {
  extractJavaFile as javaExtract,
  extractJavaPackageFromHead as javaPackageFromHead,
} from "../zoneb/extractors/java.js";
import {
  extractPythonFile as pythonExtract,
  renderPythonSignature as pythonRenderSignature,
} from "../zoneb/extractors/python.js";
import {
  extractGoFile as goExtract,
  extractGoPackageFromHead as goPackageFromHead,
  renderGoSignature as goRenderSignature,
} from "../zoneb/extractors/go.js";
import {
  extractCppFile as cppExtract,
  renderCppSignature as cppRenderSignature,
} from "../zoneb/extractors/cpp.js";
import {
  extractTypeScriptFile as typescriptExtract,
  renderTypeScriptSignature as typescriptRenderSignature,
} from "../zoneb/extractors/typescript.js";
import { formatSymbolSignature as javaRenderSignature } from "../zoneb/symbols.js";

/**
 * 代码智能语言注册表（ADR-0040 建立、ADR-0041 扩展为「语言能力对象」）。
 *
 * 只登记**当前版本真正实现了符号解析器**的语言。配置里写了未实现的条目会在
 * 装载期告警并跳过——宁可响一声，也不让工具静默返回空结果。
 *
 * 本模块只有元数据与纯函数 extractor/renderer：`createParser` 走动态 import，
 * 未启用的语言永不触碰 wasm；`shared/config.ts` 因此可以安全地只引用语言 id
 * 做装载期校验。
 */

export type CodeLanguageId = "java" | "typescript" | "python" | "go" | "cpp";

/** 一个语言可以有多个语法变体（.ts/.tsx；C/C++ 的 .c/.h 共用 cpp 变体） */
export interface ParserVariant {
  /** 变体 id（parser cache key 的一部分；同一语言内唯一） */
  readonly id: string;
  /** ripgrep `-g` 模式 */
  readonly globs: readonly string[];
  /** 懒加载该变体的 tree-sitter 解析器（进程级 memoization 由实现方负责） */
  createParser(): Promise<Parser>;
}

export interface CodeLanguage {
  readonly id: CodeLanguageId;
  /** 面向人读的名字（工具输出里的 "across N <label> file(s)"） */
  readonly displayName: string;
  /** 语法变体（顺序 = glob 展示顺序） */
  readonly variants: readonly ParserVariant[];
  /** 工具输出里的模块名前缀（"package" / "module"；"" = 不展示模块名） */
  readonly moduleLabel: string;
  /** 整行注释前缀（引用点过滤；Python 的 "#" 与 Java 系的 "//" 不同） */
  readonly commentLinePrefixes: readonly string[];
  /** 是否实现调用点提取（false = Call Chain 显式报「不支持」，而不是空结果） */
  readonly supportsInvocations: boolean;
  /** 文件头部词法模块名（仅声明型语言提供；undefined = 不做整仓预读） */
  readonly moduleNameFromHeader?: (head: string) => string;
  /** 符号 / 模块名 / 调用点提取（纯函数，AST 文档顺序） */
  readonly extract: SymbolExtractor;
  /** 签名渲染（各语言自己的形态；见 ADR-0041） */
  readonly renderSignature: (symbol: CodeSymbol) => string;
}

/**
 * 已实现符号层的语言（顺序 = 展示顺序）。
 *
 * 新增语言的最小改动：在 `zoneb/extractors/` 补一个 extractor，然后往这里加一条。
 * 调用方（repo-context / rg / tools）不再出现具体扩展名或 Java 假设。
 */
export const CODE_LANGUAGES: readonly CodeLanguage[] = [
  {
    id: "java",
    displayName: "Java",
    variants: [
      {
        id: "java",
        globs: ["*.java"],
        createParser: async () => {
          const module = await import("./java-parser.js");
          return module.getJavaParser();
        },
      },
    ],
    moduleLabel: "package",
    commentLinePrefixes: ["//", "/*", "*"],
    supportsInvocations: true,
    moduleNameFromHeader: (head) => {
      // 动态 import 会让注册表失去同步性；这里复用 extractor 的词法纯函数
      return javaPackageFromHead(head);
    },
    extract: (parser, file, source) => javaExtract(parser, file, source),
    renderSignature: (symbol) => javaRenderSignature(symbol),
  },
  {
    id: "typescript",
    displayName: "TypeScript/JavaScript",
    variants: [
      {
        id: "ts",
        // .js/.mjs/.cjs 用 typescript 语法解析（TS 是 JS 的超集；JSX 例外，走 tsx 变体）
        globs: ["*.ts", "*.mts", "*.cts", "*.js", "*.mjs", "*.cjs"],
        createParser: async () => {
          const module = await import("./typescript-parser.js");
          return module.getTypeScriptParser();
        },
      },
      {
        id: "tsx",
        globs: ["*.tsx", "*.jsx"],
        createParser: async () => {
          const module = await import("./typescript-parser.js");
          return module.getTsxParser();
        },
      },
    ],
    moduleLabel: "",
    commentLinePrefixes: ["//", "/*", "*"],
    supportsInvocations: true,
    extract: (parser, file, source) => typescriptExtract(parser, file, source),
    renderSignature: (symbol) => typescriptRenderSignature(symbol),
  },
  {
    id: "python",
    displayName: "Python",
    variants: [
      {
        id: "py",
        globs: ["*.py"],
        createParser: async () => {
          const module = await import("./python-parser.js");
          return module.getPythonParser();
        },
      },
    ],
    moduleLabel: "module",
    commentLinePrefixes: ["#"],
    supportsInvocations: true,
    extract: (parser, file, source) => pythonExtract(parser, file, source),
    renderSignature: (symbol) => pythonRenderSignature(symbol),
  },
  {
    id: "go",
    displayName: "Go",
    variants: [
      {
        id: "go",
        globs: ["*.go"],
        createParser: async () => {
          const module = await import("./go-parser.js");
          return module.getGoParser();
        },
      },
    ],
    moduleLabel: "package",
    commentLinePrefixes: ["//", "/*", "*"],
    supportsInvocations: true,
    moduleNameFromHeader: (head) => goPackageFromHead(head),
    extract: (parser, file, source) => goExtract(parser, file, source),
    renderSignature: (symbol) => goRenderSignature(symbol),
  },
  {
    id: "cpp",
    displayName: "C/C++",
    variants: [
      {
        // C 与 C++ 共用 cpp 语法（ADR-0041）：.c/.h 是 C++ 的子集
        id: "cpp",
        globs: ["*.c", "*.h", "*.cc", "*.cpp", "*.cxx", "*.hpp", "*.hh", "*.hxx"],
        createParser: async () => {
          const module = await import("./cpp-parser.js");
          return module.getCppParser();
        },
      },
    ],
    moduleLabel: "",
    commentLinePrefixes: ["//", "/*", "*"],
    supportsInvocations: true,
    extract: (parser, file, source) => cppExtract(parser, file, source),
    renderSignature: (symbol) => cppRenderSignature(symbol),
  },
];

// 静态引用 extractor/renderer：只含纯函数与类型（type-only），不会触碰 wasm。
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
  return [...new Set(languages.flatMap((language) => language.variants.flatMap((v) => v.globs)))];
}

/** 人读语言名（多个用 ", " 连接；空 = "supported" 占位由调用方处理） */
export function languageLabel(languages: readonly CodeLanguage[]): string {
  return languages.map((language) => language.displayName).join(", ");
}

/**
 * 实际出现在仓库里的语言（按仓库文件判定）。
 *
 * `auto` 会启用全部已实现语言，但一个纯 Java 仓不该在工具输出里把未出现的
 * 语言都列一遍——展示面只列真实存在的语言。
 */
export function detectLanguages(
  files: readonly string[],
  languages: readonly CodeLanguage[],
): readonly CodeLanguage[] {
  const present = new Set<CodeLanguage>();
  for (const file of files) {
    const resolved = resolveFileLanguage(file, languages);
    if (resolved !== undefined) {
      present.add(resolved.language);
    }
  }
  return languages.filter((language) => present.has(language));
}

export interface ResolvedFileLanguage {
  readonly language: CodeLanguage;
  readonly variant: ParserVariant;
}

/** 按文件扩展名归属语言与语法变体（给符号索引挑解析器） */
export function resolveFileLanguage(
  file: string,
  languages: readonly CodeLanguage[],
): ResolvedFileLanguage | undefined {
  const name = file.slice(file.lastIndexOf("/") + 1);
  for (const language of languages) {
    for (const variant of language.variants) {
      const matched = variant.globs.some(
        (glob) => glob.startsWith("*.") && name.endsWith(glob.slice(1)),
      );
      if (matched) {
        return { language, variant };
      }
    }
  }
  return undefined;
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
