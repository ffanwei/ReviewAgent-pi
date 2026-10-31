import { expect, test } from "vitest";
import type { FakeReply, FakeUsage } from "../provider/fake-fetch.js";
import { fakeFetch } from "../provider/fake-fetch.js";
import {
  LOCKED_REASONING_EFFORT,
  REVIEW_MODEL_ID,
} from "../provider/pi-client.js";
import { repoFixturePath } from "../testing/repos.js";
import { buildReviewToolkit } from "../tools/toolkit.js";
import type { LlmMessage } from "../contracts/llm.js";
import type { WireMessage } from "../contracts/llm.js";
import type { RuleSkill } from "../knowledge/rule-skill.js";
import {
  MAX_TOOL_CALLS,
  MAX_ROUNDS,
  TOOL_BUDGET_EXHAUSTED_SUMMARY,
  TRUNCATION_MAX_ROUNDS,
  TRUNCATION_MODEL_LENGTH,
  TRUNCATION_TOOL_BUDGET,
} from "./constants.js";
import { PHASE_COUNT, PHASE_INSTRUCTIONS } from "./phases.js";
import { runAgentReviewLoop } from "./agent-review-loop.js";

// agentLoop 钩子驱动循环（#6 P3a）：pi-agent-core Agent 上的
// 六阶段 + 工具子循环。时序真源 = t-series 审计：
// - 工具轮恒 recall（预算耗尽也 recall，相位只在文本回复时完结——无 force-complete）；
// - 预算上界 = 成功执行计数 6（失败也计入），超出即 "Error: tool call
//   budget exhausted" 应答（= 审计 resultSummary = wire tool content）；
// - PhaseRecord.note = "N tool call(s) skipped: budget exhausted"（相位内累计）；
// - 协议纪律：assistant tool_calls 后必须紧跟覆盖全部 id 的 tool 应答；
// - Zone A 稳定：tools 面与消息前缀跨请求 append-only。

const SYSTEM = "agent-loop-test system prompt";
const INITIAL: readonly LlmMessage[] = [
  { role: "user", content: "mr message" },
];
const DIFF = ["--- a/Foo.java", "+++ b/Foo.java", "@@ -1,2 +1,2 @@", "-old", "+new"].join("\n");
/** review.get_diff 执行输出（工具自带头行） */
const GET_DIFF_RESULT = `MR unified diff:\n${DIFF}`;

const VALID_CANDIDATE = {
  id: "F001",
  severity: "P3",
  category: "MAINTAINABILITY",
  file: "src/main/java/Foo.java",
  line: 10,
  title: "Unused helper method",
  description: "The helper is never referenced after the change.",
  evidence: ["src/main/java/Foo.java:10 private void helper()"],
  rule: "MAINTAINABILITY-001",
  confidence: 0.7,
} as const;

/**
 * 脚本 usage（fake 帧 prompt/completion/cacheRead 口径）：
 * pi-ai 折算 input = prompt − cacheRead（miss 口径），故期望 LlmUsage 为
 * {inputTokens: (i+1)*10, outputTokens: i+1, cacheReadTokens: (i+1)*5}。
 */
function usageOf(index: number): FakeUsage {
  return { promptTokens: (index + 1) * 15, completionTokens: index + 1, cacheReadTokens: (index + 1) * 5 };
}

/** 第 index 阶段的文本回复（phase-5 候选 / phase-6 裁决由调用方覆盖） */
function phaseText(phaseIndex: number): string {
  if (phaseIndex === 4) {
    return `{"candidates":[${JSON.stringify(VALID_CANDIDATE)}]}`;
  }
  if (phaseIndex === 5) {
    return '{"verdicts":[{"id":"F001","pass":true,"reason":"evidence supports"}],"complete":true}';
  }
  return `{"answer":"phase-${phaseIndex + 1}-done"}`;
}

function textReply(text: string, index: number): FakeReply {
  return { text, usage: usageOf(index) };
}

function toolReply(
  calls: readonly { id: string; name: string; args?: Record<string, unknown> }[],
  index: number,
): FakeReply {
  return {
    usage: usageOf(index),
    toolCalls: calls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: call.args ?? {},
    })),
  };
}

interface ScriptedRun {
  readonly run: () => ReturnType<typeof runAgentReviewLoop>;
  readonly requestUrls: readonly string[];
}

/** 单轮直驱脚本（phase-2 插入一批 get_diff 工具调用 + recall 文本收尾） */
function singleRoundScript(): readonly FakeReply[] {
  return [
    textReply(phaseText(0), 0),
    toolReply([{ id: "call-a", name: "review_get_diff" }], 1),
    textReply(phaseText(1), 2),
    textReply(phaseText(2), 3),
    textReply(phaseText(3), 4),
    textReply(phaseText(4), 5),
    textReply(phaseText(5), 6),
  ];
}

function scriptedLoop(replies: readonly FakeReply[], initial = INITIAL): ScriptedRun {
  const script = fakeFetch([...replies]);
  const toolkit = buildReviewToolkit({ repoPath: repoFixturePath("sample"), diff: DIFF });
  const run = () =>
    runAgentReviewLoop({
      systemPrompt: SYSTEM,
      initialContextMessages: initial,
      toolkit,
      apiKey: "test-key",
      fetch: script.fetch,
    });
  return { run, requestUrls: script.requests.map((request) => request.url) };
}

test("循环常量与 DSH 线一致（工具预算 + 截断原因 + 预算耗尽应答字节）", () => {
  expect(MAX_TOOL_CALLS).toBe(100);
  expect(TRUNCATION_TOOL_BUDGET).toBe("TOOL_BUDGET_EXHAUSTED");
  expect(TOOL_BUDGET_EXHAUSTED_SUMMARY).toBe("Error: tool call budget exhausted");
});

test("单轮直驱 + 工具子循环：phase-2 执行 get_diff 后 recall 收尾，审计齐备", async () => {
  const { run } = scriptedLoop(singleRoundScript());
  const outcome = await run();

  expect(outcome.complete).toBe(true);
  expect(outcome.rounds).toBe(1);
  expect(outcome.toolCalls).toBe(1);
  expect(outcome.findings).toHaveLength(1);
  expect(outcome.findings[0]?.id).toBe("F001");

  // phaseLog：六阶段，phase-2 因工具子循环 2 请求
  expect(outcome.audit.phaseLog).toHaveLength(PHASE_COUNT);
  expect(outcome.audit.phaseLog.map((entry) => entry.requestCount)).toEqual([1, 2, 1, 1, 1, 1]);
  expect(outcome.audit.phaseLog.every((entry) => entry.round === 1)).toBe(true);
  expect(outcome.audit.phaseLog.every((entry) => entry.note === undefined)).toBe(true);

  // toolCallLog：1 条执行记录（点分名 + 参数 JSON + 真实 resultSummary）
  expect(outcome.audit.toolCallLog).toEqual([
    { name: "review.get_diff", argumentsJson: "{}", resultSummary: GET_DIFF_RESULT },
  ]);

  // usage：7 次请求累计
  expect(outcome.usage).toEqual({
    inputTokens: 10 + 20 + 30 + 40 + 50 + 60 + 70,
    outputTokens: 1 + 2 + 3 + 4 + 5 + 6 + 7,
    cacheReadTokens: 5 + 10 + 15 + 20 + 25 + 30 + 35,
  });

  // requests：7 条 wire 捕获；模型/锁档口径
  expect(outcome.audit.requests).toHaveLength(7);
  expect(outcome.audit.requests.every((request) => request.model === REVIEW_MODEL_ID)).toBe(true);
  expect(outcome.audit.requests.every((request) => request.effort === "default")).toBe(true);

  // 截断留痕：无
  expect(outcome.audit.truncated).toBe(false);
  expect(outcome.audit.truncationReasons).toEqual([]);
});

test("Zone A 稳定：七工具面跨请求字节恒定（审计点分名 / wire 下划线名），消息前缀 append-only", async () => {
  const { run } = scriptedLoop(singleRoundScript());
  const outcome = await run();
  const requests = outcome.audit.requests;

  // 审计投影：七工具、点分名、顺序与注册表一致
  for (const request of requests) {
    expect(request.tools.map((tool) => tool.name)).toEqual([
      "review.get_diff",
      "review.get_symbol",
      "review.get_file",
      "review.find_references",
      "review.get_call_chain",
      "review.search_rule",
      "review.search_history",
    ]);
  }
  // wire 体：工具名为下划线形态
  const wireTools = JSON.parse(requests[0]!.wireBody).tools as Array<{
    function: { name: string };
  }>;
  expect(wireTools.map((tool) => tool.function.name)).toEqual([
    "review_get_diff",
    "review_get_symbol",
    "review_get_file",
    "review_find_references",
    "review_get_call_chain",
    "review_search_rule",
    "review_search_history",
  ]);
  // 锁档：reasoning_effort high
  expect(JSON.parse(requests[0]!.wireBody).reasoning_effort).toBe(LOCKED_REASONING_EFFORT);

  // 首请求消息序：system → 初始上下文 → phase-1 指令
  const first = requests[0]!.messages;
  expect(first.map((message) => message.role)).toEqual(["system", "user", "user"]);
  expect(first[1]?.content).toBe("mr message");
  expect(first[2]?.content).toBe(PHASE_INSTRUCTIONS[0]);

  // append-only：后一请求的 messages 以前一请求为逐字节前缀
  for (let index = 1; index < requests.length; index++) {
    const previous = requests[index - 1]!.messages;
    const current = requests[index]!.messages;
    expect(current.length).toBeGreaterThan(previous.length);
    expect(current.slice(0, previous.length)).toEqual(previous);
  }
});

test("协议完备性：assistant tool_calls 后紧跟覆盖全部 id 的 tool 应答；请求末消息非 assistant", async () => {
  const { run } = scriptedLoop(singleRoundScript());
  const outcome = await run();

  for (const request of outcome.audit.requests) {
    const messages = request.messages;
    expect(messages[messages.length - 1]?.role).not.toBe("assistant");
    const answered = new Set<string>();
    for (const message of messages) {
      if (message.role === "tool") {
        answered.add(String(message.tool_call_id));
      }
    }
    for (const message of messages) {
      const toolCalls = message.tool_calls as Array<{ id: string }> | undefined;
      if (message.role === "assistant" && Array.isArray(toolCalls)) {
        for (const call of toolCalls) {
          expect(answered.has(call.id), `tool call ${call.id} must be answered`).toBe(true);
        }
      }
    }
  }
  // 工具应答内容 = resultSummary（同一内容进审计与上下文）；应答出现在
  // recall 请求（requests[2]）——requests[1] 是携带工具调用的请求本身
  const second = outcome.audit.requests[2]!.messages;
  const toolMessages = second.filter((message: WireMessage) => message.role === "tool");
  expect(toolMessages).toHaveLength(1);
  expect(toolMessages[0]?.content).toBe(GET_DIFF_RESULT);
});

test("预算耗尽：第 7+ 次调用获 Error 应答、计数留痕、截断原因单列但不翻转 truncated", async () => {
  const overflowCalls = [
    { id: "call-o1", name: "review_get_diff" },
    { id: "call-o2", name: "review_get_diff" },
  ];
  const replies: FakeReply[] = [
    textReply(phaseText(0), 0),
    // 一批 6 个 get_diff：全执行（预算用满）
    toolReply(
      Array.from({ length: MAX_TOOL_CALLS }, (_, index) => ({ id: `call-e${index}`, name: "review_get_diff" })),
      1,
    ),
    // 再一批 2 个：全跳过（Error 应答）——t-series 语义：跳过后仍 recall
    toolReply(overflowCalls, 2),
    textReply(phaseText(1), 3),
    textReply(phaseText(2), 4),
    textReply(phaseText(3), 5),
    textReply(phaseText(4), 6),
    textReply(phaseText(5), 7),
  ];
  const { run } = scriptedLoop(replies);
  const outcome = await run();

  expect(outcome.complete).toBe(true);
  expect(outcome.toolCalls).toBe(MAX_TOOL_CALLS);
  expect(outcome.audit.truncated).toBe(false);
  expect(outcome.audit.truncationReasons).toEqual([TRUNCATION_TOOL_BUDGET]);

  // toolCallLog：6 条执行 + 2 条 Error 跳过（批序）
  const log = outcome.audit.toolCallLog;
  expect(log).toHaveLength(MAX_TOOL_CALLS + overflowCalls.length);
  expect(log.slice(0, MAX_TOOL_CALLS).every((entry) => entry.resultSummary === GET_DIFF_RESULT)).toBe(true);
  expect(log.slice(MAX_TOOL_CALLS)).toEqual([
    { name: "review.get_diff", argumentsJson: "{}", resultSummary: TOOL_BUDGET_EXHAUSTED_SUMMARY },
    { name: "review.get_diff", argumentsJson: "{}", resultSummary: TOOL_BUDGET_EXHAUSTED_SUMMARY },
  ]);

  // phase-2：3 请求 + 跳过计数 note
  const phase2 = outcome.audit.phaseLog[1];
  expect(phase2?.requestCount).toBe(3);
  expect(phase2?.note).toBe(`${overflowCalls.length} tool call(s) skipped: budget exhausted`);

  // 跳过批的工具应答进上下文（跳过批 recall 请求 requests[3] 里可见——
  // requests[2] 是携带溢出工具调用的请求本身）
  const fourth = outcome.audit.requests[3]!.messages;
  const skippedToolMessages = fourth.filter((message: WireMessage) => message.role === "tool" && message.content === TOOL_BUDGET_EXHAUSTED_SUMMARY);
  expect(skippedToolMessages).toHaveLength(overflowCalls.length);
});

test("输出撞上界（finish_reason length）：truncated=true + MODEL_MAX_TOKENS_REACHED，不静默成完整 run", async () => {
  // phase-1 回复被输出上界截断（内容仍是合法 JSON，但语义已被裁掉）；后续阶段照常推进
  const replies = singleRoundScript().map((reply, index) =>
    index === 0 ? { ...reply, finishReason: "length" } : reply,
  );
  const { run } = scriptedLoop(replies);
  const outcome = await run();

  expect(outcome.audit.truncated).toBe(true);
  expect(outcome.audit.truncationReasons).toEqual([TRUNCATION_MODEL_LENGTH]);
  // 截断优先：裁决虽 complete，也不得宣称完整
  expect(outcome.complete).toBe(false);
});

test("轮次上界：complete 恒 false → rounds=5、truncated=true、正常返回（退出路径可验证）", async () => {
  const verdicts = '{"verdicts":[{"id":"F001","pass":true,"reason":"ok"}],"complete":false}';
  const replies: FakeReply[] = [];
  let index = 0;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    for (let phaseIndex = 0; phaseIndex < PHASE_COUNT; phaseIndex++) {
      const text = phaseIndex === 5 ? verdicts : phaseText(phaseIndex);
      replies.push(textReply(text, index));
      index += 1;
    }
  }
  const { run } = scriptedLoop(replies);
  const outcome = await run();

  expect(outcome.complete).toBe(false);
  expect(outcome.rounds).toBe(MAX_ROUNDS);
  expect(outcome.audit.truncated).toBe(true);
  expect(outcome.audit.truncationReasons).toEqual([TRUNCATION_MAX_ROUNDS]);
  expect(outcome.audit.requests).toHaveLength(MAX_ROUNDS * PHASE_COUNT);
  expect(outcome.audit.phaseLog).toHaveLength(MAX_ROUNDS * PHASE_COUNT);
  // 每轮各产出 1 条 finding（同 id 跨轮去重：首轮后 DUPLICATE_ID 拒绝）
  expect(outcome.findings).toHaveLength(1);
  expect(outcome.audit.rejections).toHaveLength(MAX_ROUNDS - 1);
  expect(outcome.audit.rejections.every((entry) => entry.stage === "DUPLICATE_ID")).toBe(true);
});

test("provider 错误（stopReason error）：显式抛错，不静默成成功 run", async () => {
  const replies: FakeReply[] = [
    { ...textReply(phaseText(0), 0), finishReason: "content_filter" },
  ];
  const { run } = scriptedLoop(replies);
  await run().then(
    () => {
      throw new Error("expected the run to fail");
    },
    (error: unknown) => {
      expect((error as Error).message).toMatch(/review turn failed/i);
    },
  );
});

// ---- 规则 Skill（ADR-0014）：Phase 5 → skill 会话 → Phase 6 ----

const SKILL_CANDIDATE = {
  id: "RULE-CHECK@sample-rule@src/main/java/Foo.java:20",
  severity: "P3",
  category: "MAINTAINABILITY",
  file: "src/main/java/Foo.java",
  line: 20,
  title: "Unused helper method",
  description: "The helper is never referenced after the change.",
  evidence: ["src/main/java/Foo.java:20 private void helper()"],
  rule: "sample-rule",
  confidence: 0.7,
} as const;

test("规则 Skill：Phase 5 文本回合后先跑 skill 会话，Phase 6 一次裁定两批候选", async () => {
  const skill: RuleSkill = {
    name: "sample-rule",
    description: "Sample project rule skill",
    content: "Check every public method for a null guard.",
    filePath: "C:\\cache\\deadbeef\\sample-rule\\SKILL.md",
    digest: "deadbeef",
    source: { kind: "zip", path: ".review-rules/rules.zip" },
    diagnostics: [],
  };

  const script = fakeFetch([
    textReply(phaseText(0), 0),
    textReply(phaseText(1), 1),
    textReply(phaseText(2), 2),
    textReply(phaseText(3), 3),
    // Phase 5：主候选
    textReply(phaseText(4), 4),
    // skill 会话：追加一批候选
    textReply(`{"candidates":[${JSON.stringify(SKILL_CANDIDATE)}]}`, 5),
    // Phase 6：两批一起裁定
    textReply(
      '{"verdicts":[{"id":"F001","pass":true,"reason":"ok"},{"id":"RULE-CHECK@sample-rule@src/main/java/Foo.java:20","pass":true,"reason":"ok"}],"complete":true}',
      6,
    ),
  ]);

  const outcome = await runAgentReviewLoop({
    systemPrompt: SYSTEM,
    initialContextMessages: INITIAL,
    toolkit: buildReviewToolkit({ repoPath: repoFixturePath("sample"), diff: DIFF }),
    apiKey: "test-key",
    fetch: script.fetch,
    skillPass: {
      skills: [skill],
      toolkitFor: () => buildReviewToolkit({ repoPath: repoFixturePath("sample"), diff: DIFF }),
    },
  });

  // 主链请求仍六条（skill 会话不进主审计 wire log）
  expect(script.requests).toHaveLength(7);
  expect(outcome.audit.requests).toHaveLength(6);
  // skill 回合不进 phaseLog（两者并列）
  expect(outcome.audit.phaseLog.map((record) => record.phase)).toEqual([
    "Change Understanding",
    "Risk Classification",
    "Context Decision",
    "Context Retrieval",
    "Deep Reasoning",
    "Evidence Verification",
  ]);

  const phase4 = JSON.parse(outcome.audit.requests[3].wireBody) as {
    messages: { role: string; content: string }[];
  };
  // Phase 4 消息逐字节 = 常量（ADR-0012 的候选阶段注入已随 ADR-0014 退役）
  expect(phase4.messages.at(-1)?.content).toBe(PHASE_INSTRUCTIONS[3]);

  // Phase 6 = 指令 + skill 候选清单（唯一的附加段）
  const phase6 = JSON.parse(outcome.audit.requests[5].wireBody) as {
    messages: { role: string; content: string }[];
  };
  const content = phase6.messages.at(-1)?.content ?? "";
  expect(content).toContain(PHASE_INSTRUCTIONS[5]);
  expect(content.indexOf(PHASE_INSTRUCTIONS[5])).toBe(0);
  expect(content).toContain(SKILL_CANDIDATE.id);

  // 执行留痕 + 两批候选都过 gate（主候选在前）
  expect(outcome.skillPassLog).toHaveLength(1);
  expect(outcome.skillPassLog[0]).toMatchObject({
    round: 1,
    skill: "sample-rule",
    status: "ok",
    candidateCount: 1,
    mergedCount: 0,
  });
  expect(outcome.skillTranscripts).toHaveLength(1);
  expect(outcome.findings.map((finding) => finding.id)).toEqual(["F001", SKILL_CANDIDATE.id]);
  expect(outcome.toolCalls).toBe(0);
});
