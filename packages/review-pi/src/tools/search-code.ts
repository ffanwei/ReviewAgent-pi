import { rgSearchText, type RgMatch } from "../codeintel/rg.js";
import {
  boundedEcho,
  optionalBooleanArg,
  optionalPositiveIntArg,
  optionalStringArrayArg,
  requireStringArg,
  validateSearchGlobs,
} from "./args.js";
import { readThroughLedger } from "./ledger.js";
import { applyLineBudget } from "./result-budget.js";
import type { ReviewToolHandler } from "./toolkit-types.js";

/**
 * review.search_code（ADR-0099）：仓库快照文本检索。
 *
 * - 后端 `rgSearchText`（@vscode/ripgrep）：默认字面、不区分大小写；`regex`
 *   走 ripgrep 默认 Rust regex 引擎（不使用 `-P`，不依赖 PCRE2 编译选项）；
 * - 范围 = 整个快照（排除 `codeintel.excludeGlobs`）；glob 支持 `!` 负向；
 * - 每文件 20 条封顶 + 全局 `limit`（默认 50，上限 200）；两种截断都显式留痕；
 * - 输出确定性：按 (file, line, text) 排序，仓库相对 POSIX 路径；
 * - Context Ledger：登记为 evidence（标识 = 工具名 + 查询 + 标志 + glob）。
 *
 * 边界：检索结果是材料，不是结论；证据仍须落到候选的 evidence 字段。
 */

export const SEARCH_CODE_DEFAULT_LIMIT = 50;
export const SEARCH_CODE_MAX_LIMIT = 200;
export const SEARCH_CODE_MAX_PER_FILE = 20;
export const SEARCH_CODE_LINE_MAX_CHARS = 200;

const TOOL_NAME = "review.search_code";

interface SearchFlags {
  readonly regex: boolean;
  readonly caseSensitive: boolean;
  readonly globs: readonly string[];
}

export const searchCodeTool: ReviewToolHandler = async (args, context): Promise<string> => {
  const query = requireStringArg(TOOL_NAME, args, "query");
  const flags: SearchFlags = {
    regex: optionalBooleanArg(TOOL_NAME, args, "regex") ?? false,
    caseSensitive: optionalBooleanArg(TOOL_NAME, args, "caseSensitive") ?? false,
    globs: validateSearchGlobs(TOOL_NAME, optionalStringArrayArg(TOOL_NAME, args, "glob")),
  };
  const limit = resolveLimit(args);
  const perFile = Math.min(SEARCH_CODE_MAX_PER_FILE, limit);
  return readThroughLedger(
    context.ledger,
    "evidence",
    ledgerDescription(query, flags, context.micro.queryEchoChars),
    async () => {
      const repo = await context.repo();
      let matches: readonly RgMatch[];
      try {
        matches = await rgSearchText(repo.repoPath, query, {
          regex: flags.regex,
          caseSensitive: flags.caseSensitive,
          ...(flags.globs.length > 0 ? { globs: flags.globs } : {}),
          excludeGlobs: repo.excludeGlobs,
          maxPerFile: perFile,
          timeoutMs: context.ripgrepTimeoutMs,
        });
      } catch (error) {
        throw wrapSearchError(error, context.ripgrepTimeoutMs);
      }
      return renderSearchResult(query, flags, matches, {
        limit,
        perFile,
        budgetChars: context.resultBudgetChars,
        echoChars: context.micro.queryEchoChars,
      });
    },
  );
};

/** limit：默认 50；显式值必须落在 1..200 */
function resolveLimit(args: Record<string, unknown>): number {
  const limit = optionalPositiveIntArg(TOOL_NAME, args, "limit") ?? SEARCH_CODE_DEFAULT_LIMIT;
  if (limit > SEARCH_CODE_MAX_LIMIT) {
    throw new Error(`${TOOL_NAME}: argument "limit" must be <= ${String(SEARCH_CODE_MAX_LIMIT)}`);
  }
  return limit;
}

/** rg 失败归一：超时给补救动作，其余只回显首行（有界，不泄漏宿主路径） */
function wrapSearchError(error: unknown, timeoutMs: number): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("timed out")) {
    return new Error(
      `${TOOL_NAME}: search timed out after ${String(timeoutMs)} ms; narrow the query or add a glob`,
      { cause: error },
    );
  }
  const firstLine = message.split(/\r?\n/)[0] ?? "";
  return new Error(`${TOOL_NAME}: ${boundedEcho(firstLine, SEARCH_CODE_LINE_MAX_CHARS)}`, {
    cause: error,
  });
}

interface RenderOptions {
  readonly limit: number;
  readonly perFile: number;
  readonly budgetChars: number;
  readonly echoChars: number;
}

function renderSearchResult(
  query: string,
  flags: SearchFlags,
  matches: readonly RgMatch[],
  options: RenderOptions,
): string {
  const echo = boundedEcho(query, options.echoChars);
  const label = flagsLabel(flags);
  if (matches.length === 0) {
    return `Search "${echo}" (${label}): no matches.`;
  }
  const shown = matches.slice(0, options.limit);
  const files = new Set(shown.map((match) => match.file)).size;
  const header = `Search "${echo}" (${label}): ${String(shown.length)} match(es) in ${String(files)} file(s)`;
  const lines = shown.map(
    (match) => `${match.file}:${String(match.line)}: ${truncateLine(match.text)}`,
  );
  const budget = applyLineBudget([header, ...lines], options.budgetChars, (shownLines, total) =>
    `Tool result truncated: showing ${String(shownLines)} of ${String(total)} result lines (tool result budget ${String(options.budgetChars)} chars exceeded).`,
  );
  // 截断提示放在预算层之后，保证它不会被预算本身截掉
  const notices: string[] = [];
  if (matches.length > options.limit) {
    notices.push(
      `Match limit ${String(options.limit)} reached; refine the query or add a glob.`,
    );
  }
  if (options.perFile < options.limit) {
    const capped = cappedFileCount(matches, options.perFile);
    if (capped > 0) {
      notices.push(
        `Per-file limit ${String(options.perFile)} reached in ${String(capped)} file(s); some matches omitted.`,
      );
    }
  }
  return [...budget.lines, ...notices].join("\n");
}

/** 命中数达到每文件上限的文件个数（用于留痕） */
function cappedFileCount(matches: readonly RgMatch[], perFile: number): number {
  const counts = new Map<string, number>();
  for (const match of matches) {
    counts.set(match.file, (counts.get(match.file) ?? 0) + 1);
  }
  let capped = 0;
  for (const count of counts.values()) {
    if (count >= perFile) {
      capped += 1;
    }
  }
  return capped;
}

function truncateLine(text: string): string {
  return text.length <= SEARCH_CODE_LINE_MAX_CHARS
    ? text
    : `${text.slice(0, SEARCH_CODE_LINE_MAX_CHARS)}...`;
}

/** 头部标志：`literal|regex, case-sensitive|case-insensitive[, glob [a, b]]` */
function flagsLabel(flags: SearchFlags): string {
  const mode = flags.regex ? "regex" : "literal";
  const casing = flags.caseSensitive ? "case-sensitive" : "case-insensitive";
  const globPart = flags.globs.length > 0 ? `, glob [${flags.globs.join(", ")}]` : "";
  return `${mode}, ${casing}${globPart}`;
}

/** Ledger 标识：查询 + 标志 + 已排序 glob；同一语义不同参数顺序命中同一条目 */
function ledgerDescription(query: string, flags: SearchFlags, echoChars: number): string {
  const mode = flags.regex ? "regex" : "literal";
  const casing = flags.caseSensitive ? "case-sensitive" : "case-insensitive";
  const globPart = flags.globs.length > 0 ? `, glob: ${flags.globs.join(",")}` : "";
  return `${TOOL_NAME} "${boundedEcho(query, echoChars)}" [${mode}, ${casing}${globPart}]`;
}
