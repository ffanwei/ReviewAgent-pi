import type { Node, Parser } from "web-tree-sitter";
import type { CodeSymbol, FileInvocation, FileSymbolIndex, SymbolKind } from "../symbols.js";
import { normalizeParams } from "../symbols.js";

/**
 * TypeScript / JavaScript 符号提取器（ADR-0041）。
 *
 * 覆盖范围（测量常量面，名字级、无类型解析）：
 * - 顶层：class / abstract class / interface / enum / type alias / namespace /
 *   function / const 箭头函数；
 * - 类成员：method / abstract method / constructor / 字段；
 * - 接口成员：method signature / property signature；
 * - 调用点：call_expression 与 new_expression（名字级）。
 *
 * 模块名留空：TS/JS 的「模块」由解析器/打包器决定，仓库路径推导会编造语义。
 */

const TS_ACCESSIBILITY = new Set(["public", "private", "protected", "static", "abstract", "readonly", "async", "declare", "override", "get", "set"]);

const CLASS_TYPES = new Set(["class_declaration", "abstract_class_declaration"]);

export function extractTypeScriptFile(
  parser: Parser,
  file: string,
  source: string,
): FileSymbolIndex {
  const tree = parser.parse(source);
  if (tree === null) {
    return { file, moduleName: "", parseError: true, symbols: [], invocations: [] };
  }
  const root = tree.rootNode;
  const symbols = extractContainerMembers(root, "top");
  return {
    file,
    moduleName: "",
    parseError: root.hasError,
    symbols,
    invocations: extractInvocations(root),
  };
}

type ContainerKind = "top" | "class" | "interface" | "namespace";

function extractContainerMembers(node: Node, container: ContainerKind): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  for (const child of node.namedChildren) {
    const symbol = extractDeclaration(child, container);
    if (symbol !== undefined) {
      symbols.push(symbol);
      continue;
    }
    // namespace / top-level 里的 export 包装：摊平到同一层
    if (child.type === "export_statement" || child.type === "ambient_declaration") {
      const declaration = child.childForFieldName("declaration") ?? child.namedChildren.at(0);
      if (declaration !== undefined) {
        const nested = extractDeclaration(declaration, container);
        if (nested !== undefined) {
          symbols.push(nested);
        } else {
          symbols.push(...extractContainerMembers(declaration, container));
        }
      }
    }
  }
  return symbols;
}

function extractDeclaration(node: Node, container: ContainerKind): CodeSymbol | undefined {
  if (CLASS_TYPES.has(node.type)) {
    const body = node.childForFieldName("body");
    return {
      kind: "class",
      name: node.childForFieldName("name")?.text ?? "(anonymous)",
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      modifiers: modifiersOf(node, node.type === "abstract_class_declaration"),
      members: body !== null && body !== undefined ? extractContainerMembers(body, "class") : [],
    };
  }
  if (node.type === "interface_declaration") {
    const body = node.childForFieldName("body");
    return {
      kind: "interface",
      name: node.childForFieldName("name")?.text ?? "(anonymous)",
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      modifiers: modifiersOf(node, false),
      members: body !== null && body !== undefined ? extractContainerMembers(body, "interface") : [],
    };
  }
  if (node.type === "enum_declaration") {
    const body = node.childForFieldName("body");
    return {
      kind: "enum",
      name: node.childForFieldName("name")?.text ?? "(anonymous)",
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      modifiers: modifiersOf(node, false),
      members: body !== null && body !== undefined ? extractEnumMembers(body) : [],
    };
  }
  if (node.type === "type_alias_declaration") {
    return {
      kind: "type-alias",
      name: node.childForFieldName("name")?.text ?? "(anonymous)",
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      modifiers: modifiersOf(node, false),
      members: [],
    };
  }
  if (node.type === "internal_module") {
    const body = node.childForFieldName("body");
    return {
      kind: "namespace",
      name: node.childForFieldName("name")?.text ?? "(anonymous)",
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      modifiers: modifiersOf(node, false),
      members: body !== null && body !== undefined ? extractContainerMembers(body, "namespace") : [],
    };
  }
  if (node.type === "function_declaration" || node.type === "generator_function_declaration") {
    return callableSymbol(node, "function");
  }
  if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
    return extractArrowFunction(node);
  }
  if (
    container === "class" &&
    (node.type === "method_definition" || node.type === "abstract_method_signature")
  ) {
    const name = node.childForFieldName("name")?.text ?? "(anonymous)";
    return callableSymbol(node, name === "constructor" ? "constructor" : "method");
  }
  if (container === "class" && node.type === "public_field_definition") {
    return fieldSymbol(node, "field");
  }
  if (container === "interface" && node.type === "method_signature") {
    return callableSymbol(node, "method");
  }
  if (container === "interface" && node.type === "property_signature") {
    return fieldSymbol(node, "property");
  }
  return undefined;
}

function callableSymbol(node: Node, kind: SymbolKind): CodeSymbol {
  const params = normalizeParams(node.childForFieldName("parameters")?.text);
  const returnType = typeAnnotationText(node.childForFieldName("return_type")?.text);
  return {
    kind,
    name: node.childForFieldName("name")?.text ?? "(anonymous)",
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    modifiers: modifiersOf(node, false),
    ...(returnType !== undefined ? { returnType } : {}),
    ...(params !== undefined ? { params } : {}),
    members: [],
  };
}

function fieldSymbol(node: Node, kind: "field" | "property"): CodeSymbol {
  const returnType = typeAnnotationText(node.childForFieldName("type")?.text);
  return {
    kind,
    name: node.childForFieldName("name")?.text ?? "(unknown)",
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    modifiers: modifiersOf(node, false),
    ...(returnType !== undefined ? { returnType } : {}),
    members: [],
  };
}

/** `const f = (x) => …` / `const f = function (x) { … }`：提取为 function 符号 */
function extractArrowFunction(node: Node): CodeSymbol | undefined {
  const declarator = node.namedChildren.find((child) => child.type === "variable_declarator");
  if (declarator === undefined) {
    return undefined;
  }
  const value = declarator.childForFieldName("value");
  if (
    value === null ||
    value === undefined ||
    (value.type !== "arrow_function" && value.type !== "function_expression")
  ) {
    return undefined;
  }
  const params = normalizeParams(value.childForFieldName("parameters")?.text);
  const returnType = typeAnnotationText(value.childForFieldName("return_type")?.text);
  return {
    kind: "function",
    name: declarator.childForFieldName("name")?.text ?? "(anonymous)",
    line: declarator.startPosition.row + 1,
    endLine: declarator.endPosition.row + 1,
    modifiers: [],
    ...(returnType !== undefined ? { returnType } : {}),
    ...(params !== undefined ? { params } : {}),
    members: [],
  };
}

function extractEnumMembers(body: Node): CodeSymbol[] {
  const members: CodeSymbol[] = [];
  for (const child of body.namedChildren) {
    if (child.type === "property_identifier") {
      members.push({
        kind: "enum-constant",
        name: child.text,
        line: child.startPosition.row + 1,
        endLine: child.endPosition.row + 1,
        modifiers: [],
        members: [],
      });
      continue;
    }
    if (child.type === "enum_assignment") {
      const name = child.childForFieldName("name")?.text;
      if (name !== undefined) {
        members.push({
          kind: "enum-constant",
          name,
          line: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
          modifiers: [],
          members: [],
        });
      }
    }
  }
  return members;
}

/** 修饰符 = 源码顺序里的关键字（含 accessibility_modifier 节点；abstract class 补 abstract） */
function modifiersOf(node: Node, isAbstract: boolean): readonly string[] {
  const keywords: string[] = isAbstract ? ["abstract"] : [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child === null) {
      continue;
    }
    const text = child.type === "accessibility_modifier" ? child.text : child.type;
    if (TS_ACCESSIBILITY.has(text) && !keywords.includes(text)) {
      keywords.push(text);
    }
  }
  return keywords;
}

function typeAnnotationText(text: string | undefined): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  const trimmed = text.trim();
  const withoutColon = trimmed.startsWith(":") ? trimmed.slice(1).trim() : trimmed;
  return withoutColon.length > 0 ? withoutColon : undefined;
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
    const name = calleeName(creation.childForFieldName("constructor"));
    if (name !== undefined) {
      invocations.push({ name, line: creation.startPosition.row + 1 });
    }
  }
  return invocations;
}

function calleeName(node: Node | null | undefined): string | undefined {
  if (node === null || node === undefined) {
    return undefined;
  }
  if (node.type === "identifier" || node.type === "type_identifier") {
    return node.text;
  }
  if (node.type === "member_expression") {
    return node.childForFieldName("property")?.text;
  }
  return undefined;
}

/** 签名渲染（TS 形态）：`private load(id: string): Promise<void>` / `function greet(name: string): string` */
export function renderTypeScriptSignature(symbol: CodeSymbol): string {
  const mods = symbol.modifiers.length > 0 ? `${symbol.modifiers.join(" ")} ` : "";
  const ret = symbol.returnType !== undefined ? `: ${symbol.returnType}` : "";
  switch (symbol.kind) {
    case "class":
    case "interface":
    case "enum":
    case "namespace":
    case "module":
      return `${mods}${symbol.kind} ${symbol.name}`;
    case "type-alias":
      return `${mods}type ${symbol.name}`;
    case "function":
      return `${mods}function ${symbol.name}${symbol.params ?? "()"}${ret}`;
    case "method":
      return `${mods}${symbol.name}${symbol.params ?? "()"}${ret}`;
    case "constructor":
      return `${mods}constructor${symbol.params ?? "()"}`;
    case "field":
    case "property":
      return `${mods}${symbol.name}${ret}`;
    case "enum-constant":
      return symbol.name;
    default:
      return `${mods}${symbol.name}`;
  }
}
