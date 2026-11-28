import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";

import { enumerateRepoFiles } from "./enumerate.js";

const dirs: string[] = [];

function tempRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "repo-spike-enum-"));
  dirs.push(dir);
  return dir;
}

function write(root: string, rel: string, content: string | Buffer): void {
  const full = path.join(root, ...rel.split("/"));
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

afterAll(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("枚举：只保留源码/配置，按路径排序，跳过原因可枚举", async () => {
  const root = tempRepo();
  write(root, "src/a.ts", "export const a = 1;\n");
  write(root, "src/b.py", "print(1)\n");
  write(root, "README.md", "# docs\n");
  write(root, "node_modules/x.js", "module.exports = 1;\n");
  write(root, "src/logo.ts", Buffer.from([0, 1, 2, 3]));
  write(root, "src/empty.ts", "");
  write(root, "src/large.ts", "x".repeat(1_000));
  write(root, "package-lock.json", "{}");

  const result = await enumerateRepoFiles({
    repoPath: root,
    maxFiles: 10,
    maxFileChars: 100,
  });

  expect(result.files.map((file) => file.path)).toEqual(["src/a.ts", "src/b.py"]);
  expect(result.skipped).toEqual(
    expect.arrayContaining([
      { path: "README.md", reason: "unsupported-extension" },
      { path: "src/logo.ts", reason: "binary" },
      { path: "src/empty.ts", reason: "empty" },
      { path: "src/large.ts", reason: "too-large(1000>100)" },
      { path: "package-lock.json", reason: "excluded-path" },
    ]),
  );
});

test("枚举：git 仓库默认只检视已跟踪文件，trackedOnly=false 才纳入 untracked", async () => {
  const root = tempRepo();
  try {
    execFileSync("git", ["-C", root, "init"], { stdio: "ignore" });
  } catch {
    return; // 环境无 git：不把环境限制当产品行为
  }
  write(root, "src/tracked.ts", "export const tracked = 1;\n");
  write(root, "src/untracked.ts", "export const untracked = 1;\n");
  execFileSync("git", ["-C", root, "add", "src/tracked.ts"], { stdio: "ignore" });

  const defaults = await enumerateRepoFiles({
    repoPath: root,
    maxFiles: 10,
    maxFileChars: 1_000,
  });
  expect(defaults.files.map((file) => file.path)).toEqual(["src/tracked.ts"]);

  const all = await enumerateRepoFiles({
    repoPath: root,
    maxFiles: 10,
    maxFileChars: 1_000,
    trackedOnly: false,
  });
  expect(all.files.map((file) => file.path)).toEqual(["src/tracked.ts", "src/untracked.ts"]);
});

test("枚举：.aireview/ 恒排除（历史意见输入目录不进检视面，与 trackedOnly 无关）", async () => {
  const root = tempRepo();
  try {
    execFileSync("git", ["-C", root, "init"], { stdio: "ignore" });
  } catch {
    return; // 环境无 git：不把环境限制当产品行为
  }
  write(root, "src/tracked.ts", "export const tracked = 1;\n");
  write(root, ".aireview/history_review_tips.json", "[]\n");
  execFileSync("git", ["-C", root, "add", "src/tracked.ts", ".aireview/history_review_tips.json"], {
    stdio: "ignore",
  });

  const defaults = await enumerateRepoFiles({
    repoPath: root,
    maxFiles: 10,
    maxFileChars: 1_000,
  });
  expect(defaults.files.map((file) => file.path)).toEqual(["src/tracked.ts"]);
});

test("枚举：pathPrefix 只保留前缀内的文件", async () => {
  const root = tempRepo();
  write(root, "src/a.ts", "a\n");
  write(root, "src/nested/b.ts", "b\n");
  write(root, "test/c.ts", "c\n");

  const result = await enumerateRepoFiles({
    repoPath: root,
    maxFiles: 10,
    maxFileChars: 1_000,
    pathPrefix: "src",
  });

  expect(result.files.map((file) => file.path)).toEqual(["src/a.ts", "src/nested/b.ts"]);
});

test("枚举：maxFiles 截断后其余文件记为 max-files", async () => {
  const root = tempRepo();
  write(root, "a.ts", "a\n");
  write(root, "b.ts", "b\n");
  write(root, "c.ts", "c\n");

  const result = await enumerateRepoFiles({
    repoPath: root,
    maxFiles: 2,
    maxFileChars: 1_000,
  });

  expect(result.files.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
  expect(result.skipped).toContainEqual({ path: "c.ts", reason: "max-files" });
});

test("枚举：同一快照两次结果字节一致", async () => {
  const root = tempRepo();
  write(root, "src/b.ts", "b\n");
  write(root, "src/a.ts", "a\n");
  write(root, "src/nested/d.py", "d\n");

  const options = { repoPath: root, maxFiles: 10, maxFileChars: 1_000 };
  const first = await enumerateRepoFiles(options);
  const second = await enumerateRepoFiles(options);
  expect(JSON.stringify(second)).toBe(JSON.stringify(first));
});

test("枚举：符号链接不跟随，记为 not-a-regular-file", async () => {
  const root = tempRepo();
  write(root, "src/a.ts", "a\n");
  const outside = path.join(tempRepo(), "outside.ts");
  writeFileSync(outside, "outside\n");
  try {
    symlinkSync(outside, path.join(root, "src", "link.ts"));
  } catch {
    return; // Windows 无权限时跳过，不把环境限制当产品行为
  }

  const result = await enumerateRepoFiles({
    repoPath: root,
    maxFiles: 10,
    maxFileChars: 1_000,
  });

  expect(result.files.map((file) => file.path)).toEqual(["src/a.ts"]);
  expect(result.skipped).toContainEqual({ path: "src/link.ts", reason: "not-a-regular-file" });
});

test("枚举：files 精确过滤，只保留给定路径", async () => {
  const root = tempRepo();
  write(root, "src/a.ts", "a\n");
  write(root, "src/b.ts", "b\n");
  write(root, "src/c.ts", "c\n");

  const result = await enumerateRepoFiles({
    repoPath: root,
    maxFiles: 10,
    maxFileChars: 1_000,
    files: ["src/a.ts", "src/c.ts"],
  });

  expect(result.files.map((file) => file.path)).toEqual(["src/a.ts", "src/c.ts"]);
  expect(result.discovered).toBe(3);
});

test("枚举：files 含仓库不存在的路径时抛错", async () => {
  const root = tempRepo();
  write(root, "src/a.ts", "a\n");

  await expect(
    enumerateRepoFiles({
      repoPath: root,
      maxFiles: 10,
      maxFileChars: 1_000,
      files: ["src/missing.ts"],
    }),
  ).rejects.toThrow(/--files contains path/);
});

test("枚举：include / exclude 按相对路径过滤，exclude 优先", async () => {
  const root = tempRepo();
  write(root, "src/a.ts", "a\n");
  write(root, "src/a.test.ts", "t\n");
  write(root, "docs/b.ts", "b\n");

  const result = await enumerateRepoFiles({
    repoPath: root,
    maxFiles: 10,
    maxFileChars: 1_000,
    includeRegexes: [/^src\//],
    excludeRegexes: [/\.test\.ts$/],
  });

  expect(result.files.map((file) => file.path)).toEqual(["src/a.ts"]);
  expect(result.skipped).toEqual(
    expect.arrayContaining([
      { path: "src/a.test.ts", reason: "excluded-path" },
      { path: "docs/b.ts", reason: "excluded-path" },
    ]),
  );
});
