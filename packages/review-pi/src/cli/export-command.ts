import { exportSessions } from "../export/session-export.js";
import type { ExportCliArgs } from "./args.js";

/**
 * `review-pi export`（ADR-0036）：纯文件系统命令——不加载配置、不需要 apiKey、
 * 不调用模型。stdout 只输出路径（一行一个，主会话在前），便于 shell 直接消费。
 *
 * 复制失败 / 索引或任务缺失由 `exportSessions` 抛人话错误，主缝统一 exit 1。
 */
export async function runExportCommand(args: ExportCliArgs): Promise<number> {
  const result = await exportSessions({
    cwd: process.cwd(),
    ...(args.taskId !== undefined ? { taskId: args.taskId } : {}),
    ...(args.tasksDir !== undefined ? { tasksDir: args.tasksDir } : {}),
    ...(args.destPath !== undefined ? { destPath: args.destPath } : {}),
  });
  for (const file of result.returned) {
    process.stdout.write(`${file}\n`);
  }
  return 0;
}
