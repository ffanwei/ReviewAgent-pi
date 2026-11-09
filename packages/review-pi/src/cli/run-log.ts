import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";

/**
 * 运行日志（`review-pi.log`）：把 CLI 的 stderr 全量镜像到
 * `<tasks 根>/<taskId>/runs/`——与 `session-<runId>.json` 转录同目录，
 * 生产环境拿不到 stderr 时仍可事后看清「哪一步失败、原因是什么」。
 *
 * 纪律：
 * - **旁路**：日志打开 / 写入失败绝不影响检视与退出码；
 * - stderr 原样镜像（进度、告警、降级原因都在里面），不改变任何调用方的输出；
 * - 另提供 `detail()`：只落日志、不上 stderr——未捕获异常的完整堆栈走这里；
 * - 同步写（`writeSync`）：进程异常退出 / `exitGracefully` 时已落盘，无需刷缓冲；
 * - 每次 run 截断重写（文件名固定，内容对应当前这次运行）。
 */

/** 日志文件名（与 session 转录同目录：`<tasks 根>/<taskId>/runs/`） */
export const RUN_LOG_FILENAME = "review-pi.log";

export interface RunLogOptions {
  /** 写入日志头的任务 id（缺省不写该行） */
  readonly taskId?: string;
  /** 时钟注入（测试用；缺省 `new Date()`） */
  readonly now?: () => Date;
}

export interface RunLog {
  /** 日志文件的绝对路径 */
  readonly path: string;
  /** 只写日志、不上 stderr（未捕获异常的堆栈等详情） */
  detail(text: string): void;
  /** 关闭日志：恢复 `process.stderr.write` 并释放文件描述符（可重复调用） */
  close(): void;
}

/**
 * 打开运行日志并挂上 stderr 镜像。目录不存在时递归创建。
 * 打开失败直接抛错，由调用方降级为「不写日志、继续检视」。
 */
export function openRunLog(dir: string, options: RunLogOptions = {}): RunLog {
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, RUN_LOG_FILENAME);
  const fd = openSync(filePath, "w");
  const now = options.now ?? (() => new Date());
  writeSync(
    fd,
    [
      "# review-pi run log",
      `# startedAt: ${now().toISOString()}`,
      ...(options.taskId !== undefined ? [`# taskId: ${options.taskId}`] : []),
      "",
    ].join("\n"),
  );

  const rawWrite = process.stderr.write;
  let closed = false;

  const tee = ((...args: unknown[]): boolean => {
    if (!closed) {
      const chunk = args[0];
      try {
        if (typeof chunk === "string") {
          writeSync(fd, chunk);
        } else if (chunk instanceof Uint8Array) {
          writeSync(fd, chunk);
        }
      } catch {
        // 日志是旁路：写失败绝不影响正常 stderr 输出
      }
    }
    return (rawWrite as (...inner: unknown[]) => boolean).apply(process.stderr, args);
  }) as typeof process.stderr.write;

  process.stderr.write = tee;

  return {
    path: filePath,
    detail(text: string): void {
      if (closed) {
        return;
      }
      try {
        writeSync(fd, text);
      } catch {
        // 同上：旁路
      }
    },
    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      if (process.stderr.write === tee) {
        process.stderr.write = rawWrite;
      }
      try {
        closeSync(fd);
      } catch {
        // 旁路
      }
    },
  };
}
