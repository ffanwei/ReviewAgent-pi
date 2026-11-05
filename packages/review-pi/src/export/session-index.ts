import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

/**
 * cwd 的 session 索引（ADR-0036）：每次 `review` 成功后整份覆盖写一次，
 * 只记「去哪儿取本次 run 的转录」所需的寻址信息——不含消息正文、不含秘密。
 *
 * 为什么需要它：转录落在 `<tasks 根>/<taskId>/runs/`，而生产用法是「在代码仓
 * 目录里跑 review」，随后只想知道这次 run 的 session 在哪。把绝对路径记在 cwd
 * 的一份小 JSON 里，`review-pi export` 就不需要再猜 tasks 根 / taskId / runId。
 *
 * 纪律：
 * - 路径一律绝对（相对路径在不同 cwd 下会漂移）；
 * - 每次成功 run 覆盖，不做历史累积（历史转录仍留在 tasks 目录，靠 runId 区分）；
 * - 原子写（同目录临时文件 + rename），避免半截文件被 export 读到；
 * - 写失败由调用方降级为 stderr 警告，不改 run 的退出码。
 */

/** cwd 里的索引文件名（隐藏文件：不污染用户的仓库工作区） */
export const SESSION_INDEX_FILENAME = ".review-pi-session.json";

/** 索引文件版本（形状变更时递增；读取端兼容 v1） */
export const SESSION_INDEX_VERSION = 2;

export interface SessionIndex {
  readonly version: typeof SESSION_INDEX_VERSION;
  /** 本次 run 的任务 id（产物目录名） */
  readonly taskId: string;
  /** tasks 根的绝对路径（`--tasks-dir` 覆盖后的生效值） */
  readonly tasksDir: string;
  /** 本次 run 的 runId（首次模型请求时刻 `YYYYMMDD_HHMMSS_mmm`） */
  readonly runId: string;
  /** 被检视仓库快照根的绝对路径（排障用；不参与寻址） */
  readonly repo: string;
  /** run 完成时刻（ISO 8601） */
  readonly updatedAt: string;
  /**
   * 主会话转录的绝对路径（ADR-0039：分片后一个任务有多份，按 `s01 → s02 → …`）；
   * 单遍路径长度恒为 1。v1 索引的单个 `main` 读取时归一到这里。
   */
  readonly mains: readonly string[];
  /** 规则 Skill 会话转录的绝对路径（装载顺序；无 skill 时为空数组） */
  readonly skills: readonly string[];
}

/** 索引文件路径：`<cwd>/.review-pi-session.json` */
export function sessionIndexPath(cwd: string): string {
  return resolve(cwd, SESSION_INDEX_FILENAME);
}

/**
 * 覆盖写索引（原子替换）。返回目标文件绝对路径。
 * 失败直接抛错——是否降级由调用方决定（review 侧只警告）。
 */
export async function writeSessionIndex(cwd: string, index: SessionIndex): Promise<string> {
  const target = sessionIndexPath(cwd);
  const temp = `${target}.${String(process.pid)}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    await rename(temp, target);
  } catch (error) {
    // 半截临时文件不留在用户目录里（rename 失败 / 磁盘满等）
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  return target;
}

/**
 * 读索引并校验形状。缺失 / 非法 / 版本不符都是人话错误（调用方决定退出码）。
 */
export async function readSessionIndex(cwd: string): Promise<SessionIndex> {
  const target = sessionIndexPath(cwd);
  let raw: string;
  try {
    raw = await readFile(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `未找到 session 索引 ${target}（先在本目录跑一次 review，或用 --taskId <id> 指定任务）`,
        { cause: error },
      );
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`session 索引格式非法（${target}）：不是合法 JSON`);
  }
  return validateSessionIndex(parsed, target);
}

/** 索引存在就返回，否则 undefined（`--taskId` 模式用它推断 tasks 根） */
export async function tryReadSessionIndex(cwd: string): Promise<SessionIndex | undefined> {
  try {
    return await readSessionIndex(cwd);
  } catch {
    return undefined;
  }
}

function validateSessionIndex(value: unknown, path: string): SessionIndex {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`session 索引格式非法（${path}）：顶层必须是对象`);
  }
  const obj = value as Record<string, unknown>;
  if (obj.version !== 1 && obj.version !== SESSION_INDEX_VERSION) {
    throw new Error(
      `session 索引版本不支持（${path}）：version 必须为 1 或 ${String(SESSION_INDEX_VERSION)}`,
    );
  }
  const skills = obj.skills;
  if (
    !Array.isArray(skills) ||
    skills.some(
      (item) => typeof item !== "string" || item.trim() === "" || !isAbsolute(item),
    )
  ) {
    throw new Error(`session 索引格式非法（${path}）：skills 必须是绝对路径字符串数组`);
  }
  // v1（单个 main）读取时归一为 `mains: [main]`；新写一律 v2
  const mains =
    obj.version === 1 ? [requiredAbsolute(obj.main, "main", path)] : absoluteList(obj.mains, "mains", path);
  return {
    version: SESSION_INDEX_VERSION,
    taskId: requiredString(obj.taskId, "taskId", path),
    tasksDir: requiredString(obj.tasksDir, "tasksDir", path),
    runId: requiredString(obj.runId, "runId", path),
    repo: requiredString(obj.repo, "repo", path),
    updatedAt: requiredString(obj.updatedAt, "updatedAt", path),
    mains,
    skills: skills as readonly string[],
  };
}

/** v2：主转录数组必须非空且全为绝对路径 */
function absoluteList(value: unknown, key: string, path: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`session 索引格式非法（${path}）：${key} 必须是非空的绝对路径数组`);
  }
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "" || !isAbsolute(item)) {
      throw new Error(`session 索引格式非法（${path}）：${key} 必须是非空的绝对路径数组`);
    }
  }
  return value as readonly string[];
}

function requiredAbsolute(value: unknown, key: string, path: string): string {
  const text = requiredString(value, key, path);
  if (!isAbsolute(text)) {
    throw new Error(`session 索引格式非法（${path}）：${key} 必须是绝对路径`);
  }
  return text;
}

function requiredString(value: unknown, key: string, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`session 索引格式非法（${path}）：${key} 必须是非空字符串`);
  }
  return value;
}
