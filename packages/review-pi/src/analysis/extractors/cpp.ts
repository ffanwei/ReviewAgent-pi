import type { Node, Parser } from "web-tree-sitter";
import type { CodeSymbol, FileInvocation, FileSymbolIndex, SymbolKind } from "../symbols.js";
import { normalizeParams } from "../symbols.js";

/**
 * C / C++ 符号提取器（ADR-0042）。
 *
 * 覆盖范围（测量常量面，名字级、无类型解析）：
 * - 顶层与 namespace：namespace / class / struct / union / enum / typedef /
 *   using alias / template（摊平其声明）/ 函数定义与声明；
 * - 类成员：方法原型与内联定义、构造 / 析构、字段（含一行多声明符）；
 * - 类外定义（`T Class::method()`）把限定作用域记入 `owner`；
 * - 调用点：call_expression（含 `obj.method()` / `p->method()` / 模板函数）
 *   与 new_expression。
 *
 * C 与 C++ 共用 `cpp` 语言 id（ADR-0041 已定口径）：C 是 C++ 子集，
 * `.c/.h` 走同一语法，不拆两个 id 制造双份引用检索。
 */

interface CppContainer {
  /** 当前类型 / 命名空间名（构造器判定与成员归属） */
  readonly name?: string;
  /** 当前 access specifier（class 缺省 private，struct/union 缺省 public） */
  readonly access?: string;
}

const AGGREGATE_TYPES = new Set([
  "class_specifier",
  "struct_specifier",
  "union_specifier",
  "enum_specifier",
]);

/** 直接作为修饰符节点的 token */
const MODIFIER_KEYWORDS = new Set([
  "virtual",
  "static",
  "inline",
  "constexpr",
  "consteval",
  "constinit",
  "explicit",
  "friend",
  "const",
  "override",
  "final",
  "mutable",
  "volatile",
  "extern",
  "register",
  "thread_local",
]);

/** 修饰符信息在子节点里（`virtual_specifier` / `storage_class_specifier` …） */
const MODIFIER_NODE_TYPES = new Set([
  "virtual_specifier",
  "storage_class_specifier",
  "type_qualifier",
  "explicit_function_specifier",
]);

export function extractCppFile(parser: Parser, file: string, source: string): FileSymbolIndex {
  const tree = parser.parse(source);
  if (tree === null) {
    return { file, moduleName: "", parseError: true, symbols: [], invocations: [] };
  }
  const root = tree.rootNode;
  return {
    file,
    moduleName: "",
    parseError: root.hasError,
    symbols: extractContainer(root, {}),
    invocations: extractInvocations(root),
  };
}

function extractContainer(node: Node, container: CppContainer): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  let access = container.access;
  for (const child of node.namedChildren) {
    if (child.type === "access_specifier") {
      access = child.text;
      continue;
    }
    const nextContainer = access === undefined ? container : { ...container, access };
    symbols.push(...extractDeclaration(child, nextContainer));
  }
  return symbols;
}

function extractDeclaration(node: Node, container: CppContainer): CodeSymbol[] {
  if (node.type === "namespace_definition") {
    const body = node.childForFieldName("body");
    const name = node.childForFieldName("name")?.text ?? "(anonymous)";
    return [
      {
        kind: "namespace",
        name,
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        modifiers: [],
        members: body !== null && body !== undefined ? extractContainer(body, {}) : [],
      },
    ];
  }
  if (node.type === "class_specifier" || node.type === "struct_specifier" || node.type === "union_specifier") {
    return [aggregateSymbol(node, container)];
  }
  if (node.type === "enum_specifier") {
    return [enumSymbol(node, container)];
  }
  if (node.type === "type_definition") {
    return typeDefinitionSymbols(node, container);
  }
  if (node.type === "alias_declaration") {
    return [aliasSymbol(node)];
  }
  if (node.type === "template_declaration") {
    return node.namedChildren
      .filter((child) => child.type !== "template_parameter_list")
      .flatMap((child) => extractDeclaration(child, container));
  }
  if (node.type === "function_definition") {
    return [functionDefinitionSymbol(node, container)];
  }
  if (node.type === "declaration") {
    return declarationSymbols(node, container);
  }
  if (node.type === "field_declaration") {
    return fieldDeclarationSymbols(node, container);
  }
  if (node.type === "friend_declaration") {
    return node.namedChildren
      .flatMap((child) => extractDeclaration(child, container))
      .map((symbol) => addModifier(symbol, "friend"));
  }
  return [];
}

function aggregateSymbol(node: Node, container: CppContainer, nameOverride?: string): CodeSymbol {
  const kind: SymbolKind =
    node.type === "class_specifier"
      ? "class"
      : node.type === "union_specifier"
        ? "struct"
        : "struct";
  const name = nameOverride ?? node.childForFieldName("name")?.text ?? "(anonymous)";
  const body = node.childForFieldName("body");
  const defaultAccess = node.type === "class_specifier" ? "private" : "public";
  return {
    kind,
    name,
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    modifiers: modifiersOf(node, container.access),
    members:
      body !== null && body !== undefined
        ? extractContainer(body, { name, access: defaultAccess })
        : [],
  };
}

function enumSymbol(node: Node, container: CppContainer, nameOverride?: string): CodeSymbol {
  const body = node.childForFieldName("body");
  const members: CodeSymbol[] = [];
  if (body !== null && body !== undefined) {
    for (const enumerator of body.namedChildren) {
      if (enumerator.type !== "enumerator") {
        continue;
      }
      const name = enumerator.childForFieldName("name")?.text;
      if (name !== undefined) {
        members.push({
          kind: "enum-constant",
          name,
          line: enumerator.startPosition.row + 1,
          endLine: enumerator.endPosition.row + 1,
          modifiers: [],
          members: [],
        });
      }
    }
  }
  return {
    kind: "enum",
    name: nameOverride ?? node.childForFieldName("name")?.text ?? "(anonymous)",
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    modifiers: modifiersOf(node, container.access),
    members,
  };
}

function typeDefinitionSymbols(node: Node, container: CppContainer): CodeSymbol[] {
  const inner = node.childForFieldName("type");
  const declarator = declaratorName(node.childForFieldName("declarator"));
  const aliasName = declarator?.name;
  if (inner === null || inner === undefined) {
    return aliasName !== undefined ? [typeAliasSymbol(node, aliasName, ["typedef"])] : [];
  }
  if (AGGREGATE_TYPES.has(inner.type)) {
    const innerName = inner.childForFieldName("name")?.text;
    const nameOverride = innerName === undefined ? aliasName : undefined;
    const innerSymbol =
      inner.type === "enum_specifier"
        ? enumSymbol(inner, container, nameOverride)
        : aggregateSymbol(inner, container, nameOverride);
    if (nameOverride !== undefined) {
      return [innerSymbol];
    }
    const symbols = [innerSymbol];
    // `typedef struct Named { … } Alias;`：Named 与 Alias 都是符号
    if (aliasName !== undefined && aliasName !== innerSymbol.name) {
      symbols.push(typeAliasSymbol(node, aliasName, ["typedef"]));
    }
    return symbols;
  }
  return aliasName !== undefined ? [typeAliasSymbol(node, aliasName, ["typedef"])] : [];
}

function aliasSymbol(node: Node): CodeSymbol {
  const name = node.childForFieldName("name")?.text ?? "(anonymous)";
  return typeAliasSymbol(node, name, []);
}

function typeAliasSymbol(node: Node, name: string, modifiers: readonly string[]): CodeSymbol {
  return {
    kind: "type-alias",
    name,
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    modifiers,
    members: [],
  };
}

function functionDefinitionSymbol(node: Node, container: CppContainer): CodeSymbol {
  const declarator = node.childForFieldName("declarator");
  const fd = findFunctionDeclarator(declarator);
  return callableSymbol(node, fd, container, []);
}

function declarationSymbols(node: Node, container: CppContainer): CodeSymbol[] {
  const declarators = declaratorFields(node);
  const fd = declarators.map(findFunctionDeclarator).find((candidate) => candidate !== undefined);
  if (fd !== undefined) {
    return [callableSymbol(node, fd, container, [])];
  }
  // `struct { … } name;` 是变量声明而不是类型声明；只有 typedef 才给匿名聚合命名
  const typeNode = node.childForFieldName("type");
  if (typeNode !== null && typeNode !== undefined && AGGREGATE_TYPES.has(typeNode.type)) {
    return typeNode.childForFieldName("name") !== null ? [extractDeclaration(typeNode, container)[0]!] : [];
  }
  return declarators.flatMap((declarator) => fieldSymbols(node, declarator, container));
}

function fieldDeclarationSymbols(node: Node, container: CppContainer): CodeSymbol[] {
  const declarators = declaratorFields(node);
  const fd = declarators.map(findFunctionDeclarator).find((candidate) => candidate !== undefined);
  if (fd !== undefined) {
    return [callableSymbol(node, fd, container, [])];
  }
  return declarators.flatMap((declarator) => fieldSymbols(node, declarator, container));
}

function callableSymbol(
  node: Node,
  fd: Node | undefined,
  container: CppContainer,
  extraModifiers: readonly string[],
): CodeSymbol {
  const name = fd !== undefined ? declaratorName(fd.childForFieldName("declarator")) : undefined;
  const owner = name?.scope ?? container.name;
  const returnType = normalizeType(node.childForFieldName("type")?.text);
  const kind = callableKind(name?.name, owner, returnType);
  return {
    kind,
    name: name?.name ?? "(anonymous)",
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    modifiers: callableModifiers(node, fd, container, extraModifiers),
    ...optionalReturnType(returnType),
    ...optionalParams(fd?.childForFieldName("parameters")?.text),
    ...(owner !== undefined && owner.length > 0 ? { owner } : {}),
    members: [],
  };
}

function callableKind(
  name: string | undefined,
  owner: string | undefined,
  returnType: string | undefined,
): SymbolKind {
  if (name === undefined) {
    return owner !== undefined ? "method" : "function";
  }
  if (name.startsWith("~")) {
    return "constructor";
  }
  if (owner !== undefined && simpleTypeName(owner) === name && returnType === undefined) {
    return "constructor";
  }
  return owner !== undefined ? "method" : "function";
}

function fieldSymbols(node: Node, declarator: Node, container: CppContainer): CodeSymbol[] {
  const name = declaratorName(declarator)?.name;
  if (name === undefined) {
    return [];
  }
  return [
    {
      kind: "field",
      name,
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      modifiers: modifiersOf(node, container.access),
      ...optionalReturnType(normalizeType(node.childForFieldName("type")?.text)),
      members: [],
    },
  ];
}

/** 声明符里可能嵌套 pointer/reference/array/初始化器；一直剥到名字节点 */
function declaratorName(
  node: Node | null | undefined,
): { readonly name: string; readonly scope?: string } | undefined {
  if (node === null || node === undefined) {
    return undefined;
  }
  switch (node.type) {
    case "identifier":
    case "field_identifier":
    case "type_identifier":
    case "namespace_identifier":
    case "destructor_name":
    case "operator_name":
      return { name: node.text };
    case "qualified_identifier": {
      const inner = declaratorName(node.childForFieldName("name"));
      if (inner === undefined) {
        return undefined;
      }
      const scope = inner.scope ?? node.childForFieldName("scope")?.text;
      return scope !== undefined ? { name: inner.name, scope } : { name: inner.name };
    }
    case "template_function":
      return declaratorName(node.childForFieldName("name"));
    case "pointer_declarator":
    case "reference_declarator":
    case "array_declarator":
    case "parenthesized_declarator":
    case "init_declarator":
      return declaratorName(node.childForFieldName("declarator"));
    default:
      return undefined;
  }
}

function findFunctionDeclarator(node: Node | null | undefined): Node | undefined {
  if (node === null || node === undefined) {
    return undefined;
  }
  if (node.type === "function_declarator") {
    return node;
  }
  return findFunctionDeclarator(node.childForFieldName("declarator"));
}

function declaratorFields(node: Node): readonly Node[] {
  const declarators: Node[] = [];
  for (let i = 0; i < node.childCount; i += 1) {
    if (node.fieldNameForChild(i) !== "declarator") {
      continue;
    }
    const child = node.child(i);
    if (child !== null) {
      declarators.push(child);
    }
  }
  return declarators;
}

function modifiersOf(node: Node, access: string | undefined): readonly string[] {
  const modifiers: string[] = [];
  if (access !== undefined && access.length > 0) {
    modifiers.push(access);
  }
  for (const child of node.namedChildren) {
    const text = modifierText(child);
    if (text !== undefined && !modifiers.includes(text)) {
      modifiers.push(text);
    }
  }
  return modifiers;
}

function callableModifiers(
  node: Node,
  fd: Node | undefined,
  container: CppContainer,
  extraModifiers: readonly string[],
): readonly string[] {
  const modifiers = [...modifiersOf(node, container.access)];
  if (fd !== undefined) {
    for (const child of fd.namedChildren) {
      const text = modifierText(child);
      if (text !== undefined && !modifiers.includes(text)) {
        modifiers.push(text);
      }
    }
  }
  for (const modifier of extraModifiers) {
    if (!modifiers.includes(modifier)) {
      modifiers.push(modifier);
    }
  }
  return modifiers;
}

function modifierText(node: Node): string | undefined {
  if (MODIFIER_NODE_TYPES.has(node.type)) {
    return node.text.trim();
  }
  if (MODIFIER_KEYWORDS.has(node.type)) {
    return node.type;
  }
  return undefined;
}

function addModifier(symbol: CodeSymbol, modifier: string): CodeSymbol {
  return symbol.modifiers.includes(modifier)
    ? symbol
    : { ...symbol, modifiers: [...symbol.modifiers, modifier] };
}

function simpleTypeName(qualified: string): string {
  const segments = qualified.split("::");
  return segments.at(-1) ?? qualified;
}

function normalizeType(text: string | undefined): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
}

function optionalReturnType(returnType: string | undefined): { readonly returnType?: string } {
  return returnType !== undefined ? { returnType } : {};
}

function optionalParams(params: string | undefined): { readonly params?: string } {
  const normalized = normalizeParams(params);
  return normalized !== undefined ? { params: normalized } : {};
}

function extractInvocations(root: Node): readonly FileInvocation[] {
  const invocations: FileInvocation[] = [];
  for (const call of root.descendantsOfType("call_expression")) {
    const name = calleeName(call.childForFieldName("function"));
    if (name !== undefined) {
      invocations.push({ name, line: call.startPosition.row + 1 });
    }
  }
  for (const creation of root.descendantsOfType("new_expression")) {
    const type = normalizeType(creation.childForFieldName("type")?.text);
    if (type !== undefined) {
      invocations.push({ name: type, line: creation.startPosition.row + 1 });
    }
  }
  return invocations;
}

function calleeName(node: Node | null | undefined): string | undefined {
  if (node === null || node === undefined) {
    return undefined;
  }
  switch (node.type) {
    case "identifier":
    case "field_identifier":
    case "type_identifier":
    case "namespace_identifier":
      return node.text;
    case "field_expression":
      return node.childForFieldName("field")?.text;
    case "qualified_identifier":
      return declaratorName(node.childForFieldName("name"))?.name;
    case "template_function":
    case "template_method":
      return calleeName(node.childForFieldName("name"));
    case "parenthesized_expression":
      return calleeName(node.namedChildren.at(0));
    default:
      return undefined;
  }
}

/** 签名渲染（C++ 形态）：`int Point::sum() const` / `class Calculator` / `int x` */
export function renderCppSignature(symbol: CodeSymbol): string {
  const mods = symbol.modifiers.length > 0 ? `${symbol.modifiers.join(" ")} ` : "";
  const ret = symbol.returnType !== undefined ? `${symbol.returnType} ` : "";
  switch (symbol.kind) {
    case "class":
    case "struct":
    case "enum":
    case "namespace":
    case "interface":
      return `${mods}${symbol.kind} ${symbol.name}`;
    case "type-alias": {
      const typedef = symbol.modifiers.includes("typedef");
      const prefix = symbol.modifiers.filter((modifier) => modifier !== "typedef");
      const lead = typedef ? "typedef " : prefix.length > 0 ? `${prefix.join(" ")} ` : "";
      return `${lead}${typedef ? "" : "using "}${symbol.name}`;
    }
    case "function":
    case "method":
    case "constructor": {
      const owner = symbol.kind !== "function" && symbol.owner !== undefined ? `${symbol.owner}::` : "";
      return `${mods}${ret}${owner}${symbol.name}${symbol.params ?? "()"}`;
    }
    case "field":
      return `${mods}${ret}${symbol.name}`;
    case "enum-constant":
      return symbol.name;
    default:
      return `${mods}${symbol.name}`;
  }
}
