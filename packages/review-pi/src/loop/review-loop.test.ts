import { expect, test } from "vitest";
import type { AssistantMessage, Context, TextContent } from "@earendil-works/pi-ai";
import type { LlmMessage, LlmUsage } from "../contracts/llm.js";
import type { WireRequest } from "../contracts/run.js";
import { MAX_ROUNDS, TRUNCATION_MAX_ROUNDS, TRUNCATION_MODEL_LENGTH } from "./constants.js";
import { PHASE_INSTRUCTIONS } from "./phases.js";
import { runReviewLoop, type LoopTurn, type ReviewTurnRunner } from "./review-loop.js";

// 六阶段控制器（内核变量面，config B 直驱）：每单元每阶段恰好一次请求，
// 无工具子循环；回复回填上下文 append-only（compaction 显式禁用）；
// 解析失败不抛异常（note 留痕，有界推进）；验证 complete 信号决定轮次终止。

const SYSTEM = "loop-test system prompt";
const INITIAL: readonly LlmMessage[] = [
  { role: "user", content: "zone-b message" },
  { role: "user", content: "mr message" },
  { role: "user", content: "prefetch-1 message" },
];

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

function usageOf(index: number): LlmUsage {
  return { inputTokens: (index + 1) * 10, outputTokens: index + 1, cacheReadTokens: (index + 1) * 5 };
}

function assistantMessage(
  text: string,
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text } satisfies TextContent],
    api: "openai-completions",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 0,
  };
}

function textOf(message: Context["messages"][number]): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/** 注入式回合缝：脚本回复 + 从收到的 Context 构造 wire 投影（消息管理断言用） */
function scriptedTurn(replies: readonly {
  text: string;
  usage: LlmUsage;
  stopReason?: AssistantMessage["stopReason"];
}[]): {
  runTurn: ReviewTurnRunner;
  wires: WireRequest[];
} {
  const wires: WireRequest[] = [];
  let calls = 0;
  const runTurn: ReviewTurnRunner = async (context) => {
    const reply = replies[calls];
    if (reply === undefined) {
      throw new Error(`no scripted reply for turn ${calls + 1}`);
    }
    calls += 1;
    const wire: WireRequest = {
      model: "deepseek-v4-flash",
      effort: "default",
      messages: [
        { role: "system", content: context.systemPrompt ?? "" },
        ...context.messages.map((message) => ({
          role: message.role as "system" | "user" | "assistant" | "tool",
          content: textOf(message),
        })),
      ],
      tools: [],
      wireBody: "{}",
    };
    wires.push(wire);
    const turn: LoopTurn = {
      message: assistantMessage(reply.text, reply.stopReason),
      wire,
      usage: reply.usage,
    };
    return turn;
  };
  return { runTurn, wires };
}

/** 单轮完成的典型脚本（4 个 JSON 阶段回复 + 候选 + 裁决） */
function singleRoundScript(verdicts: string): { text: string; usage: LlmUsage }[] {
  return [
    { text: '{"summary":"changed fastjson codec"}', usage: usageOf(0) },
    { text: '{"riskClass":"High","reason":"deserialization"}', usage: usageOf(1) },
    { text: '{"neededContext":[],"reason":"none"}', usage: usageOf(2) },
    { text: '{"answer":"done"}', usage: usageOf(3) },
    { text: `{"candidates":[${JSON.stringify(VALID_CANDIDATE)}]}`, usage: usageOf(4) },
    { text: verdicts, usage: usageOf(5) },
  ];
}

test("循环常量与 DSH 线一致", () => {
  expect(MAX_ROUNDS).toBe(5);
  expect(TRUNCATION_MAX_ROUNDS).toBe("MAX_ROUNDS_REACHED");
  expect(TRUNCATION_MODEL_LENGTH).toBe("MODEL_MAX_TOKENS_REACHED");
});

test("输出撞上界（finish_reason length）：truncated=true + MODEL_MAX_TOKENS_REACHED，complete 不成立", async () => {
  const completeVerdicts =
    '{"verdicts":[{"id":"F001","pass":true,"reason":"evidence supports"}],"complete":true}';
  const replies = singleRoundScript(completeVerdicts).map((reply, index) =>
    index === 0 ? { ...reply, stopReason: "length" as const } : reply,
  );
  const { runTurn } = scriptedTurn(replies);
  const outcome = await runReviewLoop({
    systemPrompt: SYSTEM,
    initialContextMessages: INITIAL,
    runTurn,
  });

  expect(outcome.audit.truncated).toBe(true);
  expect(outcome.audit.truncationReasons).toEqual([TRUNCATION_MODEL_LENGTH]);
  expect(outcome.complete).toBe(false);
});

test("单轮直驱：验证通过即完成，phaseLog 六阶段各一请求，usage 累计", async () => {
  const { runTurn, wires } = scriptedTurn(
    singleRoundScript('{"verdicts":[{"id":"F001","pass":true,"reason":"evidence supports"}],"complete":true}'),
  );
  const outcome = await runReviewLoop({
    systemPrompt: SYSTEM,
    initialContextMessages: INITIAL,
    runTurn,
  });

  expect(outcome.complete).toBe(true);
  expect(outcome.rounds).toBe(1);
  expect(outcome.toolCalls).toBe(0);
  expect(outcome.findings).toEqual([{ ...VALID_CANDIDATE, evidence: [...VALID_CANDIDATE.evidence] }]);
  // usage = 六回合之和
  expect(outcome.usage).toEqual({
    inputTokens: 10 + 20 + 30 + 40 + 50 + 60,
    outputTokens: 1 + 2 + 3 + 4 + 5 + 6,
    cacheReadTokens: 5 + 10 + 15 + 20 + 25 + 30,
  });
  expect(outcome.audit.truncated).toBe(false);
  expect(outcome.audit.truncationReasons).toEqual([]);
  expect(outcome.audit.rejections).toEqual([]);
  expect(outcome.audit.requests).toHaveLength(6);
  // 逐元素同一引用（wire 捕获不复制）且序一致
  expect(outcome.audit.requests).toEqual(wires);
  expect(outcome.audit.requests[0]).toBe(wires[0]);
  expect(outcome.audit.phaseLog).toEqual(
    PHASE_INSTRUCTIONS.map((_, index) => ({
      round: 1,
      phase: [
        "Change Understanding",
        "Risk Classification",
        "Context Decision",
        "Context Retrieval",
        "Deep Reasoning",
        "Evidence Verification",
      ][index],
      requestCount: 1,
    })),
  );
});

test("append-only（compaction 显式禁用）：每请求 = 上一请求 + assistant 回复 + 下一阶段指令", async () => {
  const { runTurn, wires } = scriptedTurn(
    singleRoundScript('{"verdicts":[],"complete":true}'),
  );
  await runReviewLoop({ systemPrompt: SYSTEM, initialContextMessages: INITIAL, runTurn });

  // req_i 消息数 = system 1 + 初始 3 + 阶段 1 user + 2i（每轮追加 assistant + user）
  expect(wires.map((wire) => wire.messages.length)).toEqual([5, 7, 9, 11, 13, 15]);
  // Zone A 恒为首位 system
  for (const wire of wires) {
    expect(wire.messages[0]).toEqual({ role: "system", content: SYSTEM });
  }
  for (let index = 1; index < wires.length; index++) {
    const previous = wires[index - 1];
    const current = wires[index];
    expect(current.messages.slice(0, -2)).toEqual(previous.messages);
    expect(current.messages.at(-2)?.role).toBe("assistant");
    expect(current.messages.at(-1)).toEqual({
      role: "user",
      content: PHASE_INSTRUCTIONS[index],
    });
  }
});

test("验证拒绝：pass=false → VERIFICATION_FAILED 留痕，complete 信号仍终止", async () => {
  const { runTurn } = scriptedTurn(
    singleRoundScript('{"verdicts":[{"id":"F001","pass":false,"reason":"not supported"}],"complete":true}'),
  );
  const outcome = await runReviewLoop({
    systemPrompt: SYSTEM,
    initialContextMessages: INITIAL,
    runTurn,
  });

  expect(outcome.complete).toBe(true);
  expect(outcome.findings).toEqual([]);
  expect(outcome.audit.rejections).toEqual([
    {
      candidateId: "F001",
      stage: "VERIFICATION_FAILED",
      reason: "evidence verification rejected the candidate: not supported",
    },
  ]);
});

test("解析失败不抛异常：note 留痕进 phaseLog，有界推进", async () => {
  const { runTurn } = scriptedTurn([
    ...singleRoundScript('{"verdicts":[],"complete":true}').slice(0, 4),
    { text: "not json at all", usage: usageOf(4) },
    { text: '{"verdicts":[],"complete":true}', usage: usageOf(5) },
  ]);
  const outcome = await runReviewLoop({
    systemPrompt: SYSTEM,
    initialContextMessages: INITIAL,
    runTurn,
  });

  expect(outcome.findings).toEqual([]);
  expect(outcome.audit.rejections).toEqual([]);
  expect(outcome.audit.phaseLog[4]).toEqual({
    round: 1,
    phase: "Deep Reasoning",
    requestCount: 1,
    note: "deep-reasoning reply is not valid JSON",
  });
});

test("complete 恒 false → MAX_ROUNDS 截断留痕", async () => {
  const script: { text: string; usage: LlmUsage }[] = [];
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    script.push(
      { text: '{"summary":"x"}', usage: usageOf(0) },
      { text: '{"riskClass":"Low","reason":"x"}', usage: usageOf(1) },
      { text: '{"neededContext":[],"reason":"x"}', usage: usageOf(2) },
      { text: '{"answer":"x"}', usage: usageOf(3) },
      { text: '{"candidates":[]}', usage: usageOf(4) },
      { text: '{"verdicts":[],"complete":false}', usage: usageOf(5) },
    );
  }
  const { runTurn, wires } = scriptedTurn(script);
  const outcome = await runReviewLoop({
    systemPrompt: SYSTEM,
    initialContextMessages: INITIAL,
    runTurn,
  });

  expect(outcome.complete).toBe(false);
  expect(outcome.rounds).toBe(MAX_ROUNDS);
  expect(outcome.audit.truncated).toBe(true);
  expect(outcome.audit.truncationReasons).toEqual([TRUNCATION_MAX_ROUNDS]);
  expect(outcome.audit.requests).toHaveLength(30);
  expect(wires).toHaveLength(30);
  expect(outcome.audit.phaseLog).toHaveLength(30);
  expect(outcome.audit.phaseLog.at(-1)).toEqual({
    round: MAX_ROUNDS,
    phase: "Evidence Verification",
    requestCount: 1,
  });
});

test("预取记账透传进 audit.prefetch", async () => {
  const { runTurn } = scriptedTurn(
    singleRoundScript('{"verdicts":[],"complete":true}'),
  );
  const prefetchRecords = [
    { layer: "zone-b" as const, budgetChars: 1, contentChars: 1, truncated: false, totalEntries: 1, shownEntries: 1 },
  ];
  const outcome = await runReviewLoop({
    systemPrompt: SYSTEM,
    initialContextMessages: INITIAL,
    prefetchRecords,
    runTurn,
  });
  expect(outcome.audit.prefetch).toBe(prefetchRecords);
});
