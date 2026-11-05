import type { Parser } from "web-tree-sitter";

/**
 * 签名级符号索引（测量常量面）：Zone B Symbol Index 的语言无关模型。
 *
 * - 签名级：只提取种类 / 名称 / 修饰符 / 返回类型 / 参数表 / 行号，不含函数体；
 * - 确定性：遍历顺序 = AST 文档顺序（tree-sitter 确定），输入相同输出字节相同；
 * - 解析失败（ERROR 节点）：置 parseError 标记，由上层留痕，不静默丢弃；
 * - 每语言的具体提取器在 `zoneb/extractors/<language>.ts`（ADR-0041），
 *   本文件只保留跨语言共用的模型与树操作。
 */

export type SymbolKind =
  | "class"
  | "interface"
  | "enum"
  | "record"
  | "struct"
  | "trait"
  | "namespace"
  | "module"
  | "method"
  | "function"
  | "constructor"
  | "field"
  | "property"
  | "enum-constant"
  | "type-alias";

/** 类型级符号（可作为成员容器） */
const TYPE_KINDS: ReadonlySet<SymbolKind> = new Set<SymbolKind>([
  "class",
  "interface",
  "enum",
  "record",
  "struct",
  "trait",
  "namespace",
  "module",
]);

/** 可调用符号（Reference / Call Chain 层的主体；顶层函数与类方法同等对待） */
const CALLABLE_KINDS: ReadonlySet<SymbolKind> = new Set<SymbolKind>([
  "method",
  "function",
  "constructor",
]);

export function isTypeKind(kind: SymbolKind): boolean {
  return TYPE_KINDS.has(kind);
}

export function isCallableKind(kind: SymbolKind): boolean {
  return CALLABLE_KINDS.has(kind);
}

export interface CodeSymbol {
  readonly kind: SymbolKind;
  readonly name: string;
  /** 声明起始行（1-based） */
  readonly line: number;
  /** 声明结束行（1-based，含）；仅用于圈定/求交，不渲染进 Zone B */
  readonly endLine: number;
  readonly modifiers: readonly string[];
  /** method / function / field / property 的类型 */
  readonly returnType?: string;
  /** method / function / constructor / record 的形参表（归一化空白后含括号） */
  readonly params?: string;
  /**
   * 所属类型名（ADR-0041）。Java/TS/Python 由顶层容器推导，缺省不填；
   * 供没有类型包裹节点的语言（如 Go 的接收者方法、Rust 的 impl 块）显式声明。
   */
  readonly owner?: string;
  /** 嵌套成员（类型含成员；method/field 无成员） */
  readonly members: readonly CodeSymbol[];
}

/** 文件内的一次调用（名字级：被调方法名或构造类型名 + 调用点行号） */
export interface FileInvocation {
  readonly name: string;
  readonly line: number;
}

export interface FileSymbolIndex {
  /** 仓库相对 POSIX 路径 */
  readonly file: string;
  /** 解析出的模块名（Java package / Python dotted module；无则 ""） */
  readonly moduleName: string;
  readonly parseError: boolean;
  /** 顶层类型与顶层函数（嵌套类型在 members 里递归） */
  readonly symbols: readonly CodeSymbol[];
  /** 全文件的名字级调用点（文档顺序） */
  readonly invocations: readonly FileInvocation[];
}

/** 单语言提取器签名（`codeintel/language-support.ts` 的注册项） */
export type SymbolExtractor = (parser: Parser, file: string, source: string) => FileSymbolIndex;

/** 行区间 [startLine, endLine]（含端点，1-based） */
export interface LineSpan {
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * 默认签名渲染（Java 形态）：`final class MathUtils` /
 * `public static int sumFirst(int[] values, int count)`。
 * 只含签名要素，不含函数体。其他语言在各自 extractor 里提供 renderer。
 */
export function formatSymbolSignature(symbol: CodeSymbol): string {
  const mods = symbol.modifiers.length > 0 ? `${symbol.modifiers.join(" ")} ` : "";
  switch (symbol.kind) {
    case "class":
    case "interface":
    case "enum":
    case "struct":
    case "trait":
    case "namespace":
    case "module":
      return `${mods}${symbol.kind} ${symbol.name}`;
    case "record":
      return `${mods}record ${symbol.name}${symbol.params ?? ""}`;
    case "constructor":
      return `${mods}${symbol.name}${symbol.params ?? "()"}`;
    case "method":
    case "function":
      return `${mods}${symbol.returnType ?? "void"} ${symbol.name}${symbol.params ?? "()"}`;
    case "field":
    case "property":
      return `${mods}${symbol.returnType ?? "var"} ${symbol.name}`;
    case "type-alias":
      return `${mods}type ${symbol.name}`;
    case "enum-constant":
      return symbol.name;
  }
}

/** 形参表归一化：折叠空白、去首尾；空串 → undefined */
export function normalizeParams(text: string | undefined): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
}

function intersects(symbol: CodeSymbol, span: LineSpan): boolean {
  return symbol.line <= span.endLine && span.startLine <= symbol.endLine;
}

/**
 * 把符号树剪枝为「与任一 span 相交」的子树：
 * 类型若自身或后代相交则保留；成员仅保留相交者。输出仍为文档顺序。
 */
export function pruneSymbolsToSpans(
  symbols: readonly CodeSymbol[],
  spans: readonly LineSpan[],
): readonly CodeSymbol[] {
  const pruned: CodeSymbol[] = [];
  for (const symbol of symbols) {
    const ownHit = spans.some((span) => intersects(symbol, span));
    const prunedMembers =
      symbol.members.length > 0 ? pruneSymbolsToSpans(symbol.members, spans) : [];
    if (ownHit || prunedMembers.length > 0) {
      pruned.push({ ...symbol, members: prunedMembers });
    }
  }
  return pruned;
}

/** 剪枝树的最深层符号（方法优先；类型无相交成员时为其自身） */
export function innermostSymbols(symbols: readonly CodeSymbol[]): readonly CodeSymbol[] {
  const result: CodeSymbol[] = [];
  for (const symbol of symbols) {
    if (symbol.members.length > 0) {
      result.push(...innermostSymbols(symbol.members));
    } else {
      result.push(symbol);
    }
  }
  return result;
}

/** 包含指定行的符号链（根类型 → … → 最内层符号；空数组 = 不在任何符号内） */
export function symbolPathAt(
  symbols: readonly CodeSymbol[],
  line: number,
): readonly CodeSymbol[] {
  for (const symbol of symbols) {
    if (symbol.line <= line && line <= symbol.endLine) {
      return [symbol, ...symbolPathAt(symbol.members, line)];
    }
  }
  return [];
}
