import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";

import {
  SESSION_INDEX_FILENAME,
  readSessionIndex,
  sessionIndexPath,
  writeSessionIndex,
  type SessionIndex,
} from "./session-index.js";

/**
 * cwd session 索引（ADR-0036）：每次 run 覆盖、绝对路径、原子写。
 * 锁定面：形状校验（version / 必填字符串 / skills 数组）、缺失与坏文件的人话错误、
 * 重复写只留最新一份。
 */

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function sample(overrides: Partial<SessionIndex> = {}): SessionIndex {
  return {
    version: 2,
    taskId: "t-1",
    tasksDir: path.resolve("/tasks"),
    runId: "20261103_101500_000",
    repo: path.resolve("/repo"),
    updatedAt: "2026-11-03T10:15:00.000Z",
    mains: [path.resolve("/tasks/t-1/runs/session-20261103_101500_000.json")],
    skills: [path.resolve("/tasks/t-1/runs/session-20261103_101500_000-skill-a-r1.json")],
    ...overrides,
  };
}

test("写入后读回同形；重复写覆盖旧的一份", async () => {
  const cwd = makeTempDir("review-pi-session-index-");
  const first = sample();
  const written = await writeSessionIndex(cwd, first);
  expect(written).toBe(sessionIndexPath(cwd));
  expect(written.endsWith(SESSION_INDEX_FILENAME)).toBe(true);
  expect(await readSessionIndex(cwd)).toEqual(first);

  const second = sample({ taskId: "t-2", skills: [] });
  await writeSessionIndex(cwd, second);
  expect(await readSessionIndex(cwd)).toEqual(second);
  // 落盘形态：2 空格缩进 + 尾换行
  expect(readFileSync(written, "utf8")).toBe(`${JSON.stringify(second, null, 2)}\n`);
});

test("v1 索引（单个 main）仍可读，读取端归一为 mains: [main]（ADR-0039）", async () => {
  const cwd = makeTempDir("review-pi-session-index-v1-");
  const main = path.resolve("/tasks/t-1/runs/session-20261103_101500_000.json");
  await writeFile(
    sessionIndexPath(cwd),
    JSON.stringify({
      version: 1,
      taskId: "t-1",
      tasksDir: path.resolve("/tasks"),
      runId: "20261103_101500_000",
      repo: path.resolve("/repo"),
      updatedAt: "2026-11-03T10:15:00.000Z",
      main,
      skills: [],
    }),
    "utf8",
  );
  await expect(readSessionIndex(cwd)).resolves.toMatchObject({
    version: 2,
    mains: [main],
    skills: [],
  });
});

test("索引缺席 / 坏 JSON / 版本不符都是人话错误", async () => {
  const cwd = makeTempDir("review-pi-session-index-missing-");
  await expect(readSessionIndex(cwd)).rejects.toThrow(/未找到 session 索引/);

  const bad = makeTempDir("review-pi-session-index-bad-");
  await writeFile(sessionIndexPath(bad), "{not json", "utf8");
  await expect(readSessionIndex(bad)).rejects.toThrow(/不是合法 JSON/);

  const versionMismatch = makeTempDir("review-pi-session-index-version-");
  await writeFile(
    sessionIndexPath(versionMismatch),
    JSON.stringify({ ...sample(), version: 3 }),
    "utf8",
  );
  await expect(readSessionIndex(versionMismatch)).rejects.toThrow(/version 必须为 1/);

  const badShape = makeTempDir("review-pi-session-index-shape-");
  await writeFile(
    sessionIndexPath(badShape),
    JSON.stringify({ ...sample(), skills: [""] }),
    "utf8",
  );
  await expect(readSessionIndex(badShape)).rejects.toThrow(/skills/);

  const relativePath = makeTempDir("review-pi-session-index-relative-");
  await writeFile(
    sessionIndexPath(relativePath),
    JSON.stringify({ ...sample(), mains: ["session-1.json"] }),
    "utf8",
  );
  await expect(readSessionIndex(relativePath)).rejects.toThrow(/mains 必须是非空的绝对路径数组/);
});
