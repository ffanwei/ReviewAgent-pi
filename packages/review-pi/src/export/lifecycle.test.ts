import { expect, test } from "vitest";

import type { TaskCallTrace } from "../mcp/report.js";
import type { OneShotLifecycleEvent } from "../shared/one-shot-llm.js";
import { buildLifecycleSession, LifecycleCollector } from "./lifecycle.js";
import type { OpenCodeInfo, OpenCodeMessage } from "./opencode-compat.js";

/** 会话生命周期留痕（ADR-0073）纯组装面：顺序、形态、失败照记、无 null、id 唯一 */

function info(): OpenCodeInfo {
  return {
    id: "session-20261111_000000_000",
    projectID: "p",
    agent: "review",
    model: { id: "deepseek-v4-flash", providerID: "deepseek", variant: "default" },
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    outcome: "succeeded",
    time: { created: 100, updated: 200 },
    title: "case",
    location: { directory: "D:/repo" },
  };
}

function taskTrace(
  tool: string,
  args: unknown,
  startedAt: number,
  overrides: Partial<TaskCallTrace> = {},
): TaskCallTrace {
  return {
    tool,
    arguments: args,
    startedAt,
    durationMs: 10,
    ok: true,
    ...(tool === "mrReviewResult" || tool === "saveReviewSummary"
      ? { responseText: "server ok" }
      : {}),
    ...overrides,
  };
}

function oneShot(
  purpose: OneShotLifecycleEvent["purpose"],
  system: string,
  user: string,
  response: string | undefined,
  startedAt: number,
): OneShotLifecycleEvent {
  return response === undefined
    ? { purpose, system, user, error: "boom", startedAt }
    : { purpose, system, user, response, startedAt, usage: { inputTokens: 4, outputTokens: 3 } };
}

test("buildLifecycleSession：startTask → 对话 → one-shot → MCP tool → endTask 的顺序与形态", () => {
  const i = info();
  const base: OpenCodeMessage[] = [
    { id: "msg_base1", type: "user", text: "hello", files: [], agents: [], time: { created: 500 } },
  ];
  const session = buildLifecycleSession({
    info: i,
    baseMessages: base,
    events: [
      { kind: "task", seq: 0, trace: taskTrace("startTask", { taskId: "t" }, 1000) },
      { kind: "one-shot", seq: 1, event: oneShot("tips", "SYS", "USR", "OUTPUT", 2000) },
      { kind: "task", seq: 2, trace: taskTrace("mrReviewResult", { filePath: "a" }, 3000) },
      { kind: "task", seq: 3, trace: taskTrace("endTask", { taskId: "t" }, 4000) },
    ],
    subagents: [],
  });

  expect(session.messages.map((message) => message.type)).toEqual([
    "system", // startTask
    "user", // base 对话
    "user", // one-shot user
    "assistant", // one-shot assistant
    "assistant", // mrReviewResult tool carrier
    "system", // endTask
  ]);

  const start = session.messages[0] as { text: string };
  expect(start.text).toContain("startTask");
  const oneShotUserMessage = session.messages[2] as { text: string };
  expect(oneShotUserMessage.text).toContain("SYS");
  expect(oneShotUserMessage.text).toContain("USR");
  const oneShotAssistant = session.messages[3] as {
    content: { text: string }[];
    finish: string;
  };
  expect(oneShotAssistant.content[0]?.text).toBe("OUTPUT");
  expect(oneShotAssistant.finish).toBe("stop");
  const mcpCarrier = session.messages[4] as { content: { type: string; name?: string }[] };
  expect(mcpCarrier.content[0]?.name).toBe("mrReviewResult");
  const end = session.messages[5] as { text: string };
  expect(end.text).toContain("endTask");

  expect(JSON.stringify(session)).not.toContain(":null");
  const ids = session.messages.map((message) => message.id);
  expect(new Set(ids).size).toBe(ids.length);
  // 生命周期生成的 id 都是 msg_m + 19 hex；base 对话的 id 原样透传
  expect(session.messages[1]?.id).toBe("msg_base1");
  for (const [index, id] of ids.entries()) {
    if (index !== 1) {
      expect(id).toMatch(/^msg_m[0-9a-f]{19}$/);
    }
  }
});

test("失败照记：one-shot error → assistant finish error；MCP tool 失败 → tool status error", () => {
  const session = buildLifecycleSession({
    info: info(),
    baseMessages: [],
    events: [
      { kind: "one-shot", seq: 0, event: oneShot("summary", "S", "U", undefined, 1000) },
      { kind: "task", seq: 1, trace: taskTrace("saveReviewSummary", { markdownContent: "x" }, 2000, { ok: false, reason: "rejected", responseText: undefined }) },
    ],
    subagents: [],
  });

  const failedAssistant = session.messages[1] as { finish: string };
  expect(failedAssistant.finish).toBe("error");
  const failedTool = session.messages[2] as {
    content: { state: { status: string; error?: { message: string } } }[];
  };
  expect(failedTool.content[0]?.state.status).toBe("error");
  expect(failedTool.content[0]?.state.error?.message).toBe("rejected");
});

test("LifecycleCollector：按发生顺序单调 seq", () => {
  const collector = new LifecycleCollector();
  collector.recordTask(taskTrace("startTask", {}, 1));
  collector.recordOneShot(oneShot("tips", "S", "U", "R", 2));
  collector.recordTask(taskTrace("endTask", {}, 3));
  const events = collector.snapshot();
  expect(events.map((event) => event.seq)).toEqual([0, 1, 2]);
  expect(events.map((event) => event.kind)).toEqual(["task", "one-shot", "task"]);
});