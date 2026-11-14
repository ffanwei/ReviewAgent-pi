import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";

import { exportSessions } from "./session-export.js";
import { writeSessionIndex, type SessionIndex } from "./session-index.js";

/**
 * export 解析与复制（ADR-0036 / ADR-0072）：
 * - 索引模式：主会话在前，skill 按 skillPassLog 顺序；
 * - `--taskId` 模式：从 run.json 的 auditPath 反推 runId；
 * - `--path`：平铺复制、返回目标路径；
 * - 索引里的 tasksDir 优先于 --tasks-dir；
 * - 表示切换：缺省 = OpenCode 兼容版（opencode/），`--native` = 原生；
 * - 旧 run 无 opencode/ → 人话报错；复制兼容版时写 manifest.json；
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

interface MadeTask {
  readonly mains: readonly string[];
  readonly skills: readonly string[];
  readonly compatMains: readonly string[];
  readonly compatSkills: readonly string[];
}

/** 建一份任务产物：原生转录 + 同目录 opencode/ 兼容版（含 manifest 读取所需的 info） */
function makeTask(
  tasksRoot: string,
  taskId: string,
  skillNames: readonly string[],
  runId = RUN_ID,
): MadeTask {
  const runs = path.join(tasksRoot, taskId, "runs");
  mkdirSync(runs, { recursive: true });
  const main = path.join(runs, `session-${runId}.json`);
  writeFileSync(main, `{"main":true}\n`, "utf8");
  const skills = skillNames.map((name) => {
    const file = path.join(runs, `session-${runId}-skill-${name}-r1.json`);
    writeFileSync(file, `{"skill":"${name}"}\n`, "utf8");
    return file;
  });
  // OpenCode 兼容版（ADR-0072 的 run 时产物），放在 opencode/ 子目录
  const ocDir = path.join(runs, "opencode");
  mkdirSync(ocDir, { recursive: true });
  const compatMain = path.join(ocDir, `session-${runId}.json`);
  writeFileSync(
    compatMain,
    JSON.stringify({ info: { id: `session-${runId}`, outcome: "succeeded", tokens: {}, cost: 0 } }),
    "utf8",
  );
  const compatSkills = skillNames.map((name, position) => {
    const id = `session-${runId}-skill-${name}-r1`;
    const file = path.join(ocDir, `${id}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        info: { id, parentID: `session-${runId}`, outcome: skills.length - 1 === position ? "succeeded" : "succeeded" },
      }),
      "utf8",
    );
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
  return { mains: [main], skills, compatMains: [compatMain], compatSkills };
}

function indexOf(
  cwd: string,
  taskId: string,
  tasksDir: string,
  sessions: { readonly mains: readonly string[]; readonly skills: readonly string[] },
): SessionIndex {
  return {
    version: 2,
    taskId,
    tasksDir,
    runId: RUN_ID,
    repo: path.join(cwd, "repo"),
    updatedAt: "2026-11-03T10:15:00.000Z",
    mains: sessions.mains,
    skills: sessions.skills,
  };
}

test("缺省返回 OpenCode 兼容版；--native 返回原生转录（索引模式）", async () => {
  const cwd = makeTempDir("review-pi-export-representation-");
  const tasksRoot = path.join(cwd, "tasks");
  const sessions = makeTask(tasksRoot, "t-1", ["a", "b"]);
  await writeSessionIndex(cwd, indexOf(cwd, "t-1", tasksRoot, sessions));

  const compat = await exportSessions({ cwd });
  expect(compat.returned).toEqual([...sessions.compatMains, ...sessions.compatSkills]);

  const native = await exportSessions({ cwd, native: true });
  expect(native.returned).toEqual([...sessions.mains, ...sessions.skills]);
});

test("无索引：人话报错（提示 --taskId 或先跑 review）", async () => {
  const cwd = makeTempDir("review-pi-export-noindex-");
  await expect(exportSessions({ cwd })).rejects.toThrow(/未找到 session 索引/);
});

test("旧 run（无 opencode/）：缺省报人话错误并提示 --native", async () => {
  const cwd = makeTempDir("review-pi-export-oldrun-");
  const tasksRoot = path.join(cwd, "tasks");
  const sessions = makeTask(tasksRoot, "t-1", ["a"]);
  rmSync(sessions.compatMains[0] as string);
  rmSync(sessions.compatSkills[0] as string);
  rmSync(path.join(tasksRoot, "t-1", "runs", "opencode"), { recursive: true, force: true });
  await writeSessionIndex(cwd, indexOf(cwd, "t-1", tasksRoot, sessions));

  await expect(exportSessions({ cwd })).rejects.toThrow(/没有 OpenCode 兼容转录/);
  // --native 仍可读原生
  const native = await exportSessions({ cwd, native: true });
  expect(native.returned).toEqual([...sessions.mains, ...sessions.skills]);
});

test("--taskId 模式：按 --tasks-dir 找任务，runId 从 auditPath 反推", async () => {
  const cwd = makeTempDir("review-pi-export-task-");
  const tasksRoot = path.join(cwd, "tasks");
  const sessions = makeTask(tasksRoot, "t-9", ["x"]);

  const result = await exportSessions({ cwd, taskId: "t-9", tasksDir: tasksRoot, native: true });
  expect(result.returned).toEqual([...sessions.mains, sessions.skills[0]]);
});

test("--taskId 模式：优先使用 baseline.transcriptPath（ADR-0088）", async () => {
  const cwd = makeTempDir("review-pi-export-recorded-");
  const tasksRoot = path.join(cwd, "tasks");
  makeTask(tasksRoot, "t-10", ["a"]);
  const runs = path.join(tasksRoot, "t-10", "runs");
  const recorded = path.join(runs, "custom-main.json");
  writeFileSync(
    recorded,
    JSON.stringify({ info: { id: "session-custom" }, messages: [] }),
    "utf8",
  );
  const recordPath = path.join(runs, "run.json");
  const record = JSON.parse(readFileSync(recordPath, "utf8")) as {
    baseline: Record<string, unknown>;
  };
  record.baseline.transcriptPath = recorded;
  writeFileSync(recordPath, JSON.stringify(record), "utf8");

  const result = await exportSessions({
    cwd,
    taskId: "t-10",
    tasksDir: tasksRoot,
    native: true,
  });

  expect(result.returned[0]).toBe(recorded);
});

test("--taskId 模式：记录既无 transcriptPath 也无 auditPath → 人话报错", async () => {
  const cwd = makeTempDir("review-pi-export-no-path-");
  const tasksRoot = path.join(cwd, "tasks");
  makeTask(tasksRoot, "t-11", []);
  const recordPath = path.join(tasksRoot, "t-11", "runs", "run.json");
  const record = JSON.parse(readFileSync(recordPath, "utf8")) as {
    baseline: Record<string, unknown>;
  };
  delete record.baseline.auditPath;
  writeFileSync(recordPath, JSON.stringify(record), "utf8");

  await expect(
    exportSessions({ cwd, taskId: "t-11", tasksDir: tasksRoot, native: true }),
  ).rejects.toThrow(/无法定位主转录/);
});

test("索引里的 tasksDir 优先于 --tasks-dir", async () => {
  const cwd = makeTempDir("review-pi-export-precedence-");
  const indexPath = path.join(cwd, "indexed-tasks");
  const flagPath = path.join(cwd, "flag-tasks");
  const indexed = makeTask(indexPath, "t-1", ["only-index"]);
  makeTask(flagPath, "t-1", ["only-flag"]);
  await writeSessionIndex(cwd, indexOf(cwd, "t-1", indexPath, indexed));

  const result = await exportSessions({ cwd, taskId: "t-1", tasksDir: flagPath, native: true });
  expect(result.returned[0]?.startsWith(indexPath)).toBe(true);
  expect(result.returned.some((file) => file.includes("only-index"))).toBe(true);
});

test("--path：平铺复制、内容一致、返回目标绝对路径（主在前）", async () => {
  const cwd = makeTempDir("review-pi-export-copy-");
  const tasksRoot = path.join(cwd, "tasks");
  const sessions = makeTask(tasksRoot, "t-1", ["a", "b"]);
  await writeSessionIndex(cwd, indexOf(cwd, "t-1", tasksRoot, sessions));

  const result = await exportSessions({ cwd, destPath: "out/sessions", native: true });
  const destDir = path.join(cwd, "out", "sessions");
  expect(result.copiedTo).toBe(destDir);
  expect(result.returned).toEqual([
    ...sessions.mains.map((file) => path.join(destDir, path.basename(file))),
    ...sessions.skills.map((file) => path.join(destDir, path.basename(file))),
  ]);
  expect(readFileSync(result.returned[0] as string, "utf8")).toBe(
    readFileSync(sessions.mains[0] as string, "utf8"),
  );
  expect(existsSync(result.returned[1] as string)).toBe(true);
  expect(existsSync(path.join(destDir, "manifest.json"))).toBe(false); // 原生复制不产 manifest
});

test("--path 复制兼容版：目标目录多一份 manifest.json（父先于子）", async () => {
  const cwd = makeTempDir("review-pi-export-copy-compat-");
  const tasksRoot = path.join(cwd, "tasks");
  const sessions = makeTask(tasksRoot, "t-1", ["a", "b"]);
  await writeSessionIndex(cwd, indexOf(cwd, "t-1", tasksRoot, sessions));

  const result = await exportSessions({ cwd, destPath: "out/oc" });
  const destDir = path.join(cwd, "out", "oc");
  expect(result.returned).toEqual([
    ...sessions.compatMains.map((file) => path.join(destDir, path.basename(file))),
    ...sessions.compatSkills.map((file) => path.join(destDir, path.basename(file))),
  ]);
  const manifest = readFileSync(path.join(destDir, "manifest.json"), "utf8");
  const parsed = JSON.parse(manifest) as { importOrder: readonly string[]; sessions: readonly { parentID?: string }[] };
  expect(parsed.importOrder).toEqual([
    `session-${RUN_ID}`,
    `session-${RUN_ID}-skill-a-r1`,
    `session-${RUN_ID}-skill-b-r1`,
  ]);
  expect(parsed.sessions[1]?.["parentID"]).toBe(`session-${RUN_ID}`);
});

test("主会话文件缺失：不返回幽灵路径", async () => {
  const cwd = makeTempDir("review-pi-export-missing-");
  const tasksRoot = path.join(cwd, "tasks");
  const sessions = makeTask(tasksRoot, "t-1", []);
  rmSync(sessions.mains[0] as string);
  await writeSessionIndex(cwd, indexOf(cwd, "t-1", tasksRoot, sessions));

  await expect(exportSessions({ cwd, native: true })).rejects.toThrow(/session 文件不存在/);
});

test("任务不存在：人话报错", async () => {
  const cwd = makeTempDir("review-pi-export-notask-");
  const tasksRoot = path.join(cwd, "tasks");
  mkdirSync(tasksRoot, { recursive: true });
  await expect(exportSessions({ cwd, taskId: "nope", tasksDir: tasksRoot, native: true })).rejects.toThrow(
    /没有 run\.json/,
  );
});

test("分片任务：按 s01 主 → s01 skill → s02 主 → s02 skill 列出全部会话（ADR-0039）", async () => {
  const cwd = makeTempDir("review-pi-export-shards-");
  const tasksRoot = path.join(cwd, "tasks");
  const taskId = "t-split";
  const runs = path.join(tasksRoot, taskId, "runs");
  const attempt = "attempt-20261103_101500_000";
  const shardRunIds = ["20261103_101500_100", "20261103_101500_200"];
  const mainFiles: string[] = [];
  const skillFiles: string[] = [];
  const skillLog: unknown[] = [];
  const shardRecords: unknown[] = [];
  shardRunIds.forEach((shardRunId, position) => {
    const dirName = `s0${String(position + 1)}`;
    const shardDir = path.join(runs, "shards", attempt, dirName);
    mkdirSync(shardDir, { recursive: true });
    const main = path.join(shardDir, `session-${shardRunId}.json`);
    const skill = path.join(shardDir, `session-${shardRunId}-skill-rule-r1.json`);
    writeFileSync(main, `{"shard":${String(position + 1)}}\n`, "utf8");
    writeFileSync(skill, `{"shard":${String(position + 1)},"skill":"rule"}\n`, "utf8");
    // 兼容版（缺省路径靠此存在性校验通过）
    const ocDir = path.join(shardDir, "opencode");
    mkdirSync(ocDir, { recursive: true });
    writeFileSync(path.join(ocDir, path.basename(main)), `{"info":{"id":"${path.basename(main, ".json")}"}}\n`, "utf8");
    writeFileSync(path.join(ocDir, path.basename(skill)), `{"info":{"id":"${path.basename(skill, ".json")}"}}\n`, "utf8");
    mainFiles.push(main);
    skillFiles.push(skill);
    // 聚合 run.json 里两者都是 runs 目录相对 POSIX 路径
    const mainRelative = ["shards", attempt, dirName, path.basename(main)].join("/");
    const skillRelative = ["shards", attempt, dirName, path.basename(skill)].join("/");
    skillLog.push({ skill: "rule", round: 1, transcriptFile: skillRelative });
    shardRecords.push({
      index: position + 1,
      runId: shardRunId,
      files: 1,
      chars: 100,
      complete: true,
      truncated: false,
      usage: {},
      rounds: 1,
      toolCalls: 0,
      transcriptFile: mainRelative,
      auditFile: ["shards", attempt, dirName, `${shardRunId}.json`].join("/"),
    });
  });
  writeFileSync(
    path.join(runs, "run.json"),
    JSON.stringify({
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
        auditPath: path.join(tasksRoot, taskId, "audit", `${RUN_ID}.json`),
        audit: { skillPassLog: skillLog },
      },
      effective: null,
      verifierPass: null,
      shards: shardRecords,
    }),
    "utf8",
  );

  const result = await exportSessions({ cwd, taskId, tasksDir: tasksRoot, native: true });
  expect(result.returned).toEqual([
    mainFiles[0],
    skillFiles[0],
    mainFiles[1],
    skillFiles[1],
  ]);
});