import { expect, test } from "vitest";
import { getGoParser } from "../../codeintel/go-parser.js";
import { extractGoFile, extractGoPackageFromHead, renderGoSignature } from "./go.js";
import type { CodeSymbol } from "../symbols.js";

// Go 符号提取器（ADR-0042）：名字级、AST 文档顺序；方法接收者记入 owner；
// struct 字段支持一行多名字与嵌入字段；package 子句是模块名。

const SOURCE = [
  "package service", // 1
  "", // 2
  'import "fmt"', // 3
  "", // 4
  "type Greeter struct {", // 5
  "    Name string", // 6
  "    Age, Score int", // 7
  "    Embedded", // 8
  "    *PointerEmbedded", // 9
  "}", // 10
  "", // 11
  "type Speaker interface {", // 12
  "    Speak(msg string) error", // 13
  "}", // 14
  "", // 15
  "type ID = int", // 16
  "", // 17
  "type Counter int", // 18
  "", // 19
  "const (", // 20
  "    MaxName = 10", // 21
  "    MinName", // 22
  ")", // 23
  "", // 24
  "var (", // 25
  '    defaultName, defaultAge = "x", 1', // 26
  ")", // 27
  "", // 28
  "func NewGreeter(name string, age int) *Greeter {", // 29
  "    return &Greeter{Name: name, Age: age}", // 30
  "}", // 31
  "", // 32
  "func (g *Greeter) Speak(msg string) error {", // 33
  "    fmt.Println(msg)", // 34
  "    return nil", // 35
  "}", // 36
  "", // 37
  "func run() {", // 38
  '    g := NewGreeter("x", 1)', // 39
  '    _ = g.Speak("hi")', // 40
  "}", // 41
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

test("extractGoFile：package / struct / interface / 类型别名 / const / var / 方法", async () => {
  const parser = await getGoParser();
  const index = extractGoFile(parser, "service/cmd/main.go", SOURCE);
  expect(index.file).toBe("service/cmd/main.go");
  expect(index.moduleName).toBe("service");
  expect(index.parseError).toBe(false);
  expect(index.symbols.map((symbol) => `${symbol.kind}:${symbol.name}`)).toEqual([
    "struct:Greeter",
    "interface:Speaker",
    "type-alias:ID",
    "type-alias:Counter",
    "field:MaxName",
    "field:MinName",
    "field:defaultName",
    "field:defaultAge",
    "function:NewGreeter",
    "method:Speak",
    "function:run",
  ]);

  const greeter = find(index.symbols, "Greeter");
  expect(greeter.line).toBe(5);
  expect(greeter.members.map((member) => `${member.kind}:${member.name}`)).toEqual([
    "field:Name",
    "field:Age",
    "field:Score",
    "field:Embedded",
    "field:PointerEmbedded",
  ]);
  expect(find(index.symbols, "Age").returnType).toBe("int");
  expect(find(index.symbols, "Embedded").returnType).toBe("Embedded");

  expect(find(index.symbols, "Speaker").members.map((member) => member.name)).toEqual(["Speak"]);
  const speakDeclarations = findAll(index.symbols, "Speak");
  expect(speakDeclarations.map((symbol) => symbol.owner)).toEqual([undefined, "Greeter"]);
  expect(speakDeclarations[1]?.params).toBe("(msg string)");
  expect(speakDeclarations[1]?.returnType).toBe("error");

  expect(find(index.symbols, "ID").modifiers).toEqual(["alias"]);
  expect(find(index.symbols, "ID").returnType).toBe("int");
  expect(find(index.symbols, "Counter").modifiers).toEqual([]);
  expect(find(index.symbols, "MaxName").modifiers).toEqual(["const"]);
  expect(find(index.symbols, "defaultAge").returnType).toBeUndefined();

  expect(find(index.symbols, "NewGreeter").params).toBe("(name string, age int)");
  expect(find(index.symbols, "NewGreeter").returnType).toBe("*Greeter");
});

test("extractGoFile：调用点名字级提取（identifier 与 selector 都取被调名字）", async () => {
  const parser = await getGoParser();
  const index = extractGoFile(parser, "service/cmd/main.go", SOURCE);
  const names = index.invocations.map((invocation) => invocation.name);
  expect(names).toContain("NewGreeter");
  expect(names).toContain("Println");
  expect(names).toContain("Speak");
  expect(index.invocations.find((invocation) => invocation.name === "Speak")?.line).toBe(40);
});

test("renderGoSignature：函数 / 方法接收者 / 类型别名 / 字段形态", async () => {
  const parser = await getGoParser();
  const index = extractGoFile(parser, "service/cmd/main.go", SOURCE);
  expect(renderGoSignature(find(index.symbols, "Greeter"))).toBe("struct Greeter");
  expect(
    renderGoSignature(findAll(index.symbols, "Speak").find((symbol) => symbol.owner === "Greeter")!),
  ).toBe("func (Greeter) Speak(msg string) error");
  expect(renderGoSignature(find(index.symbols, "NewGreeter"))).toBe(
    "func NewGreeter(name string, age int) *Greeter",
  );
  expect(renderGoSignature(find(index.symbols, "ID"))).toBe("type ID = int");
  expect(renderGoSignature(find(index.symbols, "Counter"))).toBe("type Counter int");
  expect(renderGoSignature(find(index.symbols, "MaxName"))).toBe("const MaxName");
  expect(renderGoSignature(find(index.symbols, "Name"))).toBe("Name string");
});

test("extractGoPackageFromHead：词法包名（注释/空文件 → 空串）", () => {
  expect(extractGoPackageFromHead('package service\n\nimport "fmt"')).toBe("service");
  expect(extractGoPackageFromHead("// package comment\npackage pkg")).toBe("pkg");
  expect(extractGoPackageFromHead("")).toBe("");
});

test("extractGoFile：泛型接收者与嵌入字段取基类型名（不把类型参数当类型）", async () => {
  const parser = await getGoParser();
  const source = [
    "package demo",
    "",
    "type Box[T any] struct {",
    "    Value T",
    "}",
    "",
    "func (b Box[T]) Get() T {",
    "    return b.Value",
    "}",
  ].join("\n");
  const index = extractGoFile(parser, "demo/box.go", source);
  const get = findAll(index.symbols, "Get")[0];
  expect(get?.owner).toBe("Box");
  expect(find(index.symbols, "Value").returnType).toBe("T");
});

test("extractGoFile：语法错误置 parseError 并留痕（不静默丢弃）", async () => {
  const parser = await getGoParser();
  const index = extractGoFile(parser, "broken.go", "package broken\nfunc broken(\n");
  expect(index.parseError).toBe(true);
});
