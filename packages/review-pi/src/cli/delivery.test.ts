import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import type { Finding } from "../contracts/finding.js";
import type { LlmUsage } from "../contracts/llm.js";
import { findingMergeKey } from "../run/findings-merge.js";
import type { ReviewRunResult } from "../run/review-run.js";
import {
  deliverReviewRun,
  deliverSkip,
  finalizeDelivery,
  type DeliveryClock,
  type DeliveryEventsPort,
  type DeliveryInput,
  type DeliveryOneShotPort,
  type DeliveryTaskPort,
} from "./delivery.js";
import type { ProgressSummary } from "./progress-render.js";
import type { SemanticTipEntry } from "./report-payload.js";
import { DIFF_TOO_LARGE_SUMMARY_MARKDOWN } from "./review-summary.js";

// 交付 module（ADR-0081 / 0086）：fake task/events + 临时目录锁顺序、失败语义与产物。
// 进程字节由 bin.process.test.ts 把守；这里只测 interface。

const USAGE: LlmUsage = { inputTokens: 10, outputTokens: 5 };
const SEMANTIC: SemanticTipEntry = {
  review: "r",
  suggestion: "s",
  category: "安全",
  subcategory: "x",
  source: "common-reviewer",
  ruleId: "",
};

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F001",
    severity: "P1",
    category: "SECURITY",
    file: "src/a.ts",
    line: 1,
    title: "T",
    description: "d",
    evidence: ["e"],
    rule: "",
    confidence: 0.9,
    ...overrides,
  };
}

function runResult(findings: readonly Finding[], reviewsPath: string): ReviewRunResult {
  return {
    runId: "run-1",
    record: {
      source: "mr",
      caseId: "case-1",
      rep: 1,
      model: "m",
      verifier: "off",
      completedAt: "2026-11-14T00:00:00.000Z",
      baseline: {
        findings,
        usage: USAGE,
        rounds: 1,
        toolCalls: 0,
        audit: {
          toolCallLog: [],
          phaseLog: [],
          rejections: [],
          truncated: false,
          truncationReasons: [],
          ruleSkill: [{ source: "x", digest: "d", name: "r" }],
        },
        auditPath: "audit.json",
      },
      effective: null,
      verifierPass: null,
    },
    recordPath: "run.json",
    auditPath: "audit.json",
    transcriptPath: "session.json",
    transcriptPaths: ["session.json"],
    reviewsPath,
    ledgerHitCount: 0,
    modelCalls: 1,
    skillBashCalls: 0,
  };
}

function fakeTask(options: {
  readonly calls: string[];
  readonly failing?: ReadonlySet<string>;
  readonly started?: boolean;
  readonly summaryOk?: boolean;
  readonly onSave?: () => void;
}): DeliveryTaskPort {
  return {
    get started() {
      return options.started ?? true;
    },
    async reportFile(args) {
      options.calls.push(`report:${args.filePath}`);
      return (options.failing?.has(args.filePath) ?? false)
        ? { ok: false, reason: "boom" }
        : { ok: true };
    },
    async saveSummary(_args, saveOptions) {
      options.onSave?.();
      options.calls.push("summary");
      const waitedMs = saveOptions?.settleBefore === false ? 0 : 5_000;
      return options.summaryOk === false
        ? { ok: false, reason: "boom", waitedMs }
        : { ok: true, waitedMs };
    },
    async finish() {
      options.calls.push("finish");
      return { ok: true, waitedMs: 5_000 };
    },
  };
}

function fakeEvents(calls: string[]): DeliveryEventsPort {
  return {
    async flush() {
      calls.push("flush");
      return { sent: 1, failed: 0, dropped: 0, batches: 1 };
    },
    async close() {
      calls.push("close");
    },
  };
}

async function makeInput(options: {
  readonly findings?: readonly Finding[];
  readonly businessOn?: boolean;
  readonly coverageFiles?: readonly string[];
  readonly reportedFiles?: readonly string[];
  readonly submitted?: ReadonlySet<string>;
  readonly failingFiles?: ReadonlySet<string>;
  readonly semantic?: ReadonlyMap<string, SemanticTipEntry>;
  readonly oneShot?: DeliveryOneShotPort;
  readonly progress?: { finish(summary: ProgressSummary): void };
  readonly reviewsPath?: string;
  readonly cwd?: string;
} = {}): Promise<{
  readonly input: DeliveryInput;
  readonly dir: string;
  readonly calls: string[];
  readonly logs: string[];
}> {
  const dir = await mkdtemp(join(tmpdir(), "review-delivery-"));
  dirs.push(dir);
  const calls: string[] = [];
  const logs: string[] = [];
  let tick = 0;
  const clock: DeliveryClock = {
    now: () => tick++,
    sleep: async () => undefined,
  };
  const task =
    options.businessOn === false
      ? undefined
      : fakeTask({
          calls,
          ...(options.failingFiles !== undefined ? { failing: options.failingFiles } : {}),
        });
  const input: DeliveryInput = {
    run: runResult(options.findings ?? [], options.reviewsPath ?? join(dir, "reviews_en.json")),
    identity: { caseId: "case-1", taskId: "task-1", cwd: options.cwd ?? dir },
    paths: { tasksRoot: dir, runsRoot: dir },
    repoPath: dir,
    coverageFiles: options.coverageFiles ?? [],
    model: { modelId: "m", baseUrl: "https://example.test" },
    limits: { confidenceMin: 0.5, severityMin: "P3" },
    mcp: {
      ...(task !== undefined ? { task } : {}),
      submittedFindingKeys: options.submitted ?? new Set(),
      reportedFiles: [...(options.reportedFiles ?? [])],
      flushTimeoutMs: 1_000,
    },
    tips: {
      semanticByMergeKey: new Map(options.semantic ?? []),
      uncoveredReasonByMergeKey: new Map(),
    },
    timing: { startedAt: 0 },
    ports: {
      oneShot: options.oneShot ?? {
        async generateTips() {
          return { outcome: { kind: "failed", reason: "not used" } };
        },
        async generateSummary() {
          return { markdown: "# summary" };
        },
      },
      clock,
      log: (line) => logs.push(line),
      ...(options.progress !== undefined ? { progress: options.progress } : {}),
    },
  };
  return { input, dir, calls, logs };
}

test("正常路径：覆盖补报 → 进度收尾 → 总结，返回 stdout 文档与产物", async () => {
  const item = finding();
  const finished: ProgressSummary[] = [];
  const { input, dir, calls } = await makeInput({
    findings: [item],
    coverageFiles: ["src/a.ts", "src/b.ts"],
    submitted: new Set([findingMergeKey(item)]),
    semantic: new Map([[findingMergeKey(item), SEMANTIC]]),
    progress: { finish: (summary) => finished.push(summary) },
  });

  const outcome = await deliverReviewRun(input);

  expect(calls).toEqual(["report:src/a.ts", "report:src/b.ts", "summary"]);
  expect(outcome.timings.settleMs).toBe(5_000);
  expect(finished).toHaveLength(1);
  expect(finished[0]?.modelCalls).toBe(1);
  expect(outcome.deferredFailure).toBeUndefined();
  expect(JSON.parse(outcome.stdoutDocument)).toMatchObject({ ok: true, caseId: "case-1" });

  const tips = JSON.parse(await readFile(join(dir, "reviews_tips_zh.json"), "utf8")) as unknown[];
  expect(tips).toHaveLength(1);
  const copy = JSON.parse(await readFile(join(dir, "review-result.json"), "utf8")) as unknown[];
  expect(copy).toEqual(tips);

  const index = JSON.parse(await readFile(join(dir, ".review-pi-session.json"), "utf8")) as {
    readonly taskId: string;
    readonly runId: string;
  };
  expect(index.taskId).toBe("task-1");
  expect(index.runId).toBe("run-1");
});

test("tips 落盘失败：返回 deferredFailure，总结仍发送", async () => {
  const item = finding();
  const dir = await mkdtemp(join(tmpdir(), "review-delivery-blocked-"));
  dirs.push(dir);
  const blocker = join(dir, "blocker");
  await writeFile(blocker, "x");

  const { input, calls, logs } = await makeInput({
    findings: [item],
    submitted: new Set([findingMergeKey(item)]),
    semantic: new Map([[findingMergeKey(item), SEMANTIC]]),
    reviewsPath: join(blocker, "reviews_en.json"),
  });

  const outcome = await deliverReviewRun(input);

  expect(outcome.deferredFailure).toBeInstanceOf(Error);
  expect(calls).toContain("summary");
  expect(logs.some((line) => line.includes("中文产物落盘失败"))).toBe(true);
});

test("业务关闭：零 MCP 调用，仍产 tips", async () => {
  const item = finding();
  let tipsCalls = 0;
  const oneShot: DeliveryOneShotPort = {
    async generateTips() {
      tipsCalls += 1;
      return {
        outcome: {
          kind: "ok",
          files: [],
          skippedTips: [],
          degradedTips: [],
          skippedFiles: [],
          semanticByKey: new Map([[findingMergeKey(item), SEMANTIC]]),
          uncoveredByKey: new Map(),
        },
      };
    },
    async generateSummary() {
      return { markdown: "# summary" };
    },
  };

  const { input, dir, calls } = await makeInput({
    findings: [item],
    businessOn: false,
    oneShot,
  });

  await deliverReviewRun(input);

  expect(calls).toEqual([]);
  expect(tipsCalls).toBe(1);
  const tips = JSON.parse(await readFile(join(dir, "reviews_tips_zh.json"), "utf8")) as unknown[];
  expect(tips).toHaveLength(1);
});

test("全部被置信度过滤：tips 产 []，不调一次性生成", async () => {
  let tipsCalls = 0;
  const oneShot: DeliveryOneShotPort = {
    async generateTips() {
      tipsCalls += 1;
      return { outcome: { kind: "failed", reason: "not used" } };
    },
    async generateSummary() {
      return { markdown: "# summary" };
    },
  };
  const { input, dir, logs } = await makeInput({
    findings: [finding({ confidence: 0.1 })],
    businessOn: false,
    oneShot,
  });

  await deliverReviewRun(input);

  expect(tipsCalls).toBe(0);
  const tips = JSON.parse(await readFile(join(dir, "reviews_tips_zh.json"), "utf8")) as unknown[];
  expect(tips).toEqual([]);
  expect(logs.some((line) => line.includes("置信度过滤丢弃 1 条"))).toBe(true);
});

test("覆盖补报只报差集；单文件失败只留痕不抛", async () => {
  const { input, calls, logs } = await makeInput({
    coverageFiles: ["a.ts", "b.ts", "c.ts"],
    reportedFiles: ["a.ts"],
    failingFiles: new Set(["b.ts"]),
  });

  await deliverReviewRun(input);

  expect(calls).toEqual(["report:b.ts", "report:c.ts", "summary"]);
  expect(logs.some((line) => line.includes("b.ts 失败（boom）"))).toBe(true);
});

test("session 索引写失败：只留痕，仍返回 stdout 文档", async () => {
  const dir = await mkdtemp(join(tmpdir(), "review-delivery-nocwd-"));
  dirs.push(dir);
  const blocker = join(dir, "blocker");
  await writeFile(blocker, "x");

  const { input, logs } = await makeInput({ cwd: join(blocker, "missing") });

  const outcome = await deliverReviewRun(input);

  expect(outcome.stdoutDocument.length).toBeGreaterThan(0);
  expect(logs.some((line) => line.includes("session 索引写入失败"))).toBe(true);
});

test("finalize：task.finish → events.flush → close，settleMs 来自 facade", async () => {
  const calls: string[] = [];
  const dir = await mkdtemp(join(tmpdir(), "review-finalize-"));
  dirs.push(dir);

  const outcome = await finalizeDelivery({
    taskId: "task-1",
    runsRoot: dir,
    task: fakeTask({ calls }),
    events: fakeEvents(calls),
    flushEnabled: true,
    flushTimeoutMs: 1_000,
    log: (line) => calls.push(`log:${line.trim()}`),
    clock: { now: () => 0, sleep: async () => undefined },
  });

  expect(calls).toEqual([
    "finish",
    "flush",
    "log:review-pi: MCP 上报 sent 1 / failed 0 / dropped 0",
    "close",
  ]);
  expect(outcome.settleMs).toBe(5_000);
});

test("finalize：业务关闭仍 flush/close 事件通道", async () => {
  const calls: string[] = [];
  const dir = await mkdtemp(join(tmpdir(), "review-finalize-events-"));
  dirs.push(dir);

  await finalizeDelivery({
    taskId: "task-1",
    runsRoot: dir,
    events: fakeEvents(calls),
    flushEnabled: true,
    flushTimeoutMs: 1_000,
    log: () => undefined,
    clock: { now: () => 0, sleep: async () => undefined },
  });

  expect(calls).toEqual(["flush", "close"]);
});

function skipTask(options: {
  readonly calls: string[];
  readonly started?: boolean;
  readonly summaryOk?: boolean;
}): DeliveryTaskPort {
  return fakeTask(options);
}

test("deliverSkip：业务开启时报首个文件与固定总结，返回 stdout 文档", async () => {
  const calls: string[] = [];
  const summaries: string[] = [];

  const outcome = await deliverSkip({
    identity: { caseId: "case-1", taskId: "task-1" },
    skip: { reason: "diff-too-large", message: "msg", diffLength: 100, maxChars: 10 },
    firstFile: "a.ts",
    task: skipTask({ calls }),
    reportedFiles: [],
    log: () => undefined,
  });

  expect(calls).toEqual(["report:a.ts", "summary"]);
  expect(JSON.parse(outcome.stdoutDocument)).toEqual({
    ok: true,
    caseId: "case-1",
    skipped: "diff-too-large",
    findings: [],
  });
});

test("deliverSkip：业务关闭时零 MCP 调用，仍产 stdout 文档", async () => {
  const outcome = await deliverSkip({
    identity: { caseId: "case-1", taskId: "task-1" },
    skip: { reason: "no-reviewable-files", message: "msg", droppedFiles: 1, droppedChars: 5 },
    task: undefined,
    reportedFiles: [],
    log: () => undefined,
  });

  expect(JSON.parse(outcome.stdoutDocument)).toEqual({
    ok: true,
    caseId: "case-1",
    skipped: "no-reviewable-files",
    findings: [],
  });
});

test("deliverSkip：首个文件缺席时仍发固定总结", async () => {
  const calls: string[] = [];

  await deliverSkip({
    identity: { caseId: "case-1", taskId: "task-1" },
    skip: { reason: "no-reviewable-files", message: "msg", droppedFiles: 2, droppedChars: 9 },
    task: skipTask({ calls }),
    reportedFiles: [],
    log: () => undefined,
  });

  expect(calls).toEqual(["summary"]);
});

test("deliverSkip：startTask 未发出时零 MCP 调用", async () => {
  const calls: string[] = [];

  await deliverSkip({
    identity: { caseId: "case-1", taskId: "task-1" },
    skip: { reason: "diff-too-large", message: "msg", diffLength: 100, maxChars: 10 },
    firstFile: "a.ts",
    task: skipTask({ calls, started: false }),
    reportedFiles: [],
    log: () => undefined,
  });

  expect(calls).toEqual([]);
});

test("deliverSkip：summary 失败只留痕", async () => {
  const calls: string[] = [];
  const logs: string[] = [];

  await deliverSkip({
    identity: { caseId: "case-1", taskId: "task-1" },
    skip: { reason: "diff-too-large", message: "msg", diffLength: 100, maxChars: 10 },
    task: skipTask({ calls, summaryOk: false }),
    reportedFiles: [],
    log: (line) => logs.push(line),
  });

  expect(logs.some((line) => line.includes("MCP saveReviewSummary 失败（boom）"))).toBe(true);
});

test("固定总结文案按 reason 选择", async () => {
  const calls: string[] = [];
  const summaries: string[] = [];
  const task: DeliveryTaskPort = {
    ...fakeTask({ calls }),
    async saveSummary(args) {
      summaries.push(args.markdownContent);
      return { ok: true, waitedMs: 0 };
    },
  };

  await deliverSkip({
    identity: { caseId: "case-1", taskId: "task-1" },
    skip: { reason: "diff-too-large", message: "msg", diffLength: 100, maxChars: 10 },
    task,
    reportedFiles: [],
    log: () => undefined,
  });

  expect(summaries).toEqual([DIFF_TOO_LARGE_SUMMARY_MARKDOWN]);
});
