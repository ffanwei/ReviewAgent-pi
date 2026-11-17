import { expect, test } from "vitest";
import { getJavaParser } from "../codeintel/java-parser.js";
import { extractJavaFile } from "./extractors/java.js";
import {
  formatSymbolSignature,
  innermostSymbols,
  pruneSymbolsToSpans,
  symbolPathAt,
  type CodeSymbol,
} from "./symbols.js";

// 签名级符号索引（测量常量面）：tree-sitter-java 零构建解析，遍历 = AST 文档顺序，
// 同输入同输出。解析失败置 parseError 留痕，不静默丢弃。

const SOURCE = [
  "package com.example.demo;", // 1
  "", // 2
  "import java.util.List;", // 3
  "", // 4
  "public final class MathUtils {", // 5
  "", // 6
  "    private int count;", // 7
  '    public static String label = "x";', // 8
  "", // 9
  "    public MathUtils(int count) {", // 10
  "        this.count = count;", // 11
  "        java.util.List<String> items = new java.util.ArrayList<>();", // 12
  "    }", // 13
  "", // 14
  "    public static int sum(int[] values, int limit) {", // 15
  "        int total = 0;", // 16
  "        for (int i = 0; i < limit; i++) {", // 17
  "            total += values[i];", // 18
  "        }", // 19
  "        return total;", // 20
  "    }", // 21
  "}", // 22
  "", // 23
  "interface Shape {", // 24
  "    double area();", // 25
  "}", // 26
  "", // 27
  "enum Color {", // 28
  "    RED, GREEN;", // 29
  "", // 30
  "    public String pretty() {", // 31
  "        return name().toLowerCase();", // 32
  "    }", // 33
  "}", // 34
  "", // 35
  "record Point(int x, int y) {", // 36
  "    int doubledX() {", // 37
  "        return x * 2;", // 38
  "    }", // 39
  "}", // 40
].join("\n");

test("extractJavaFile：包名 / 类型树 / 成员 / 修饰符 / 参数归一化", async () => {
  const parser = await getJavaParser();
  const index = extractJavaFile(parser, "src/A.java", SOURCE);
  expect(index.file).toBe("src/A.java");
  expect(index.moduleName).toBe("com.example.demo");
  expect(index.parseError).toBe(false);

  expect(index.symbols).toEqual([
    {
      kind: "class",
      name: "MathUtils",
      line: 5,
      endLine: 22,
      modifiers: ["public", "final"],
      members: [
        {
          kind: "field",
          name: "count",
          line: 7,
          endLine: 7,
          modifiers: ["private"],
          returnType: "int",
          members: [],
        },
        {
          kind: "field",
          name: "label",
          line: 8,
          endLine: 8,
          modifiers: ["public", "static"],
          returnType: "String",
          members: [],
        },
        {
          kind: "constructor",
          name: "MathUtils",
          line: 10,
          endLine: 13,
          modifiers: ["public"],
          params: "(int count)",
          members: [],
        },
        {
          kind: "method",
          name: "sum",
          line: 15,
          endLine: 21,
          modifiers: ["public", "static"],
          returnType: "int",
          params: "(int[] values, int limit)",
          members: [],
        },
      ],
    },
    {
      kind: "interface",
      name: "Shape",
      line: 24,
      endLine: 26,
      modifiers: [],
      members: [
        {
          kind: "method",
          name: "area",
          line: 25,
          endLine: 25,
          modifiers: [],
          returnType: "double",
          params: "()",
          members: [],
        },
      ],
    },
    {
      kind: "enum",
      name: "Color",
      line: 28,
      endLine: 34,
      modifiers: [],
      members: [
        { kind: "enum-constant", name: "RED", line: 29, endLine: 29, modifiers: [], members: [] },
        { kind: "enum-constant", name: "GREEN", line: 29, endLine: 29, modifiers: [], members: [] },
        {
          kind: "method",
          name: "pretty",
          line: 31,
          endLine: 33,
          modifiers: ["public"],
          returnType: "String",
          params: "()",
          members: [],
        },
      ],
    },
    {
      kind: "record",
      name: "Point",
      line: 36,
      endLine: 40,
      modifiers: [],
      params: "(int x, int y)",
      members: [
        {
          kind: "method",
          name: "doubledX",
          line: 37,
          endLine: 39,
          modifiers: [],
          returnType: "int",
          params: "()",
          members: [],
        },
      ],
    },
  ]);
});

test("extractJavaFile：调用点 = method_invocation 全量后接 new 表达式全量（各自文档顺序）", async () => {
  const parser = await getJavaParser();
  const index = extractJavaFile(parser, "src/A.java", SOURCE);
  // name().toLowerCase()：外层调用先于内层（pre-order）；
  // new 表达式记 type 字段原文（含钻石操作符）
  expect(index.invocations).toEqual([
    { name: "toLowerCase", line: 32 },
    { name: "name", line: 32 },
    { name: "java.util.ArrayList<>", line: 12 },
  ]);
});

test("extractJavaFile：无法解析的源置 parseError 留痕", async () => {
  const parser = await getJavaParser();
  const index = extractJavaFile(parser, "src/Broken.java", "))) not java [[[");
  expect(index.parseError).toBe(true);
  expect(index.moduleName).toBe("");
});

test("formatSymbolSignature：签名级渲染（不含函数体）", () => {
  const field: CodeSymbol = {
    kind: "field",
    name: "count",
    line: 1,
    endLine: 1,
    modifiers: ["private"],
    returnType: "int",
    members: [],
  };
  expect(formatSymbolSignature(field)).toBe("private int count");

  const method: CodeSymbol = {
    kind: "method",
    name: "sum",
    line: 1,
    endLine: 1,
    modifiers: ["public", "static"],
    returnType: "int",
    params: "(int[] values, int limit)",
    members: [],
  };
  expect(formatSymbolSignature(method)).toBe("public static int sum(int[] values, int limit)");

  const noParams: CodeSymbol = {
    kind: "method",
    name: "area",
    line: 1,
    endLine: 1,
    modifiers: [],
    returnType: "double",
    members: [],
  };
  expect(formatSymbolSignature(noParams)).toBe("double area()");

  const ctor: CodeSymbol = {
    kind: "constructor",
    name: "MathUtils",
    line: 1,
    endLine: 1,
    modifiers: ["public"],
    params: "(int count)",
    members: [],
  };
  expect(formatSymbolSignature(ctor)).toBe("public MathUtils(int count)");

  const record: CodeSymbol = {
    kind: "record",
    name: "Point",
    line: 1,
    endLine: 1,
    modifiers: [],
    params: "(int x, int y)",
    members: [],
  };
  expect(formatSymbolSignature(record)).toBe("record Point(int x, int y)");

  const iface: CodeSymbol = {
    kind: "interface",
    name: "Shape",
    line: 1,
    endLine: 1,
    modifiers: [],
    members: [],
  };
  expect(formatSymbolSignature(iface)).toBe("interface Shape");

  const constant: CodeSymbol = {
    kind: "enum-constant",
    name: "RED",
    line: 1,
    endLine: 1,
    modifiers: [],
    members: [],
  };
  expect(formatSymbolSignature(constant)).toBe("RED");
});

test("pruneSymbolsToSpans：类型自身或后代相交则保留，成员仅保留相交者", () => {
  const method: CodeSymbol = {
    kind: "method",
    name: "sum",
    line: 15,
    endLine: 21,
    modifiers: [],
    returnType: "int",
    members: [],
  };
  const otherMethod: CodeSymbol = { ...method, name: "area", line: 25, endLine: 25, returnType: "double" };
  const cls: CodeSymbol = {
    kind: "class",
    name: "MathUtils",
    line: 5,
    endLine: 30,
    modifiers: [],
    members: [method, otherMethod],
  };
  const iface: CodeSymbol = {
    kind: "interface",
    name: "Shape",
    line: 35,
    endLine: 40,
    modifiers: [],
    members: [],
  };

  // span 命中 sum：类保留，成员只留 sum
  const hitMethod = pruneSymbolsToSpans([cls, iface], [{ startLine: 15, endLine: 16 }]);
  expect(hitMethod).toEqual([{ ...cls, members: [method] }]);
  expect(hitMethod[0]?.members.map((m) => m.name)).toEqual(["sum"]);

  // span 命中类但无成员相交：类保留、成员清空
  const hitClassOnly = pruneSymbolsToSpans([cls, iface], [{ startLine: 6, endLine: 6 }]);
  expect(hitClassOnly).toEqual([{ ...cls, members: [] }]);

  // 完全不相交：丢弃
  const hitNothing = pruneSymbolsToSpans([cls, iface], [{ startLine: 100, endLine: 200 }]);
  expect(hitNothing).toEqual([]);

  // 多 span：任一相交即可
  const multiSpan = pruneSymbolsToSpans([cls], [
    { startLine: 25, endLine: 26 },
    { startLine: 40, endLine: 41 },
  ]);
  expect(multiSpan).toEqual([{ ...cls, members: [otherMethod] }]);
});

test("innermostSymbols：剪枝树的最深层符号；无成员类型为自身", () => {
  const method: CodeSymbol = { kind: "method", name: "sum", line: 15, endLine: 21, modifiers: [], members: [] };
  const cls: CodeSymbol = {
    kind: "class",
    name: "MathUtils",
    line: 5,
    endLine: 22,
    modifiers: [],
    members: [method],
  };
  const emptyClass: CodeSymbol = { kind: "class", name: "Empty", line: 1, endLine: 2, modifiers: [], members: [] };
  expect(innermostSymbols([cls, emptyClass])).toEqual([method, emptyClass]);
});

test("symbolPathAt：包含指定行的符号链（根 → 最内层）；行不在任何符号内为空", () => {
  const method: CodeSymbol = { kind: "method", name: "sum", line: 15, endLine: 21, modifiers: [], members: [] };
  const cls: CodeSymbol = {
    kind: "class",
    name: "MathUtils",
    line: 5,
    endLine: 22,
    modifiers: [],
    members: [method],
  };
  expect(symbolPathAt([cls], 16).map((s) => s.name)).toEqual(["MathUtils", "sum"]);
  expect(symbolPathAt([cls], 6).map((s) => s.name)).toEqual(["MathUtils"]);
  expect(symbolPathAt([cls], 22).map((s) => s.name)).toEqual(["MathUtils"]); // 端点含
  expect(symbolPathAt([cls], 23)).toEqual([]);
});
