import type { Node, Parser } from "web-tree-sitter";
import type { CodeSymbol, FileInvocation, FileSymbolIndex, SymbolKind } from "../symbols.js";
import { normalizeParams } from "../symbols.js";

/**
 * Java 符号提取器（ADR-0041：语言无关模型 + 每语言 extractor）。
 *
 * 行为与 ADR-0040 之前逐字节一致：同样的节点表、同样的修饰符集合、
 * 同样的默认包语义。这样通用化重构本身不改变任何既有输出。
 */

const TYPE_DECL_TYPES = new Set([
  "class_declaration",
  "interface_declaration",
  "enum_declaration",
  "record_declaration",
]);

const MODIFIER_KEYWORDS = new Set([
  "public",
  "protected",
  "private",
  "abstract",
  "static",
  "final",
  "transient",
  "volatile",
  "synchronized",
  "native",
  "strictfp",
  "default",
]);

/** 文件头部的 package 声明（用于廉价词法预读，避免为取包名解析整文件） */
const JAVA_PACKAGE_PATTERN =
  /^[ \t]*package[ \t]+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)[ \t]*;/m;

/** 解析一个 Java 文件，产出签名级符号索引 */
export function extractJavaFile(parser: Parser, file: string, source: string): FileSymbolIndex {
  const tree = parser.parse(source);
  if (tree === null) {
    // tree-sitter 仅在输入为 null/undefined 时返回 null；此处视为解析失败并留痕
    return { file, moduleName: "", parseError: true, symbols: [], invocations: [] };
  }
  const root = tree.rootNode;
  const moduleName = extractPackageName(root);
  const symbols: CodeSymbol[] = [];
  for (const child of root.namedChildren) {
    if (TYPE_DECL_TYPES.has(child.type)) {
      symbols.push(extractTypeSymbol(child));
    }
  }
  const invocations = extractInvocations(root);
  return {
    file,
    moduleName,
    parseError: root.hasError,
    symbols,
    invocations,
  };
}

/** 文件头部词法包名（无 package 声明 → 默认包 ""） */
export function extractJavaPackageFromHead(head: string): string {
  return JAVA_PACKAGE_PATTERN.exec(head)?.[1] ?? "";
}

function extractPackageName(root: Node): string {
  const packageDecl = root.namedChildren.find((child) => child.type === "package_declaration");
  if (packageDecl === undefined) {
    return "";
  }
  const nameNode =
    packageDecl.childForFieldName("name") ??
    packageDecl.namedChildren.find((child) => child.type !== ";");
  return nameNode?.text ?? "";
}

function extractTypeSymbol(node: Node): CodeSymbol {
  const kind = typeKindOf(node.type);
  const name = node.childForFieldName("name")?.text ?? "(anonymous)";
  const params =
    node.type === "record_declaration"
      ? normalizeParams(node.childForFieldName("parameters")?.text)
      : undefined;
  const body = node.childForFieldName("body");
  const members = body !== null && body !== undefined ? extractMembers(body) : [];
  return {
    kind,
    name,
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    modifiers: extractModifiers(node),
    ...(params !== undefined ? { params } : {}),
    members,
  };
}

function extractMembers(body: Node): CodeSymbol[] {
  const members: CodeSymbol[] = [];
  for (const child of body.namedChildren) {
    if (child.type === "enum_body_declarations") {
      // enum 的方法/字段成员包在 enum_body_declarations 里，摊平处理
      members.push(...extractMembers(child));
      continue;
    }
    const member = extractMember(child);
    if (member !== undefined) {
      members.push(member);
    }
  }
  return members;
}

function extractMember(node: Node): CodeSymbol | undefined {
  if (TYPE_DECL_TYPES.has(node.type)) {
    return extractTypeSymbol(node);
  }
  if (node.type === "method_declaration" || node.type === "constructor_declaration") {
    return extractCallableSymbol(node);
  }
  if (node.type === "field_declaration") {
    return extractFirstFieldSymbol(node);
  }
  if (node.type === "enum_constant") {
    return {
      kind: "enum-constant",
      name: node.childForFieldName("name")?.text ?? "(unknown)",
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      modifiers: [],
      members: [],
    };
  }
  return undefined;
}

function extractCallableSymbol(node: Node): CodeSymbol {
  const returnType =
    node.type === "method_declaration" ? node.childForFieldName("type")?.text : undefined;
  const params = normalizeParams(node.childForFieldName("parameters")?.text);
  return {
    kind: node.type === "constructor_declaration" ? "constructor" : "method",
    name: node.childForFieldName("name")?.text ?? "(anonymous)",
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    modifiers: extractModifiers(node),
    ...(returnType !== undefined ? { returnType } : {}),
    ...(params !== undefined ? { params } : {}),
    members: [],
  };
}

function extractFirstFieldSymbol(node: Node): CodeSymbol | undefined {
  const declarator = node.namedChildren.find((child) => child.type === "variable_declarator");
  if (declarator === undefined) {
    return undefined;
  }
  const returnType = node.childForFieldName("type")?.text;
  return {
    kind: "field",
    name: declarator.childForFieldName("name")?.text ?? "(unknown)",
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    modifiers: extractModifiers(node),
    ...(returnType !== undefined ? { returnType } : {}),
    members: [],
  };
}

function extractModifiers(node: Node): readonly string[] {
  const modifiersNode = node.namedChildren.find((child) => child.type === "modifiers");
  if (modifiersNode === undefined) {
    return [];
  }
  const keywords: string[] = [];
  for (let i = 0; i < modifiersNode.childCount; i++) {
    const child = modifiersNode.child(i);
    if (child !== null && MODIFIER_KEYWORDS.has(child.type)) {
      keywords.push(child.type);
    }
  }
  return keywords;
}

function extractInvocations(root: Node): readonly FileInvocation[] {
  const invocations: FileInvocation[] = [];
  for (const invocation of root.descendantsOfType("method_invocation")) {
    const name = invocation.childForFieldName("name")?.text;
    if (name !== undefined) {
      invocations.push({ name, line: invocation.startPosition.row + 1 });
    }
  }
  for (const creation of root.descendantsOfType("object_creation_expression")) {
    const type = creation.childForFieldName("type")?.text;
    if (type !== undefined) {
      invocations.push({ name: type, line: creation.startPosition.row + 1 });
    }
  }
  return invocations;
}

function typeKindOf(nodeType: string): SymbolKind {
  switch (nodeType) {
    case "interface_declaration":
      return "interface";
    case "enum_declaration":
      return "enum";
    case "record_declaration":
      return "record";
    default:
      return "class";
  }
}
