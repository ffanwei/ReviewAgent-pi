import { describe, expect, test } from "vitest";
import { analyzeDiff, oldSpansOf } from "./diff-analysis.js";
import { mrJsonToUnifiedDiff } from "./mr-json.js";

/**
 * `--mr-json` 装载缝（ADR-0029）：GitCode/GitLab 文件变更数组 → 统一 diff。
 *
 * 接口给的是按文件切片的 hunk 片段（只有 new_path + diff，没有文件头），
 * `analyzeDiff` 以文件头定位当前文件——所以这里既断言「补头后的字节」，
 * 也断言「补头后能被真解析器吃下」（后者才是产品契约）。
 */

/** 用户提供的真实形状：新增 / 修改 / 删除 / 修改，均只有 new_path 与 diff */
const SAMPLE = [
  {
    new_path: "src/utils/date.ts",
    diff:
      "@@ -0,0 +1,18 @@\n" +
      "+/**\n" +
      "+ * 格式化日期为 YYYY-MM-DD\n" +
      "+ */\n" +
      "+export function formatDate(date: Date): string {\n" +
      "+  const y = date.getFullYear();\n" +
      "+  const m = String(date.getMonth() + 1).padStart(2, '0');\n" +
      "+  const d = String(date.getDate()).padStart(2, '0');\n" +
      "+  return `${y}-${m}-${d}`;\n" +
      "+}",
  },
  {
    new_path: "src/api/user.ts",
    diff:
      "@@ -12,9 +12,15 @@ export interface User {\n" +
      "   id: number;\n" +
      "   name: string;\n" +
      "-  email: string;\n" +
      "+  email: string | null;\n" +
      "+  avatar?: string;\n" +
      " }",
  },
  {
    new_path: "src/legacy/old-auth.js",
    diff: "@@ -1,24 +0,0 @@\n-// deprecated: use src/auth/index.ts instead\n-const jwt = require('jsonwebtoken');",
  },
  {
    new_path: "src/auth/index.ts",
    diff:
      "@@ -1,10 +1,10 @@\n" +
      "-import { verifyToken } from '../legacy/old-auth';\n" +
      "+import { verify } from 'jsonwebtoken';\n" +
      " \n" +
      " export function checkAuth(token: string): boolean {",
  },
];

function convert(entries: unknown): string {
  return mrJsonToUnifiedDiff(JSON.stringify(entries), "MR-1234.json");
}

describe("mrJsonToUnifiedDiff：接口数组 → 统一 diff", () => {
  test("样例 4 项：文件头齐全，且真解析器能读出 4 个文件与正确行区间", () => {
    const diff = convert(SAMPLE);

    // 文件头（新增 / 删除各自带 /dev/null 与 mode 行）
    expect(diff).toContain("diff --git a/src/utils/date.ts b/src/utils/date.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/utils/date.ts\n@@ -0,0 +1,18 @@");
    expect(diff).toContain("diff --git a/src/api/user.ts b/src/api/user.ts\n--- a/src/api/user.ts\n+++ b/src/api/user.ts\n@@ -12,9 +12,15 @@");
    expect(diff).toContain("diff --git a/src/legacy/old-auth.js b/src/legacy/old-auth.js\ndeleted file mode 100644\n--- a/src/legacy/old-auth.js\n+++ /dev/null\n@@ -1,24 +0,0 @@");
    expect(diff).toContain("diff --git a/src/auth/index.ts b/src/auth/index.ts\n--- a/src/auth/index.ts\n+++ b/src/auth/index.ts\n@@ -1,10 +1,10 @@");

    // 产品契约：解析器按路径排序给出文件与 hunk 区间
    const analysis = analyzeDiff(diff);
    expect(analysis.files.map((file) => file.file)).toEqual([
      "src/api/user.ts",
      "src/auth/index.ts",
      "src/legacy/old-auth.js",
      "src/utils/date.ts",
    ]);
    expect(analysis.files[0]?.hunks[0]).toEqual({
      oldStart: 12,
      oldCount: 9,
      newStart: 12,
      newCount: 15,
    });
    // 删除文件：纯新增/纯删除以单行近似（oldSpansOf 的既有口径）
    const deleted = analysis.files.find((file) => file.file === "src/legacy/old-auth.js");
    expect(deleted !== undefined && oldSpansOf(deleted)).toEqual([{ startLine: 1, endLine: 24 }]);
  });

  test("只读「路径 + 正文」两个语义字段：取到就不再往下看方言键，元数据一概不参与", () => {
    const diff = convert([
      {
        old_path: "before/name.ts",
        new_path: "after/name.ts",
        new_file: true,
        deleted_file: true,
        renamed_file: true,
        filename: "ignored-by-precedence.ts",
        path: "ignored-too.ts",
        patch: "@@ -9,9 +9,9 @@\n-a\n+b",
        binary: true,
        diff: "@@ -3,2 +3,2 @@\n-a\n+b",
      },
    ]);
    // 路径取 new_path（优先于 filename / path）；正文取 diff（优先于 patch）；没有 rename 行
    expect(diff).toBe("diff --git a/after/name.ts b/after/name.ts\n--- a/after/name.ts\n+++ b/after/name.ts\n@@ -3,2 +3,2 @@\n-a\n+b\n");
  });

  test("GitCode v5 `/files` 与 GitHub 形态（filename + patch）直接可吃", () => {
    // 真实响应字段：sha / filename / status / additions / deletions / blob_url / raw_url / patch
    const diff = convert([
      {
        sha: "6dcb09b",
        filename: "src/api/user.ts",
        status: "modified",
        additions: "2",
        deletions: "1",
        blob_url: "https://example.invalid/blob",
        raw_url: "https://example.invalid/raw",
        patch: "@@ -12,9 +12,15 @@ export interface User {\n   id: number;\n-  email: string;\n+  email: string | null;",
      },
      { sha: "aaaaaaa", filename: "assets/logo.png", status: "added", patch: null },
      { sha: "bbbbbbb", filename: "src/new.ts", status: "added", patch: "@@ -0,0 +1,2 @@\n+export const A = 1;\n+export const B = 2;" },
    ]);

    expect(diff).toContain("diff --git a/src/api/user.ts b/src/api/user.ts\n--- a/src/api/user.ts\n+++ b/src/api/user.ts\n@@ -12,9 +12,15 @@");
    expect(diff).toContain("diff --git a/src/new.ts b/src/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,2 @@");
    // 二进制条目没有 patch → 跳过，不进 diff
    expect(diff).not.toContain("logo.png");

    expect(analyzeDiff(diff).files.map((file) => file.file)).toEqual(["src/api/user.ts", "src/new.ts"]);
  });

  test("`path` 也认；diff 为空串时继续看 patch", () => {
    expect(convert([{ path: "x/y.ts", diff: "", patch: "@@ -1 +1 @@\n-a\n+b" }])).toBe(
      "diff --git a/x/y.ts b/x/y.ts\n--- a/x/y.ts\n+++ b/x/y.ts\n@@ -1 +1 @@\n-a\n+b\n",
    );
  });

  test("diff 已是整段 patch（网关直回 git 原文）→ 原样透传，不重复包头", () => {
    const patch = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b";
    expect(convert([{ new_path: "x.ts", diff: patch }])).toBe(`${patch}\n`);
  });

  test("空 diff 条目跳过；全部为空 → fail fast（不静默产出零文件）", () => {
    const diff = convert([
      { new_path: "a/b.png", diff: "" },
      { new_path: "c.ts", diff: "@@ -1 +1 @@\n-a\n+b" },
      { new_path: "d/rename-only.ts" },
    ]);
    expect(diff).toContain("c.ts");
    expect(diff).not.toContain("a/b.png");
    expect(diff).not.toContain("rename-only");

    expect(() => convert([{ new_path: "a/b.png", diff: "" }, { new_path: "x.bin" }])).toThrow(
      /没有可转换的文本 diff（2 个条目全部为空 diff \/ 二进制变更）/,
    );
  });

  test("BOM 与 CRLF 容忍（Windows 侧导出常带两者）", () => {
    const json = `\uFEFF${JSON.stringify([{ new_path: "a.ts", diff: "@@ -1 +1 @@\r\n-a\r\n+b" }])}`;
    expect(mrJsonToUnifiedDiff(json, "MR-1.json")).toBe(
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
    );
  });

  test("形状不对：错误消息带输入标签、条目序号与该项实际键", () => {
    expect(() => mrJsonToUnifiedDiff('{"files":[]}', "MR-1.json")).toThrow(
      /MR-1\.json: 期望文件变更数组，得到 object/,
    );
    expect(() => mrJsonToUnifiedDiff("{oops", "MR-1.json")).toThrow(/MR-1\.json: 不是合法 JSON/);
    expect(() => convert([{ new_path: "a.ts" }, "nope"])).toThrow(/第 2 项不是对象/);
    expect(() => convert([{ diff: "@@ -1 +1 @@\n-a\n+b" }])).toThrow(/第 1 项缺 new_path/);
    // 方言不匹配时把「实际有哪些键」直接列出来，用户不用回头翻 JSON
    expect(() => convert([{ sha: "x", status: "added", patch: "@@ -0,0 +1 @@\n+a" }])).toThrow(
      /第 1 项缺 new_path（[^）]*也可用 filename \/ path）——该项现有键：sha、status、patch/,
    );
    expect(() => convert([{ new_path: "a.ts", diff: ["@@ -1 +1 @@"] }])).toThrow(
      /第 1 项的 diff 必须是字符串（得到 array）/,
    );
    // GitHub 形态的正文键叫 patch：报错也要点名它
    expect(() => convert([{ filename: "a.ts", patch: { body: "@@ -1 +1 @@" } }])).toThrow(
      /第 1 项的 patch 必须是字符串（得到 object）/,
    );
  });

  test("多行 hunk 与 `\\ No newline at end of file` 原样保留", () => {
    const diff = convert([
      {
        new_path: "m.ts",
        diff: "@@ -1,2 +1,2 @@\n-a\n+b\n \\ No newline at end of file",
      },
    ]);
    expect(diff).toContain("@@ -1,2 +1,2 @@\n-a\n+b\n \\ No newline at end of file\n");
  });
});
