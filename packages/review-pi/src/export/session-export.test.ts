import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";

import { exportSessions } from "./session-export.js";
import { writeSessionIndex, type SessionIndex } from "./session-index.js";

/**
 * export 解析与复制（ADR-0036）：
 * - 索引模式：主会话在前，skill 按 skillPassLog 顺序；
 * - `--taskId` 模式：从 run.json 的 auditPath 反推 runId；
 * - `--path`：平铺复制、返回目标路径；
 * - 索引里的 tasksDir 优先于 --tasks-dir；
 * - 文件缺失 / 任务缺失是人话错误。
 */

const RUN_ID = "20261103_101500_000";
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

function makeTask(
  tasksRoot: string,
  taskId: string,
  skillNames: readonly string[],
  runId = RUN_ID,
): { readonly main: string; readonly skills: readonly string[] } {
  const runs = path.join(tasksRoot, taskId, "runs");
  mkdirSync(runs, { recursive: true });
  const main = path.join(runs, `session-${runId}.json`);
  writeFileSync(main, `{"main":true}\n`, "utf8");
  const skills = skillNames.map((name) => {
    const file = path.join(runs, `session-${runId}-skill-${name}-r1.json`);
    writeFileSync(file, `{"skill":"${name}"}\n`, "utf8");
    return file;
  });
  const record = {
    source: "mr",
    caseId: "case",
    rep: 1,
    model: "m",
    verifier: "off",
    completedAt: "2026-11-03T10:15:00.000Z",
    baseline: {
      findings: [],
      usage: {},
      rounds: 1,
      toolCalls: 0,
      auditPath: path.join(tasksRoot, taskId, "audit", `${runId}.json`),
      audit: {
        skillPassLog: skillNames.map((name) => ({
          skill: name,
          transcriptFile: `session-${runId}-skill-${name}-r1.json`,
        })),
      },
    },
  };
  writeFileSync(path.join(runs, "run.json"), JSON.stringify(record), "utf8");
  return { main, skills };
}

function indexOf(
  cwd: string,
  taskId: string,
  tasksDir: string,
  sessions: { readonly main: string; readonly skills: readonly string[] },
): SessionIndex {
  return {
    version: 1,
    taskId,
    tasksDir,
    runId: RUN_ID,
    repo: path.join(cwd, "repo"),
    updatedAt: "2026-11-03T10:15:00.000Z",
    main: sessions.main,
    skills: sessions.skills,
  };
}

test("索引模式：主会话在前，skill 按 skillPassLog 顺序", async () => {
  const cwd = makeTempDir("review-pi-export-index-");
  const tasksRoot = path.join(cwd, "tasks");
  const sessions = makeTask(tasksRoot, "t-1", ["a", "b"]);
  await writeSessionIndex(cwd, indexOf(cwd, "t-1", tasksRoot, sessions));

  const result = await exportSessions({ cwd });
  expect(result.returned).toEqual([sessions.main, ...sessions.skills]);
  expect(result.sources).toEqual(result.returned);
  expect(result.copiedTo).toBeUndefined();
});

test("无索引：人话报错（提示 --taskId 或先跑 review）", async () => {
  const cwd = makeTempDir("review-pi-export-noindex-");
  await expect(exportSessions({ cwd })).rejects.toThrow(/未找到 session 索引/);
});

test("--taskId 模式：按 --tasks-dir 找任务，runId 从 auditPath 反推", async () => {
  const cwd = makeTempDir("review-pi-export-task-");
  const tasksRoot = path.join(cwd, "tasks");
  const sessions = makeTask(tasksRoot, "t-9", ["x"]);

  const result = await exportSessions({ cwd, taskId: "t-9", tasksDir: tasksRoot });
  expect(result.returned).toEqual([sessions.main, sessions.skills[0]]);
});

test("索引里的 tasksDir 优先于 --tasks-dir", async () => {
  const cwd = makeTempDir("review-pi-export-precedence-");
  const indexPath = path.join(cwd, "indexed-tasks");
  const flagPath = path.join(cwd, "flag-tasks");
  const indexed = makeTask(indexPath, "t-1", ["only-index"]);
  makeTask(flagPath, "t-1", ["only-flag"]);
  await writeSessionIndex(cwd, indexOf(cwd, "t-1", indexPath, indexed));

  const result = await exportSessions({ cwd, taskId: "t-1", tasksDir: flagPath });
  expect(result.returned[0]?.startsWith(indexPath)).toBe(true);
  expect(result.returned.some((file) => file.includes("only-index"))).toBe(true);
});

test("--path：平铺复制、内容一致、返回目标绝对路径（主在前）", async () => {
  const cwd = makeTempDir("review-pi-export-copy-");
  const tasksRoot = path.join(cwd, "tasks");
  const sessions = makeTask(tasksRoot, "t-1", ["a", "b"]);
  await writeSessionIndex(cwd, indexOf(cwd, "t-1", tasksRoot, sessions));

  const result = await exportSessions({ cwd, destPath: "out/sessions" });
  const destDir = path.join(cwd, "out", "sessions");
  expect(result.copiedTo).toBe(destDir);
  expect(result.returned).toEqual([
    path.join(destDir, path.basename(sessions.main)),
    ...sessions.skills.map((file) => path.join(destDir, path.basename(file))),
  ]);
  expect(readFileSync(result.returned[0] as string, "utf8")).toBe(
    readFileSync(sessions.main, "utf8"),
  );
  expect(existsSync(result.returned[1] as string)).toBe(true);
});

test("主会话文件缺失：不返回幽灵路径", async () => {
  const cwd = makeTempDir("review-pi-export-missing-");
  const tasksRoot = path.join(cwd, "tasks");
  const sessions = makeTask(tasksRoot, "t-1", []);
  rmSync(sessions.main);
  await writeSessionIndex(cwd, indexOf(cwd, "t-1", tasksRoot, sessions));

  await expect(exportSessions({ cwd })).rejects.toThrow(/session 文件不存在/);
});

test("任务不存在：人话报错", async () => {
  const cwd = makeTempDir("review-pi-export-notask-");
  const tasksRoot = path.join(cwd, "tasks");
  mkdirSync(tasksRoot, { recursive: true });
  await expect(exportSessions({ cwd, taskId: "nope", tasksDir: tasksRoot })).rejects.toThrow(
    /没有 run\.json/,
  );
});
