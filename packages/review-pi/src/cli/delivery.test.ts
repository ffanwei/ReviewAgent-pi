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
  finalizeDelivery,
  type DeliveryClock,
  type DeliveryInput,
  type DeliveryOneShotPort,
  type DeliveryReporterPort,
} from "./delivery.js";
import type { ProgressSummary } from "./progress-render.js";
import type { SemanticTipEntry } from "./report-payload.js";

// 交付 module（ADR-0081）：fake ports + 临时目录锁顺序、失败语义与产物。
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

function fakeReporter(
  calls: string[],
  failing: ReadonlySet<string>,
  onSave?: () => void,
): DeliveryReporterPort {
  return {
    async reportFileResult(args) {
      calls.push(`report:${args.filePath}`);
      return failing.has(args.filePath) ? { ok: false, reason: "boom" } : { ok: true };
    },
    async saveReviewSummary() {
      onSave?.();
      calls.push("summary");
      return { ok: true };
    },
    async endTask() {
      calls.push("endTask");
      return { ok: true };
    },
    async flush() {
      return { sent: 0, failed: 0, dropped: 0, batches: 0 };
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
  readonly onSave?: () => void;
} = {}): Promise<{
  readonly input: DeliveryInput;
  readonly dir: string;
  readonly calls: string[];
  readonly logs: string[];
  readonly sleeps: number[];
}> {
  const dir = await mkdtemp(join(tmpdir(), "review-delivery-"));
  dirs.push(dir);
  const calls: string[] = [];
  const logs: string[] = [];
  const sleeps: number[] = [];
  let tick = 0;
  const clock: DeliveryClock = {
    now: () => tick++,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  const reporter = fakeReporter(calls, options.failingFiles ?? new Set(), options.onSave);
  const input: DeliveryInput = {
    run: runResult(options.findings ?? [], options.reviewsPath ?? join(dir, "reviews_en.json")),
    identity: { caseId: "case-1", taskId: "task-1", cwd: options.cwd ?? dir },
    paths: { tasksRoot: dir, runsRoot: dir },
    repoPath: dir,
    coverageFiles: options.coverageFiles ?? [],
    model: { modelId: "m", baseUrl: "https://example.test" },
    limits: { confidenceMin: 0.5, severityMin: "P3" },
    mcp: {
      ...(options.businessOn === false ? {} : { reporter }),
      started: true,
      submittedFindingKeys: options.submitted ?? new Set(),
      reportedFiles: [...(options.reportedFiles ?? [])],
      settleMs: 5000,
      flushTimeoutMs: 1000,
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
  return { input, dir, calls, logs, sleeps };
}

test("正常路径：覆盖补报 → 进度收尾 → 沉降 → 总结，返回 stdout 文档与产物", async () => {
  const item = finding();
  const finished: ProgressSummary[] = [];
  const { input, dir, calls, sleeps } = await makeInput({
    findings: [item],
    coverageFiles: ["src/a.ts", "src/b.ts"],
    submitted: new Set([findingMergeKey(item)]),
    semantic: new Map([[findingMergeKey(item), SEMANTIC]]),
    progress: { finish: (summary) => finished.push(summary) },
  });

  const outcome = await deliverReviewRun(input);

  expect(calls).toEqual(["report:src/a.ts", "report:src/b.ts", "summary"]);
  expect(sleeps).toEqual([5000]);
  expect(finished).toHaveLength(1);
  expect(finished[0]?.modelCalls).toBe(1);
  expect(outcome.summaryCalled).toBe(true);
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
  expect(outcome.summaryCalled).toBe(true);
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

  const outcome = await deliverReviewRun(input);

  expect(calls).toEqual([]);
  expect(tipsCalls).toBe(1);
  expect(outcome.summaryCalled).toBe(false);
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

test("沉降发生在 saveReviewSummary 之前", async () => {
  let sleptBeforeSummary = false;
  let sleepsAtSave = -1;
  const { input, sleeps } = await makeInput({
    onSave: () => {
      sleepsAtSave = sleeps.length;
      sleptBeforeSummary = sleepsAtSave === 1;
    },
  });

  await deliverReviewRun(input);

  expect(sleptBeforeSummary).toBe(true);
  expect(sleepsAtSave).toBe(1);
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

test("finalize：沉降 → endTask → flush → close，顺序固定", async () => {
  const calls: string[] = [];
  const sleeps: number[] = [];
  let tick = 0;
  const clock: DeliveryClock = {
    now: () => tick++,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  const dir = await mkdtemp(join(tmpdir(), "review-finalize-"));
  dirs.push(dir);

  const outcome = await finalizeDelivery({
    taskId: "task-1",
    runsRoot: dir,
    reporter: {
      async endTask() {
        calls.push("endTask");
        return { ok: true };
      },
      async flush() {
        calls.push("flush");
        return { sent: 1, failed: 0, dropped: 0, batches: 1 };
      },
      async close() {
        calls.push("close");
      },
    },
    started: true,
    summaryCalled: true,
    flushEnabled: true,
    flushTimeoutMs: 1000,
    settleMs: 5000,
    log: (line) => calls.push(`log:${line.trim()}`),
    clock,
  });

  expect(sleeps).toEqual([5000]);
  expect(calls).toEqual([
    "log:review-pi: MCP 固定等待 5000ms（saveReviewSummary → endTask）",
    "endTask",
    "flush",
    "log:review-pi: MCP 上报 sent 1 / failed 0 / dropped 0",
    "close",
  ]);
  expect(outcome.settleMs).toBe(1);
});

test("finalize：未发出 startTask 不补 endTask；flush 关闭仍 close", async () => {
  const calls: string[] = [];
  const dir = await mkdtemp(join(tmpdir(), "review-finalize-skip-"));
  dirs.push(dir);

  const outcome = await finalizeDelivery({
    taskId: "task-1",
    runsRoot: dir,
    reporter: {
      async endTask() {
        calls.push("endTask");
        return { ok: true };
      },
      async flush() {
        calls.push("flush");
        return { sent: 0, failed: 0, dropped: 0, batches: 0 };
      },
      async close() {
        calls.push("close");
      },
    },
    started: false,
    summaryCalled: false,
    flushEnabled: false,
    flushTimeoutMs: 1000,
    settleMs: 5000,
    log: () => undefined,
    clock: { now: () => 0, sleep: async () => undefined },
  });

  expect(calls).toEqual(["close"]);
  expect(outcome.settleMs).toBe(0);
});
