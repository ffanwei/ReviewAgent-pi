import { open, readdir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type { Parser } from "web-tree-sitter";
import {
  detectLanguages,
  languageGlobs,
  languageLabel,
  resolveFileLanguage,
  resolveLanguages,
  type CodeLanguage,
  type LanguageSelection,
} from "../codeintel/language-support.js";
import { readUtf8Tolerant, repoRootName, toPosixPath } from "../codeintel/fs-utils.js";
import { rgListFiles, rgSearchWord } from "../codeintel/rg.js";
import { DEFAULT_EXCLUDE_GLOBS } from "../codeintel/scan-defaults.js";
import type { FileSymbolIndex } from "./symbols.js";

/**
 * 仓库快照上下文（测量常量面）：Zone B 构造的确定性读取层。
 *
 * - 文件清单来自 ripgrep（排序去重，仓库相对 POSIX 路径）；
 * - 模块名用文件头部的词法提取，且**只对声明型语言**执行（Java 的 package）；
 *   Python 的模块名由路径推导、TS 留空——都不需要为每个文件读头部；
 * - 源码读取与符号解析按需 memoize（同一文件只读/解析一次）；
 * - 解析器按「语言变体」懒加载：未启用的语言、未调用符号工具的运行都不碰 wasm。
 */

const PACKAGE_HEAD_BYTES = 8192;

/** 加载参数（ADR-0025：微限与 ripgrep 超时显式穿参；缺省 = 今天的值） */
export interface LoadRepoContextOptions {
  /** 文件头读多长（`limits.micro.packageHeadBytes`） */
  readonly packageHeadBytes?: number;
  /** ripgrep 单次调用超时（`limits.timeouts.ripgrepMs`） */
  readonly ripgrepTimeoutMs?: number;
  /** 代码智能启用哪些语言（`codeintel.languages`，ADR-0040）；缺省 "auto" = 全部已实现语言 */
  readonly languages?: LanguageSelection;
  /** 扫描排除 glob（`codeintel.excludeGlobs`，ADR-0041）；缺省 = 内置非源码目录 */
  readonly excludeGlobs?: readonly string[];
}

export interface RepoContext {
  /** 绝对仓库根 */
  readonly repoPath: string;
  readonly repoName: string;
  /** 启用的代码智能语言（空 = 显式关闭，符号级工具扫 0 个文件） */
  readonly languages: readonly CodeLanguage[];
  /** 仓库里真实存在源文件的启用语言（展示用；顺序 = 注册表顺序） */
  readonly detectedLanguages: readonly CodeLanguage[];
  /** 全部启用语言的 ripgrep 模式（`-g` 传参用） */
  readonly languageGlobs: readonly string[];
  /** 扫描排除 glob（`-g '!…'` 传参用） */
  readonly excludeGlobs: readonly string[];
  /** 已检测语言的人读名字（"Java"）；空串 = 未启用任何语言 / 仓里没有源文件 */
  readonly languageLabel: string;
  /** 全部已启用语言的源文件（排序、仓库相对 POSIX 路径） */
  readonly sourceFiles: readonly string[];
  /** 词法模块名（仅声明型语言；默认包为 ""） */
  readonly moduleNameByFile: ReadonlyMap<string, string>;
  /** 仓库根下的普通文件名（构建文件探测用） */
  readonly rootFileNames: readonly string[];
  hasFile(file: string): boolean;
  /** 文件归属的语言（不在启用范围内 → undefined） */
  languageFor(file: string): CodeLanguage | undefined;
  readSource(file: string): Promise<string>;
  symbolIndex(file: string): Promise<FileSymbolIndex>;
  /**
   * 文本上包含该名字的候选文件（rg 全词匹配 → 去重排序）。
   * 符号查找/调用链先用它收窄解析面，避免多语言下把整仓都解析一遍。
   */
  candidateFilesForName(name: string, timeoutMs?: number): Promise<readonly string[]>;
}

export async function loadRepoContext(
  repoPath: string,
  options: LoadRepoContextOptions = {},
): Promise<RepoContext> {
  const packageHeadBytes = options.packageHeadBytes ?? PACKAGE_HEAD_BYTES;
  const languages = resolveLanguages(options.languages ?? "auto");
  const excludeGlobs = options.excludeGlobs ?? DEFAULT_EXCLUDE_GLOBS;
  const globs = languageGlobs(languages);
  const resolvedRoot = path.resolve(repoPath);
  const sourceFiles = await rgListFiles(resolvedRoot, globs, {
    ...(options.ripgrepTimeoutMs !== undefined ? { timeoutMs: options.ripgrepTimeoutMs } : {}),
    excludeGlobs,
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const label = languageLabel(languages);
    throw new Error(
      `failed to list ${label === "" ? "supported" : label} source files under repository path "${resolvedRoot}" (is it an existing directory?): ${message}`,
      { cause: error },
    );
  });
  const detected = detectLanguages(sourceFiles, languages);
  const moduleNameByFile = new Map<string, string>();
  for (const file of sourceFiles) {
    const language = resolveFileLanguage(file, languages)?.language;
    if (language?.moduleNameFromHeader === undefined) {
      continue;
    }
    moduleNameByFile.set(
      file,
      await extractModuleLexically(resolvedRoot, file, packageHeadBytes, language.moduleNameFromHeader),
    );
  }
  const rootFileNames = await listRootFileNames(resolvedRoot);
  const sourceCache = new Map<string, string>();
  const indexCache = new Map<string, FileSymbolIndex>();
  const parserCache = new Map<string, Promise<Parser>>();
  const parserFor = (file: string): Promise<Parser> => {
    const resolved = resolveFileLanguage(file, languages);
    if (resolved === undefined) {
      throw new Error(`no code-intelligence parser registered for source file "${file}"`);
    }
    const key = `${resolved.language.id}:${resolved.variant.id}`;
    let parserPromise = parserCache.get(key);
    if (parserPromise === undefined) {
      parserPromise = resolved.variant.createParser();
      parserCache.set(key, parserPromise);
    }
    return parserPromise;
  };
  return {
    repoPath: resolvedRoot,
    repoName: repoRootName(resolvedRoot),
    languages,
    detectedLanguages: detected,
    languageGlobs: globs,
    excludeGlobs,
    languageLabel: languageLabel(detected),
    sourceFiles,
    moduleNameByFile,
    rootFileNames,
    hasFile: (file: string) => sourceFiles.includes(file),
    languageFor: (file: string) => resolveFileLanguage(file, languages)?.language,
    readSource: async (file: string) => {
      const cached = sourceCache.get(file);
      if (cached !== undefined) {
        return cached;
      }
      const source = await readUtf8Tolerant(absoluteFile(resolvedRoot, file));
      sourceCache.set(file, source);
      return source;
    },
    symbolIndex: async (file: string) => {
      const cached = indexCache.get(file);
      if (cached !== undefined) {
        return cached;
      }
      const source = await readUtf8Tolerant(absoluteFile(resolvedRoot, file));
      const parser = await parserFor(file);
      const language = resolveFileLanguage(file, languages)?.language;
      if (language === undefined) {
        throw new Error(`no code-intelligence language registered for source file "${file}"`);
      }
      const index = language.extract(parser, file, source);
      indexCache.set(file, index);
      return index;
    },
    candidateFilesForName: async (name: string, timeoutMs?: number) => {
      const matches = await rgSearchWord(resolvedRoot, name, {
        globs,
        excludeGlobs,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
      return [...new Set(matches.map((match) => match.file))].sort(compareText);
    },
  };
}

/** 文件头部词法模块名（无声明 → ""） */
async function extractModuleLexically(
  repoPath: string,
  file: string,
  headBytes: number,
  extractFromHead: (head: string) => string,
): Promise<string> {
  const absPath = absoluteFile(repoPath, file);
  let handle: FileHandle;
  try {
    handle = await open(absPath, "r");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to read file "${absPath}": ${message}`, { cause: error });
  }
  try {
    const buffer = Buffer.alloc(headBytes);
    const { bytesRead } = await handle.read(buffer, 0, headBytes, 0);
    const head = buffer.subarray(0, bytesRead).toString("utf8");
    return extractFromHead(head);
  } finally {
    await handle.close();
  }
}

/** 变更文件不在快照中时的路径推导包名（src/main/java 前缀剥离，否则取目录部分） */
export function derivePackageFromPath(posixFile: string): string {
  const knownRoots = ["src/main/java", "src/test/java"];
  for (const root of knownRoots) {
    if (posixFile.startsWith(`${root}/`)) {
      return packageFromDirs(posixFile.slice(root.length + 1).split("/").slice(0, -1));
    }
  }
  const segments = toPosixPath(posixFile).split("/");
  const javaIndex = segments.lastIndexOf("java");
  const dirs = javaIndex >= 0 ? segments.slice(javaIndex + 1, -1) : segments.slice(0, -1);
  return packageFromDirs(dirs);
}

function packageFromDirs(dirs: readonly string[]): string {
  return dirs.filter((segment) => segment.length > 0).join(".");
}

function absoluteFile(repoPath: string, file: string): string {
  return path.join(repoPath, ...file.split("/"));
}

async function listRootFileNames(repoPath: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(repoPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to read repository root "${repoPath}": ${message}`, { cause: error });
  }
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
