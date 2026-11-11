import { join } from "node:path";

import { expect, test } from "vitest";

import { auditPathOf, buildTraceSession } from "./trace-export.js";

/** opencode-trace 兼容导出（ADR-0074）纯函数面：映射 + 合成 + 路径变换 */

test("auditPathOf：runs/…/session-<runId>.json → audit/…/<runId>.json", () => {
  expect(auditPathOf(join("C:", "t", "t1", "runs", "session-20261111_000000_000.json"))).toBe(
    join("C:", "t", "t1", "audit", "20261111_000000_000.json"),
  );
  expect(
    auditPathOf(join("C:", "t", "t1", "runs", "shards", "attempt-x", "s02", "session-20261111_111111_111.json")),
  ).toBe(join("C:", "t", "t1", "audit", "shards", "attempt-x", "s02", "20261111_111111_111.json"));
});

test("buildTraceSession：records 数 = requests 数；request.body = wireBody 原文；response 合成", () => {
  const transcript = {
    info: {
      id: "session-20261111_000000_000",
      title: "case",
      model: { id: "deepseek-v4-flash", baseUrl: "https://api.example.com/v1" },
      time: { created: 1000, updated: 2000 },
    },
    messages: [
      { role: "system", content: "SYS" },
      { role: "user", content: "diff...", timestamp: 1000 },
      {
        role: "assistant",
        timestamp: 2000,
        model: "deepseek-v4-flash",
        responseId: "resp-1",
        stopReason: "toolUse",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "toolCall", id: "call-1", name: "review_get_file", arguments: { path: "a.ts" } },
        ],
        usage: { input: 100, output: 20, cacheRead: 500, cacheWrite: 0 },
      },
      { role: "user", content: "phase1", timestamp: 3000 },
      {
        role: "assistant",
        timestamp: 4000,
        model: "deepseek-v4-flash",
        responseId: "resp-2",
        stopReason: "stop",
        content: [{ type: "text", text: "no issues" }],
        usage: { input: 120, output: 30, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  };
  const audit = {
    model: "deepseek-v4-flash",
    requests: [
      { model: "deepseek-v4-flash", effort: "medium", messages: [], tools: [], wireBody: '{"model":"deepseek-v4-flash","messages":[]}' },
      { model: "deepseek-v4-flash", effort: "medium", messages: [], tools: [], wireBody: '{"model":"deepseek-v4-flash","messages":[{"role":"user"}]}' },
    ],
  };

  const session = buildTraceSession(transcript, audit);
  expect(session.metadata.sessionId).toBe("session-20261111_000000_000");
  expect(session.metadata.title).toBe("case");
  expect(session.records).toHaveLength(2);

  const first = session.records[0]!;
  expect(first.id).toBe(1);
  expect(first.purpose).toBe("chat.completion");
  expect(first.request.body).toEqual({ model: "deepseek-v4-flash", messages: [] });
  const message = (first.response!.body as { choices: { message: Record<string, unknown> }[] }).choices[0]!
    .message;
  // thinking → reasoning_content；toolCall → tool_calls；无 text → 无 content
  expect(message["reasoning_content"]).toBe("hmm");
  expect("content" in message).toBe(false);
  expect(message["tool_calls"]).toHaveLength(1);
  expect(((first.response!.body as { choices: { finish_reason: string }[] }).choices[0]!).finish_reason).toBe(
    "tool_calls",
  );

  const second = session.records[1]!;
  const secondMessage = (second.response!.body as { choices: { message: Record<string, unknown> }[] }).choices[0]!
    .message;
  expect(secondMessage["content"]).toBe("no issues");
  expect("tool_calls" in secondMessage).toBe(false);
});