import { expect, test } from "vitest";

import { formatTipReview, formatTipSuggestion } from "./tip-format.js";

// ADR-0111：输出面只补 Markdown 段落，不改文字与已有换行。

test("review：影响评估前没有换行时补空行", () => {
  expect(formatTipReview("[缺陷类型] 文件句柄泄漏。影响评估：fd 耗尽。")).toBe(
    "[缺陷类型] 文件句柄泄漏。\n\n影响评估：fd 耗尽。",
  );
});

test("suggestion：代码示例前没有换行时补空行，示例内容另起一行", () => {
  expect(formatTipSuggestion("[重构思路] 加 defer。代码示例：`defer f.Close()`")).toBe(
    "[重构思路] 加 defer。\n\n代码示例：\n`defer f.Close()`",
  );
});

test("suggestion：fenced code block 从行首开始", () => {
  expect(formatTipSuggestion("[重构思路] 加 defer。代码示例：```go\ndefer f.Close()\n```")).toBe(
    "[重构思路] 加 defer。\n\n代码示例：\n```go\ndefer f.Close()\n```",
  );
});

test("已经有段落分隔时原样保留（幂等）", () => {
  const review = "[缺陷类型] 文件句柄泄漏。\n\n影响评估：fd 耗尽。";
  const suggestion = "[重构思路] 加 defer。\n\n代码示例：\n`defer f.Close()`";
  expect(formatTipReview(review)).toBe(review);
  expect(formatTipReview(formatTipReview(review))).toBe(review);
  expect(formatTipSuggestion(suggestion)).toBe(suggestion);
  expect(formatTipSuggestion(formatTipSuggestion(suggestion))).toBe(suggestion);
});

test("单换行也算已有换行，不强行改成空行", () => {
  const review = "[缺陷类型] 文件句柄泄漏。\n影响评估：fd 耗尽。";
  expect(formatTipReview(review)).toBe(review);
});

test("支持方括号标签；标签在开头或无标签时不动", () => {
  expect(formatTipReview("[缺陷类型] 泄漏。[影响评估] fd 耗尽。")).toBe(
    "[缺陷类型] 泄漏。\n\n[影响评估] fd 耗尽。",
  );
  expect(formatTipSuggestion("[重构思路] 加 defer。[代码示例] `defer f.Close()`")).toBe(
    "[重构思路] 加 defer。\n\n[代码示例]\n`defer f.Close()`",
  );
  expect(formatTipReview("影响评估：只有标签")).toBe("影响评估：只有标签");
  expect(formatTipSuggestion("没有任何标签")).toBe("没有任何标签");
});

test("首尾空白被裁掉，内部文字不变", () => {
  expect(formatTipReview("  [缺陷类型] 泄漏。影响评估：fd 耗尽。  ")).toBe(
    "[缺陷类型] 泄漏。\n\n影响评估：fd 耗尽。",
  );
});
