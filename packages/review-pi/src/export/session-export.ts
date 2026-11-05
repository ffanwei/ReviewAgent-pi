import { copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

import { runDirPath } from "../experiment/run-record.js";
import { resolveTasksRoot, taskDirPath } from "../shared/tasks-dir.js";
import { readSessionIndex, tryReadSessionIndex, type SessionIndex } from "./session-index.js";

/**
 * `review-pi export` 的解析与复制（ADR-0036）。
 *
 * 两种寻址：
 * - 缺省：读 cwd 的 `.review-pi-session.json`（上一次成功 run 写的绝对路径）；
 * - `--taskId <id>`：读 `<tasks 根>/<id>/runs/` 下**最新一次 run** 的转录
 *   （以 `run.json` 的 `auditPath` 反推 runId，再拼主 / skill 文件名）。
 *
 * 两种模式都只返回**文件确实存在**的路径；缺文件即人话报错，不返回幽灵路径。
 * `--path <dir>` 平铺复制（保留原文件名、同名覆盖），返回值改为复制后的绝对路径。
 */

export interface SessionPaths {
  /** 主会话转录（绝对路径；分片时按 s01 → s02 → … 顺序） */
  readonly mains: readonly string[];
  /** 规则 Skill 会话转录（绝对路径；装载 / 分片顺序；可能为空） */
  readonly skills: readonly string[];
  /**
   * 显式输出顺序（ADR-0039 决策 13）：分片时为 `s01 主 → s01 skill → s02 主 → …`；
   * 指数组缺席时退回「先全部主会话、再全部 skill」（单遍 / 索引模式的既有顺序）。
   */
  readonly order?: readonly string[];
}

export interface ExportSessionsInput {
  readonly cwd: string;
  /** 指定任务 id；缺席 = 读 cwd 索引 */
  readonly taskId?: string;
  /** tasks 根覆盖（只在 cwd 没有索引时生效；有索引以索引里的绝对根为准） */
  readonly tasksDir?: string;
  /** 复制目标目录（相对 cwd）；缺席 = 只返回源路径 */
  readonly destPath?: string;
}

export interface ExportSessionsResult {
  /** 源路径（主在前） */
  readonly sources: readonly string[];
  /** 返回给调用方的路径：未复制 = 源路径；复制 = 目标路径（主在前） */
  readonly returned: readonly string[];
  /** 复制目标目录（仅复制时出现） */
  readonly copiedTo?: string;
}

export async function exportSessions(input: ExportSessionsInput): Promise<ExportSessionsResult> {
  const sessions =
    input.taskId === undefined
      ? sessionsFromIndex(await readSessionIndex(input.cwd))
      : await sessionsFromTask(input, input.taskId);
  const sources = (sessions.order ?? [...sessions.mains, ...sessions.skills]).map((file) =>
    resolve(file),
  );
  await assertSessionsExist(sources);

  if (input.destPath === undefined) {
    return { sources, returned: sources };
  }

  const copiedTo = resolve(input.cwd, input.destPath);
  await mkdir(copiedTo, { recursive: true });
  const returned: string[] = [];
  for (const source of sources) {
    const target = join(copiedTo, basename(source));
    // 目标目录就是源目录时不做自拷贝（copyFile 同路径行为依平台而异）
    if (resolve(target) !== source) {
      await copyFile(source, target);
    }
    returned.push(target);
  }
  return { sources, returned, copiedTo };
}

function sessionsFromIndex(index: SessionIndex): SessionPaths {
  return { mains: index.mains, skills: index.skills };
}

async function sessionsFromTask(
  input: ExportSessionsInput,
  taskId: string,
): Promise<SessionPaths> {
  // 任务根的判定顺序（已与使用方确认）：cwd 索引里的 tasksDir → --tasks-dir → 缺省根
  const index = await tryReadSessionIndex(input.cwd);
  const tasksRoot =
    index?.tasksDir ??
    resolveTasksRoot({
      cwd: input.cwd,
      ...(input.tasksDir !== undefined ? { tasksDir: input.tasksDir } : {}),
    });
  const runsRoot = taskDirPath(tasksRoot, taskId);
  return sessionsFromRunRecord(runsRoot);
}

async function sessionsFromRunRecord(runsRoot: string): Promise<SessionPaths> {
  const runsDir = runDirPath(runsRoot);
  const recordPath = join(runsDir, "run.json");
  let raw: string;
  try {
    raw = await readFile(recordPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `任务目录里没有 run.json：${recordPath}（确认 --taskId 与 tasks 根是否正确）`,
        { cause: error },
      );
    }
    throw error;
  }

  let record: unknown;
  try {
    record = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`run.json 不是合法 JSON：${recordPath}`);
  }

  const logged = skillTranscriptFiles(record).map((file) => resolve(runsDir, file));
  const shardFiles = shardTranscriptFiles(record);
  const shards = shardFiles.map((file) => resolve(runsDir, file));
  if (shards.length > 0) {
    // 分片（ADR-0039 决策 13）：每个 shard 的主转录后紧跟它自己的 skill 转录。
    // 聚合 skillPassLog 的 transcriptFile 已是 runs 目录相对路径（含 sNN 段），
    // 按 shard 目录前缀归组即可还原「s01 主 → s01 skill → s02 主 → …」。
    const shardDirs = shardFiles.map((file) =>
      posixDirname(runRelative(runsDir, resolve(runsDir, file))),
    );
    const skills: string[] = [];
    const order: string[] = [];
    for (const [position, dir] of shardDirs.entries()) {
      const main = shards[position];
      if (main !== undefined) {
        order.push(main);
      }
      const prefix = dir === "" ? "" : `${dir}/`;
      for (const file of logged) {
        const relativeFile = runRelative(runsDir, file);
        if (relativeFile.startsWith(prefix)) {
          skills.push(file);
          order.push(file);
        }
      }
    }
    return { mains: shards, skills, order };
  }

  const runId = runIdOfRecord(record) ?? (await newestRunId(runsDir));
  return {
    mains: [join(runsDir, `session-${runId}.json`)],
    skills: logged.length > 0 ? logged : await listSkillSessions(runsDir, runId),
  };
}

/** `run.json` 的 `baseline.auditPath` 文件名就是 runId（ADR-0032 单源） */
function runIdOfRecord(record: unknown): string | undefined {
  const auditPath = recordPathValue(record);
  if (auditPath === undefined) {
    return undefined;
  }
  const runId = basename(auditPath).replace(/\.json$/, "");
  return /^\d{8}_\d{6}_\d{3}$/.test(runId) ? runId : undefined;
}

function recordPathValue(record: unknown): string | undefined {
  if (typeof record !== "object" || record === null) {
    return undefined;
  }
  const baseline = (record as Record<string, unknown>).baseline;
  if (typeof baseline !== "object" || baseline === null) {
    return undefined;
  }
  const audit = (baseline as Record<string, unknown>).audit;
  if (typeof audit === "object" && audit !== null) {
    const auditPath = (audit as Record<string, unknown>).auditPath;
    if (typeof auditPath === "string" && auditPath.trim() !== "") {
      return auditPath;
    }
  }
  const direct = (baseline as Record<string, unknown>).auditPath;
  return typeof direct === "string" && direct.trim() !== "" ? direct : undefined;
}

/** skill 转录按 skillPassLog 顺序取（与运行时回填的 transcriptFile 同源） */
function skillTranscriptFiles(record: unknown): readonly string[] {
  const log = auditEntries(record).skillPassLog;
  if (!Array.isArray(log)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of log) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const transcriptFile = (entry as Record<string, unknown>).transcriptFile;
    // 没有转录 = 会话没发出过请求（装载失败），不是缺失
    if (typeof transcriptFile === "string" && transcriptFile.trim() !== "") {
      files.push(transcriptFile);
    }
  }
  return files;
}

/** 分片主转录（ADR-0039）：`run.json.shards[]` 的顺序即执行顺序 */
function shardTranscriptFiles(record: unknown): readonly string[] {
  const shards = (record as { readonly shards?: unknown } | null)?.shards;
  if (!Array.isArray(shards)) {
    return [];
  }
  const files: string[] = [];
  for (const shard of shards) {
    if (typeof shard !== "object" || shard === null) {
      continue;
    }
    const transcriptFile = (shard as Record<string, unknown>).transcriptFile;
    if (typeof transcriptFile === "string" && transcriptFile.trim() !== "") {
      files.push(transcriptFile);
    }
  }
  return files;
}

function auditEntries(record: unknown): Record<string, unknown> {
  if (typeof record !== "object" || record === null) {
    return {};
  }
  const baseline = (record as Record<string, unknown>).baseline;
  if (typeof baseline !== "object" || baseline === null) {
    return {};
  }
  const audit = (baseline as Record<string, unknown>).audit;
  return typeof audit === "object" && audit !== null ? (audit as Record<string, unknown>) : {};
}

/** 绝对路径 → runs 目录相对 POSIX（与写入侧 `relativePosix` 同口径） */
function runRelative(runsDir: string, file: string): string {
  return relative(resolve(runsDir), resolve(file)).split(sep).join("/");
}

function posixDirname(posixPath: string): string {
  const index = posixPath.lastIndexOf("/");
  return index < 0 ? "" : posixPath.slice(0, index);
}

/** run.json 缺 auditPath 时的兜底：按文件名取最新 runId（固定宽度 = 字典序即时序） */
async function newestRunId(runsDir: string): Promise<string> {
  const names = await readdirOrThrow(runsDir);
  const runIds = names
    .map((name) => /^session-(\d{8}_\d{6}_\d{3})\.json$/.exec(name)?.[1])
    .filter((runId): runId is string => runId !== undefined)
    .sort();
  const runId = runIds.at(-1);
  if (runId === undefined) {
    throw new Error(`任务目录里没有任何主会话转录：${runsDir}`);
  }
  return runId;
}

/** 兜底：run.json 没有 skillPassLog 时，按文件名列出该 run 的 skill 转录 */
async function listSkillSessions(runsDir: string, runId: string): Promise<readonly string[]> {
  const names = await readdirOrThrow(runsDir);
  return names
    .filter((name) => name.startsWith(`session-${runId}-skill-`) && name.endsWith(".json"))
    .sort()
    .map((name) => join(runsDir, name));
}

async function readdirOrThrow(dir: string): Promise<readonly string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`任务目录不存在：${dir}`, { cause: error });
    }
    throw error;
  }
}

async function assertSessionsExist(files: readonly string[]): Promise<void> {
  const missing: string[] = [];
  for (const file of files) {
    try {
      const info = await stat(file);
      if (!info.isFile()) {
        missing.push(file);
      }
    } catch {
      missing.push(file);
    }
  }
  if (missing.length > 0) {
    throw new Error(`session 文件不存在：\n${missing.join("\n")}`);
  }
}
