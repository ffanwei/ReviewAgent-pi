import { expect, test } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { FetchFunction } from "@earendil-works/pi-ai";
import { sseBody, type FakeReply } from "../provider/fake-fetch.js";
import { createInertContextLedger } from "../tools/ledger.js";
import { reviewToolSchemas } from "../tools/registry.js";
import type { ReviewToolkit } from "../tools/toolkit.js";
import { SYSTEM_PROMPT } from "../zonea/system-prompt.js";
import type { RuleSkill } from "./rule-skill.js";
import { runSkillPass } from "./skill-pass.js";

// 单个 skill 检视会话（ADR-0014 决策 3/4/6/11）：
// - 独立 Agent，种子 = 主会话 Phase 5 末 messages 快照；
// - 工具面 = 七检视工具 + bash；
// - 失败三态：ok / empty / failed（带 failureStage）；
// - 独立转录原料（写盘在 run 层）。

const PACK_ROOT = "C:\\cache\\deadbeef\\sample-rule";

const SKILL: RuleSkill = {
  name: "sample-rule",
  description: "Sample project rule skill",
  content: "Check every public method for a null guard.",
  filePath: `${PACK_ROOT}\\SKILL.md`,
  digest: "deadbeef",
  source: { kind: "zip", path: ".review-rules/rules.zip" },
  diagnostics: [],
};

const SEED: AgentMessage[] = [
  { role: "user", content: [{ type: "text", text: "seed-1 (initial MR message)" }], timestamp: 1 },
  { role: "user", content: [{ type: "text", text: "seed-2 (phase 5 instruction)" }], timestamp: 2 },
];

/** 记录请求体（OpenAI SDK 以 fetch(url, { body: <json string> }) 调用注入缝） */
function scriptedFetch(replies: readonly FakeReply[]): {
  fetch: FetchFunction;
  bodies: Record<string, unknown>[];
} {
  const bodies: Record<string, unknown>[] = [];
  let calls = 0;
  const fetchFn = (async (_input: unknown, init?: RequestInit) => {
    calls += 1;
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    const reply = replies[calls - 1];
    if (reply === undefined) {
      throw new Error(`no scripted reply for request ${calls}`);
    }
    return new Response(sseBody(reply), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as FetchFunction;
  return { fetch: fetchFn, bodies };
}

function stubToolkit(executed: string[] = []): ReviewToolkit {
  return {
    schemas: reviewToolSchemas(),
    ledger: createInertContextLedger(),
    executeTool: async (name) => {
      executed.push(name);
      return `tool result: ${name}`;
    },
  };
}

const ZERO = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 } as const;

function candidate(id: string, rule: unknown, line = 11): Record<string, unknown> {
  return {
    id,
    severity: "P2",
    category: "BUG",
    file: "src/main/java/com/example/Alpha.java",
    line,
    title: "Missing null guard on a public method",
    description: "A public method dereferences its argument without a null guard.",
    evidence: [`src/main/java/com/example/Alpha.java:${line} public int getBase() {`],
    rule,
    confidence: 0.8,
  };
}

function candidatesReply(candidates: readonly unknown[]): FakeReply {
  return { text: JSON.stringify({ candidates }), usage: ZERO };
}

function baseOptions(overrides: Partial<Parameters<typeof runSkillPass>[0]> = {}) {
  return {
    round: 1,
    skill: SKILL,
    systemPrompt: SYSTEM_PROMPT,
    seedMessages: SEED,
    toolkit: stubToolkit(),
    apiKey: "offline-test",
    ...overrides,
  };
}

test("独立会话：复用 system prompt、种子历史原样、八工具、真实 pack 路径、独立转录", async () => {
  const script = scriptedFetch([candidatesReply([candidate("S1", "sample-rule")])]);
  const outcome = await runSkillPass(baseOptions({ fetch: script.fetch }));

  const body = script.bodies[0] as {
    messages: { role: string; content: unknown }[];
    tools?: { function?: { name?: string } }[];
  };
  // Zone A 复用：同一 SYSTEM_PROMPT（跨会话缓存前缀）
  expect(body.messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
  // 种子 = 主会话 Phase 5 末快照（原样，不改写）
  expect(body.messages[1]).toMatchObject({ role: "user", content: [{ type: "text", text: "seed-1 (initial MR message)" }] });
  expect(body.messages[2]).toMatchObject({ role: "user", content: [{ type: "text", text: "seed-2 (phase 5 instruction)" }] });
  // 首条新消息 = skill 块（真实 pack 路径）+ 输出契约
  const invocation = body.messages.at(-1)?.content as { type: string; text?: string }[];
  const text = invocation.map((block) => block.text ?? "").join("");
  expect(text).toContain(`<skill name="sample-rule" location="${PACK_ROOT}\\SKILL.md">`);
  expect(text).toContain(`References are relative to ${PACK_ROOT}.`);
  expect(text).toContain(SKILL.content);
  expect(text).toContain('"rule" field to the skill name "sample-rule"');
  // 工具面 = 七检视工具 + bash
  expect((body.tools ?? []).map((tool) => tool.function?.name)).toEqual([
    "review_get_diff",
    "review_get_symbol",
    "review_get_file",
    "review_find_references",
    "review_get_call_chain",
    "review_search_rule",
    "review_search_history",
    "bash",
  ]);

  expect(outcome.record).toMatchObject({
    round: 1,
    skill: "sample-rule",
    status: "ok",
    requestCount: 1,
    toolCallCount: 0,
    candidateCount: 1,
    mergedCount: 0,
    ruleIds: ["sample-rule"],
  });
  expect(outcome.candidates).toHaveLength(1);
  expect(outcome.transcript).toBeDefined();
  const transcript = outcome.transcript;
  if (transcript === undefined) {
    throw new Error("expected a transcript");
  }
  expect(transcript.complete).toBe(true);
  expect(transcript.capture.messages.slice(0, SEED.length)).toEqual(SEED);
  expect(transcript.capture.messages).toHaveLength(SEED.length + 2); // 首条 user + 回复
  expect(transcript.capture.firstRequestAt).toBeInstanceOf(Date);
});

test("跑通 0 候选 = empty（合法，不是失败；也没有 degradedReason）", async () => {
  const script = scriptedFetch([candidatesReply([])]);
  const outcome = await runSkillPass(baseOptions({ fetch: script.fetch }));

  expect(outcome.record).toMatchObject({
    status: "empty",
    candidateCount: 0,
    mergedCount: 0,
  });
  expect(outcome.record.degradedReason).toBeUndefined();
  expect(outcome.record.failureStage).toBeUndefined();
  expect(outcome.candidates).toEqual([]);
  expect(outcome.transcript?.complete).toBe(true);
});

test("解析失败 = failed/parse（带 degradedReason，候选为空）", async () => {
  const script = scriptedFetch([{ text: "I could not decide.", usage: ZERO }]);
  const outcome = await runSkillPass(baseOptions({ fetch: script.fetch }));

  expect(outcome.record).toMatchObject({
    status: "failed",
    failureStage: "parse",
    candidateCount: 0,
  });
  expect(String(outcome.record.degradedReason)).toContain("JSON");
  expect(outcome.candidates).toEqual([]);
  expect(outcome.transcript?.complete).toBe(false);
});

test("会话异常 = failed/session（provider/fetch 抛错不穿透 run）", async () => {
  const throwingFetch = (async () => {
    throw new Error("network exploded");
  }) as unknown as FetchFunction;
  const outcome = await runSkillPass(baseOptions({ fetch: throwingFetch }));

  expect(outcome.record).toMatchObject({ status: "failed", failureStage: "session" });
  expect(outcome.record.degradedReason?.length).toBeGreaterThan(0);
  // 请求已发出过 ⇒ 会话转录留有现场，但标记未完成
  expect(outcome.transcript?.complete ?? false).toBe(false);
});

test("会话超时 = failed/session（10 min 上界可注入）", async () => {
  const hangingFetch = ((_input: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      });
    })) as FetchFunction;
  const outcome = await runSkillPass(baseOptions({ fetch: hangingFetch, timeoutMs: 25 }));

  expect(outcome.record).toMatchObject({ status: "failed", failureStage: "session" });
  expect(String(outcome.record.degradedReason)).toContain("timed out");
});

test("工具回合：七工具经 executeTool 执行并回填，toolCallCount 记数", async () => {
  const executed: string[] = [];
  const script = scriptedFetch([
    {
      text: "let me look",
      toolCalls: [{ id: "call-1", name: "review_get_diff", arguments: {} }],
      usage: ZERO,
    },
    candidatesReply([candidate("S1", "sample-rule")]),
  ]);
  const outcome = await runSkillPass(
    baseOptions({ fetch: script.fetch, toolkit: stubToolkit(executed) }),
  );

  expect(executed).toEqual(["review.get_diff"]);
  expect(outcome.record).toMatchObject({ status: "ok", requestCount: 2, toolCallCount: 1 });
  const transcript = outcome.transcript;
  expect(transcript?.capture.messages.some((message) => message.role === "toolResult")).toBe(true);
});

test("ruleIds 首见序去重；非字符串 rule 忽略", async () => {
  const script = scriptedFetch([
    candidatesReply([
      candidate("S1", "alpha", 11),
      candidate("S2", "beta", 12),
      candidate("S3", "alpha", 13),
      candidate("S4", 42, 14),
    ]),
  ]);
  const outcome = await runSkillPass(baseOptions({ fetch: script.fetch }));
  expect(outcome.record.ruleIds).toEqual(["alpha", "beta"]);
});

// ADR-0014 验收 6：skill 会话可以有真实 pack 路径，但**主会话请求**不能有——
// 候选对象要进 Phase 6 请求，所以在这里把 pack 根换成占位符（原始措辞留在
// 本会话的独立转录里）。
test("候选文本里的 pack 根被净化成 <rule-skill>（含正斜杠写法，递归到数组/对象）", async () => {
  const raw = candidate("S1", "sample-rule");
  const script = scriptedFetch([
    candidatesReply([
      {
        ...raw,
        description: `Rule at ${PACK_ROOT}\\rules\\01-null-dereference.md is violated.`,
        evidence: [
          `${PACK_ROOT}/rules/02-resource-leak.md:3 close() is missing`,
          { file: `${PACK_ROOT}\\scripts\\filter_rules.py`, nested: [`${PACK_ROOT}\\x`] },
        ],
      },
    ]),
  ]);
  const outcome = await runSkillPass(baseOptions({ fetch: script.fetch }));

  const serialized = JSON.stringify(outcome.candidates);
  expect(serialized).not.toContain(PACK_ROOT);
  expect(serialized).not.toContain(PACK_ROOT.replaceAll("\\", "/"));
  // 数组与嵌套对象逐层净化
  expect(outcome.candidates[0]).toMatchObject({
    description: "Rule at <rule-skill>\\rules\\01-null-dereference.md is violated.",
    evidence: [
      "<rule-skill>/rules/02-resource-leak.md:3 close() is missing",
      { file: "<rule-skill>\\scripts\\filter_rules.py", nested: ["<rule-skill>\\x"] },
    ],
  });
  // 原始措辞不丢：独立转录里仍是未净化的原文（转录存的是模型回复字节，
  // 回复是 JSON，故 pack 根以转义形态出现）
  const reply = outcome.transcript?.capture.messages.filter((message) => message.role === "assistant").at(-1);
  if (reply === undefined) {
    throw new Error("expected an assistant reply in the transcript");
  }
  const replyText = (reply.content as { type: string; text?: string }[])
    .map((block) => block.text ?? "")
    .join("");
  expect(replyText).toContain(PACK_ROOT.replaceAll("\\", "\\\\"));
});
