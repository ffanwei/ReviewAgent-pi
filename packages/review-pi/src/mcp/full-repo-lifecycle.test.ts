import { describe, expect, test } from "vitest";

import type { TaskCallResult } from "../contracts/mcp-task.js";
import {
  createFullRepoLifecycle,
  type FullRepoTasksTransport,
} from "./full-repo-lifecycle.js";
import type { FullRepoCurrentTipsArgs, MrReviewResultArgs, TaskIdArgs } from "./task-tools.js";

interface RecordedCall {
  readonly tool: string;
  readonly args: unknown;
}

function fakeTasks(outcomes: {
  start?: TaskCallResult;
  report?: TaskCallResult;
  currentTips?: TaskCallResult;
  end?: TaskCallResult;
} = {}): FullRepoTasksTransport & {
  readonly calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const ok: TaskCallResult = { ok: true };
  return {
    calls,
    async startTask(args: TaskIdArgs) {
      calls.push({ tool: "startTask", args });
      return outcomes.start ?? ok;
    },
    async endTask(args: TaskIdArgs) {
      calls.push({ tool: "endTask", args });
      return outcomes.end ?? ok;
    },
    async reportFileResult(args: MrReviewResultArgs) {
      calls.push({ tool: "reportFileResult", args });
      return outcomes.report ?? ok;
    },
    async reportCurrentTips(args: FullRepoCurrentTipsArgs) {
      calls.push({ tool: "reportCurrentTips", args });
      return outcomes.currentTips ?? ok;
    },
  };
}

function lifecycle(tasks: FullRepoTasksTransport, settleMs = 5_000) {
  let nowMs = 0;
  const sleeps: number[] = [];
  const logs: string[] = [];
  return {
    sleeps,
    logs,
    value: createFullRepoLifecycle({
      tasks,
      taskId: "repo-task-1",
      settleMs,
      now: () => nowMs,
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
      },
      log: (line) => logs.push(line),
    }),
  };
}

describe("createFullRepoLifecycle（ADR-0117）", () => {
  test("顺序：start → report → currentTips(空数组) → endTask；两段沉降", async () => {
    const tasks = fakeTasks();
    const { value, sleeps, logs } = lifecycle(tasks);

    expect(await value.start()).toEqual({ ok: true });
    expect(value.started).toBe(true);
    expect(
      await value.reportFile({
        filePath: "src/a.ts",
        reviewTips: [],
      }),
    ).toEqual({ ok: true });
    expect(await value.reportCurrentTips()).toEqual({ ok: true });
    const done = await value.finish();

    expect(tasks.calls.map((call) => call.tool)).toEqual([
      "startTask",
      "reportFileResult",
      "reportCurrentTips",
      "endTask",
    ]);
    expect(tasks.calls[2]?.args).toEqual({ taskId: "repo-task-1", invalidatedTips: [] });
    expect(tasks.calls[3]?.args).toEqual({ taskId: "repo-task-1" });
    expect(sleeps).toEqual([5_000, 5_000]);
    expect(logs).toEqual([
      "review-pi: MCP 固定等待 5000ms（fullRepoReportReviewResult → fullRepoFilerCurrentTips）\n",
      "review-pi: MCP 固定等待 5000ms（fullRepoFilerCurrentTips → fullRepoEndTask）\n",
    ]);
    // 第一段沉降由 reportCurrentTips 自己承担；finish 只计第二段。
    expect(done).toEqual({ ok: true, waitedMs: 5_000 });
  });

  test("R-21：reportCurrentTips 携带失效清单；finish 补发用 setInvalidatedTips 的清单", async () => {
    const tasks = fakeTasks();
    const { value } = lifecycle(tasks);
    expect(await value.start()).toEqual({ ok: true });

    // 未显式调用 currentTips：先预登记，finish 补发时携带
    value.setInvalidatedTips([{ reason: "文件已删除", tipsId: 7 }]);
    const done = await value.finish();
    expect(done).toEqual({ ok: true, waitedMs: 10_000 });
    // finish 补发的 currentTips 是倒数第二个调用（最后是 endTask）
    expect(tasks.calls.at(-2)?.args).toEqual({
      taskId: "repo-task-1",
      invalidatedTips: [{ reason: "文件已删除", tipsId: 7 }],
    });
  });

  test("R-21：显式 reportCurrentTips(args) 覆盖预登记清单且幂等", async () => {
    const tasks = fakeTasks();
    const { value } = lifecycle(tasks);
    expect(await value.start()).toEqual({ ok: true });
    value.setInvalidatedTips([{ reason: "重复", tipsId: 1 }]);
    expect(
      await value.reportCurrentTips({ invalidatedTips: [{ reason: "已修复", tipsId: 9 }] }),
    ).toEqual({ ok: true });
    expect(await value.reportCurrentTips()).toEqual({ ok: true });
    await value.finish();
    expect(tasks.calls.at(-2)?.args).toEqual({
      taskId: "repo-task-1",
      invalidatedTips: [{ reason: "已修复", tipsId: 9 }],
    });
  });

  test("start 失败：不发 currentTips / endTask", async () => {
    const tasks = fakeTasks({ start: { ok: false, reason: "down" } });
    const { value } = lifecycle(tasks);

    expect(await value.start()).toEqual({ ok: false, reason: "down" });
    expect(value.started).toBe(false);
    expect(await value.finish()).toEqual({ ok: true, waitedMs: 0 });
    expect(tasks.calls.map((call) => call.tool)).toEqual(["startTask"]);
  });

  test("currentTips 失败仍继续 endTask；重复调用不重发", async () => {
    const tasks = fakeTasks({ currentTips: { ok: false, reason: "rejected" } });
    const { value } = lifecycle(tasks, 0);

    await value.start();
    expect(await value.reportCurrentTips()).toEqual({ ok: false, reason: "rejected" });
    expect(await value.reportCurrentTips()).toEqual({ ok: false, reason: "rejected" });
    const done = await value.finish();

    expect(done).toEqual({ ok: true, waitedMs: 0 });
    expect(tasks.calls.filter((call) => call.tool === "reportCurrentTips")).toHaveLength(1);
    expect(tasks.calls.filter((call) => call.tool === "endTask")).toHaveLength(1);
  });

  test("finish 幂等：只发一次 endTask", async () => {
    const tasks = fakeTasks();
    const { value } = lifecycle(tasks, 0);

    await value.start();
    expect(await value.finish()).toEqual({ ok: true, waitedMs: 0 });
    expect(await value.finish()).toEqual({ ok: true, waitedMs: 0 });
    expect(tasks.calls.map((call) => call.tool)).toEqual([
      "startTask",
      "reportCurrentTips",
      "endTask",
    ]);
  });

  test("finish 在未显式发 currentTips 时补发（保证顺序）", async () => {
    const tasks = fakeTasks();
    const { value } = lifecycle(tasks, 0);

    await value.start();
    await value.finish();
    expect(tasks.calls.map((call) => call.tool)).toEqual([
      "startTask",
      "reportCurrentTips",
      "endTask",
    ]);
  });
});
