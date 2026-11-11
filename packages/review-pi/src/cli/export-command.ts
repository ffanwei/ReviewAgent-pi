import { cp } from "node:fs/promises";
import { resolve } from "node:path";

import { exportSessions } from "../export/session-export.js";
import { TRACE_DIR, runsDirOf } from "../export/trace-export.js";
import type { ExportCliArgs } from "./args.js";

/**
 * `review-pi export`（ADR-0036）：纯文件系统命令——不加载配置、不需要 apiKey、
 * 不调用模型。stdout 只输出一行路径（逗号 + 空格分隔，主会话在前），便于
 * shell 直接当作单个字符串消费。
 *
 * `--trace <dir>`（ADR-0074）：trace 已在 run 时默认落盘到 `<runs>/opencode-trace/`，
 * 这里只把它复制到 `<dir>`（供 zip 后喂给 opencode-trace-viewer import）。
 *
 * 复制失败 / 索引或任务缺失由 `exportSessions` 抛人话错误，主缝统一 exit 1。
 */
export async function runExportCommand(args: ExportCliArgs): Promise<number> {
  if (args.traceDir !== undefined) {
    return runTraceExport(args);
  }
  const result = await exportSessions({
    cwd: process.cwd(),
    ...(args.taskId !== undefined ? { taskId: args.taskId } : {}),
    ...(args.tasksDir !== undefined ? { tasksDir: args.tasksDir } : {}),
    ...(args.destPath !== undefined ? { destPath: args.destPath } : {}),
    ...(args.native !== undefined ? { native: args.native } : {}),
  });
  process.stdout.write(`${result.returned.join(", ")}\n`);
  return 0;
}

/** `--trace <dir>`：复制 run 时已落盘的 `<runs>/opencode-trace/` 到目标目录 */
async function runTraceExport(args: ExportCliArgs): Promise<number> {
  const { sources } = await exportSessions({
    cwd: process.cwd(),
    ...(args.taskId !== undefined ? { taskId: args.taskId } : {}),
    ...(args.tasksDir !== undefined ? { tasksDir: args.tasksDir } : {}),
    native: true,
  });
  const main = sources.find((file) => !file.includes("-skill-"));
  if (main === undefined) {
    throw new Error("没有主会话转录，无法定位 trace 目录");
  }
  const traceDir = resolve(runsDirOf(main), TRACE_DIR);
  const dest = resolve(args.traceDir!);
  await cp(traceDir, dest, { recursive: true });
  process.stdout.write(`${dest}\n`);
  return 0;
}