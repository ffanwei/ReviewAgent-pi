import { expect, test } from "vitest";
import { summarizeToolArguments } from "./tool-arguments.js";

// 进度行的入参摘要（ADR-0016 脱敏硬规则）：stderr 永远不出现完整入参，
// 也永远不出现工具结果全文。这里的断言是那条规则的单点真源。

test("摘要按入参声明顺序渲染 key=value", () => {
  expect(summarizeToolArguments({ path: "src/a.ts", start_line: 10 })).toBe("path=src/a.ts start_line=10");
});

test("摘要丢弃空值与 null 入参", () => {
  expect(summarizeToolArguments({ path: "", query: null, name: "x" })).toBe("name=x");
});

test("摘要折叠空白：一次调用恒占一行", () => {
  expect(summarizeToolArguments({ query: "foo\n  bar\tbaz" })).toBe("query=foo bar baz");
});

test("摘要截断到 80 字符（省略号计入总长）", () => {
  const summary = summarizeToolArguments({ query: "x".repeat(500) });
  expect(summary).toHaveLength(80);
  expect(summary.endsWith("…")).toBe(true);
  expect(summary.startsWith("query=xxxx")).toBe(true);
});

test("无入参调用的摘要是空串", () => {
  expect(summarizeToolArguments({})).toBe("");
});
