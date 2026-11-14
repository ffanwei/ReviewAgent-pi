import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "vitest";

import { fakeFetch, type FakeReply } from "../provider/fake-fetch.js";
import { DEFAULT_REVIEW_RUNTIME, type ReviewRuntime } from "../shared/review-runtime.js";
import { goldenFixture } from "../testing/golden.js";
import { repoFixturePath } from "../testing/repos.js";
import { VUL4J_1_ISSUE } from "../testing/vul4j1-script.js";
import { MrDiffTooLargeError, NoReviewableFilesError } from "./mr-input.js";
import { runReview, runReviewOutcome, type ReviewRunInput } from "./review-run.js";

// 准入结果化（ADR-0083）：预期内跳过返回数据；旧 `runReview` 仍抛错（兼容适配器）。

const tempDirs: string[] = [];

function tempRunsRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "review-admission-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const ZERO = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 } as const;

/** 一轮零工具回复脚本：六相位各一文本回复（phase-5 空候选 / phase-6 complete） */
function sixPhaseNoToolCorpus(): FakeReply[] {
  return [
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: '{"candidates":[]}', usage: ZERO },
    { text: '{"verdicts":[],"complete":true}', usage: ZERO },
  ];
}

const TEST_FILE_DIFF = [
  "diff --git a/src/a.test.ts b/src/a.test.ts",
  "--- a/src/a.test.ts",
  "+++ b/src/a.test.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

function baseInput(overrides: Partial<ReviewRunInput> = {}): ReviewRunInput {
  return {
    caseId: "ADMISSION-1",
    repoPath: repoFixturePath("sample"),
    diff: goldenFixture("vul4j-1.diff"),
    issueDescription: VUL4J_1_ISSUE,
    apiKey: "offline-test",
    fetch: (async () => {
      throw new Error("fetch must not be called on admission");
    }) as unknown as ReviewRunInput["fetch"],
    runsRoot: tempRunsRoot(),
    rep: 1,
    ruleSkillLoader: async () => [],
    ...overrides,
  };
}

test("过滤后无可检视文件：返回 skipped 数据，不调模型", async () => {
  const outcome = await runReviewOutcome(baseInput({ diff: TEST_FILE_DIFF }));

  expect(outcome.kind).toBe("skipped");
  if (outcome.kind !== "skipped") {
    throw new Error("expected skipped");
  }
  expect(outcome.skip.reason).toBe("no-reviewable-files");
  expect(outcome.skip.message).toContain("过滤后没有可检视的文件");
  if (outcome.skip.reason === "no-reviewable-files") {
    expect(outcome.skip.droppedFiles).toBe(1);
    expect(outcome.skip.droppedChars).toBeGreaterThan(0);
  }
});

test("diff 超体积门：返回 skipped 数据，不调模型", async () => {
  const runtime: ReviewRuntime = {
    ...DEFAULT_REVIEW_RUNTIME,
    limits: {
      ...DEFAULT_REVIEW_RUNTIME.limits,
      boundary: {
        ...DEFAULT_REVIEW_RUNTIME.limits.boundary,
        maxDiffChars: 10,
      },
    },
  };
  const outcome = await runReviewOutcome(baseInput({ runtime }));

  expect(outcome.kind).toBe("skipped");
  if (outcome.kind !== "skipped") {
    throw new Error("expected skipped");
  }
  expect(outcome.skip.reason).toBe("diff-too-large");
  if (outcome.skip.reason === "diff-too-large") {
    expect(outcome.skip.maxChars).toBe(10);
    expect(outcome.skip.diffLength).toBeGreaterThan(10);
  }
});

test("旧入口 runReview：跳过仍抛原错误（兼容契约）", async () => {
  const noFiles = await runReview(baseInput({ diff: TEST_FILE_DIFF })).catch(
    (error: unknown) => error,
  );
  expect(noFiles).toBeInstanceOf(NoReviewableFilesError);
  expect((noFiles as NoReviewableFilesError).droppedFiles).toBe(1);

  const runtime: ReviewRuntime = {
    ...DEFAULT_REVIEW_RUNTIME,
    limits: {
      ...DEFAULT_REVIEW_RUNTIME.limits,
      boundary: {
        ...DEFAULT_REVIEW_RUNTIME.limits.boundary,
        maxDiffChars: 10,
      },
    },
  };
  const tooLarge = await runReview(baseInput({ runtime })).catch((error: unknown) => error);
  expect(tooLarge).toBeInstanceOf(MrDiffTooLargeError);
  expect((tooLarge as MrDiffTooLargeError).maxChars).toBe(10);
});

test("正常路径：返回 reviewed 与 RunResult", async () => {
  const outcome = await runReviewOutcome(
    baseInput({ fetch: fakeFetch(sixPhaseNoToolCorpus()).fetch }),
  );

  expect(outcome.kind).toBe("reviewed");
  if (outcome.kind !== "reviewed") {
    throw new Error("expected reviewed");
  }
  expect(outcome.result.runId.length).toBeGreaterThan(0);
  expect(outcome.result.record.caseId).toBe("ADMISSION-1");
});
