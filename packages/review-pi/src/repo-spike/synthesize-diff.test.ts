import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";

import { synthesizeGroupDiff } from "./synthesize-diff.js";
import type { RepoGroup } from "./types.js";

const dirs: string[] = [];

function tempRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "repo-spike-diff-"));
  dirs.push(dir);
  return dir;
}

function write(root: string, rel: string, content: string): void {
  const full = path.join(root, ...rel.split("/"));
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function group(files: readonly string[]): RepoGroup {
  return {
    index: 1,
    key: "test",
    files: files.map((file) => ({ path: file, size: 100 })),
    estimatedChars: files.length * 100,
  };
}

afterAll(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("合成 diff：新文件头 + 全部 + 行 + 行数正确", async () => {
  const root = tempRepo();
  write(root, "src/a.ts", "line 1\nline 2\n");

  const synthetic = await synthesizeGroupDiff(group(["src/a.ts"]), { repoPath: root });

  expect(synthetic.files).toEqual(["src/a.ts"]);
  expect(synthetic.diff).toContain("diff --git a/src/a.ts b/src/a.ts");
  expect(synthetic.diff).toContain("--- /dev/null");
  expect(synthetic.diff).toContain("+++ b/src/a.ts");
  expect(synthetic.diff).toContain("@@ -0,0 +1,2 @@");
  expect(synthetic.diff).toContain("+line 1");
  expect(synthetic.diff).toContain("+line 2");
  expect(synthetic.diff.endsWith("\n")).toBe(true);
  // repo 模式给模型的原貌：同样的文件，但没有任何 diff 头。
  expect(synthetic.snapshot).toEqual([{ path: "src/a.ts", content: "line 1\nline 2" }]);
});

test("合成 diff：CRLF 归一化、无尾换行标记", async () => {
  const root = tempRepo();
  write(root, "a.ts", "one\r\ntwo");

  const synthetic = await synthesizeGroupDiff(group(["a.ts"]), { repoPath: root });

  expect(synthetic.diff).toContain("+one\n+two");
  expect(synthetic.diff).toContain("\\ No newline at end of file");
  expect(synthetic.diff).not.toContain("\r");
});

test("合成 diff：空文件 / 读取失败跳过并留原因", async () => {
  const root = tempRepo();
  write(root, "empty.ts", "");
  write(root, "ok.ts", "ok\n");

  const synthetic = await synthesizeGroupDiff(group(["empty.ts", "ok.ts", "missing.ts"]), {
    repoPath: root,
  });

  expect(synthetic.files).toEqual(["ok.ts"]);
  expect(synthetic.skipped).toEqual(
    expect.arrayContaining([
      { path: "empty.ts", reason: "empty" },
      { path: "missing.ts", reason: "read-failed" },
    ]),
  );
});
