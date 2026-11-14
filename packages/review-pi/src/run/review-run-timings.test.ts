import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "vitest";

import { fakeFetch, type FakeReply, type FakeUsage } from "../provider/fake-fetch.js";
import { DEFAULT_LIMITS, type SplitLimits } from "../shared/config.js";
import { DEFAULT_REVIEW_RUNTIME, type ReviewRuntime } from "../shared/review-runtime.js";
import { repoFixturePath } from "../testing/repos.js";
import { VUL4J_1_ISSUE } from "../testing/vul4j1-script.js";
import {
  runReviewOutcome,
  type ReviewRunInput,
  type ReviewTimings,
} from "./review-run.js";

// 阶段时间事实（ADR-0084）：run 层产出 phase 起止与窗口；分片路径不再靠
// 「事件顺序 + 全局最后请求结束」反推。

const tempDirs: string[] = [];

function tempRunsRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "review-pi-timings-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const USAGE: FakeUsage = { promptTokens: 30, completionTokens: 2, cacheReadTokens: 10 };
const ZERO_REPLY: FakeReply = { text: "ok", usage: USAGE };

function sixPhaseNoTool(): FakeReply[] {
  return [
    ZERO_REPLY,
    ZERO_REPLY,
    ZERO_REPLY,
    ZERO_REPLY,
    { text: '{"candidates":[]}', usage: USAGE },
    { text: '{"verdicts":[],"complete":true}', usage: USAGE },
  ];
}

function fileBlock(name: string, marker: string): string {
  const lines = [
    `diff --git a/${name} b/${name}`,
    `--- a/${name}`,
    `+++ b/${name}`,
    "@@ -1,3 +1,3 @@",
    `-old ${marker}`,
    `+new ${marker}`,
    `+more ${marker} context`,
  ];
  for (let index = 0; index < 12; index += 1) {
    lines.push(`+padding ${marker} line ${String(index)}`);
  }
  return lines.join("\n");
}

const BLOCK_A = fileBlock("src/main/java/com/example/Alpha.java", "ALPHA-MARKER");
const BLOCK_B = fileBlock("src/main/java/com/example/Beta.java", "BETA-MARKER");
const TWO_FILE_DIFF = `${BLOCK_A}\n${BLOCK_B}`;

function splitRuntime(overrides: Partial<SplitLimits>): ReviewRuntime {
  return {
    ...DEFAULT_REVIEW_RUNTIME,
    limits: {
      ...DEFAULT_LIMITS,
      retry: { ...DEFAULT_LIMITS.retry, maxAttempts: 1, reviewTurnAttempts: 1 },
      split: { ...DEFAULT_LIMITS.split, ...overrides },
    },
  };
}

function baseInput(
  runsRoot: string,
  diff: string,
  runtime: ReviewRuntime,
  fetch: ReviewRunInput["fetch"],
  onShardFindings?: ReviewRunInput["onShardFindings"],
): ReviewRunInput {
  return {
    caseId: "TIMINGS-1",
    repoPath: repoFixturePath("sample"),
    diff,
    issueDescription: VUL4J_1_ISSUE,
    apiKey: "offline-test",
    fetch,
    runsRoot,
    rep: 1,
    runtime,
    ruleSkillLoader: async () => [],
    ...(onShardFindings !== undefined ? { onShardFindings } : {}),
  };
}

function timingsOf(outcome: Awaited<ReturnType<typeof runReviewOutcome>>): ReviewTimings {
  if (outcome.kind !== "reviewed") {
    throw new Error("expected reviewed");
  }
  const timings = outcome.result.timings;
  if (timings === undefined) {
    throw new Error("expected timings");
  }
  return timings;
}

test("分片：每片 phase 起止有序、片间不重叠、审计窗口与片间报文分离", async () => {
  const runsRoot = tempRunsRoot();
  const script = fakeFetch([...sixPhaseNoTool(), ...sixPhaseNoTool()]);
  const runtime = splitRuntime({
    enabled: true,
    maxShardChars: Math.max(BLOCK_A.length, BLOCK_B.length) + 1,
  });

  const outcome = await runReviewOutcome(
    baseInput(runsRoot, TWO_FILE_DIFF, runtime, script.fetch, async () => {
      // 让片间回调真实占用一点时间，保证 interPassReportMs 可区分。
      await new Promise((resolve) => setTimeout(resolve, 5));
    }),
  );
  const timings = timingsOf(outcome);

  // 2 片 × 6 相位
  expect(timings.phaseSpans).toHaveLength(12);
  expect(timings.phaseSpans.slice(0, 6).every((span) => span.shardIndex === 1)).toBe(true);
  expect(timings.phaseSpans.slice(6).every((span) => span.shardIndex === 2)).toBe(true);

  for (const span of timings.phaseSpans) {
    expect(span.endedAt).toBeGreaterThanOrEqual(span.startedAt);
  }
  const shardOne = timings.phaseSpans.filter((span) => span.shardIndex === 1);
  const shardTwo = timings.phaseSpans.filter((span) => span.shardIndex === 2);
  expect(shardOne.at(-1)?.endedAt).toBeLessThanOrEqual(shardTwo[0]?.startedAt ?? 0);

  // 审计窗口终点 = 最后一片最后一个请求结束（= 最后一段 phase 的结束）
  expect(timings.auditEndedAt).toBe(timings.phaseSpans.at(-1)?.endedAt);
  expect(timings.auditStartedAt).toBeLessThanOrEqual(timings.auditEndedAt);

  // 片间报文只计一次，且审计扣得动
  expect(timings.interPassReportMs).toBeGreaterThan(0);
  expect(timings.reportCallbacksMs).toBeGreaterThanOrEqual(timings.interPassReportMs);
  expect(
    timings.auditEndedAt - timings.auditStartedAt - timings.interPassReportMs,
  ).toBeLessThan(timings.auditEndedAt - timings.auditStartedAt);
});

test("单遍：timings 返回但 interPassReportMs = 0，phase 不带片号", async () => {
  const runsRoot = tempRunsRoot();
  const script = fakeFetch(sixPhaseNoTool());
  const runtime = splitRuntime({ enabled: false, maxShardChars: 200 });

  const outcome = await runReviewOutcome(
    baseInput(runsRoot, TWO_FILE_DIFF, runtime, script.fetch),
  );
  const timings = timingsOf(outcome);

  expect(timings.phaseSpans).toHaveLength(6);
  expect(timings.phaseSpans.every((span) => span.shardIndex === undefined)).toBe(true);
  expect(timings.interPassReportMs).toBe(0);
  expect(timings.auditEndedAt).toBe(timings.phaseSpans.at(-1)?.endedAt);
});
