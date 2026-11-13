import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { REVIEW_PI_VERSION } from "../shared/version.js";
import { openRunLog, RUN_LOG_FILENAME, type RunLog } from "./run-log.js";

// 运行日志单测：stderr 镜像 + 仅日志详情 + close 恢复；全在临时目录，零网络。
// 注意：本文件会临时改写 process.stderr.write，afterEach 必须保证恢复。

const tempDirs: string[] = [];
let opened: RunLog | null = null;
const originalWrite = process.stderr.write;

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "review-pi-run-log-"));
  tempDirs.push(dir);
  return dir;
}

/** 把 stderr 换成本地收集器（避免测试输出噪音），返回收集到的文本 */
function silentStderr(): { readonly text: () => string } {
  const chunks: string[] = [];
  process.stderr.write = ((...args: unknown[]): boolean => {
    chunks.push(String(args[0]));
    return true;
  }) as typeof process.stderr.write;
  return { text: () => chunks.join("") };
}

afterEach(() => {
  opened?.close();
  opened = null;
  process.stderr.write = originalWrite;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stderr 全量镜像到 review-pi.log，detail 只落日志不上 stderr", () => {
  const dir = tempDir();
  const stderr = silentStderr();
  const log = openRunLog(dir, { taskId: "t-1" });
  opened = log;

  process.stderr.write("review-pi: 呈现投影降级（gateway 503）\n");
  log.detail("[uncaught]\nstack line\n");

  expect(log.path).toBe(join(dir, RUN_LOG_FILENAME));
  const text = readFileSync(log.path, "utf8");
  expect(text).toContain(`# version: ${REVIEW_PI_VERSION}`);
  expect(text).toContain("# taskId: t-1");
  expect(text).toContain("review-pi: 呈现投影降级（gateway 503）");
  expect(text).toContain("stack line");

  // stderr 仍拿到同一行（镜像不是截流）；detail 只进文件
  expect(stderr.text()).toContain("review-pi: 呈现投影降级（gateway 503）");
  expect(stderr.text()).not.toContain("[uncaught]");
  expect(text.match(/\[uncaught\]/g)).toHaveLength(1);
});

test("close 恢复打开前的 process.stderr.write 且可重复调用；关闭后的写入不再进日志", () => {
  const dir = tempDir();
  const silent = ((..._args: unknown[]): boolean => true) as typeof process.stderr.write;
  process.stderr.write = silent;
  const log = openRunLog(dir);
  opened = log;

  expect(process.stderr.write).not.toBe(silent);
  log.close();
  expect(process.stderr.write).toBe(silent);

  process.stderr.write("after-close\n");
  log.close();

  const text = readFileSync(log.path, "utf8");
  expect(text).not.toContain("after-close");
});

test("目录不存在时递归创建", () => {
  const dir = join(tempDir(), "nested", "runs");
  silentStderr();
  const log = openRunLog(dir);
  opened = log;
  log.detail("x\n");
  expect(readFileSync(log.path, "utf8")).toContain("x");
});
