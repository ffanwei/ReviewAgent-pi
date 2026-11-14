import { expect, test } from "vitest";

import type { TaskCallResult } from "../contracts/mcp-task.js";
import { createTaskLifecycle } from "./task-lifecycle.js";

// 生命周期 facade（ADR-0086）：顺序与两段沉降由本模块拥有；fake task + 假时钟。

function harness(
  overrides: {
    readonly start?: TaskCallResult;
    readonly summary?: TaskCallResult;
    readonly end?: TaskCallResult;
    readonly settleMs?: number;
  } = {},
) {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  let tick = 0;
  const task = {
    async startTask(): Promise<TaskCallResult> {
      calls.push("startTask");
      return overrides.start ?? { ok: true };
    },
    async saveReviewSummary(): Promise<TaskCallResult> {
      calls.push("saveReviewSummary");
      return overrides.summary ?? { ok: true };
    },
    async endTask(): Promise<TaskCallResult> {
      calls.push("endTask");
      return overrides.end ?? { ok: true };
    },
    async reportFileResult(): Promise<TaskCallResult> {
      calls.push("reportFileResult");
      return { ok: true };
    },
  };
  const lifecycle = createTaskLifecycle({
    task,
    taskId: "task-1",
    settleMs: overrides.settleMs ?? 5_000,
    now: () => tick,
    sleep: async (ms) => {
      sleeps.push(ms);
      tick += ms;
    },
    log: (line) => logs.push(line),
  });
  return { lifecycle, calls, sleeps, logs };
}

test("正常顺序：start → report → 沉降 → summary → 沉降 → endTask", async () => {
  const { lifecycle, calls, sleeps, logs } = harness();

  await lifecycle.start();
  await lifecycle.reportFile({ filePath: "a.ts", reviewTips: [] });
  const saved = await lifecycle.saveSummary({ markdownContent: "# summary" });
  const done = await lifecycle.finish();

  expect(calls).toEqual([
    "startTask",
    "reportFileResult",
    "saveReviewSummary",
    "endTask",
  ]);
  expect(sleeps).toEqual([5_000, 5_000]);
  expect(saved.waitedMs).toBe(5_000);
  expect(done.waitedMs).toBe(5_000);
  expect(logs).toEqual([
    "review-pi: MCP 固定等待 5000ms（mrReviewResult → saveReviewSummary）\n",
    "review-pi: MCP 固定等待 5000ms（saveReviewSummary → endTask）\n",
  ]);
});

test("startTask 失败：不补 endTask、不等待", async () => {
  const { lifecycle, calls, sleeps } = harness({
    start: { ok: false, reason: "boom" },
  });

  const startResult = await lifecycle.start();
  const done = await lifecycle.finish();

  expect(startResult).toEqual({ ok: false, reason: "boom" });
  expect(lifecycle.started).toBe(false);
  expect(calls).toEqual(["startTask"]);
  expect(sleeps).toEqual([]);
  expect(done).toEqual({ ok: true, waitedMs: 0 });
});

test("跳过路径：saveSummary 不沉降，finish 仍等第二段并补 endTask", async () => {
  const { lifecycle, calls, sleeps } = harness();

  await lifecycle.start();
  const saved = await lifecycle.saveSummary(
    { markdownContent: "# summary" },
    { settleBefore: false },
  );
  await lifecycle.finish();

  expect(saved.waitedMs).toBe(0);
  expect(sleeps).toEqual([5_000]);
  expect(calls).toEqual(["startTask", "saveReviewSummary", "endTask"]);
});

test("总结失败：仍沉降并补 endTask，失败原因原样返回", async () => {
  const { lifecycle, sleeps } = harness({
    summary: { ok: false, reason: "summary failed" },
  });

  await lifecycle.start();
  const saved = await lifecycle.saveSummary({ markdownContent: "# summary" });
  const done = await lifecycle.finish();

  expect(saved).toEqual({
    ok: false,
    reason: "summary failed",
    waitedMs: 5_000,
  });
  expect(done).toEqual({ ok: true, waitedMs: 5_000 });
  expect(sleeps).toEqual([5_000, 5_000]);
});

test("settleMs = 0：零等待、零沉降行（进程测试形态）", async () => {
  const { lifecycle, sleeps, logs } = harness({ settleMs: 0 });

  await lifecycle.start();
  await lifecycle.saveSummary({ markdownContent: "# summary" });
  await lifecycle.finish();

  expect(sleeps).toEqual([]);
  expect(logs).toEqual([]);
});

test("finish 幂等：第二次调用不重复 endTask", async () => {
  const { lifecycle, calls } = harness();

  await lifecycle.start();
  await lifecycle.saveSummary({ markdownContent: "# summary" });
  const first = await lifecycle.finish();
  const second = await lifecycle.finish();

  expect(second).toBe(first);
  expect(calls.filter((call) => call === "endTask")).toHaveLength(1);
});
