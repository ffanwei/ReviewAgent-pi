import { isAbsolute, posix, win32 } from "node:path";

import { CONFIG_DIR_NAME, homeDirectory } from "./config.js";

/**
 * 任务输出目录（ADR-0033）：`review` 的落盘位置由「任务 id」决定，
 * 不再是用户随手给的 `--out` 路径。
 *
 * 形态：
 * - 缺省根 = `<home>/.PiAgent/tasks`（与配置文件同住 `.PiAgent/`）；
 * - 单次 run 的落盘根 = `<tasksRoot>/<taskId>`（其下仍是 `runs/` + `audit/` + `.cache/`，
 *   见 ADR-0032）；
 * - `--tasks-dir <dir>` 只覆盖**根**（测试 / CI / 沙箱），taskId 语义不变。
 *
 * 纪律：
 * - 主目录为空 = fail fast，不猜路径（与 `resolveConfigPath` 同口径）；
 * - taskId 是**单段目录名**，不是路径：分隔符 / 盘符 / 控制字符 / Windows 保留名一律拒绝，
 *   否则 `--taskId ../../x` 能把产物写到任意位置。
 */

export const TASKS_DIR_NAME = "tasks";

/** 缺省根的人话标签（usage / 参数回显用；`~` 形态，跨平台一致） */
export const DEFAULT_TASKS_ROOT_LABEL = `~/${CONFIG_DIR_NAME}/${TASKS_DIR_NAME}`;

/** taskId 长度上限（目录名，不追求语义，只挡住畸形输入） */
export const TASK_ID_MAX_CHARS = 100;

/** Windows 设备名（大小写不敏感，带扩展名同样不可用：`con.txt`） */
const WINDOWS_RESERVED_NAMES: readonly string[] = [
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, index) => `com${String(index + 1)}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${String(index + 1)}`),
];

/** Windows 上文件名非法字符（`/` `\` 单列，便于给出更准的文案） */
const WINDOWS_INVALID_CHARS = /[<>:"|?*]/;
/** 控制字符（含 NUL）；`\p{Cc}` 覆盖 C0/C1 */
const CONTROL_CHARS = /\p{Cc}/u;

/** 注入 platform 时也必须用对应解析器（测试跨平台确定性） */
function resolveFor(platform: NodeJS.Platform, ...parts: string[]): string {
  return platform === "win32" ? win32.resolve(...parts) : posix.resolve(...parts);
}

export interface TasksRootOptions {
  /** `--tasks-dir` 显式值（相对路径按 `cwd` 解析） */
  readonly tasksDir?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

/** tasks 根目录：`--tasks-dir` 优先（按 cwd 解析），否则 `<home>/.PiAgent/tasks` */
export function resolveTasksRoot(options: TasksRootOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const cwd = options.cwd ?? process.cwd();
  const tasksDir = options.tasksDir;
  if (tasksDir !== undefined) {
    return resolveFor(platform, cwd, tasksDir);
  }
  const home = homeDirectory({
    platform,
    ...(options.env !== undefined ? { env: options.env } : {}),
  });
  if (home === undefined) {
    throw new Error(
      `无法确定用户主目录（${platform === "win32" ? "USERPROFILE" : "HOME"} 为空）——请用 --tasks-dir <dir> 指定 tasks 根目录`,
    );
  }
  const dir = platform === "win32" ? win32.join(home, CONFIG_DIR_NAME, TASKS_DIR_NAME) : posix.join(home, CONFIG_DIR_NAME, TASKS_DIR_NAME);
  return resolveFor(platform, dir);
}

/** 单次 run 的落盘根：`<tasksRoot>/<taskId>` */
export function taskDirPath(
  tasksRoot: string,
  taskId: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return resolveFor(platform, tasksRoot, taskId);
}

export type TaskIdCheck =
  | { readonly ok: true; readonly taskId: string }
  | { readonly ok: false; readonly message: string };

/**
 * taskId 校验：必须能安全地当作**单段目录名**用。
 * 允许空格与任意 Unicode（中文任务名合法），拒绝一切能把路径「拐出去」或让
 * Windows 无法建目录的形态。
 */
export function checkTaskId(raw: string): TaskIdCheck {
  const taskId = raw.trim();
  const invalid = (reason: string): TaskIdCheck => ({
    ok: false,
    message: `invalid --taskId ${JSON.stringify(raw)}: ${reason}`,
  });
  if (taskId.length === 0) {
    return invalid("must be a non-empty task id");
  }
  if (taskId.length > TASK_ID_MAX_CHARS) {
    return invalid(`must be at most ${String(TASK_ID_MAX_CHARS)} characters`);
  }
  if (taskId === "." || taskId === "..") {
    return invalid('must not be "." or ".."');
  }
  if (taskId.startsWith(".")) {
    return invalid('must not start with "." (task dirs stay visible in ~/.PiAgent/tasks)');
  }
  if (taskId.includes("/") || taskId.includes("\\")) {
    return invalid("must not contain path separators (taskId is a single directory name)");
  }
  if (isAbsolute(taskId) || /^[A-Za-z]:/.test(taskId)) {
    return invalid("must not be an absolute path (taskId is a single directory name)");
  }
  if (CONTROL_CHARS.test(taskId)) {
    return invalid("must not contain control characters");
  }
  if (WINDOWS_INVALID_CHARS.test(taskId)) {
    return invalid('must not contain any of <>:"|?* (Windows-invalid file name characters)');
  }
  if (/[. ]$/.test(taskId)) {
    return invalid('must not end with "." or a space (Windows strips them)');
  }
  const base = taskId.split(".")[0]?.toLowerCase() ?? "";
  if (WINDOWS_RESERVED_NAMES.includes(base)) {
    return invalid(`"${base}" is a reserved device name on Windows`);
  }
  return { ok: true, taskId };
}
