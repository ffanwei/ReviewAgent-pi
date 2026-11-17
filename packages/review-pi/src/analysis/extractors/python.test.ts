import { expect, test } from "vitest";
import { getPythonParser } from "../../codeintel/python-parser.js";
import { extractPythonFile, pythonModuleName, renderPythonSignature } from "./python.js";
import type { CodeSymbol } from "../symbols.js";

// Python 符号提取器（ADR-0041）：名字级、AST 文档顺序；装饰器记为修饰符；
// 嵌套函数不提取（方法体内的局部实现不是公共符号）；模块名由路径推导。

const SOURCE = [
  "import os", // 1
  "", // 2
  "CONSTANT: int = 1", // 3
  "", // 4
  "", // 5
  "@decorator(arg=1)", // 6
  "class Formatter(Base):", // 7
  '    sep = ", "', // 8
  "    count: int = 0", // 9
  "", // 10
  "    def __init__(self, prefix: str) -> None:", // 11
  "        self.prefix = prefix", // 12
  "", // 13
  "    @property", // 14
  "    def size(self) -> int:", // 15
  "        return self.count", // 17
  "", // 17
  "    @staticmethod", // 18
  '    async def build(name: str) -> "Formatter":', // 19
  "        return Formatter(name).format_name(name)", // 20
  "", // 21
  "    class Inner:", // 22
  "        pass", // 23
  "", // 24
  "", // 25
  "def make_default(value, *args, **kwargs) -> Formatter:", // 26
  "    return Formatter(str(value))", // 27
  "", // 28
  "", // 29
  "async def fetch(url: str) -> bytes:", // 30
  "    return await get(url)", // 31
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

test("extractPythonFile：模块名 / 顶层类与函数 / 类成员 / 装饰器", async () => {
  const parser = await getPythonParser();
  const index = extractPythonFile(parser, "service/pkg/util.py", SOURCE);
  expect(index.file).toBe("service/pkg/util.py");
  expect(index.moduleName).toBe("service.pkg.util");
  expect(index.parseError).toBe(false);
  expect(index.symbols.map((symbol) => `${symbol.kind}:${symbol.name}`)).toEqual([
    "field:CONSTANT",
    "class:Formatter",
    "function:make_default",
    "function:fetch",
  ]);

  const formatter = find(index.symbols, "Formatter");
  expect(formatter.line).toBe(7);
  expect(formatter.modifiers).toEqual(["decorator"]);
  expect(formatter.members.map((member) => `${member.kind}:${member.name}`)).toEqual([
    "field:sep",
    "field:count",
    "method:__init__",
    "method:size",
    "method:build",
    "class:Inner",
  ]);

  expect(findNested(index.symbols, "Formatter", "count").returnType).toBe("int");
  expect(findNested(index.symbols, "Formatter", "__init__").params).toBe(
    "(self, prefix: str)",
  );
  expect(findNested(index.symbols, "Formatter", "__init__").returnType).toBe("None");
  expect(findNested(index.symbols, "Formatter", "size").modifiers).toEqual(["property"]);
  expect(findNested(index.symbols, "Formatter", "build").modifiers).toEqual([
    "staticmethod",
    "async",
  ]);

  // 顶层函数（无类包裹）也要被识别，且 async 记为修饰符
  expect(find(index.symbols, "make_default").params).toBe("(value, *args, **kwargs)");
  expect(find(index.symbols, "make_default").returnType).toBe("Formatter");
  expect(find(index.symbols, "fetch").modifiers).toEqual(["async"]);
  expect(find(index.symbols, "fetch").returnType).toBe("bytes");
});

test("extractPythonFile：调用点名字级提取（identifier 与 attribute 都取末段）", async () => {
  const parser = await getPythonParser();
  const index = extractPythonFile(parser, "service/pkg/util.py", SOURCE);
  const names = index.invocations.map((invocation) => invocation.name);
  expect(names).toContain("format_name");
  expect(names).toContain("Formatter");
  expect(names).toContain("str");
  expect(names).toContain("get");
  expect(index.invocations.find((invocation) => invocation.name === "get")?.line).toBe(31);
});

test("renderPythonSignature：装饰器 / async 前缀 / 返回类型 / 字段形态", async () => {
  const parser = await getPythonParser();
  const index = extractPythonFile(parser, "service/pkg/util.py", SOURCE);
  expect(renderPythonSignature(find(index.symbols, "Formatter"))).toBe("@decorator class Formatter");
  expect(renderPythonSignature(findNested(index.symbols, "Formatter", "size"))).toBe(
    "@property def size(self) -> int",
  );
  expect(renderPythonSignature(findNested(index.symbols, "Formatter", "build"))).toBe(
    '@staticmethod async def build(name: str) -> "Formatter"',
  );
  expect(renderPythonSignature(find(index.symbols, "make_default"))).toBe(
    "def make_default(value, *args, **kwargs) -> Formatter",
  );
  expect(renderPythonSignature(find(index.symbols, "CONSTANT"))).toBe("CONSTANT: int");
});

test("pythonModuleName：路径转点号，__init__ 收成包名", () => {
  expect(pythonModuleName("service/pkg/util.py")).toBe("service.pkg.util");
  expect(pythonModuleName("service/pkg/__init__.py")).toBe("service.pkg");
  expect(pythonModuleName("single.py")).toBe("single");
  expect(pythonModuleName("pkg\\sub\\mod.py")).toBe("pkg.sub.mod");
});

test("extractPythonFile：缩进块解析失败时置 parseError 并留痕（不静默丢弃）", async () => {
  const parser = await getPythonParser();
  const index = extractPythonFile(parser, "broken.py", "def broken(\n");
  expect(index.parseError).toBe(true);
});
