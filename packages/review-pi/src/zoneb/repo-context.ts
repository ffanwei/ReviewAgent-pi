import { open, readdir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type { Parser } from "web-tree-sitter";
import {
  languageForFile,
  languageGlobs,
  languageLabel,
  resolveLanguages,
  type CodeLanguage,
  type LanguageSelection,
} from "../codeintel/language-support.js";
import { readUtf8Tolerant, repoRootName, toPosixPath } from "../codeintel/fs-utils.js";
import { rgListFiles } from "../codeintel/rg.js";
import type { FileSymbolIndex } from "./symbols.js";
import { extractFileSymbols } from "./symbols.js";

/**
 * 仓库快照上下文（测量常量面）：Zone B 构造的确定性读取层。
 *
 * - 文件清单来自 ripgrep（排序去重，仓库相对 POSIX 路径）；
 * - 包名用文件头部的词法提取（package 声明必须位于类型声明之前，读头部 8KB 足够；
 *   超长 license 头导致提取不到时归入默认包——确定性兜底，已在代码注释留痕）；
 * - 源码读取与符号解析按需 memoize（同一文件只读/解析一次）。
 */

const PACKAGE_HEAD_BYTES = 8192;
const PACKAGE_PATTERN = /^[ \t]*package[ \t]+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)[ \t]*;/m;

/** 加载参数（ADR-0025：微限与 ripgrep 超时显式穿参；缺省 = 今天的值） */
export interface LoadRepoContextOptions {
  /** 文件头读多长（`limits.micro.packageHeadBytes`） */
  readonly packageHeadBytes?: number;
  /** ripgrep 单次调用超时（`limits.timeouts.ripgrepMs`） */
  readonly ripgrepTimeoutMs?: number;
  /** 代码智能启用哪些语言（`codeintel.languages`，ADR-0040）；缺省 "auto" = 今天的 Java */
  readonly languages?: LanguageSelection;
}

export interface RepoContext {
  /** 绝对仓库根 */
  readonly repoPath: string;
  readonly repoName: string;
  /** 启用的代码智能语言（空 = 显式关闭，符号级工具扫 0 个文件） */
  readonly languages: readonly CodeLanguage[];
  /** 全部启用语言的 ripgrep 模式（`-g` 传参用） */
  readonly languageGlobs: readonly string[];
  /** 启用语言的人读名字（"Java"）；空串 = 未启用任何语言 */
  readonly languageLabel: string;
  /** 全部已启用语言的源文件（排序、仓库相对 POSIX 路径） */
  readonly sourceFiles: readonly string[];
  /** 词法包名（默认包为 ""） */
  readonly packageNameByFile: ReadonlyMap<string, string>;
  /** 仓库根下的普通文件名（构建文件探测用） */
  readonly rootFileNames: readonly string[];
  hasFile(file: string): boolean;
  readSource(file: string): Promise<string>;
  symbolIndex(file: string): Promise<FileSymbolIndex>;
}

export async function loadRepoContext(
  repoPath: string,
  options: LoadRepoContextOptions = {},
): Promise<RepoContext> {
  const packageHeadBytes = options.packageHeadBytes ?? PACKAGE_HEAD_BYTES;
  const languages = resolveLanguages(options.languages ?? "auto");
  const globs = languageGlobs(languages);
  const label = languageLabel(languages);
  const resolvedRoot = path.resolve(repoPath);
  const sourceFiles = await rgListFiles(resolvedRoot, globs, options.ripgrepTimeoutMs).catch(
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `failed to list ${label === "" ? "supported" : label} source files under repository path "${resolvedRoot}" (is it an existing directory?): ${message}`,
        { cause: error },
      );
    },
  );
  const packageNameByFile = new Map<string, string>();
  for (const file of sourceFiles) {
    packageNameByFile.set(file, await extractPackageLexically(resolvedRoot, file, packageHeadBytes));
  }
  const rootFileNames = await listRootFileNames(resolvedRoot);
  const sourceCache = new Map<string, string>();
  const indexCache = new Map<string, FileSymbolIndex>();
  // 解析器按语言懒加载：未启用的语言、未调用符号工具的运行都不碰 wasm
  const parserCache = new Map<string, Promise<Parser>>();
  const parserFor = (file: string): Promise<Parser> => {
    const language = languageForFile(file, languages);
    if (language === undefined) {
      throw new Error(`no code-intelligence parser registered for source file "${file}"`);
    }
    let parserPromise = parserCache.get(language.id);
    if (parserPromise === undefined) {
      parserPromise = language.createParser();
      parserCache.set(language.id, parserPromise);
    }
    return parserPromise;
  };
  return {
    repoPath: resolvedRoot,
    repoName: repoRootName(resolvedRoot),
    languages,
    languageGlobs: globs,
    languageLabel: label,
    sourceFiles,
    packageNameByFile,
    rootFileNames,
    hasFile: (file: string) => sourceFiles.includes(file),
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
      const index = extractFileSymbols(parser, file, source);
      indexCache.set(file, index);
      return index;
    },
  };
}

/** 文件头部词法包名（无 package 声明 → 默认包 ""） */
async function extractPackageLexically(
  repoPath: string,
  file: string,
  headBytes: number,
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
    return PACKAGE_PATTERN.exec(head)?.[1] ?? "";
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
