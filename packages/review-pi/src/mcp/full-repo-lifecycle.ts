import type { TaskCallResult } from "../contracts/mcp-task.js";
import type {
  FullRepoCurrentTipsArgs,
  InvalidatedTip,
  MrReviewResultArgs,
  TaskIdArgs,
} from "./task-tools.js";
import type { SettledTaskResult } from "./task-lifecycle.js";

/**
 * 全仓检视业务 tool 的生命周期 facade（ADR-0117）。
 *
 * 顺序（服务端契约）：
 *
 * ```text
 * fullRepoStartTask
 *   → fullRepoReportReviewResult（每批完成后按文件，多次）
 *   → fullRepoFilerCurrentTips（v1 恒空数组）
 *   → fullRepoEndTask
 * ```
 *
 * 与 PR 的 `createTaskLifecycle` 分开：repo 没有 `saveReviewSummary`，收尾换成
 * 历史意见失效清单。失败语义与 PR 一致：只回 `{ok:false}`、绝不抛错；`finish()`
 * 幂等，只在 `start` 成功发出过时才发 `endTask`。
 *
 * 两段固定沉降沿用 ADR-0053 的临时措施（服务端异步处理导致回调乱序）：
 * 最后一批上报 → currentTips、currentTips → endTask。
 */

/** facade 只依赖 reporter 的全仓四个业务方法（结构子集） */
export interface FullRepoTasksTransport {
  startTask(args: TaskIdArgs): Promise<TaskCallResult>;
  endTask(args: TaskIdArgs): Promise<TaskCallResult>;
  reportFileResult(args: MrReviewResultArgs): Promise<TaskCallResult>;
  reportCurrentTips(args: FullRepoCurrentTipsArgs): Promise<TaskCallResult>;
}

export interface FullRepoLifecycle {
  /** `fullRepoStartTask` 是否成功发出；`finish()` 只在 true 时补 `endTask` */
  readonly started: boolean;
  start(): Promise<TaskCallResult>;
  reportFile(args: Omit<MrReviewResultArgs, "taskId">): Promise<TaskCallResult>;
  /**
   * 发历史意见失效清单。v1 恒发空数组；调用过（无论成功失败）后 `finish()`
   * 不再重复发。缺省先沉降（最后一批上报 → currentTips）。
   */
  reportCurrentTips(): Promise<TaskCallResult>;
  /** 确保 currentTips 已发 → 第二段沉降 → `endTask`；幂等 */
  finish(): Promise<SettledTaskResult>;
}

export interface CreateFullRepoLifecycleOptions {
  readonly tasks: FullRepoTasksTransport;
  readonly taskId: string;
  readonly settleMs: number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  /** stderr 行（含换行）；沉降行在等待前打出 */
  readonly log: (line: string) => void;
}

/** v1 不处理失效逻辑：每次都传空数组（字段形状仍按服务端 schema） */
const NO_INVALIDATED_TIPS: readonly InvalidatedTip[] = [];

export function createFullRepoLifecycle(
  options: CreateFullRepoLifecycleOptions,
): FullRepoLifecycle {
  const { tasks, taskId, settleMs, now, sleep, log } = options;
  let started = false;
  let currentTips: TaskCallResult | undefined;
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

  const sendCurrentTips = async (): Promise<TaskCallResult> => {
    if (currentTips !== undefined) {
      return currentTips;
    }
    const result = await tasks.reportCurrentTips({ taskId, invalidatedTips: NO_INVALIDATED_TIPS });
    // 与既有口径一致：只要调用发生过，就视为该边界已跨过（失败也不例外）
    currentTips = result;
    return result;
  };

  return {
    get started() {
      return started;
    },
    async start() {
      const outcome = await tasks.startTask({ taskId });
      if (outcome.ok) {
        started = true;
      }
      return outcome;
    },
    reportFile(args) {
      return tasks.reportFileResult({ taskId, ...args });
    },
    async reportCurrentTips() {
      if (currentTips !== undefined) {
        return currentTips;
      }
      await settle("fullRepoReportReviewResult → fullRepoFilerCurrentTips");
      return sendCurrentTips();
    },
    async finish() {
      if (finished !== undefined) {
        return finished;
      }
      if (!started) {
        finished = { ok: true, waitedMs: 0 };
        return finished;
      }
      let waitedMs = 0;
      if (currentTips === undefined) {
        waitedMs += await settle(
          "fullRepoReportReviewResult → fullRepoFilerCurrentTips",
        );
        await sendCurrentTips();
      }
      waitedMs += await settle("fullRepoFilerCurrentTips → fullRepoEndTask");
      const outcome = await tasks.endTask({ taskId });
      finished = outcome.ok
        ? { ok: true, waitedMs }
        : { ok: false, reason: outcome.reason, waitedMs };
      return finished;
    },
  };
}
