import type { Node, Parser } from "web-tree-sitter";
import type { CodeSymbol, FileInvocation, FileSymbolIndex, SymbolKind } from "../symbols.js";
import { normalizeParams } from "../symbols.js";

/**
 * Go 符号提取器（ADR-0042）。
 *
 * 覆盖范围（测量常量面，名字级、无类型解析）：
 * - 顶层：package / type（struct / interface / 命名类型 / alias）/ const / var /
 *   function / method；
 * - struct 字段（含一行多名字与嵌入字段）、interface 方法；
 * - 方法接收者记入 `owner`（Go 方法没有类型包裹节点，与 Java/TS 不同）；
 * - 调用点：call_expression（`foo()` 与 `obj.foo()` 都取被调名字）。
 *
 * 模块名 = 文件头部的 `package X`（词法预读与 AST 提取共用同一语义）。
 */

const GO_PACKAGE_PATTERN = /^[ \t]*package[ \t]+([A-Za-z_]\w*)/m;

export function extractGoFile(parser: Parser, file: string, source: string): FileSymbolIndex {
  const tree = parser.parse(source);
  if (tree === null) {
    return { file, moduleName: "", parseError: true, symbols: [], invocations: [] };
  }
  const root = tree.rootNode;
  const symbols: CodeSymbol[] = [];
  for (const child of root.namedChildren) {
    symbols.push(...extractDeclaration(child));
  }
  return {
    file,
    moduleName: goPackageName(root),
    parseError: root.hasError,
    symbols,
    invocations: extractInvocations(root),
  };
}

/** 文件头部词法包名（Go 文件必有 package 子句；缺失 → ""） */
export function extractGoPackageFromHead(head: string): string {
  return GO_PACKAGE_PATTERN.exec(head)?.[1] ?? "";
}

function goPackageName(root: Node): string {
  const clause = root.namedChildren.find((child) => child.type === "package_clause");
  return clause?.namedChildren.find((child) => child.type === "package_identifier")?.text ?? "";
}

function extractDeclaration(node: Node): CodeSymbol[] {
  switch (node.type) {
    case "type_declaration":
      return node.namedChildren
        .filter((child) => child.type === "type_spec" || child.type === "type_alias")
        .flatMap((child) => extractTypeSpec(child));
    case "const_declaration":
      return extractValueSpecs(node, "const_spec", ["const"]);
    case "var_declaration":
      return extractValueSpecs(node, "var_spec", []);
    case "function_declaration":
      return [callableSymbol(node, "function")];
    case "method_declaration":
      return [callableSymbol(node, "method", receiverTypeName(node))];
    default:
      return [];
  }
}

function extractTypeSpec(node: Node): CodeSymbol[] {
  const name = node.childForFieldName("name")?.text ?? "(anonymous)";
  const typeNode = node.childForFieldName("type");
  const line = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;
  if (typeNode === null || typeNode === undefined) {
    return [{ kind: "type-alias", name, line, endLine, modifiers: [], members: [] }];
  }
  if (typeNode.type === "struct_type") {
    return [
      {
        kind: "struct",
        name,
        line,
        endLine,
        modifiers: [],
        members: structMembers(typeNode),
      },
    ];
  }
  if (typeNode.type === "interface_type") {
    return [
      {
        kind: "interface",
        name,
        line,
        endLine,
        modifiers: [],
        members: interfaceMembers(typeNode),
      },
    ];
  }
  // `type ID int` 与 `type ID = int` 都是名字级类型别名；alias 修饰符区分 `=`
  const alias = node.type === "type_alias";
  const underlying = normalizeType(typeNode.text);
  return [
    {
      kind: "type-alias",
      name,
      line,
      endLine,
      modifiers: alias ? ["alias"] : [],
      ...(underlying !== undefined ? { returnType: underlying } : {}),
      members: [],
    },
  ];
}

function structMembers(structType: Node): CodeSymbol[] {
  const list = structType.namedChildren.find((child) => child.type === "field_declaration_list");
  if (list === undefined) {
    return [];
  }
  const members: CodeSymbol[] = [];
  for (const field of list.namedChildren) {
    if (field.type !== "field_declaration") {
      continue;
    }
    const returnType = normalizeType(field.childForFieldName("type")?.text);
    const names = directNames(field);
    if (names.length === 0) {
      // 嵌入字段（`Embedded` / `*PointerEmbedded`）：字段名取基类型名
      const embedded = embeddedFieldName(field.childForFieldName("type"));
      if (embedded !== undefined) {
        members.push(fieldSymbol(field, embedded, returnType));
      }
      continue;
    }
    for (const name of names) {
      members.push(fieldSymbol(field, name, returnType));
    }
  }
  return members;
}

function interfaceMembers(interfaceType: Node): CodeSymbol[] {
  const members: CodeSymbol[] = [];
  for (const member of interfaceType.namedChildren) {
    if (member.type !== "method_elem") {
      continue;
    }
    members.push({
      kind: "method",
      name: member.childForFieldName("name")?.text ?? "(anonymous)",
      line: member.startPosition.row + 1,
      endLine: member.endPosition.row + 1,
      modifiers: [],
      ...optionalReturnType(normalizeType(member.childForFieldName("result")?.text)),
      ...optionalParams(member.childForFieldName("parameters")?.text),
      members: [],
    });
  }
  return members;
}

function extractValueSpecs(
  node: Node,
  specType: "const_spec" | "var_spec",
  modifiers: readonly string[],
): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  for (const spec of collectSpecs(node, specType)) {
    const returnType = normalizeType(spec.childForFieldName("type")?.text);
    for (const name of directNames(spec)) {
      symbols.push({
        kind: "field",
        name,
        line: spec.startPosition.row + 1,
        endLine: spec.endPosition.row + 1,
        modifiers,
        ...optionalReturnType(returnType),
        members: [],
      });
    }
  }
  return symbols;
}

/** 分组声明（`var ( … )` / `const ( … )`）的 spec 层 */
function collectSpecs(node: Node, specType: string): readonly Node[] {
  const direct = node.namedChildren.filter((child) => child.type === specType);
  if (direct.length > 0) {
    return direct;
  }
  return node.namedChildren
    .filter((child) => child.type === "var_spec_list" || child.type === "const_spec_list")
    .flatMap((list) => list.namedChildren.filter((child) => child.type === specType));
}

function callableSymbol(node: Node, kind: SymbolKind, owner?: string): CodeSymbol {
  return {
    kind,
    name: node.childForFieldName("name")?.text ?? "(anonymous)",
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    modifiers: [],
    ...optionalReturnType(normalizeType(node.childForFieldName("result")?.text)),
    ...optionalParams(node.childForFieldName("parameters")?.text),
    ...(owner !== undefined && owner.length > 0 ? { owner } : {}),
    members: [],
  };
}

function fieldSymbol(node: Node, name: string, returnType: string | undefined): CodeSymbol {
  return {
    kind: "field",
    name,
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    modifiers: [],
    ...optionalReturnType(returnType),
    members: [],
  };
}

/** 一行多名字字段：`X, Y int` */
function directNames(node: Node): string[] {
  const names: string[] = [];
  for (let i = 0; i < node.childCount; i += 1) {
    if (node.fieldNameForChild(i) !== "name") {
      continue;
    }
    const child = node.child(i);
    if (child !== null && (child.type === "identifier" || child.type === "field_identifier")) {
      names.push(child.text);
    }
  }
  return names;
}

/** 嵌入字段名：类型表达式的基类型名（`*pkg.Type` → Type；`Foo[T]` → Foo） */
function embeddedFieldName(typeNode: Node | null | undefined): string | undefined {
  if (typeNode === null || typeNode === undefined) {
    return undefined;
  }
  return baseTypeIdentifier(typeNode);
}

/** 方法接收者类型：`*Greeter` / `Greeter[T]` → Greeter */
function receiverTypeName(node: Node): string | undefined {
  const receiver = node.childForFieldName("receiver");
  const declaration = receiver?.namedChildren.find(
    (child) => child.type === "parameter_declaration",
  );
  const typeNode = declaration?.childForFieldName("type");
  return typeNode !== null && typeNode !== undefined ? baseTypeIdentifier(typeNode) : undefined;
}

/**
 * 类型表达式的基类型名（深度优先取 name/type 字段）：
 * `descendantsOfType(...).at(-1)` 会在 `Greeter[T]` 上取到 `T`，因此不能直接用。
 */
function baseTypeIdentifier(node: Node): string | undefined {
  if (node.type === "type_identifier") {
    return node.text;
  }
  const named = node.childForFieldName("name") ?? node.childForFieldName("type");
  if (named !== null && named !== undefined) {
    return baseTypeIdentifier(named);
  }
  for (const child of node.namedChildren) {
    const found = baseTypeIdentifier(child);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function normalizeType(text: string | undefined): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
}

function optionalReturnType(
  returnType: string | undefined,
): { readonly returnType?: string } {
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
  return invocations;
}

function calleeName(node: Node | null | undefined): string | undefined {
  if (node === null || node === undefined) {
    return undefined;
  }
  switch (node.type) {
    case "identifier":
    case "field_identifier":
      return node.text;
    case "selector_expression":
      return node.childForFieldName("field")?.text;
    case "index_expression":
    case "parenthesized_expression":
      return calleeName(node.namedChildren.at(0));
    default:
      return undefined;
  }
}

/** 签名渲染（Go 形态）：`func (Greeter) Greet() string` / `type ID int` / `Name string` */
export function renderGoSignature(symbol: CodeSymbol): string {
  const mods = symbol.modifiers.length > 0 ? `${symbol.modifiers.join(" ")} ` : "";
  const ret = symbol.returnType !== undefined ? ` ${symbol.returnType}` : "";
  switch (symbol.kind) {
    case "struct":
    case "interface":
      return `${mods}${symbol.kind} ${symbol.name}`;
    case "type-alias":
      return symbol.modifiers.includes("alias")
        ? `type ${symbol.name} = ${symbol.returnType ?? ""}`.trimEnd()
        : `type ${symbol.name}${ret}`;
    case "function":
    case "method":
    case "constructor": {
      const receiver = symbol.owner !== undefined ? `(${symbol.owner}) ` : "";
      return `${mods}func ${receiver}${symbol.name}${symbol.params ?? "()"}${ret}`;
    }
    case "field":
      return `${mods}${symbol.name}${ret}`;
    case "enum-constant":
      return symbol.name;
    default:
      return `${mods}${symbol.name}`;
  }
}
