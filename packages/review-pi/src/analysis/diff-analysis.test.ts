import { expect, test } from "vitest";
import { goldenFixture } from "../testing/golden.js";
import { analyzeDiff, oldSpansOf } from "./diff-analysis.js";

// Diff 层分析（测量常量面：固定管线第一层，纯字符串解析、确定性）。
// b 侧路径优先（删除文件回退 a 侧）；hunk 区间取旧侧（快照 = MR 前 base）。

test("解析 VUL4J-1 黄金 diff：单文件单 hunk", () => {
  const analysis = analyzeDiff(goldenFixture("vul4j-1.diff"));
  expect(analysis.files).toEqual([
    {
      file: "src/main/java/com/alibaba/fastjson/serializer/ObjectArrayCodec.java",
      hunks: [{ oldStart: 174, oldCount: 7, newStart: 174, newCount: 7 }],
    },
  ]);
});

test("多文件按路径排序去重，diff --git 与裸 ---/+++ 头都可识别", () => {
  const diff = [
    "diff --git a/src/B.java b/src/B.java",
    "--- a/src/B.java",
    "+++ b/src/B.java",
    "@@ -1,3 +1,4 @@",
    " context",
    "+added",
    "diff --git a/src/A.java b/src/A.java",
    "--- a/src/A.java",
    "+++ b/src/A.java",
    "@@ -10,2 +10,2 @@",
    "-old",
    "+new",
    "--- a/src/C.java",
    "+++ b/src/C.java",
    "@@ -1 +1 @@",
    "-x",
    "+y",
  ].join("\n");
  const analysis = analyzeDiff(diff);
  expect(analysis.files.map((file) => file.file)).toEqual(["src/A.java", "src/B.java", "src/C.java"]);
  expect(analysis.files[0]?.hunks).toEqual([{ oldStart: 10, oldCount: 2, newStart: 10, newCount: 2 }]);
  expect(analysis.files[1]?.hunks).toEqual([{ oldStart: 1, oldCount: 3, newStart: 1, newCount: 4 }]);
  // 裸头（无 diff --git）：hunk 归到最近一次定文件的 +++ 侧
  expect(analysis.files[2]?.hunks).toEqual([{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 }]);
});

test("裸 hunk 头省略 count 时按 1 行处理", () => {
  const analysis = analyzeDiff("--- a.java\n+++ b.java\n@@ -5 +5,2 @@\n context\n+new");
  expect(analysis.files[0]?.hunks).toEqual([{ oldStart: 5, oldCount: 1, newStart: 5, newCount: 2 }]);
});

test("/dev/null：新增文件取 +++ 侧，删除文件保持 --- 侧", () => {
  const added = analyzeDiff("--- /dev/null\n+++ b/New.java\n@@ -0,0 +1,2 @@\n+a\n+b");
  expect(added.files[0]?.file).toBe("New.java");

  const deleted = analyzeDiff("--- a/Old.java\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b");
  expect(deleted.files[0]?.file).toBe("Old.java");
});

test("oldSpansOf：常规 hunk 端点含；纯新增（oldCount=0）以单行近似", () => {
  const normal = oldSpansOf({ file: "a.java", hunks: [{ oldStart: 10, oldCount: 5, newStart: 10, newCount: 5 }] });
  expect(normal).toEqual([{ startLine: 10, endLine: 14 }]);

  const added = oldSpansOf({ file: "a.java", hunks: [{ oldStart: 7, oldCount: 0, newStart: 8, newCount: 3 }] });
  expect(added).toEqual([{ startLine: 7, endLine: 7 }]);
});

test("无可解析文件头或 hunk 先于文件头：显式抛错（fail fast，不静默空结果）", () => {
  expect(() => analyzeDiff("no recognizable headers")).toThrow();
  expect(() => analyzeDiff("@@ -1 +1 @@\n+x")).toThrow();
});
