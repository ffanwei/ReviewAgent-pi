import type { Node, Parser } from "web-tree-sitter";
import type { CodeSymbol, FileInvocation, FileSymbolIndex, SymbolKind } from "../symbols.js";
import { normalizeParams } from "../symbols.js";

/**
 * Python 符号提取器（ADR-0041）。
 *
 * 覆盖范围（测量常量面，名字级、无类型解析）：
 * - 顶层：class / def / async def / 顶层赋值；
 * - 类成员：method / async method / 类属性 / 嵌套类；
 * - 装饰器：`@property` / `@staticmethod` 等按源码顺序记为修饰符；
 * - 调用点：call（`foo()` 与 `obj.foo()` 都取最后一段名字）。
 *
 * 模块名由仓库路径推导（`pkg/sub/mod.py` → `pkg.sub.mod`）；
 * 嵌套函数不提取（只保留类成员与顶层声明，避免把局部实现当公共符号）。
 */

export function extractPythonFile(parser: Parser, file: string, source: string): FileSymbolIndex {
  const tree = parser.parse(source);
  if (tree === null) {
    return { file, moduleName: pythonModuleName(file), parseError: true, symbols: [], invocations: [] };
  }
  const root = tree.rootNode;
  return {
    file,
    moduleName: pythonModuleName(file),
    parseError: root.hasError,
    symbols: extractModuleMembers(root),
    invocations: extractInvocations(root),
  };
}

/** 模块名：去 .py、路径分段用点连接、`__init__` 收成包名 */
export function pythonModuleName(file: string): string {
  const normalized = file.replace(/\\/g, "/");
  const withoutSuffix = normalized.endsWith(".py") ? normalized.slice(0, -3) : normalized;
  const segments = withoutSuffix.split("/").filter((segment) => segment.length > 0);
  if (segments.at(-1) === "__init__") {
    segments.pop();
  }
  return segments.join(".");
}

function extractModuleMembers(module: Node): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  for (const child of module.namedChildren) {
    const symbol = extractDeclaration(child, false);
    if (symbol !== undefined) {
      symbols.push(symbol);
    }
  }
  return symbols;
}

/** 类体成员（block 的直接子节点；方法体内的嵌套函数不在直接子节点里） */
function extractClassMembers(body: Node): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  for (const child of body.namedChildren) {
    const symbol = extractDeclaration(child, true);
    if (symbol !== undefined) {
      symbols.push(symbol);
    }
  }
  return symbols;
}

function extractDeclaration(node: Node, insideClass: boolean): CodeSymbol | undefined {
  if (node.type === "decorated_definition") {
    const definition = node.childForFieldName("definition");
    if (definition === null || definition === undefined) {
      return undefined;
    }
    const symbol = extractDeclaration(definition, insideClass);
    if (symbol === undefined) {
      return undefined;
    }
    return { ...symbol, modifiers: [...decoratorsOf(node), ...symbol.modifiers] };
  }
  if (node.type === "class_definition") {
    const body = node.childForFieldName("body");
    return {
      kind: "class",
      name: node.childForFieldName("name")?.text ?? "(anonymous)",
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      modifiers: asyncModifier(node),
      members: body !== null && body !== undefined ? extractClassMembers(body) : [],
    };
  }
  if (node.type === "function_definition") {
    return functionSymbol(node, insideClass ? "method" : "function");
  }
  if (node.type === "expression_statement") {
    const assignment = node.namedChildren.find((child) => child.type === "assignment");
    if (assignment !== undefined) {
      return fieldSymbol(assignment);
    }
  }
  return undefined;
}

function functionSymbol(node: Node, kind: SymbolKind): CodeSymbol {
  const params = normalizeParams(node.childForFieldName("parameters")?.text);
  const returnType = node.childForFieldName("return_type")?.text.trim();
  return {
    kind,
    name: node.childForFieldName("name")?.text ?? "(anonymous)",
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    modifiers: asyncModifier(node),
    ...(returnType !== undefined && returnType.length > 0 ? { returnType } : {}),
    ...(params !== undefined ? { params } : {}),
    members: [],
  };
}

function fieldSymbol(assignment: Node): CodeSymbol | undefined {
  const left = assignment.childForFieldName("left");
  if (left === null || left === undefined || left.type !== "identifier") {
    return undefined;
  }
  const returnType = assignment.childForFieldName("type")?.text.trim();
  return {
    kind: "field",
    name: left.text,
    line: assignment.startPosition.row + 1,
    endLine: assignment.endPosition.row + 1,
    modifiers: [],
    ...(returnType !== undefined && returnType.length > 0 ? { returnType } : {}),
    members: [],
  };
}

function asyncModifier(node: Node): readonly string[] {
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i)?.type === "async") {
      return ["async"];
    }
  }
  return [];
}

/** 装饰器名（`@property` → "property"；`@app.route("/x")` → "app.route"） */
function decoratorsOf(node: Node): readonly string[] {
  const names: string[] = [];
  for (const child of node.namedChildren) {
    if (child.type !== "decorator") {
      continue;
    }
    const text = child.text.replace(/^@/, "").trim();
    const name = text.split("(")[0]?.trim() ?? "";
    if (name.length > 0) {
      names.push(name);
    }
  }
  return names;
}

function extractInvocations(root: Node): readonly FileInvocation[] {
  const invocations: FileInvocation[] = [];
  for (const call of root.descendantsOfType("call")) {
    const fn = call.childForFieldName("function");
    const name = calleeName(fn);
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
  if (node.type === "identifier") {
    return node.text;
  }
  if (node.type === "attribute") {
    return node.childForFieldName("attribute")?.text;
  }
  return undefined;
}

/** 签名渲染（Python 形态）：`def fetch(self, url: str) -> bytes` / `x: int` */
export function renderPythonSignature(symbol: CodeSymbol): string {
  const asyncPrefix = symbol.modifiers.includes("async") ? "async " : "";
  const decorators = symbol.modifiers
    .filter((modifier) => modifier !== "async")
    .map((modifier) => `@${modifier} `)
    .join("");
  const ret = symbol.returnType !== undefined ? ` -> ${symbol.returnType}` : "";
  switch (symbol.kind) {
    case "class":
      return `${decorators}class ${symbol.name}`;
    case "function":
    case "method":
    case "constructor":
      return `${decorators}${asyncPrefix}def ${symbol.name}${symbol.params ?? "()"}${ret}`;
    case "field":
    case "property": {
      const typeSuffix = symbol.returnType !== undefined ? `: ${symbol.returnType}` : "";
      return `${decorators}${symbol.name}${typeSuffix}`;
    }
    case "enum-constant":
      return symbol.name;
    default:
      return `${decorators}${symbol.name}`;
  }
}
