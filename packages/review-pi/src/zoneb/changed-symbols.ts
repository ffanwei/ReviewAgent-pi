import type { DiffAnalysis } from "./diff-analysis.js";
import { oldSpansOf } from "./diff-analysis.js";
import type { RepoContext } from "./repo-context.js";
import type { CodeSymbol, LineSpan } from "./symbols.js";
import { innermostSymbols, isCallableKind, isTypeKind, pruneSymbolsToSpans } from "./symbols.js";

/**
 * Diff 层 → Symbol 层的桥（测量常量面）：变更文件 + 旧侧 hunk 行区间 → 相交符号（签名级）。
 *
 * 圈定规则：hunk 的旧侧行区间与符号的 [line, endLine] 求交；
 * 方法级符号优先作为「变更符号」（Reference / Call Chain 层的检索对象）。
 */

export interface ChangedSymbolRef {
  readonly file: string;
  /** 最内层相交符号（通常为 method / function / constructor） */
  readonly symbol: CodeSymbol;
  /** 所属顶层类型名（顶层函数为 ""） */
  readonly typeName: string;
}

export interface ChangedFileSymbols {
  readonly file: string;
  readonly presentInSnapshot: boolean;
  /** 与 hunk 相交的剪枝符号树（渲染 Symbol 层用） */
  readonly pruned: readonly CodeSymbol[];
  /** 最内层相交符号（Reference / Call Chain 层用） */
  readonly innermost: readonly ChangedSymbolRef[];
}

export async function resolveChangedFileSymbols(
  repo: RepoContext,
  diff: DiffAnalysis,
): Promise<readonly ChangedFileSymbols[]> {
  const results: ChangedFileSymbols[] = [];
  for (const fileDiff of diff.files) {
    results.push(await resolveSingleFile(repo, fileDiff.file, oldSpansOf(fileDiff)));
  }
  return results;
}

async function resolveSingleFile(
  repo: RepoContext,
  file: string,
  spans: readonly LineSpan[],
): Promise<ChangedFileSymbols> {
  if (!repo.hasFile(file)) {
    return { file, presentInSnapshot: false, pruned: [], innermost: [] };
  }
  const index = await repo.symbolIndex(file);
  const pruned = pruneSymbolsToSpans(index.symbols, spans);
  const innermost: ChangedSymbolRef[] = [];
  for (const topType of pruned) {
    // 顶层函数的容器名是空串，否则 qualifiedName 会渲染成 "greet.greet"
    const containerName = isTypeKind(topType.kind) ? topType.name : "";
    for (const leaf of innermostSymbols([topType])) {
      innermost.push({ file, symbol: leaf, typeName: leaf.owner ?? containerName });
    }
  }
  return { file, presentInSnapshot: true, pruned, innermost };
}

/** 变更符号中可作 Reference / Call Chain 检索对象的方法级名字（排序去重） */
export function changedMethodNames(changed: readonly ChangedFileSymbols[]): readonly string[] {
  const names = new Set<string>();
  for (const entry of changed) {
    for (const ref of entry.innermost) {
      if (isCallableKind(ref.symbol.kind)) {
        names.add(ref.symbol.name);
      }
    }
  }
  if (names.size > 0) {
    return [...names].sort();
  }
  // 无方法级相交时回退到最内层符号名（纯字段/类型声明变更）
  return changedInnermostNames(changed);
}

function changedInnermostNames(changed: readonly ChangedFileSymbols[]): readonly string[] {
  const names = new Set<string>();
  for (const entry of changed) {
    for (const ref of entry.innermost) {
      names.add(ref.symbol.name);
    }
  }
  return [...names].sort();
}

/** Call Chain 的主体：方法/构造器级变更符号（按限定名排序去重） */
export function changedMethodRefs(
  changed: readonly ChangedFileSymbols[],
): readonly ChangedSymbolRef[] {
  const refs = changed.flatMap((entry) =>
    entry.innermost.filter((ref) => isCallableKind(ref.symbol.kind)),
  );
  const byKey = new Map<string, ChangedSymbolRef>();
  for (const ref of refs) {
    const key = `${ref.typeName}.${ref.symbol.name}:${ref.file}:${ref.symbol.line}`;
    if (!byKey.has(key)) {
      byKey.set(key, ref);
    }
  }
  return [...byKey.values()].sort((a, b) => compare(qualifiedName(a), qualifiedName(b)));
}

export function qualifiedName(ref: ChangedSymbolRef): string {
  return ref.typeName.length > 0 ? `${ref.typeName}.${ref.symbol.name}` : ref.symbol.name;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
