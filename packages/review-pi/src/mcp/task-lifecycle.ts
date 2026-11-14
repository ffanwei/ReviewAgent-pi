import type { TaskCallResult } from "../contracts/mcp-task.js";
import type {
  MrReviewResultArgs,
  SaveReviewSummaryArgs,
  TaskIdArgs,
} from "./task-tools.js";

/**
 * MCP 业务 tool 的生命周期 facade（ADR-0086）。
 *
 * 拥有「开始 → 片级结果 → 总结 → 结束」的顺序与两段固定沉降；`McpReporter`
 * 只保留纯传输的四个 task 方法。所有失败仍只回 `{ok:false}`、绝不抛错。
 *
 * 沉降是**临时措施**（ADR-0053 / 待优化清单 M-001）：服务端给出顺序保证后，
 * 删除本模块里的 `settle` 即可，调用方不需要再改。
 */

export const TASK_TOOL_SETTLE_MS = 5_000;

/**
 * 进程测试专用覆盖（**不是配置面**）：只允许把固定间隔压到 0 或其他非负整数，
 * 避免每条启用 MCP 的进程用例多等 10 秒。生产环境不设置该变量，读取结果恒为
 * `TASK_TOOL_SETTLE_MS`。非法值（负数 / 小数 / 非数字）一律回落缺省。
 */
export const TASK_TOOL_SETTLE_ENV = "PIAGENT_TEST_TASK_TOOL_SETTLE_MS";

/** 解析生效的沉降间隔（纯函数，env 由调用方注入，便于单测）。 */
export function resolveTaskToolSettleMs(
  env: Readonly<Record<string, string | undefined>>,
): number {
  const raw = env[TASK_TOOL_SETTLE_ENV];
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return TASK_TOOL_SETTLE_MS;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : TASK_TOOL_SETTLE_MS;
}

/** facade 只依赖 reporter 的四个业务方法（结构子集） */
export interface TaskTransport {
  startTask(args: TaskIdArgs): Promise<TaskCallResult>;
  endTask(args: TaskIdArgs): Promise<TaskCallResult>;
  saveReviewSummary(args: SaveReviewSummaryArgs): Promise<TaskCallResult>;
  reportFileResult(args: MrReviewResultArgs): Promise<TaskCallResult>;
}

/** 带沉降耗时的结果：调用方据此把等待计入阶段账本 */
export type SettledTaskResult =
  | { readonly ok: true; readonly waitedMs: number }
  | { readonly ok: false; readonly reason: string; readonly waitedMs: number };

export interface TaskLifecycle {
  /** `startTask` 是否成功发出；`finish()` 只在 true 时补 `endTask` */
  readonly started: boolean;
  start(): Promise<TaskCallResult>;
  reportFile(args: Omit<MrReviewResultArgs, "taskId">): Promise<TaskCallResult>;
  /**
   * 发总结。缺省先沉降（`mrReviewResult → saveReviewSummary`）；
   * 跳过检视路径传 `settleBefore: false`（与既有行为一致）。
   */
  saveSummary(
    args: Omit<SaveReviewSummaryArgs, "taskId">,
    options?: { readonly settleBefore?: boolean },
  ): Promise<SettledTaskResult>;
  /** 第二段沉降（仅当发过总结）→ `endTask`（仅当 start 成功）；幂等 */
  finish(): Promise<SettledTaskResult>;
}

export interface CreateTaskLifecycleOptions {
  readonly task: TaskTransport;
  readonly taskId: string;
  readonly settleMs: number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  /** stderr 行（含换行）；沉降行在等待前打出，与既有输出时序一致 */
  readonly log: (line: string) => void;
}

export function createTaskLifecycle(
  options: CreateTaskLifecycleOptions,
): TaskLifecycle {
  const { task, taskId, settleMs, now, sleep, log } = options;
  let started = false;
  let summaryCalled = false;
  let finished: SettledTaskResult | undefined;

  const settle = async (boundary: string): Promise<number> => {
    if (settleMs <= 0) {
      return 0;
    }
    log(`review-pi: MCP 固定等待 ${String(settleMs)}ms（${boundary}）\n`);
    const startedAt = now();
    await sleep(settleMs);
    return Math.max(0, now() - startedAt);
  };

  return {
    get started() {
      return started;
    },
    async start() {
      const outcome = await task.startTask({ taskId });
      if (outcome.ok) {
        started = true;
      }
      return outcome;
    },
    reportFile(args) {
      return task.reportFileResult({ taskId, ...args });
    },
    async saveSummary(args, saveOptions = {}) {
      const waitedMs =
        saveOptions.settleBefore === false
          ? 0
          : await settle("mrReviewResult → saveReviewSummary");
      const outcome = await task.saveReviewSummary({ taskId, ...args });
      // 与既有口径一致：只要调用发生过，第二段沉降就成立（失败也不例外）
      summaryCalled = true;
      return outcome.ok
        ? { ok: true, waitedMs }
        : { ok: false, reason: outcome.reason, waitedMs };
    },
    async finish() {
      if (finished !== undefined) {
        return finished;
      }
      if (!started) {
        finished = { ok: true, waitedMs: 0 };
        return finished;
      }
      const waitedMs = summaryCalled
        ? await settle("saveReviewSummary → endTask")
        : 0;
      const outcome = await task.endTask({ taskId });
      finished = outcome.ok
        ? { ok: true, waitedMs }
        : { ok: false, reason: outcome.reason, waitedMs };
      return finished;
    },
  };
}
