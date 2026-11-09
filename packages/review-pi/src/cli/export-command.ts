import { exportSessions } from "../export/session-export.js";
import type { ExportCliArgs } from "./args.js";

/**
 * `review-pi export`（ADR-0036）：纯文件系统命令——不加载配置、不需要 apiKey、
 * 不调用模型。stdout 只输出一行路径（逗号 + 空格分隔，主会话在前），便于
 * shell 直接当作单个字符串消费。
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
  process.stdout.write(`${result.returned.join(", ")}\n`);
  return 0;
}
