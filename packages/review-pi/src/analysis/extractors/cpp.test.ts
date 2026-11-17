import { expect, test } from "vitest";
import { getCppParser } from "../../codeintel/cpp-parser.js";
import { extractCppFile, renderCppSignature } from "./cpp.js";
import type { CodeSymbol } from "../symbols.js";

// C/C++ 符号提取器（ADR-0042）：名字级、AST 文档顺序；类外定义的限定作用域
// 记入 owner；C 与 C++ 共用 cpp 语法（ADR-0041）。

const SOURCE = [
  "namespace demo {", // 1
  "", // 2
  "class Calculator {", // 3
  "public:", // 4
  "    explicit Calculator(int base);", // 5
  "    int add(int value) const;", // 6
  "    static Calculator make(int base);", // 7
  "private:", // 8
  "    int base_;", // 9
  "    int min_, max_;", // 10
  "};", // 11
  "", // 12
  "Calculator::Calculator(int base) : base_(base) {}", // 13
  "", // 14
  "int Calculator::add(int value) const {", // 15
  "    return base_ + value;", // 16
  "}", // 17
  "", // 18
  "Calculator Calculator::make(int base) {", // 19
  "    return Calculator(base);", // 20
  "}", // 21
  "", // 22
  "struct Point {", // 23
  "    int x;", // 24
  "    int y;", // 25
  "    int sum() const;", // 26
  "};", // 27
  "", // 28
  "int Point::sum() const {", // 29
  "    Point p{1, 2};", // 30
  "    return p.x + p.y;", // 31
  "}", // 32
  "", // 33
  "enum Color { Red, Green = 3 };", // 34
  "", // 35
  "using IntAlias = int;", // 36
  "", // 37
  "typedef struct Named { int v; } Named;", // 38
  "", // 39
  "template <typename T>", // 40
  "T maxOf(T a, T b) {", // 41
  "    return a > b ? a : b;", // 42
  "}", // 43
  "", // 44
  "int caller() {", // 45
  "    Calculator c(1);", // 46
  "    auto p = Point{1, 2};", // 47
  "    int* raw = new int(3);", // 48
  "    delete raw;", // 49
  "    return c.add(p.sum());", // 50
  "}", // 51
  "", // 52
  "} // namespace demo", // 53
].join("\n");

function find(root: readonly CodeSymbol[], name: string): CodeSymbol {
  for (const symbol of root) {
    if (symbol.name === name) {
      return symbol;
    }
    const nested = find(symbol.members, name);
    if (nested.name !== "") {
      return nested;
    }
  }
  return { kind: "class", name: "", line: 0, endLine: 0, modifiers: [], members: [] };
}

function findAll(root: readonly CodeSymbol[], name: string): CodeSymbol[] {
  const matches: CodeSymbol[] = [];
  for (const symbol of root) {
    if (symbol.name === name) {
      matches.push(symbol);
    }
    matches.push(...findAll(symbol.members, name));
  }
  return matches;
}

test("extractCppFile：namespace / class / 成员 / 类外定义 / enum / alias / typedef / template", async () => {
  const parser = await getCppParser();
  const index = extractCppFile(parser, "native/src/math.cpp", SOURCE);
  expect(index.file).toBe("native/src/math.cpp");
  expect(index.moduleName).toBe("");
  expect(index.parseError).toBe(false);
  expect(index.symbols.map((symbol) => `${symbol.kind}:${symbol.name}`)).toEqual([
    "namespace:demo",
  ]);

  const demo = find(index.symbols, "demo");
  expect(demo.members.map((member) => `${member.kind}:${member.name}`)).toEqual([
    "class:Calculator",
    "constructor:Calculator",
    "method:add",
    "method:make",
    "struct:Point",
    "method:sum",
    "enum:Color",
    "type-alias:IntAlias",
    "struct:Named",
    "function:maxOf",
    "function:caller",
  ]);

  const calculator = find(demo.members, "Calculator");
  expect(calculator.line).toBe(3);
  expect(calculator.members.map((member) => `${member.kind}:${member.name}`)).toEqual([
    "constructor:Calculator",
    "method:add",
    "method:make",
    "field:base_",
    "field:min_",
    "field:max_",
  ]);
  expect(find(calculator.members, "Calculator").modifiers).toEqual(["public", "explicit"]);
  expect(find(calculator.members, "add").returnType).toBe("int");
  expect(find(calculator.members, "add").params).toBe("(int value)");
  expect(find(calculator.members, "add").modifiers).toEqual(["public", "const"]);
  expect(find(calculator.members, "make").modifiers).toEqual(["public", "static"]);
  expect(find(calculator.members, "min_").returnType).toBe("int");
  expect(find(calculator.members, "min_").modifiers).toEqual(["private"]);

  // 类外定义：限定作用域进 owner，且与类内原型是同一名字的不同声明
  const addDefinitions = findAll(demo.members, "add");
  expect(addDefinitions.map((symbol) => symbol.owner)).toEqual([
    "Calculator",
    "Calculator",
  ]);
  expect(addDefinitions[1]?.modifiers).toEqual(["const"]);

  const point = find(demo.members, "Point");
  expect(point.kind).toBe("struct");
  expect(point.members.map((member) => member.name)).toEqual(["x", "y", "sum"]);

  expect(find(demo.members, "Color").members.map((member) => member.name)).toEqual([
    "Red",
    "Green",
  ]);
  expect(find(demo.members, "IntAlias").kind).toBe("type-alias");
  expect(find(demo.members, "Named").kind).toBe("struct");
  expect(find(demo.members, "maxOf").kind).toBe("function");
  expect(find(demo.members, "maxOf").params).toBe("(T a, T b)");
});

test("extractCppFile：调用点（方法调用 / 模板函数 / new）", async () => {
  const parser = await getCppParser();
  const index = extractCppFile(parser, "native/src/math.cpp", SOURCE);
  const names = index.invocations.map((invocation) => invocation.name);
  expect(names).toContain("Calculator");
  expect(names).toContain("add");
  expect(names).toContain("sum");
  expect(names).toContain("int");
  expect(index.invocations.find((invocation) => invocation.name === "sum")?.line).toBe(50);
});

test("renderCppSignature：类 / 方法 / 类外定义 / 字段 / alias 形态", async () => {
  const parser = await getCppParser();
  const index = extractCppFile(parser, "native/src/math.cpp", SOURCE);
  const demo = find(index.symbols, "demo");
  const calculator = find(demo.members, "Calculator");
  expect(renderCppSignature(calculator)).toBe("class Calculator");
  expect(renderCppSignature(find(calculator.members, "add"))).toBe(
    "public const int Calculator::add(int value)",
  );
  expect(renderCppSignature(find(calculator.members, "min_"))).toBe("private int min_");
  expect(renderCppSignature(findAll(demo.members, "add")[1]!)).toBe(
    "const int Calculator::add(int value)",
  );
  expect(renderCppSignature(find(demo.members, "IntAlias"))).toBe("using IntAlias");
  expect(renderCppSignature(find(demo.members, "Named"))).toBe("struct Named");
});

test("extractCppFile：typedef 匿名 struct 以别名命名，成员 owner 跟随别名", async () => {
  const parser = await getCppParser();
  const source = [
    "namespace demo {",
    "typedef struct {",
    "    void run();",
    "} AnonymousAlias;",
    "}",
  ].join("\n");
  const index = extractCppFile(parser, "demo/alias.cpp", source);
  const alias = find(index.symbols, "AnonymousAlias");
  expect(alias.kind).toBe("struct");
  expect(alias.members.map((member) => `${member.kind}:${member.name}`)).toEqual([
    "method:run",
  ]);
  expect(alias.members[0]?.owner).toBe("AnonymousAlias");
});

test("extractCppFile：语法错误置 parseError 并留痕（不静默丢弃）", async () => {
  const parser = await getCppParser();
  const index = extractCppFile(parser, "broken.cpp", "int broken( {\n");
  expect(index.parseError).toBe(true);
});
