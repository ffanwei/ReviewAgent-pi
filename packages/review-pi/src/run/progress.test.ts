import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import type { LlmUsage } from "../contracts/llm.js";
import type { RunProgressEvent } from "../contracts/progress.js";
import { fakeFetch, type FakeReply, type FakeUsage } from "../provider/fake-fetch.js";
import { goldenFixture } from "../testing/golden.js";
import { repoFixturePath } from "../testing/repos.js";
import { VUL4J_1_ISSUE } from "../testing/vul4j1-script.js";
import type { RuleSkill } from "../knowledge/rule-skill.js";
import { runReview } from "./review-run.js";

// 运行进度投影（ADR-0016）在 run 入口（S1 = runReview）的行为契约：
// - 事件序列 = 既有留痕的实时投影（阶段 → 请求首尾 → 工具首尾 → skill 首尾）；
// - 请求级 usage 逐条可加，总和与 `record.baseline.usage`（审计同源）对账；
// - 投影**不改**任何落盘产物：RunRecord / 审计文件里没有 progress 字段，
//   也不含工具结果全文（进度只报行数/字符数）。
//
// 断言面只看公共入口（runReview + onProgress 注入），不窥探内核变量。

const tempDirs: string[] = [];

function tempRunsRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "review-pi-progress-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 可区分的 usage（每请求不同 ⇒ 对账能发现串号/漏记） */
function usageAt(index: number): FakeUsage {
  return { promptTokens: 1_000 + index * 10, completionTokens: 200 + index, cacheReadTokens: 100 };
}

function textReply(text: string, index: number): FakeReply {
  return { text, usage: usageAt(index) };
}

function candidatesReply(candidates: readonly unknown[], index: number): FakeReply {
  return { text: JSON.stringify({ candidates }), usage: usageAt(index) };
}

function verdictsReply(ids: readonly string[], index: number): FakeReply {
  return {
    text: JSON.stringify({
      verdicts: ids.map((id) => ({ id, pass: true, reason: "evidence supports" })),
      complete: true,
    }),
    usage: usageAt(index),
  };
}

function toolReply(name: string, args: Record<string, unknown>, index: number): FakeReply {
  return {
    text: `let me check (${name})`,
    toolCalls: [{ id: `call-${index}`, name, arguments: args }],
    usage: usageAt(index),
  };
}

const RULE_FILE = "src/main/java/com/example/Alpha.java";

function skillCandidate(skill: string, line: number): Record<string, unknown> {
  return {
    id: `RULE-CHECK@${skill}@${RULE_FILE}:${line}`,
    severity: "P2",
    category: "BUG",
    file: RULE_FILE,
    line,
    title: "Missing null guard on a public method",
    description: "A public method dereferences its argument without a null guard, per the project rule.",
    evidence: [`${RULE_FILE}:${line} public int getBase() {`],
    rule: skill,
    confidence: 0.8,
  };
}

const SAMPLE_RULE_SKILL: RuleSkill = {
  name: "sample-rule",
  description: "Sample project rule skill sample-rule",
  content: "Check every public method for a null guard (sample-rule).",
  filePath: "C:\\host\\cache\\deadbeef\\sample-rule\\SKILL.md",
  digest: "deadbeef",
  source: { kind: "zip", path: ".review-rules/rules.zip" },
  diagnostics: [],
};

/** 事件序列的压缩形态（便于整体断言「谁在谁之前」） */
function sequenceOf(events: readonly RunProgressEvent[]): string[] {
  return events.map((event) => {
    switch (event.kind) {
      case "phase":
        return `phase ${event.round}.${event.index}`;
      case "request":
        return event.state === "start" ? `req ${event.requestId} start` : `req ${event.requestId} end`;
      case "tool":
        return event.state === "start" ? `tool ${event.name} start` : `tool ${event.name} end`;
      case "skill":
        return `skill ${event.skill} ${event.state}`;
    }
  });
}

function totalUsage(events: readonly RunProgressEvent[]): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
} {
  const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  for (const event of events) {
    if (event.kind !== "request" || event.state !== "end") {
      continue;
    }
    total.inputTokens += event.usage.inputTokens;
    total.outputTokens += event.usage.outputTokens;
    total.cacheReadTokens += event.usage.cacheReadTokens ?? 0;
  }
  return total;
}

test("config F:阶段/请求/工具/skill 事件按发生序投影,请求 usage 总和与记录对账", async () => {
  const events: RunProgressEvent[] = [];
  const candidate = skillCandidate("sample-rule", 11);
  const script = fakeFetch([
    textReply("ok", 1),
    textReply("ok", 2),
    // 主会话 Phase 3 内一次工具回合（工具结果进入同一相位，不额外推进阶段）
    toolReply("review_get_diff", {}, 3),
    textReply("ok", 4),
    textReply("ok", 5),
    candidatesReply([], 6),
    // ↓ skill 会话：一次工具回合 + 最终候选
    toolReply("review_get_diff", {}, 7),
    candidatesReply([candidate], 8),
    // ↓ 主会话 Phase 6（主请求序号继续，不从 skill 会话继承）
    verdictsReply([candidate.id as string], 9),
  ]);
  const run = await runReview({
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"),
    diff: goldenFixture("vul4j-1.diff"),
    issueDescription: VUL4J_1_ISSUE,
    apiKey: "offline-test",
    fetch: script.fetch,
    runsRoot: tempRunsRoot(),
    experimentId: "phase2-smoke",
    rep: 1,
    configId: "F",
    ruleSkillLoader: async () => [SAMPLE_RULE_SKILL],
    onProgress: (event) => events.push(event),
  });

  expect(script.requests).toHaveLength(9);
  expect(sequenceOf(events)).toEqual([
    "phase 1.1",
    "req 1 start",
    "req 1 end",
    "phase 1.2",
    "req 2 start",
    "req 2 end",
    "phase 1.3",
    "req 3 start",
    "tool review.get_diff start",
    "tool review.get_diff end",
    "req 3 end",
    "req 4 start",
    "req 4 end",
    "phase 1.4",
    "req 5 start",
    "req 5 end",
    "phase 1.5",
    "req 6 start",
    "req 6 end",
    // skill 会话在 Phase 5 与 Phase 6 之间；请求序号按会话作用域自增
    "skill sample-rule start",
    "req 1 start",
    "tool review.get_diff start",
    "tool review.get_diff end",
    "req 1 end",
    "req 2 start",
    "req 2 end",
    "skill sample-rule end",
    "phase 1.6",
    "req 7 start",
    "req 7 end",
  ]);

  // 阶段事件带轮次与 1-based 序号（不做百分比，只是「第几步」）
  const phases = events.filter((event) => event.kind === "phase");
  expect(phases).toHaveLength(6);
  expect(phases.map((event) => (event.kind === "phase" ? event.index : -1))).toEqual([1, 2, 3, 4, 5, 6]);
  expect(phases.every((event) => event.kind === "phase" && event.round === 1 && event.total === 6)).toBe(true);
  expect(phases.map((event) => (event.kind === "phase" ? event.phase : ""))).toEqual([
    "Change Understanding",
    "Risk Classification",
    "Context Decision",
    "Context Retrieval",
    "Deep Reasoning",
    "Evidence Verification",
  ]);

  // 工具事件：成功 = ok 且无 detail；结果全文（resultSummary）永不进事件
  const toolEnds = events.filter(
    (event): event is Extract<RunProgressEvent, { kind: "tool"; state: "end" }> =>
      event.kind === "tool" && event.state === "end",
  );
  expect(toolEnds).toHaveLength(2);
  expect(toolEnds.every((event) => event.ok && event.detail === undefined)).toBe(true);
  expect(toolEnds[0]?.resultLines).toBeGreaterThan(0);
  expect(JSON.stringify(events)).not.toContain("MR unified diff");

  // skill 收尾汇总：状态 + 会话内请求/工具计数（与审计 skillPassLog 同值）
  const skillEnd = events.find(
    (event): event is Extract<RunProgressEvent, { kind: "skill"; state: "end" }> =>
      event.kind === "skill" && event.state === "end",
  );
  expect(skillEnd).toMatchObject({
    round: 1,
    skill: "sample-rule",
    status: "ok",
    requestCount: 2,
    toolCallCount: 1,
  });
  expect(skillEnd?.detail).toBeUndefined();

  // 对账：逐请求 usage 之和 = 运行记录 usage（含 skill 会话折算）
  expect(totalUsage(events)).toEqual(run.record.baseline.usage);

  // 投影不改落盘产物：记录与审计里没有 progress 键，也没有事件面字段
  expect(JSON.stringify(run.record)).not.toContain("\"progress\"");
  expect(readFileSync(run.auditPath, "utf8")).not.toContain("\"progress\"");
  expect(run.record.baseline.toolCalls).toBe(2);
  expect(run.record.baseline.audit.skillPassLog).toMatchObject([
    { skill: "sample-rule", status: "ok", requestCount: 2, toolCallCount: 1 },
  ]);
}, 120_000);

test("config D:工具失败投影为 ok=false + 一行 detail（不落工具结果全文）", async () => {
  const events: RunProgressEvent[] = [];
  const script = fakeFetch([
    textReply("ok", 1),
    textReply("ok", 2),
    toolReply("review_get_file", { path: "no/such/file.java" }, 3),
    textReply("ok", 4),
    textReply("ok", 5),
    candidatesReply([], 6),
    verdictsReply([], 7),
  ]);
  const run = await runReview({
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"),
    diff: goldenFixture("vul4j-1.diff"),
    issueDescription: VUL4J_1_ISSUE,
    apiKey: "offline-test",
    fetch: script.fetch,
    runsRoot: tempRunsRoot(),
    experimentId: "phase2-smoke",
    rep: 1,
    configId: "D",
    onProgress: (event) => events.push(event),
  });

  const toolEnd = events.find(
    (event): event is Extract<RunProgressEvent, { kind: "tool"; state: "end" }> =>
      event.kind === "tool" && event.state === "end",
  );
  expect(toolEnd).toMatchObject({
    name: "review.get_file",
    ok: false,
    argumentsSummary: "path=no/such/file.java",
    resultChars: expect.any(Number),
  });
  // detail 只留首行，且剥掉 "Error: " 前缀（状态词归呈现层）
  expect(toolEnd?.detail).toBe(
    'review.get_file: file "no/such/file.java" cannot be read from the repository snapshot (not found or unreadable)',
  );
  expect(events.some((event) => event.kind === "skill")).toBe(false);
  // 审计仍记完整 resultSummary（投影只读，不改留痕）
  expect(run.record.baseline.audit.toolCallLog[0]?.resultSummary).toContain("Error: ");
}, 120_000);

test("config B:零工具路径只投阶段与请求（没有工具/skill 事件）", async () => {
  const events: RunProgressEvent[] = [];
  const script = fakeFetch([
    textReply("ok", 1),
    textReply("ok", 2),
    textReply("ok", 3),
    textReply("ok", 4),
    candidatesReply([], 5),
    verdictsReply([], 6),
  ]);
  await runReview({
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"),
    diff: goldenFixture("vul4j-1.diff"),
    issueDescription: VUL4J_1_ISSUE,
    apiKey: "offline-test",
    fetch: script.fetch,
    runsRoot: tempRunsRoot(),
    experimentId: "phase2-smoke",
    rep: 1,
    configId: "B",
    onProgress: (event) => events.push(event),
  });

  expect(script.requests).toHaveLength(6);
  expect(events.filter((event) => event.kind === "phase")).toHaveLength(6);
  expect(events.filter((event) => event.kind === "request")).toHaveLength(12);
  expect(events.some((event) => event.kind === "tool" || event.kind === "skill")).toBe(false);
  expect(events.filter((event) => event.kind === "request" && event.state === "start").map(
    (event) => (event.kind === "request" ? event.requestId : -1),
  )).toEqual([1, 2, 3, 4, 5, 6]);
}, 120_000);

test("config F:skill 会话的 bash 计入会话留痕、不计入指标 toolCalls（ADR-0014 口径）", async () => {
  const events: RunProgressEvent[] = [];
  const script = fakeFetch([
    textReply("ok", 1),
    textReply("ok", 2),
    textReply("ok", 3),
    textReply("ok", 4),
    candidatesReply([], 5),
    // ↓ skill 会话：一条被元字符规则拒绝的 bash（确定性失败，不真的起子进程）
    toolReply("bash", { command: "echo hi | cat" }, 6),
    candidatesReply([], 7),
    // ↓ 主会话 Phase 6
    verdictsReply([], 8),
  ]);
  const run = await runReview({
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"),
    diff: goldenFixture("vul4j-1.diff"),
    issueDescription: VUL4J_1_ISSUE,
    apiKey: "offline-test",
    fetch: script.fetch,
    runsRoot: tempRunsRoot(),
    experimentId: "phase2-smoke",
    rep: 1,
    configId: "F",
    ruleSkillLoader: async () => [SAMPLE_RULE_SKILL],
    onProgress: (event) => events.push(event),
  });

  expect(script.requests).toHaveLength(8);
  const bashEnd = events.find(
    (event): event is Extract<RunProgressEvent, { kind: "tool"; state: "end" }> =>
      event.kind === "tool" && event.state === "end",
  );
  expect(bashEnd).toMatchObject({
    name: "bash",
    argumentsSummary: "command=echo hi | cat",
    ok: false,
  });
  expect(bashEnd?.detail).toContain("metacharacters");

  const skillEnd = events.find(
    (event): event is Extract<RunProgressEvent, { kind: "skill"; state: "end" }> =>
      event.kind === "skill" && event.state === "end",
  );
  // 会话留痕的 toolCallCount 只数七检视工具（ADR-0014 既有口径）；bash 不进去
  expect(skillEnd).toMatchObject({ skill: "sample-rule", requestCount: 2, toolCallCount: 0 });

  // 指标 toolCalls 也不含 bash（本 run 主会话零工具调用）
  expect(run.record.baseline.toolCalls).toBe(0);
  expect(run.record.baseline.audit.skillPassLog).toMatchObject([
    { skill: "sample-rule", requestCount: 2, toolCallCount: 0 },
  ]);
}, 120_000);
