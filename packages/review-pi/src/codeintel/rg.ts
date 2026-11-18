import { spawn } from "node:child_process";
import path from "node:path";
import { rgPath } from "@vscode/ripgrep";
import { toRepoRelativePath } from "./fs-utils.js";

/**
 * ripgrep 封装（测量常量面）：词法引用匹配后端。
 *
 * - @vscode/ripgrep@1.18.0：平台二进制随 npm tarball 分发（optional deps），零构建脚本；
 * - 检索结果统一按 (file, line) 排序后返回，消除 rg 并行输出的顺序不确定性；
 * - 路径归一化为仓库相对 POSIX 路径；
 * - 退出码语义：0 = 有匹配，1 = 无匹配（不是错误），2 = 错误；
 * - 符号面（rgSearchWord / rgListFiles）不使用 rg 的 --max-count 等静默截断
 *   开关——截断一律由上层预算层显式留痕；
 * - 文本面（rgSearchText）是唯一例外：每文件上限用于抑制单文件噪声，工具层
 *   必须在结果文本里显式留痕（命中数、被封顶的文件数）。
 */

export interface RgMatch {
  /** 仓库相对 POSIX 路径 */
  readonly file: string;
  /** 1-based 行号 */
  readonly line: number;
  /** 整行文本（保留缩进，去除行尾空白） */
  readonly text: string;
}

export interface RgSearchOptions {
  /** 文件 glob 列表，缺省 ["*.java"]（单语言兜底；调用方通常传 RepoContext 的语言表） */
  readonly globs?: readonly string[];
  /**
   * 不使用语言 glob，扫描仓库内全部文本文件（仍应用 `excludeGlobs`）。
   * 符号工具零结果时用它确认名字是否只出现在未索引语言中；提供时忽略 `globs`。
   */
  readonly allFiles?: boolean;
  /** 排除 glob 列表（ADR-0041）；传 `codeintel.excludeGlobs`，不带前导 "!" */
  readonly excludeGlobs?: readonly string[];
  /** 单次调用超时（毫秒），默认 30000；超时杀进程并抛错（不静默挂起） */
  readonly timeoutMs?: number;
}

export interface RgListOptions {
  readonly timeoutMs?: number;
  readonly excludeGlobs?: readonly string[];
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** 单语言兜底（仅直调形态；生产路径由 `RepoContext.languageGlobs` 提供） */
const DEFAULT_GLOBS: readonly string[] = ["*.java"];

/** 列出 root 下匹配任一 glob 的全部文件（排序去重后的仓库相对 POSIX 路径） */
export function rgListFiles(
  root: string,
  globs: string | readonly string[],
  options: RgListOptions = {},
): Promise<readonly string[]> {
  const patterns = typeof globs === "string" ? [globs] : globs;
  if (patterns.length === 0) {
    // 显式关闭代码智能（或没有任何已实现语言）：0 个文件，别退化成「扫全仓」
    return Promise.resolve([]);
  }
  const args = [
    "--files",
    "--no-config",
    "--no-ignore",
    "--no-messages",
    ...globArgs(patterns, options.excludeGlobs ?? []),
    "--",
    root,
  ];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return runRg(args, timeoutMs).then((stdout) => {
    const files = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => toRepoRelativePath(root, line))
      .filter((file) => file.length > 0);
    return [...new Set(files)].sort(compareText);
  });
}

/**
 * 大小写敏感的全词匹配检索（find_references 语义：名字级精确匹配）。
 * 固定字符串 + 全词边界，不做正则解释。
 */
export function rgSearchWord(
  root: string,
  word: string,
  options: RgSearchOptions = {},
): Promise<readonly RgMatch[]> {
  const globs = options.globs ?? DEFAULT_GLOBS;
  if (options.allFiles !== true && globs.length === 0) {
    return Promise.resolve([]);
  }
  const args = [
    "--json",
    "--no-config",
    "--no-ignore",
    "--no-messages",
    "--case-sensitive",
    "--fixed-strings",
    "--word-regexp",
    ...globArgs(options.allFiles === true ? [] : globs, options.excludeGlobs ?? []),
    "--",
    word,
    root,
  ];
  return runRg(args, options.timeoutMs ?? DEFAULT_TIMEOUT_MS).then((stdout) => {
    const matches: RgMatch[] = [];
    for (const line of stdout.split("\n")) {
      if (line.length === 0) {
        continue;
      }
      const parsed = parseMatchEvent(line);
      if (parsed !== undefined) {
        matches.push(parsed);
      }
    }
    const normalized = matches.map((match) => ({
      ...match,
      file: toRepoRelativePath(root, match.file),
    }));
    normalized.sort(
      (a, b) => compareText(a.file, b.file) || a.line - b.line || compareText(a.text, b.text),
    );
    return normalized;
  });
}

export interface RgTextSearchOptions {
  /** 是否按正则解释 query（缺省字面匹配） */
  readonly regex?: boolean;
  /** 是否区分大小写（缺省不区分） */
  readonly caseSensitive?: boolean;
  /** 文件 glob（`!` 前缀 = 负向）；正负向会自动拆开排序 */
  readonly globs?: readonly string[];
  /** 排除 glob（ADR-0041；不带前导 "!"） */
  readonly excludeGlobs?: readonly string[];
  /** 每文件命中上限（缺省 20）；工具层必须在结果里留痕 */
  readonly maxPerFile?: number;
  /** 单次调用超时（毫秒），缺省 30000 */
  readonly timeoutMs?: number;
}

/** 文本检索每文件缺省上限（与工具层常量对齐） */
const DEFAULT_TEXT_MAX_PER_FILE = 20;
/** 文本检索跳过的单文件大小（rg 后缀语法）：生成物/巨型数据不参与检索 */
const TEXT_SEARCH_MAX_FILESIZE = "2M";

/**
 * 仓库快照文本检索（review.search_code 后端）。
 *
 * 与符号面共用 runRg / parseMatchEvent / 排序比较器；差异是三处：
 * - `-F` 字面 / 默认 Rust regex（不使用 `-P`，不依赖 PCRE2 编译选项）；
 * - 默认不区分大小写（显式 `caseSensitive` 才加 `--case-sensitive`）；
 * - 每文件 `--max-count` 封顶，配合工具层的显式留痕。
 *
 * 输出统一按 (file, line, text) 排序，消除 rg 并行输出的顺序不确定性。
 */
export function rgSearchText(
  root: string,
  query: string,
  options: RgTextSearchOptions = {},
): Promise<readonly RgMatch[]> {
  const positives: string[] = [];
  const negatives: string[] = [];
  for (const glob of options.globs ?? []) {
    if (glob.startsWith("!")) {
      negatives.push(glob);
    } else {
      positives.push(glob);
    }
  }
  const args = [
    "--json",
    "--no-config",
    "--no-ignore",
    "--no-messages",
    "--max-filesize",
    TEXT_SEARCH_MAX_FILESIZE,
    ...(options.caseSensitive === true ? ["--case-sensitive"] : ["--ignore-case"]),
    ...(options.regex === true ? [] : ["--fixed-strings"]),
    "--max-count",
    String(options.maxPerFile ?? DEFAULT_TEXT_MAX_PER_FILE),
    ...globArgs([...positives, ...negatives], options.excludeGlobs ?? []),
    "--",
    query,
    ".",
  ];
  // cwd = root + 路径 "."：让用户 glob 走「仓库根相对」语义（`src/**` 也能命中），
  // 避免把绝对 root 传给 rg 后 -g 只能匹配 `**/` 前缀的形态。
  return runRg(args, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, root).then((stdout) => {
    const matches: RgMatch[] = [];
    for (const line of stdout.split("\n")) {
      if (line.length === 0) {
        continue;
      }
      const parsed = parseMatchEvent(line);
      if (parsed !== undefined) {
        matches.push(parsed);
      }
    }
    const normalized = matches.map((match) => ({
      ...match,
      file: toRepoRelativePath(
        root,
        path.isAbsolute(match.file) ? match.file : path.resolve(root, match.file),
      ),
    }));
    normalized.sort(
      (a, b) => compareText(a.file, b.file) || a.line - b.line || compareText(a.text, b.text),
    );
    return normalized;
  });
}

interface RgMatchEvent {
  readonly type: "match";
  readonly data: {
    readonly path: { readonly text: string };
    readonly line_number: number;
    readonly lines: { readonly text: string };
  };
}

function parseMatchEvent(line: string): RgMatch | undefined {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof event !== "object" || event === null) {
    return undefined;
  }
  const candidate = event as Partial<RgMatchEvent>;
  if (
    candidate.type !== "match" ||
    typeof candidate.data !== "object" ||
    candidate.data === null
  ) {
    return undefined;
  }
  const pathText = candidate.data.path?.text;
  const lineNumber = candidate.data.line_number;
  const lineText = candidate.data.lines?.text;
  if (
    typeof pathText !== "string" ||
    typeof lineNumber !== "number" ||
    typeof lineText !== "string"
  ) {
    return undefined;
  }
  return {
    file: pathText,
    line: lineNumber,
    text: lineText.replace(/\r?\n$/, "").trimEnd(),
  };
}

function runRg(args: readonly string[], timeoutMs: number, cwd?: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(rgPath, args, {
      windowsHide: true,
      ...(cwd !== undefined ? { cwd } : {}),
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(
          new Error(`ripgrep timed out after ${timeoutMs}ms (pattern: ${describePattern(args)})`),
        );
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        // 不回显 rgPath（宿主机内部绝对路径；错误字节需跨环境可复现）
        reject(new Error(`failed to spawn ripgrep binary: ${error.message}`, { cause: error }));
      }
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      // 0 = 有匹配；1 = 无匹配；2 = 错误
      if (code === 2) {
        reject(new Error(`ripgrep failed (exit code 2): ${stderr.trim()}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function globArgs(globs: readonly string[], excludeGlobs: readonly string[]): readonly string[] {
  // 负向 glob 必须排在正向之后：ripgrep 后者优先
  return [...globs, ...excludeGlobs.map((glob) => `!${glob}`)].flatMap((glob) => ["-g", glob]);
}

function describePattern(args: readonly string[]): string {
  const index = args.indexOf("--");
  return index >= 0 && index + 1 < args.length ? args[index + 1] ?? "(none)" : "(none)";
}

function compareText(a: string, b: string): number {
  // JS 字符串比较按 UTF-16 码元，跨平台确定
  return a < b ? -1 : a > b ? 1 : 0;
}
