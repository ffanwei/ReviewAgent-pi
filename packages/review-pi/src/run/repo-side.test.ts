import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, expect, test } from "vitest";

import {
  detectRepoSnapshotSide,
  formatRepoSnapshotSideNotice,
} from "./repo-side.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeRepo(files: Readonly<Record<string, string>>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "review-repo-side-"));
  dirs.push(dir);
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(dir, ...relative.split("/"));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
  return dir;
}

const MODIFIED_DIFF = [
  "diff --git a/src/a.java b/src/a.java",
  "index 1111111..2222222 100644",
  "--- a/src/a.java",
  "+++ b/src/a.java",
  "@@ -1,3 +1,3 @@",
  " class A {",
  "-    old();",
  "+    new();",
  " }",
].join("\n");

const OLD_A = ["class A {", "    old();", "}", ""].join("\n");
const NEW_A = ["class A {", "    new();", "}", ""].join("\n");

const ADDED_DIFF = [
  "diff --git a/src/b.java b/src/b.java",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/b.java",
  "@@ -0,0 +1,2 @@",
  "+class B {",
  "+}",
].join("\n");

const DELETED_DIFF = [
  "diff --git a/src/c.java b/src/c.java",
  "deleted file mode 100644",
  "--- a/src/c.java",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-class C {",
  "-}",
].join("\n");

const NEW_B = ["class B {", "}", ""].join("\n");
const DELETED_C = ["class C {", "}", ""].join("\n");

test("快照停在改前侧：旧侧块命中 → base", async () => {
  const repoPath = await makeRepo({ "src/a.java": OLD_A });

  const record = await detectRepoSnapshotSide({ repoPath, diff: MODIFIED_DIFF });

  expect(record).toMatchObject({
    side: "base",
    baseVotes: 1,
    headVotes: 0,
    filesChecked: 1,
    filesSkipped: 0,
  });
});

test("快照停在改后侧：新侧块命中 → head", async () => {
  const repoPath = await makeRepo({ "src/a.java": NEW_A });

  const record = await detectRepoSnapshotSide({ repoPath, diff: MODIFIED_DIFF });

  expect(record).toMatchObject({ side: "head", headVotes: 1, baseVotes: 0, filesChecked: 1 });
});

test("新增文件：树里没有 → base（弱证据），树里有 → head", async () => {
  const headRepo = await makeRepo({ "src/b.java": NEW_B });
  const baseRepo = await makeRepo({});

  await expect(
    detectRepoSnapshotSide({ repoPath: headRepo, diff: ADDED_DIFF }),
  ).resolves.toMatchObject({ side: "head", headVotes: 1, baseVotes: 0 });

  await expect(
    detectRepoSnapshotSide({ repoPath: baseRepo, diff: ADDED_DIFF }),
  ).resolves.toMatchObject({ side: "base", headVotes: 0, baseVotes: 1, filesSkipped: 1 });
});

test("删除文件：树里还有 → base，树里已删 → head", async () => {
  const baseRepo = await makeRepo({ "src/c.java": DELETED_C });
  const headRepo = await makeRepo({});

  await expect(
    detectRepoSnapshotSide({ repoPath: baseRepo, diff: DELETED_DIFF }),
  ).resolves.toMatchObject({ side: "base", baseVotes: 1 });

  await expect(
    detectRepoSnapshotSide({ repoPath: headRepo, diff: DELETED_DIFF }),
  ).resolves.toMatchObject({ side: "head", headVotes: 1 });
});

test("侧别混杂：base 文件 + 已存在的新增文件 → mixed", async () => {
  const repoPath = await makeRepo({ "src/a.java": OLD_A, "src/b.java": NEW_B });
  const diff = `${MODIFIED_DIFF}\n${ADDED_DIFF}`;

  const record = await detectRepoSnapshotSide({ repoPath, diff });

  expect(record.side).toBe("mixed");
  expect(record.baseVotes).toBe(1);
  expect(record.headVotes).toBe(1);
});

test("无文本证据（空 diff / 非统一 diff / 二进制块）→ unknown", async () => {
  const repoPath = await makeRepo({ "src/a.java": OLD_A });
  const binaryDiff = [
    "diff --git a/logo.png b/logo.png",
    "index 1111111..2222222 100644",
    "Binary files a/logo.png and b/logo.png differ",
  ].join("\n");

  await expect(
    detectRepoSnapshotSide({ repoPath, diff: "" }),
  ).resolves.toMatchObject({ side: "unknown", filesChecked: 0 });
  await expect(
    detectRepoSnapshotSide({ repoPath, diff: "this is not a unified diff" }),
  ).resolves.toMatchObject({ side: "unknown" });
  await expect(
    detectRepoSnapshotSide({ repoPath, diff: binaryDiff }),
  ).resolves.toMatchObject({ side: "unknown", filesWithoutHunks: 1 });
});

test("CRLF 检出（行尾归一）不影响判定", async () => {
  const repoPath = await makeRepo({ "src/a.java": NEW_A.replaceAll("\n", "\r\n") });

  await expect(
    detectRepoSnapshotSide({ repoPath, diff: MODIFIED_DIFF }),
  ).resolves.toMatchObject({ side: "head" });
});

test("git 引号 + 八进制路径（中文文件名）能定位并判定", async () => {
  const repoPath = await makeRepo({ "中文.md": "new\n" });
  const diff = [
    'diff --git "a/\\344\\270\\255\\346\\226\\207.md" "b/\\344\\270\\255\\346\\226\\207.md"',
    '--- "a/\\344\\270\\255\\346\\226\\207.md"',
    '+++ "b/\\344\\270\\255\\346\\226\\207.md"',
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n");

  await expect(
    detectRepoSnapshotSide({ repoPath, diff }),
  ).resolves.toMatchObject({ side: "head", headVotes: 1, filesChecked: 1 });
});

test("仓库路径不存在也不抛错 → unknown", async () => {
  await expect(
    detectRepoSnapshotSide({
      repoPath: join(tmpdir(), "review-repo-side-does-not-exist"),
      diff: MODIFIED_DIFF,
    }),
  ).resolves.toMatchObject({ side: "unknown" });
});

test("提醒文案：只有 base / mixed 出声", () => {
  const base = formatRepoSnapshotSideNotice({
    side: "base",
    headVotes: 0,
    baseVotes: 3,
    filesChecked: 2,
    filesSkipped: 0,
    filesWithoutHunks: 0,
  });
  expect(base).toContain("base");

  const mixed = formatRepoSnapshotSideNotice({
    side: "mixed",
    headVotes: 1,
    baseVotes: 1,
    filesChecked: 2,
    filesSkipped: 0,
    filesWithoutHunks: 0,
  });
  expect(mixed).toContain("混杂");

  const silent = {
    headVotes: 0,
    baseVotes: 0,
    filesChecked: 0,
    filesSkipped: 0,
    filesWithoutHunks: 0,
  } as const;
  expect(formatRepoSnapshotSideNotice({ ...silent, side: "head" })).toBeUndefined();
  expect(formatRepoSnapshotSideNotice({ ...silent, side: "unknown" })).toBeUndefined();
});
