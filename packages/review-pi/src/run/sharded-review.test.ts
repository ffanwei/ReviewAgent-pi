import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import type { RunProgressEvent } from "../contracts/progress.js";
import { fakeFetch, type FakeReply, type FakeUsage } from "../provider/fake-fetch.js";
import { DEFAULT_LIMITS, type SplitLimits } from "../shared/config.js";
import { DEFAULT_REVIEW_RUNTIME, type ReviewRuntime } from "../shared/review-runtime.js";
import { repoFixturePath } from "../testing/repos.js";
import { VUL4J_1_ISSUE } from "../testing/vul4j1-script.js";
import { runReview } from "./review-run.js";

/**
 * 大 MR 第二期编排层（ADR-0039）：
 * - 单 shard 零变更硬门（`split.enabled=false` / diff ≤ maxShardChars）；
 * - 预检错误（单块超预算 / 超片数）零模型请求；
 * - 分片执行：每片输入只含本片 diff + 其他文件摘要，`review.get_diff` 只返回本片；
 * - findings 确定性合并、账目闭合、无部分结果；
 * - 进度事件只发一次 run.start/end 并带 shards 计数，片内事件带 shard 标签。
 */

const tempDirs: string[] = [];

function tempRunsRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "review-pi-shards-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 每个请求固定 usage：input = prompt − cacheRead（fake 帧口径） */
const USAGE: FakeUsage = { promptTokens: 30, completionTokens: 2, cacheReadTokens: 10 };
const ZERO_REPLY: FakeReply = { text: "ok", usage: USAGE };

/** 六相位零工具脚本（一轮 = 6 请求） */
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

/** 六相位脚本，Phase 5 产出候选、Phase 6 全部放行 */
function sixPhaseWithCandidate(candidate: Record<string, unknown>): FakeReply[] {
  return sixPhaseWithCandidates([candidate]);
}

/** 六相位脚本：Phase 5 产出多个候选，Phase 6 全部放行 */
function sixPhaseWithCandidates(candidates: readonly Record<string, unknown>[]): FakeReply[] {
  return [
    ZERO_REPLY,
    ZERO_REPLY,
    ZERO_REPLY,
    ZERO_REPLY,
    { text: JSON.stringify({ candidates }), usage: USAGE },
    {
      text: JSON.stringify({
        verdicts: candidates.map((candidate) => ({
          id: candidate.id,
          pass: true,
          reason: "evidence supports",
        })),
        complete: true,
      }),
      usage: USAGE,
    },
  ];
}

/** 一个 `diff --git` 文件块（内容带唯一标记，便于断言分片隔离） */
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
      split: { ...DEFAULT_LIMITS.split, ...overrides },
    },
  };
}

function baseInput(
  runsRoot: string,
  diff: string,
  runtime: ReviewRuntime,
  fetch: Parameters<typeof runReview>[0]["fetch"],
  emit?: (event: RunProgressEvent) => void,
): Parameters<typeof runReview>[0] {
  return {
    caseId: "SPLIT-1",
    repoPath: repoFixturePath("sample"),
    diff,
    issueDescription: VUL4J_1_ISSUE,
    apiKey: "offline-test",
    fetch,
    runsRoot,
    rep: 1,
    runtime,
    ruleSkillLoader: async () => [],
    ...(emit !== undefined ? { onProgress: emit } : {}),
  };
}

function candidate(
  id: string,
  file: string,
  line: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    severity: "P2",
    category: "BUG",
    file,
    line,
    title: "Missing null guard on a public method",
    description: "A public method dereferences its argument without a null guard.",
    evidence: [`${file}:${line} public int getBase() {`],
    rule: "NULL-001",
    confidence: 0.7,
    ...overrides,
  };
}

/** 读分片审计（run.json.shards[].auditFile 是 audit 根相对 POSIX 路径） */
function readShardAudit(runsRoot: string, auditFile: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(runsRoot, "audit", auditFile), "utf8")) as Record<
    string,
    unknown
  >;
}

test("单 shard 零变更：split.enabled=false 时大 diff 仍走单遍，事件/审计/记录无分片键", async () => {
  const runsRoot = tempRunsRoot();
  const events: RunProgressEvent[] = [];
  const script = fakeFetch(sixPhaseNoTool());
  const runtime = splitRuntime({ enabled: false, maxShardChars: 200 });

  const run = await runReview(
    baseInput(runsRoot, TWO_FILE_DIFF, runtime, script.fetch, (event) => events.push(event)),
  );

  expect(script.requests).toHaveLength(6);
  expect(run.transcriptPaths).toHaveLength(1);
  expect(run.record.shards).toBeUndefined();
  expect(events.filter((event) => event.kind === "run")).toHaveLength(2);
  expect(
    events.some(
      (event) =>
        (event.kind === "run" && event.shards !== undefined) ||
        (event.kind !== "run" && event.shard !== undefined),
    ),
  ).toBe(false);
  const audit = JSON.parse(readFileSync(run.auditPath, "utf8")) as Record<string, unknown>;
  expect(audit.shards).toBeUndefined();
  expect(audit.requests).toHaveLength(6);
});

test("单 shard 零变更：diff ≤ maxShardChars 时即使 enabled 也走单遍", async () => {
  const runsRoot = tempRunsRoot();
  const script = fakeFetch(sixPhaseNoTool());
  const runtime = splitRuntime({ enabled: true, maxShardChars: TWO_FILE_DIFF.length + 10 });

  const run = await runReview(baseInput(runsRoot, TWO_FILE_DIFF, runtime, script.fetch));

  expect(script.requests).toHaveLength(6);
  expect(run.record.shards).toBeUndefined();
  expect(run.recordPath).toBe(path.join(runsRoot, "runs", "run.json"));
  expect(run.transcriptPath).toBe(path.join(runsRoot, "runs", `session-${run.runId}.json`));
});

test("预检错误零模型请求：单块超预算 / 超片数都不发请求、不落任何产物", async () => {
  const tooBigRuns = tempRunsRoot();
  const tooBigScript = fakeFetch(sixPhaseNoTool());
  const tooBigRuntime = splitRuntime({ enabled: true, maxShardChars: 50 });
  await expect(
    runReview(baseInput(tooBigRuns, TWO_FILE_DIFF, tooBigRuntime, tooBigScript.fetch)),
  ).rejects.toThrow(/超过单片预算/);
  expect(tooBigScript.requests).toHaveLength(0);
  expect(existsSync(path.join(tooBigRuns, "runs", "run.json"))).toBe(false);

  const tooManyRuns = tempRunsRoot();
  const tooManyScript = fakeFetch(sixPhaseNoTool());
  const tooManyRuntime = splitRuntime({
    enabled: true,
    maxShardChars: Math.max(BLOCK_A.length, BLOCK_B.length) + 1,
    maxShards: 1,
  });
  await expect(
    runReview(baseInput(tooManyRuns, TWO_FILE_DIFF, tooManyRuntime, tooManyScript.fetch)),
  ).rejects.toThrow(/超过上限/);
  expect(tooManyScript.requests).toHaveLength(0);
  expect(existsSync(path.join(tooManyRuns, "runs", "run.json"))).toBe(false);
});

test("分片执行：每片输入只含本片 diff + 其他文件摘要，review.get_diff 只返回本片", async () => {
  const runsRoot = tempRunsRoot();
  const runtime = splitRuntime({
    enabled: true,
    maxShardChars: Math.max(BLOCK_A.length, BLOCK_B.length) + 1,
    maxShards: 4,
  });
  // 第 1 片：Phase 3 内一次 review.get_diff（+1 请求）
  const shardOne: FakeReply[] = [
    ZERO_REPLY,
    ZERO_REPLY,
    { text: "check diff", toolCalls: [{ id: "call-diff-1", name: "review_get_diff", arguments: {} }], usage: USAGE },
    ZERO_REPLY,
    ZERO_REPLY,
    { text: '{"candidates":[]}', usage: USAGE },
    { text: '{"verdicts":[],"complete":true}', usage: USAGE },
  ];
  const script = fakeFetch([...shardOne, ...sixPhaseNoTool()]);

  const run = await runReview(baseInput(runsRoot, TWO_FILE_DIFF, runtime, script.fetch));

  expect(script.requests).toHaveLength(13);
  expect(run.record.shards).toHaveLength(2);
  const [first, second] = run.record.shards ?? [];
  expect(first?.index).toBe(1);
  expect(second?.index).toBe(2);
  expect(first?.files).toBe(1);
  expect(second?.files).toBe(1);
  expect(first?.chars).toBe(BLOCK_A.length);
  expect(second?.chars).toBe(BLOCK_B.length);

  const auditOne = readShardAudit(runsRoot, first?.auditFile as string);
  const auditTwo = readShardAudit(runsRoot, second?.auditFile as string);
  const requestOne = (auditOne.requests as { wireBody: string; messages: { content: string }[] }[])[0];
  const initialOne = JSON.parse(requestOne?.wireBody as string).messages[1].content as string;
  const requestTwo = (auditTwo.requests as { wireBody: string; messages: { content: string }[] }[])[0];
  const initialTwo = JSON.parse(requestTwo?.wireBody as string).messages[1].content as string;

  // 片 1 有 A 的正文，B 只出现在「其他文件摘要」里（路径，不含正文）
  expect(initialOne).toContain("ALPHA-MARKER");
  expect(initialOne).not.toContain("BETA-MARKER");
  expect(initialOne).toContain("Other files changed in this MR");
  expect(initialOne).toContain("src/main/java/com/example/Beta.java");
  // 片 2 反之
  expect(initialTwo).toContain("BETA-MARKER");
  expect(initialTwo).not.toContain("ALPHA-MARKER");
  expect(initialTwo).toContain("src/main/java/com/example/Alpha.java");

  // review.get_diff 工具结果 = 本片 diff（只含 A）
  const toolLog = auditOne.toolCallLog as { name: string; resultSummary: string }[];
  expect(toolLog).toHaveLength(1);
  expect(toolLog[0]?.name).toBe("review.get_diff");
  expect(toolLog[0]?.resultSummary).toContain("ALPHA-MARKER");
  expect(toolLog[0]?.resultSummary).not.toContain("BETA-MARKER");
});

test("分片 findings 合并 + 账目闭合 + run.json.shards 可寻址", async () => {
  const runsRoot = tempRunsRoot();
  const runtime = splitRuntime({
    enabled: true,
    maxShardChars: Math.max(BLOCK_A.length, BLOCK_B.length) + 1,
    maxShards: 4,
  });
  const alpha = "src/main/java/com/example/Alpha.java";
  const beta = "src/main/java/com/example/Beta.java";
  const shardOneCandidate = candidate("F001", alpha, 11, { severity: "P2", confidence: 0.6 });
  const mergedCandidate = candidate("F001", alpha, 11, {
    severity: "P1",
    confidence: 0.9,
    description: "A public method dereferences its argument without a null guard (confirmed).",
    evidence: [`${alpha}:11 public int getBase() {`, `${alpha}:12 a second line`],
  });
  const extraCandidate = candidate("F002", beta, 5, {
    title: "Unused import left behind",
    severity: "P3",
    rule: "STYLE-001",
  });
  const script = fakeFetch([
    ...sixPhaseWithCandidate(shardOneCandidate),
    ...sixPhaseWithCandidates([mergedCandidate, extraCandidate]),
  ]);

  const events: RunProgressEvent[] = [];
  const run = await runReview(
    baseInput(runsRoot, TWO_FILE_DIFF, runtime, script.fetch, (event) => events.push(event)),
  );

  // 请求数：2 片 × 6 相位（候选在同一相位内产出，不额外请求）
  expect(script.requests).toHaveLength(12);
  const shards = run.record.shards ?? [];
  expect(shards.map((shard) => shard.index)).toEqual([1, 2]);

  // findings：同 (file, line, title) 跨片合并；不同落点保留并按文件顺序编号
  const findings = run.record.baseline.findings;
  expect(findings.map((finding) => finding.id)).toEqual(["F001", "F002"]);
  expect(findings[0]?.line).toBe(11);
  expect(findings[0]?.severity).toBe("P1");
  expect(findings[0]?.confidence).toBe(0.9);
  expect(findings[0]?.evidence).toEqual([
    `${alpha}:11 public int getBase() {`,
    `${alpha}:12 a second line`,
  ]);
  expect(findings[1]?.file).toBe(beta);

  // 账目闭合：usage = 各片之和，rounds = 最大，toolCalls 求和
  expect(run.record.baseline.usage).toEqual({
    inputTokens: 12 * 20,
    outputTokens: 12 * 2,
    cacheReadTokens: 12 * 10,
  });
  expect(run.record.baseline.rounds).toBe(1);
  let usageFromShards = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  let toolCallsFromShards = 0;
  for (const shard of shards) {
    usageFromShards = {
      inputTokens: usageFromShards.inputTokens + shard.usage.inputTokens,
      outputTokens: usageFromShards.outputTokens + shard.usage.outputTokens,
      cacheReadTokens: usageFromShards.cacheReadTokens + (shard.usage.cacheReadTokens ?? 0),
    };
    toolCallsFromShards += shard.toolCalls;
  }
  expect(usageFromShards).toEqual(run.record.baseline.usage);
  expect(toolCallsFromShards).toBe(run.record.baseline.toolCalls);

  // 聚合审计：正文为空（正文在各片），shards[] 记全量
  const audit = JSON.parse(readFileSync(run.auditPath, "utf8")) as Record<string, unknown>;
  expect(audit.requests).toEqual([]);
  expect(audit.toolCallLog).toEqual([]);
  const shardAudits = audit.shards as { index: number; status: string; filePaths: string[] }[];
  expect(shardAudits.map((entry) => entry.index)).toEqual([1, 2]);
  expect(shardAudits.every((entry) => entry.status === "ok")).toBe(true);
  expect(shardAudits[0]?.filePaths).toEqual([alpha]);

  // 聚合 run.json 落盘；片内转录/审计可寻址且文件存在
  const recordPath = path.join(runsRoot, "runs", "run.json");
  expect(run.recordPath).toBe(recordPath);
  const persisted = JSON.parse(readFileSync(recordPath, "utf8")) as {
    shards: { transcriptFile: string; auditFile: string }[];
  };
  expect(persisted.shards).toHaveLength(2);
  for (const shard of persisted.shards) {
    expect(existsSync(path.join(runsRoot, "runs", shard.transcriptFile))).toBe(true);
    expect(existsSync(path.join(runsRoot, "audit", shard.auditFile))).toBe(true);
  }
  expect(run.transcriptPaths).toHaveLength(2);
  expect(run.transcriptPaths.every((file) => file.includes(`${path.sep}shards${path.sep}`))).toBe(
    true,
  );
  // 聚合 reviews_en.json 只有一份，findings 与记录同源
  const reviews = JSON.parse(readFileSync(run.reviewsPath, "utf8")) as { findings: { id: string }[] };
  expect(reviews.findings.map((finding) => finding.id)).toEqual(["F001", "F002"]);

  // 进度：一次 run.start（shards.total=2）+ 一次 run.end（ok=2/failed=0）；片内事件带标签
  const runEvents = events.filter((event) => event.kind === "run");
  expect(runEvents).toHaveLength(2);
  const start = runEvents[0];
  expect(start?.kind === "run" && start.state === "start" ? start.shards : undefined).toEqual({
    total: 2,
  });
  const end = runEvents[1];
  expect(end?.kind === "run" && end.state === "end" ? end.shards : undefined).toEqual({
    total: 2,
    ok: 2,
    failed: 0,
  });
  const nonRun = events.filter((event) => event.kind !== "run");
  expect(nonRun.length).toBeGreaterThan(0);
  expect(nonRun.every((event) => event.shard !== undefined)).toBe(true);
  expect(new Set(nonRun.map((event) => event.shard?.index))).toEqual(new Set([1, 2]));
});

test("第二片失败：退出抛错、不写聚合产物，已完成的片产物保留（无部分结果）", async () => {
  const runsRoot = tempRunsRoot();
  const runtime = splitRuntime({
    enabled: true,
    maxShardChars: Math.max(BLOCK_A.length, BLOCK_B.length) + 1,
    maxShards: 4,
  });
  // 只够第 1 片（6 请求），第 2 片第一个请求就耗尽脚本 → 抛错
  const script = fakeFetch(sixPhaseNoTool());
  const events: RunProgressEvent[] = [];

  await expect(
    runReview(
      baseInput(runsRoot, TWO_FILE_DIFF, runtime, script.fetch, (event) => events.push(event)),
    ),
  ).rejects.toThrow(/review turn failed/);
  expect(script.requests).toHaveLength(7);

  // 聚合产物一律不写
  expect(existsSync(path.join(runsRoot, "runs", "run.json"))).toBe(false);
  expect(existsSync(path.join(runsRoot, "runs", "reviews_en.json"))).toBe(false);
  // 第 1 片的产物保留（s01 目录里应有转录与 reviews_en.json）
  const shardsDir = path.join(runsRoot, "runs", "shards");
  const attempts = existsSync(shardsDir) ? readdirSync(shardsDir) : [];
  expect(attempts).toHaveLength(1);
  const shardOneDir = path.join(shardsDir, attempts[0] as string, "s01");
  expect(existsSync(shardOneDir)).toBe(true);
  const files = readdirSync(shardOneDir);
  expect(files.some((file) => file.startsWith("session-"))).toBe(true);
  expect(files).toContain("reviews_en.json");

  // 进度：run.start 带片数、run.end 为 failed
  const runEvents = events.filter((event) => event.kind === "run");
  expect(runEvents).toHaveLength(2);
  expect(
    runEvents[0]?.kind === "run" && runEvents[0].state === "start"
      ? runEvents[0].shards
      : undefined,
  ).toEqual({ total: 2 });
  expect(
    runEvents[1]?.kind === "run" && runEvents[1].state === "end"
      ? runEvents[1].status
      : undefined,
  ).toBe("failed");
});

// ---- 片级上报回调（ADR-0045：onShardFindings） ----

test("单片路径：hook 恰好一次，label {index:1,total:1}，findings 即该片定型结果", async () => {
  const runsRoot = tempRunsRoot();
  const runtime = splitRuntime({ enabled: false, maxShardChars: 200 });
  const script = fakeFetch(sixPhaseWithCandidate(candidate("C1", "src/Foo.java", 3)));
  const seen: { label: { index: number; total: number }; findings: unknown[] }[] = [];

  const run = await runReview({
    ...baseInput(runsRoot, BLOCK_A, runtime, script.fetch),
    onShardFindings: async (label, findings) => {
      seen.push({ label, findings: [...findings] });
    },
  });

  expect(seen).toHaveLength(1);
  expect(seen[0]?.label).toEqual({ index: 1, total: 1 });
  expect(seen[0]?.findings).toEqual(run.record.baseline.findings);
  // 不注入任何上报语义：请求面与产物面不受影响（6 请求、聚合产物在位）
  expect(script.requests).toHaveLength(6);
  expect(run.record.baseline.findings).toHaveLength(1);
});

test("分片路径：每片一次、label 带片号、串行 await（上一片回调完成才开下一片）", async () => {
  const runsRoot = tempRunsRoot();
  const runtime = splitRuntime({
    enabled: true,
    maxShardChars: Math.max(BLOCK_A.length, BLOCK_B.length) + 1,
    maxShards: 4,
  });
  // 第 1 片产 1 条候选（文件 A），第 2 片产 1 条候选（文件 B）
  const script = fakeFetch([
    ...sixPhaseWithCandidate(candidate("C1", "src/main/java/com/example/Alpha.java", 3)),
    ...sixPhaseWithCandidate(candidate("C2", "src/main/java/com/example/Beta.java", 5)),
  ]);
  const order: string[] = [];
  const labels: { index: number; total: number }[] = [];

  await runReview({
    ...baseInput(runsRoot, TWO_FILE_DIFF, runtime, script.fetch),
    onShardFindings: async (label, findings) => {
      labels.push({ ...label });
      order.push(`s${String(label.index)}:start(${String(findings.length)})`);
      // 让第 1 片的回调慢一拍：若 run 层不等它，s2 的 start 会插到 s1:end 之前
      if (label.index === 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      order.push(`s${String(label.index)}:end`);
    },
  });

  expect(labels).toEqual([
    { index: 1, total: 2 },
    { index: 2, total: 2 },
  ]);
  expect(order).toEqual(["s1:start(1)", "s1:end", "s2:start(1)", "s2:end"]);
});

test("hook 抛错 = 实现方 bug：run 层吞掉，检视照常成功（旁路纪律）", async () => {
  const runsRoot = tempRunsRoot();
  const runtime = splitRuntime({ enabled: false, maxShardChars: 200 });
  const script = fakeFetch(sixPhaseNoTool());

  const run = await runReview({
    ...baseInput(runsRoot, BLOCK_A, runtime, script.fetch),
    onShardFindings: async () => {
      throw new Error("reporting blew up");
    },
  });

  expect(run.record.baseline.findings).toEqual([]);
  expect(script.requests).toHaveLength(6);
});
