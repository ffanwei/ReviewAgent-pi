import { expect, test } from "vitest";
import { getTsxParser, getTypeScriptParser } from "../../codeintel/typescript-parser.js";
import { extractTypeScriptFile, renderTypeScriptSignature } from "./typescript.js";
import type { CodeSymbol } from "../symbols.js";

// TypeScript / JavaScript 符号提取器（ADR-0041）：名字级、AST 文档顺序；
// 顶层函数/箭头函数与类方法同等对待（isCallableKind），模块名留空。

const SOURCE = [
  'import { X } from "./x";', // 1
  "", // 2
  "export interface Shape {", // 3
  "  readonly name: string;", // 4
  "  area(scale: number): number;", // 5
  "}", // 6
  "", // 7
  "export abstract class Base<T> implements Shape {", // 8
  "  private count = 0;", // 9
  '  static readonly TAG = "t";', // 10
  "  constructor(public label: string) {}", // 11
  "  abstract area(scale: number): number;", // 12
  "  async load(id: string): Promise<void> {}", // 13
  '  static create(): Base<string> { return new Base<string>("x"); }', // 14
  "}", // 15
  "", // 16
  "export enum Color { RED, GREEN = 2 }", // 17
  "", // 18
  "export type Alias = string | number;", // 19
  "", // 20
  "export namespace NS {", // 21
  "  export function inner(): void {}", // 22
  "}", // 23
  "", // 24
  "export function greet(name: string): string {", // 25
  "  return shout(name);", // 26
  "}", // 27
  "", // 28
  "export const shout = (text: string): string => text.toUpperCase();", // 29
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

function findNested(root: readonly CodeSymbol[], container: string, name: string): CodeSymbol {
  return find(find(root, container).members, name);
}

test("extractTypeScriptFile：顶层类型 / 接口 / 枚举 / 别名 / 命名空间 / 函数", async () => {
  const parser = await getTypeScriptParser();
  const index = extractTypeScriptFile(parser, "web/src/app.ts", SOURCE);
  expect(index.file).toBe("web/src/app.ts");
  expect(index.moduleName).toBe("");
  expect(index.parseError).toBe(false);
  expect(index.symbols.map((symbol) => `${symbol.kind}:${symbol.name}`)).toEqual([
    "interface:Shape",
    "class:Base",
    "enum:Color",
    "type-alias:Alias",
    "namespace:NS",
    "function:greet",
    "function:shout",
  ]);

  const shape = find(index.symbols, "Shape");
  expect(shape.line).toBe(3);
  expect(findNested(index.symbols, "Shape", "name").kind).toBe("property");
  expect(findNested(index.symbols, "Shape", "name").returnType).toBe("string");
  expect(findNested(index.symbols, "Shape", "area").kind).toBe("method");
  expect(findNested(index.symbols, "Shape", "area").params).toBe("(scale: number)");
  expect(findNested(index.symbols, "Shape", "area").returnType).toBe("number");

  const base = find(index.symbols, "Base");
  expect(base.modifiers).toEqual(["abstract"]);
  expect(base.members.map((member) => `${member.kind}:${member.name}`)).toEqual([
    "field:count",
    "field:TAG",
    "constructor:constructor",
    "method:area",
    "method:load",
    "method:create",
  ]);
  expect(findNested(index.symbols, "Base", "count").modifiers).toEqual(["private"]);
  expect(findNested(index.symbols, "Base", "TAG").modifiers).toEqual(["static", "readonly"]);
  expect(findNested(index.symbols, "Base", "area").modifiers).toEqual(["abstract"]);
  expect(findNested(index.symbols, "Base", "load").modifiers).toEqual(["async"]);
  expect(findNested(index.symbols, "Base", "load").returnType).toBe("Promise<void>");

  // 枚举常量按声明顺序
  expect(find(index.symbols, "Color").members.map((member) => member.name)).toEqual([
    "RED",
    "GREEN",
  ]);
  // namespace 成员摊平在 namespace 之下
  expect(findNested(index.symbols, "NS", "inner").kind).toBe("function");
  // 箭头函数与 function 声明同等对待
  expect(find(index.symbols, "shout").kind).toBe("function");
  expect(find(index.symbols, "shout").params).toBe("(text: string)");
  expect(find(index.symbols, "shout").returnType).toBe("string");
});

test("extractTypeScriptFile：调用点名字级提取（call + new，无类型解析）", async () => {
  const parser = await getTypeScriptParser();
  const index = extractTypeScriptFile(parser, "web/src/app.ts", SOURCE);
  const names = index.invocations.map((invocation) => invocation.name);
  expect(names).toContain("shout");
  expect(names).toContain("toUpperCase");
  expect(names).toContain("Base");
  expect(index.invocations.find((invocation) => invocation.name === "shout")?.line).toBe(26);
  expect(index.invocations.find((invocation) => invocation.name === "Base")?.line).toBe(14);
});

test("renderTypeScriptSignature：类 / 方法 / 函数 / 构造器 / 字段形态", async () => {
  const parser = await getTypeScriptParser();
  const index = extractTypeScriptFile(parser, "web/src/app.ts", SOURCE);
  expect(renderTypeScriptSignature(find(index.symbols, "Base"))).toBe("abstract class Base");
  expect(renderTypeScriptSignature(findNested(index.symbols, "Base", "load"))).toBe(
    "async load(id: string): Promise<void>",
  );
  expect(renderTypeScriptSignature(findNested(index.symbols, "Base", "constructor"))).toBe(
    "constructor(public label: string)",
  );
  expect(renderTypeScriptSignature(find(index.symbols, "greet"))).toBe(
    "function greet(name: string): string",
  );
  expect(renderTypeScriptSignature(findNested(index.symbols, "Shape", "name"))).toBe(
    "readonly name: string",
  );
});

test("extractTypeScriptFile：tsx 变体解析 JSX 组件（JSX 不是 typescript 语法子集）", async () => {
  const parser = await getTsxParser();
  const source = [
    "export function Badge(props: { label: string }) {", // 1
    "  return <span>{props.label}</span>;", // 2
    "}", // 3
  ].join("\n");
  const index = extractTypeScriptFile(parser, "web/src/view.tsx", source);
  expect(index.parseError).toBe(false);
  expect(index.symbols.map((symbol) => `${symbol.kind}:${symbol.name}`)).toEqual([
    "function:Badge",
  ]);
  expect(index.symbols[0]?.params).toBe("(props: { label: string })");
});
