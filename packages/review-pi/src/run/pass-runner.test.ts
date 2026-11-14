import path from "node:path";

import { expect, test } from "vitest";

import type { RunProgressEvent } from "../contracts/progress.js";
import { DEFAULT_REVIEW_RUNTIME } from "../shared/review-runtime.js";
import {
  attemptName,
  buildPass,
  runPasses,
  type ReviewRunContext,
} from "./pass-runner.js";
import type { ReviewPassInput, ReviewPassResult } from "./review-pass.js";
import type { Shard } from "./shard-planner.js";

// pass 装配（ADR-0081 候选 2）：单遍与分片共享同一 context，差异只在
// 目录布局、片标签与 run 级审计值是否进入本遍。

const DIFF = [
  "diff --git a/a.ts b/a.ts",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

const SHARD_DIFF = [
  "diff --git a/b.ts b/b.ts",
  "--- a/b.ts",
  "+++ b/b.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

const SHARD: Shard = {
  index: 2,
  diff: SHARD_DIFF,
  files: ["b.ts"],
  chars: SHARD_DIFF.length,
  otherFilesSummary: "",
  truncated: [],
};

function context(overrides: Partial<ReviewRunContext> = {}): ReviewRunContext {  return {
    caseId: "case-1",
    repoPath: "/repo",
    issueDescription: "desc",
    apiKey: "key",
    fetch: (async () => {
      throw new Error("unused");
    }) as unknown as ReviewRunContext["fetch"],
    rep: 1,
    runtime: DEFAULT_REVIEW_RUNTIME,
    modelId: "model-1",
    runsRoot: "/tasks/t1",
    runsDir: "/tasks/t1/runs",
    auditRoot: "/tasks/t1/audit",
    persistRecord: true,
    boundary: { degraded: false } as ReviewRunContext["boundary"],
    mrFilter: { droppedFiles: 1 } as ReviewRunContext["mrFilter"],
    config: { digest: "d" } as unknown as ReviewRunContext["config"],
    modelFallback: { requested: "a", used: "b", reason: "model-not-found" },
    tipsConfidenceMin: 0.5,
    tipsSeverityMin: "P2",
    ruleSkills: [],
    ruleSkillAudit: [],
    startedAt: new Date("2026-11-14T00:00:00.000Z"),
    emit: () => undefined,
    ...overrides,
  };
}

test("单遍：目录落在 run 根、无片标签、run 级审计值进入本遍", () => {
  const ctx = context();
  const built = buildPass(ctx, { kind: "single", diff: DIFF }, ctx.startedAt);

  expect(built.input.runDir).toBe(ctx.runsDir);
  expect(built.input.auditDir).toBe(ctx.auditRoot);
  expect(built.input.diff).toBe(DIFF);
  expect(built.input.initialDiff).toBe(DIFF);
  expect(built.input.boundary).toBe(ctx.boundary);
  expect(built.input.config).toBe(ctx.config);
  expect(built.input.modelFallback).toBe(ctx.modelFallback);
  expect(built.input.mrFilter).toBe(ctx.mrFilter);
  expect(built.input.shard).toBeUndefined();
  expect(built.label).toEqual({ index: 1, total: 1 });
  expect(built.files).toEqual(["a.ts"]);
});

test("分片：目录在 shards/attempt-…/sNN、带片标签、run 级审计值缺席", () => {
  const ctx = context();
  const built = buildPass(ctx, { kind: "shard", shard: SHARD, total: 3 }, ctx.startedAt);
  const attempt = attemptName(ctx.startedAt);

  expect(built.input.diff).toBe(SHARD_DIFF);
  expect(built.input.initialDiff).toBe(SHARD_DIFF);
  expect(built.input.runDir).toBe(
    path.join(ctx.runsDir, "shards", attempt, "s02"),
  );
  expect(built.input.auditDir).toBe(
    path.join(ctx.auditRoot, "shards", attempt, "s02"),
  );
  expect(built.input.boundary).toEqual({ degraded: false });
  expect(built.input.config).toBeUndefined();
  expect(built.input.modelFallback).toBeUndefined();
  expect(built.input.mrFilter).toBeUndefined();
  expect(built.input.shard).toEqual({ index: 2, total: 3 });
  expect(built.label).toEqual({ index: 2, total: 3 });
  expect(built.files).toEqual(["b.ts"]);
});

test("字段矩阵：除每遍字段与 run 级审计值外，单遍与分片逐字段相同", () => {
  const ctx = context();
  const single = buildPass(ctx, { kind: "single", diff: DIFF }, ctx.startedAt);
  const sharded = buildPass(ctx, { kind: "shard", shard: SHARD, total: 3 }, ctx.startedAt);

  const commonKeys = [
    "caseId",
    "repoPath",
    "issueDescription",
    "apiKey",
    "fetch",
    "runtime",
    "modelId",
    "rep",
    "ruleSkills",
    "ruleSkillAudit",
    "startedAt",
    "tipsConfidenceMin",
    "tipsSeverityMin",
  ] as const;
  for (const key of commonKeys) {
    expect((sharded.input as unknown as Record<string, unknown>)[key]).toBe(
      (single.input as unknown as Record<string, unknown>)[key],
    );
  }
});

test("分片 initialDiff 带上其他文件摘要", () => {
  const ctx = context();
  const otherFilesSummary = "Other files changed in this MR (not shown in this shard):\n- c.ts (+1/-0)";
  const built = buildPass(
    ctx,
    { kind: "shard", shard: { ...SHARD, otherFilesSummary }, total: 1 },
    ctx.startedAt,
  );

  expect(built.input.initialDiff).toBe(`${SHARD_DIFF}\n\n${otherFilesSummary}`);
});

test("分片 emit：非 run 事件带片标签，run 事件不带", () => {
  const events: RunProgressEvent[] = [];
  const ctx = context({ emit: (event) => events.push(event) });
  const built = buildPass(ctx, { kind: "shard", shard: SHARD, total: 3 }, ctx.startedAt);

  built.input.emit({
    kind: "phase",
    state: "start",
    round: 1,
    index: 1,
    phase: "Change Understanding",
  } as unknown as RunProgressEvent);
  built.input.emit({
    kind: "run",
    state: "end",
    status: "ok",
    runId: "run-1",
  } as unknown as RunProgressEvent);

  expect(events[0]).toMatchObject({ shard: { index: 2, total: 3 } });
  expect(events[1]).not.toHaveProperty("shard");
});

function passResult(finishedAt: Date): ReviewPassResult {
  return {
    runId: "run-1",
    startedAt: new Date("2026-11-14T00:00:00.000Z"),
    finishedAt,
    findings: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    rounds: 1,
    toolCalls: 0,
    audit: {
      requests: [],
      toolCallLog: [],
      phaseLog: [],
      rejections: [],
      cacheBreaks: [],
      truncated: false,
      truncationReasons: [],
      ruleSkill: [],
    },
    complete: true,
    transcriptPath: "/tmp/session.json",
    reviewsPath: "/tmp/reviews_en.json",
    auditPath: "/tmp/audit.json",
    ledgerHitCount: 0,
    modelCalls: 0,
    skillBashCalls: 0,
    skillTranscriptPaths: [],
  };
}

test("runPasses 单遍：一次执行、一次回调，startedAt = context.startedAt", async () => {
  const startedAts: Date[] = [];
  const hooks: Array<{ index: number; total: number; files: readonly string[] }> = [];
  const ctx = context({
    onShardFindings: async (label, _findings, files) => {
      hooks.push({ index: label.index, total: label.total, files });
    },
  });

  const executed = await runPasses(ctx, [{ kind: "single", diff: DIFF }], {
    runPass: async (input) => {
      startedAts.push(input.startedAt);
      return passResult(new Date("2026-11-14T00:00:05.000Z"));
    },
  });

  expect(executed).toHaveLength(1);
  expect(startedAts).toEqual([ctx.startedAt]);
  expect(hooks).toEqual([{ index: 1, total: 1, files: ["a.ts"] }]);
});

test("runPasses 分片：串行、回调在每遍之后、startedAt 递进", async () => {
  const sequence: string[] = [];
  const startedAts: Date[] = [];
  const firstFinished = new Date("2026-11-14T00:00:01.000Z");
  const secondFinished = new Date("2026-11-14T00:00:02.000Z");
  const ctx = context({
    onShardFindings: async (label) => {
      sequence.push(`hook:${String(label.index)}/${String(label.total)}`);
    },
  });
  const shards: Shard[] = [
    { ...SHARD, index: 1, files: ["x.ts"] },
    { ...SHARD, index: 2, files: ["y.ts"] },
  ];

  const executed = await runPasses(
    ctx,
    shards.map((shard) => ({ kind: "shard" as const, shard, total: 2 })),
    {
      runPass: async (input) => {
        sequence.push(`pass:${String(input.shard?.index ?? 0)}`);
        startedAts.push(input.startedAt);
        return passResult(input.shard?.index === 1 ? firstFinished : secondFinished);
      },
    },
  );

  expect(sequence).toEqual(["pass:1", "hook:1/2", "pass:2", "hook:2/2"]);
  expect(startedAts).toEqual([ctx.startedAt, firstFinished]);
  expect(executed.map((entry) => entry.pass.finishedAt)).toEqual([
    firstFinished,
    secondFinished,
  ]);
});

test("runPasses 把 buildPass 的结果原样交给执行器", async () => {
  let seen: ReviewPassInput | undefined;
  const ctx = context();

  await runPasses(ctx, [{ kind: "single", diff: DIFF }], {
    runPass: async (input) => {
      seen = input;
      return passResult(new Date());
    },
  });

  expect(seen?.diff).toBe(DIFF);
  expect(seen?.runDir).toBe(ctx.runsDir);
  expect(seen?.auditDir).toBe(ctx.auditRoot);
});

test("片级回调抛错不打断执行（旁路纪律）", async () => {
  const ctx = context({
    onShardFindings: async () => {
      throw new Error("boom");
    },
  });

  const executed = await runPasses(ctx, [{ kind: "single", diff: DIFF }], {
    runPass: async () => passResult(new Date()),
  });

  expect(executed).toHaveLength(1);
});
