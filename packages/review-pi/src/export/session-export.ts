import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { OPENCODE_DIR } from "./opencode-compat.js";
import { runDirPath } from "../experiment/run-record.js";
import { resolveTasksRoot, taskDirPath } from "../shared/tasks-dir.js";
import { readSessionIndex, tryReadSessionIndex, type SessionIndex } from "./session-index.js";

/**
 * `review-pi export` 的解析与复制（ADR-0036 / ADR-0072）。
 *
 * 两种寻址：
 * - 缺省：读 cwd 的 `.review-pi-session.json`（上一次成功 run 写的绝对路径）；
 * - `--taskId <id>`：读 `<tasks 根>/<id>/runs/` 下**最新一次 run** 的转录
 *   （以 `run.json` 的 `auditPath` 反推 runId，再拼主 / skill 文件名）。
 *
 * 两种模式都只返回**文件确实存在**的路径；缺文件即人话报错，不返回幽灵路径。
 *
 * 表示切换（ADR-0072）：缺省返回 OpenCode 兼容版转录（同目录 `<…>/opencode/`），
 * `--native` 切回 pi 原生转录；`--path <dir>` 平铺复制所选表示（保留原文件名、
 * 同名覆盖），返回值改为复制后的绝对路径；复制兼容版时目标目录额外产出
 * `manifest.json`（导入顺序）。
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
  /** 表示切换（ADR-0072）：true = 返回 pi 原生转录；缺席 = OpenCode 兼容版 */
  readonly native?: boolean;
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
  const ordered = sessions.order ?? [...sessions.mains, ...sessions.skills];
  const nativeSources = ordered.map((file) => resolve(file));
  await assertSessionsExist(nativeSources);

  const native = input.native === true;
  const sources = native ? nativeSources : nativeSources.map(compatPathOf);
  if (!native) {
    await assertCompatSessionsExist(sources);
  }

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
  // OpenCode 兼容版复制时在目标目录写导入顺序清单（ADR-0072）：只随兼容版产出，
  // 原生复制不写。
  if (!native) {
    await writeCompatManifest(copiedTo, sources);
  }
  return { sources, returned, copiedTo };
}

/** 原生转录路径 → 同目录 `opencode/` 子目录下的兼容版路径 */
function compatPathOf(nativePath: string): string {
  const resolved = resolve(nativePath);
  return join(dirname(resolved), OPENCODE_DIR, basename(resolved));
}

/** 兼容版存在性校验：缺失报「旧 run 无兼容转录、请用 --native」的人话，不返回幽灵路径 */
async function assertCompatSessionsExist(files: readonly string[]): Promise<void> {
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
    throw new Error(
      `该 run 没有 OpenCode 兼容转录（<runs>/opencode/ 子目录缺失或文件不全）；` +
        `旧 run 请改用 --native 取原生转录，或用升级后的 review-pi 重跑。缺失：\n${missing.join("\n")}`,
    );
  }
}

/**
 * 兼容版目标目录的 `manifest.json`（ADR-0072）：记录导入顺序（父先于子）与
 * 每条会话的 `info.id` / `parentID` / `outcome`。`parentID` / `outcome` 读自
 * 兼容文件自己的 `info`（文件系统读取，仍不碰配置 / 不调模型）。
 */
async function writeCompatManifest(dir: string, compatFiles: readonly string[]): Promise<void> {
  const importOrder: string[] = [];
  const sessions: unknown[] = [];
  for (const file of compatFiles) {
    const id = basename(file).replace(/\.json$/, "");
    importOrder.push(id);
    let info: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as { info?: unknown };
      if (typeof parsed.info === "object" && parsed.info !== null) {
        info = parsed.info as Record<string, unknown>;
      }
    } catch {
      info = undefined;
    }
    sessions.push({
      id,
      file: basename(file),
      ...(info?.["parentID"] !== undefined ? { parentID: info["parentID"] } : {}),
      ...(info?.["outcome"] !== undefined ? { outcome: info["outcome"] } : {}),
    });
  }
  const manifest = {
    generatedAt: new Date().toISOString(),
    importOrder,
    sessions,
  };
  await writeFile(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
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

  // 单遍（ADR-0088）：优先用写者记录的绝对转录路径；旧记录由 auditPath 的
  // runId 推 `runs/session-<runId>.json`（唯一 legacy 分支）。两者都没有即报错，
  // 不再猜「最新 session 文件」。
  const recorded = baselineTranscriptPath(record);
  const runId = runIdOfRecord(record) ?? (recorded !== undefined ? runIdOfTranscript(recorded) : undefined);
  if (recorded === undefined && runId === undefined) {
    throw new Error(
      `run.json 缺少 baseline.transcriptPath / auditPath，无法定位主转录：${recordPath}`,
    );
  }
  return {
    mains: [
      recorded !== undefined
        ? resolve(recorded)
        : join(runsDir, `session-${String(runId)}.json`),
    ],
    skills:
      logged.length > 0
        ? logged
        : runId !== undefined
          ? await listSkillSessions(runsDir, runId)
          : [],
  };
}

/** `run.json` 的 `baseline.transcriptPath`（ADR-0088；旧记录缺席） */
function baselineTranscriptPath(record: unknown): string | undefined {
  if (typeof record !== "object" || record === null) {
    return undefined;
  }
  const baseline = (record as Record<string, unknown>).baseline;
  if (typeof baseline !== "object" || baseline === null) {
    return undefined;
  }
  const transcriptPath = (baseline as Record<string, unknown>).transcriptPath;
  return typeof transcriptPath === "string" && transcriptPath.trim() !== ""
    ? transcriptPath
    : undefined;
}

/** 从 `session-<runId>.json` 取 runId（记录路径的 legacy 兜底） */
function runIdOfTranscript(transcriptPath: string): string | undefined {
  const runId = basename(transcriptPath).replace(/^session-/, "").replace(/\.json$/, "");
  return /^\d{8}_\d{6}_\d{3}$/.test(runId) ? runId : undefined;
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
