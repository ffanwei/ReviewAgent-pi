import { expect, test } from "vitest";

import {
  isRepairablePath,
  repairFilePaths,
} from "./path-repair.js";

const KNOWN = [
  "src/main/java/App.java",
  "src/util/Helper.ts",
  "src/components/Button.tsx",
  "pkg/a.go",
];

function files(findings: readonly { file: string }[]): string[] {
  return findings.map((finding) => finding.file);
}

test("精确匹配不修复", () => {
  const result = repairFilePaths([{ file: "src/main/java/App.java" }], KNOWN);
  expect(files(result.items)).toEqual(["src/main/java/App.java"]);
  expect(result.repairs).toEqual([]);
});

test("宽松匹配：反斜杠 / 大小写 / ./ / Unicode NFC", () => {
  const result = repairFilePaths(
    [
      { file: "src\\main\\java\\App.java" },
      { file: "SRC/Util/helper.TS" },
      { file: "./src/components/Button.tsx" },
    ],
    KNOWN,
  );
  expect(files(result.items)).toEqual([
    "src/main/java/App.java",
    "src/util/Helper.ts",
    "src/components/Button.tsx",
  ]);
  expect(result.repairs.map((repair) => repair.distance)).toEqual([0, 0, 0]);
});

test("少数拼写错误：唯一最佳才修", () => {
  const result = repairFilePaths([{ file: "src/util/Helpr.ts" }], KNOWN);
  expect(files(result.items)).toEqual(["src/util/Helper.ts"]);
  expect(result.repairs).toEqual([
    { from: "src/util/Helpr.ts", to: "src/util/Helper.ts", distance: 1 },
  ]);
});

test("目录写错、文件名正确：能修", () => {
  const result = repairFilePaths([{ file: "src/utli/Helper.ts" }], KNOWN);
  expect(files(result.items)).toEqual(["src/util/Helper.ts"]);
});

test("平局不修：不把意见挂到不确定的文件上", () => {
  const result = repairFilePaths(
    [{ file: "pkg/c.go" }],
    ["pkg/a.go", "pkg/b.go"],
  );
  expect(files(result.items)).toEqual(["pkg/c.go"]);
  expect(result.repairs).toEqual([]);
});

test("扩展名不同不做模糊匹配（另一个文件，不是笔误）", () => {
  const result = repairFilePaths(
    [{ file: "src/components/Button.ts" }],
    KNOWN,
  );
  expect(files(result.items)).toEqual(["src/components/Button.ts"]);
});

test("绝对路径 / 盘符 / .. 段不修", () => {
  for (const path of ["/etc/passwd", "C:\\repo\\src\\main\\java\\App.java", "../src/main/java/App.java"]) {
    expect(isRepairablePath(path)).toBe(false);
    const result = repairFilePaths([{ file: path }], KNOWN);
    expect(files(result.items)).toEqual([path]);
  }
});

test("同一错误路径只解析一次，逐条留痕", () => {
  const result = repairFilePaths(
    [{ file: "src/util/Helpr.ts" }, { file: "src/util/Helpr.ts" }],
    KNOWN,
  );
  expect(files(result.items)).toEqual(["src/util/Helper.ts", "src/util/Helper.ts"]);
  expect(result.repairs).toHaveLength(2);
});

test("空输入 / 空文件全集零行为变化", () => {
  const findings = [{ file: "whatever.ts" }];
  expect(repairFilePaths([], KNOWN).items).toEqual([]);
  expect(repairFilePaths(findings, []).items).toEqual(findings);
});
