import { expect, test } from "vitest";

import { blockPathOf, fileBlockRanges, splitFileBlocks } from "./blocks.js";

// 文件块切分是字节保真视图：块文本按序 join 必须逐字节还原输入。

const DIFF = [
  "preamble line",
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1,2 @@",
  "-old",
  "+new",
  "+extra",
  "diff --git a/gone.ts b/gone.ts",
  "deleted file mode 100644",
  "--- a/gone.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-gone",
].join("\n");

test("块切分：前置内容成 path 为空的块，join 逐字节还原", () => {
  const blocks = splitFileBlocks(DIFF);
  expect(blocks.map((block) => block.path)).toEqual(["", "src/a.ts", "gone.ts"]);
  expect(blocks.map((block) => block.text).join("\n")).toBe(DIFF);
});

test("块计数：只数 + / - 体行，不数文件头", () => {
  const blocks = splitFileBlocks(DIFF);
  expect(blocks[1]).toMatchObject({ added: 2, removed: 1 });
  expect(blocks[2]).toMatchObject({ added: 0, removed: 1 });
});

test("块路径：diff --git 兜底；无法识别时为空串", () => {
  expect(blockPathOf(["diff --git a/x.ts b/x.ts"])).toBe("x.ts");
  expect(blockPathOf(["random text"])).toBe("");
});

test("行区间：每个块覆盖到下一个块起点", () => {
  const lines = DIFF.split("\n");
  const ranges = fileBlockRanges(lines);
  expect(ranges).toHaveLength(2);
  expect(ranges[0]?.start).toBe(1);
  expect(ranges[1]?.start).toBe(8);
  expect(ranges[1]?.end).toBe(lines.length);
});
