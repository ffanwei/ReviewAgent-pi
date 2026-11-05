import type { ReviewToolHandler, ToolRunContext } from "./toolkit-types.js";import { readThroughLedger } from "./ledger.js";
import { applyLineBudget } from "./result-budget.js";
import { requireStringArg } from "./args.js";
import { noSourceFilesMessage } from "../codeintel/language-support.js";
import type { CodeSymbol } from "../zoneb/symbols.js";
import { formatSymbolSignature } from "../zoneb/symbols.js";
import type { RepoContext } from "../zoneb/repo-context.js";

/**
 * review.get_symbol（#6 P3a）：签名级符号检索（tree-sitter 零构建）。
 *
 * - 名字级精确匹配（大小写敏感，无类型解析）：先 rg 收窄候选文件，再解析符号索引，
 *   命中符号返回签名（种类/修饰符/返回类型/参数表/行号），不含函数体；
 * - 候选收窄（ADR-0041）：多语言下全仓解析不可接受；符号声明必然在文本上包含该名字，
 *   因此 rg 预过滤不改变命中集合，只缩小解析面；
 * - 类型命中附带其成员签名（递归嵌套）；
 * - 确定性：文件顺序 = 排序后的文件清单，符号顺序 = AST 文档顺序；
 * - 解析失败文件命中时显式留痕（词法精度天花板为已知限制）；
 * - 超预算在行边界截断并留痕；
 * - Context Ledger：登记为 symbol（标识 = 工具名 + 符号名）。
 */

export const getSymbolTool: ReviewToolHandler = async (args, context): Promise<string> => {
  const name = requireStringArg("review.get_symbol", args, "symbol");
  return readThroughLedger(
    context.ledger,
    "symbol",
    `review.get_symbol "${name}"`,
    async () => renderSymbolLookup(name, context),
  );
};

/** 真实读取路径：候选文件符号索引扫描 + 签名渲染（含零命中显式留痕） */
async function renderSymbolLookup(name: string, context: ToolRunContext): Promise<string> {
  const repo = await context.repo();
  if (repo.sourceFiles.length === 0) {
    return `Symbol "${name}": ${noSourceFilesMessage(repo.languages)}`;
  }
  const lines: string[] = [];
  let matchCount = 0;
  let parseErrorFiles = 0;

  const candidates = await repo
    .candidateFilesForName(name, context.ripgrepTimeoutMs)
    .catch((error: unknown) => {
      throw new Error(`review.get_symbol: ${errorMessage(error)}`, { cause: error });
    });

  for (const file of candidates) {
    const index = await repo.symbolIndex(file).catch((error: unknown) => {
      // 归一为仓库相对路径消息（不泄漏绝对路径，与 get_file / search-tools 错误纪律一致）
      throw new Error(
        `review.get_symbol: symbol index unavailable for file "${file}" (not found or unreadable)`,
        { cause: error },
      );
    });
    const matches = collectMatches(index.symbols, name);
    if (matches.length === 0) {
      continue;
    }
    if (index.parseError) {
      parseErrorFiles++;
    }
    matchCount += matches.length;
    const language = repo.languageFor(file);
    lines.push(`${file}${moduleSuffix(index.moduleName, language?.moduleLabel ?? "")}`);
    for (const match of matches) {
      lines.push(...renderSymbolLines(repo, file, match, 1));
    }
  }

  const header = [
    `Symbol "${name}": ${matchCount} match(es) across ${repo.sourceFiles.length} ${repo.languageLabel} file(s)`,
  ];
  if (parseErrorFiles > 0) {
    header.push(
      `Note: ${parseErrorFiles} file(s) with matching symbols contain parse errors; signatures may be incomplete.`,
    );
  }
  if (matchCount === 0) {
    return header.join("\n");
  }
  const budget = applyLineBudget(
    [...header, ...lines],
    context.resultBudgetChars,
    (shown, total) =>
      `Tool result truncated: showing ${shown} of ${total} result lines (tool result budget ${context.resultBudgetChars} chars exceeded).`,
  );
  return budget.lines.join("\n");
}

/** 模块名后缀：Java 的空包保留 "(default package)" 以维持既有输出字节 */
function moduleSuffix(moduleName: string, moduleLabel: string): string {
  if (moduleName.length > 0) {
    return ` (${moduleLabel.length > 0 ? moduleLabel : "module"} ${moduleName})`;
  }
  return moduleLabel === "package" ? " (default package)" : "";
}

/** 递归收集名字命中的符号（文档顺序） */
function collectMatches(symbols: readonly CodeSymbol[], name: string): readonly CodeSymbol[] {
  const matches: CodeSymbol[] = [];
  for (const symbol of symbols) {
    if (symbol.name === name) {
      matches.push(symbol);
    }
    if (symbol.members.length > 0) {
      matches.push(...collectMatches(symbol.members, name));
    }
  }
  return matches;
}

/** 符号行渲染：命中符号及其成员（嵌套缩进），与 Zone B Symbol Index 同风格 */
function renderSymbolLines(
  repo: RepoContext,
  file: string,
  symbol: CodeSymbol,
  depth: number,
): readonly string[] {
  const indent = "  ".repeat(depth);
  const render = repo.languageFor(file)?.renderSignature ?? formatSymbolSignature;
  return [
    `${indent}L${symbol.line} ${render(symbol)}`,
    ...symbol.members.flatMap((member) => renderSymbolLines(repo, file, member, depth + 1)),
  ];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
