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
  type OutsideIndexMatches,
} from "./language-support.js";
import { readUtf8Tolerant } from "../codeintel/fs-utils.js";
import { rgListFiles, rgSearchWord } from "../codeintel/rg.js";
import { DEFAULT_EXCLUDE_GLOBS } from "../shared/scan-defaults.js";
import type { FileSymbolIndex } from "./symbols.js";

/**
 * 零结果提示的全仓扫描上限。
 *
 * 这是 best-effort 附加信息：不能因为提示扫描把一次符号查询拖到工具超时。
 * 超时后调用方 catch 为空提示，原零结果照常返回。
 */
const OUTSIDE_INDEX_SCAN_TIMEOUT_MS = 8_000;

/**
 * 仓库快照上下文（测量常量面）：Zone B 构造的确定性读取层。
 *
 * - 文件清单来自 ripgrep（排序去重，仓库相对 POSIX 路径）；
 * - 源码读取与符号解析按需 memoize（同一文件只读/解析一次）；
 * - 解析器按「语言变体」懒加载：未启用的语言、未调用符号工具的运行都不碰 wasm。
 */

/** 加载参数（ADR-0025：微限与 ripgrep 超时显式穿参；缺省 = 今天的值） */
export interface LoadRepoContextOptions {
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
  /**
   * 名字在“符号索引覆盖不到的文件”中的文本命中（零结果提示用）。
   *
   * 与 `candidateFilesForName` 相反：这里扫描全仓（仍应用 `excludeGlobs`），
   * 再过滤掉已启用语言的文件。只在符号工具零结果时按需调用，不参与符号解析。
   */
  nameMatchesOutsideLanguages(name: string, timeoutMs?: number): Promise<OutsideIndexMatches>;
}

export async function loadRepoContext(
  repoPath: string,
  options: LoadRepoContextOptions = {},
): Promise<RepoContext> {
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
  const sourceCache = new Map<string, string>();
  const indexCache = new Map<string, FileSymbolIndex>();
  const outsideNameCache = new Map<string, Promise<OutsideIndexMatches>>();
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
    languages,
    detectedLanguages: detected,
    languageGlobs: globs,
    excludeGlobs,
    languageLabel: languageLabel(detected),
    sourceFiles,
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
    nameMatchesOutsideLanguages: (name: string, timeoutMs?: number) => {
      const cached = outsideNameCache.get(name);
      if (cached !== undefined) {
        return cached;
      }
      const pending = rgSearchWord(resolvedRoot, name, {
        allFiles: true,
        excludeGlobs,
        timeoutMs: Math.min(timeoutMs ?? OUTSIDE_INDEX_SCAN_TIMEOUT_MS, OUTSIDE_INDEX_SCAN_TIMEOUT_MS),
      }).then((matches) => {
        const files = [...new Set(matches.map((match) => match.file))]
          .filter((file) => resolveFileLanguage(file, languages) === undefined)
          .sort(compareText);
        const extensions = [
          ...new Set(
            files
              .map((file) => path.posix.extname(file).toLowerCase())
              .filter((extension) => extension.length > 0),
          ),
        ].sort(compareText);
        return { files, extensions };
      });
      // 只缓存成功结果：超时/失败不留下永久失败缓存（下一次调用仍可重试）。
      pending.catch(() => outsideNameCache.delete(name));
      outsideNameCache.set(name, pending);
      return pending;
    },
  };
}

function absoluteFile(repoPath: string, file: string): string {
  return path.join(repoPath, ...file.split("/"));
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
