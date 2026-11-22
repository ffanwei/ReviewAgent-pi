import { expect, test } from "vitest";
import { evidenceCodeSegments, groundFindingEvidence } from "./evidence-grounding.js";

const FILE = [
  "public class Foo {",
  "  void run() {",
  "    const value = compute(alpha, beta);",
  "    if (value == null) { return; }",
  "  }",
  "}",
].join("\n");

function ground(evidence: readonly string[], file: string | null = FILE) {
  return groundFindingEvidence({ evidence }, file, 30);
}

test("整段逐字命中 → grounded", () => {
  const result = ground(["src/Foo.java:3 — const value = compute(alpha, beta);"]);
  expect(result.status).toBe("grounded");
  expect(result.matchedEntries).toBe(1);
});

test("多行 / 分号 / 省略号拼接仍可定位 → grounded", () => {
  const result = ground([
    "src/Foo.java:3-4 — const value = compute(alpha, beta); ... if (value == null) { return; }",
  ]);
  expect(result.status).toBe("grounded");
});

test("代码后追加中文解释 → 前缀窗口命中，仍 grounded", () => {
  const result = ground([
    "src/Foo.java:3 — const value = compute(alpha, beta); 这里可能返回 null，需要判空。",
  ]);
  expect(result.status).toBe("grounded");
});

test("纯中文描述没有代码片段 → unverified", () => {
  const result = ground(["src/Foo.java:3 — 这里可能返回空值，需要增加判空逻辑。"]);
  expect(result.status).toBe("unverified");
  expect(evidenceCodeSegments("src/Foo.java:3 — 这里可能返回空值，需要增加判空逻辑。")).toEqual([]);
});

test("编造代码 → unverified", () => {
  const result = ground(["src/Foo.java:3 — const value = totallyFabricated(input);"]);
  expect(result.status).toBe("unverified");
});

test("文件不可读 → unverifiable（调用方 fail-open）", () => {
  const result = ground(["src/Foo.java:3 — const value = compute(alpha, beta);"], null);
  expect(result.status).toBe("unverifiable");
});

test("多行代码每条独立匹配；中文说明行被跳过", () => {
  const segments = evidenceCodeSegments(
    "a.ts:1 — const x = 1;\n这是说明\nconst y = 2;",
  );
  expect(segments).toEqual(["const x = 1", "const y = 2"]);
});
