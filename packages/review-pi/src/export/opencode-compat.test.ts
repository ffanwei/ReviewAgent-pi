import { expect, test } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import {
  buildOpenCodeSession,
  providerIdFromBaseUrl,
  type OpenCodeAssistantMessage,
  type OpenCodeToolPart,
} from "./opencode-compat.js";
import type { TranscriptInfo } from "./transcript.js";

/**
 * OpenCode 兼容会话归一化（ADR-0072）纯函数面：
 * - `info` 恰好 10 键、`runId` 剥除、`cost` 拍平、`providerID`/`variant` 填齐；
 * - 消息 id 确定性 `msg_m` 前缀、跨会话唯一；
 * - `finish` `toolUse → tool-calls`；工具 part `executed:false`、`metadata:{}`、
 *   `error.type` 补齐；**全文档无 `null`**（import-clean 的铁律）。
 */

function makeInfo(overrides: Partial<TranscriptInfo> = {}): TranscriptInfo {
  return {
    id: "session-20261111_000000_000",
    runId: "20261111_000000_000",
    agent: "review",
    model: { id: "deepseek-v4-flash", baseUrl: "https://api.deepseek.com/v1" },
    tokens: { input: 5, output: 7, reasoning: 3, cache: { read: 2, write: 1 } },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1.25 },
    outcome: "succeeded",
    time: { created: 1000, updated: 9000 },
    title: "case-1",
    location: { directory: "D:/repo" },
    ...overrides,
  };
}

/** 造一条 assistant（宽松面：只填归一化读到的字段） */
function assistant(content: readonly unknown[], extra: Record<string, unknown> = {}): AgentMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    usage: {
      input: 5,
      output: 7,
      cacheRead: 2,
      cacheWrite: 1,
      reasoning: 3,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1.25 },
    },
    stopReason: "toolUse",
    timestamp: 2000,
    ...extra,
  } as unknown as AgentMessage;
}

test("归一化：info 10 键 + 消息 id 确定性 + 无 null + finish/tool 补齐", () => {
  const messages = [
    { role: "user", content: "hello", timestamp: 1500 },
    assistant(
      [
        { type: "thinking", thinking: "hmm", signature: "sig" },
        { type: "toolCall", id: "call-err", name: "review_bogus", arguments: { foo: "bar" } },
        { type: "text", text: "done" },
      ],
      { responseId: "resp-1", rawStopReason: "tool_calls" },
    ),
    {
      role: "toolResult",
      toolCallId: "call-err",
      toolName: "review_bogus",
      content: [{ type: "text", text: "Tool not found" }],
      details: {},
      isError: true,
      timestamp: 3000,
    },
  ] as unknown as readonly AgentMessage[];

  const session = buildOpenCodeSession({ info: makeInfo(), systemPrompt: "SYS", messages });

  // info：恰好 OpenCode 10 键（无 runId），cost 拍平成数字，model 填齐 providerID/variant
  expect(Object.keys(session.info)).toEqual([
    "id",
    "projectID",
    "agent",
    "model",
    "cost",
    "tokens",
    "outcome",
    "time",
    "title",
    "location",
  ]);
  expect(session.info.id).toBe("session-20261111_000000_000");
  expect(session.info.cost).toBe(1.25);
  expect(session.info.model).toEqual({
    id: "deepseek-v4-flash",
    providerID: "deepseek",
    variant: "default",
  });
  // projectID = sha1(location.directory)，稳定非空
  expect(session.info.projectID).toMatch(/^[0-9a-f]{40}$/);

  // 消息序列：system + user + assistant（toolResult 不另立）
  expect(session.messages.map((message) => message.type)).toEqual(["system", "user", "assistant"]);

  // 全文档无 null（import-clean 铁律）
  expect(JSON.stringify(session)).not.toContain(":null");

  // 消息 id：msg_m 前缀、确定性、唯一
  const ids = session.messages.map((message) => message.id);
  for (const id of ids) {
    expect(id).toMatch(/^msg_m[0-9a-f]{19}$/);
  }
  expect(new Set(ids).size).toBe(ids.length);

  // assistant：finish 归一 + variant 补 default + streamed/completed 合成
  const assistantMessage = session.messages[2] as OpenCodeAssistantMessage;
  expect(assistantMessage.finish).toBe("tool-calls");
  expect(assistantMessage.rawFinish).toBe("tool_calls");
  expect(assistantMessage.model).toEqual({
    id: "deepseek-v4-flash",
    providerID: "deepseek",
    variant: "default",
  });
  expect(assistantMessage.time).toEqual({ created: 2000, streamed: 2001, completed: 2002 });

  // tool part：executed:false、metadata:{}、error.type 补齐、reasoning 时间合成
  const toolPart = assistantMessage.content.find((part): part is OpenCodeToolPart => part.type === "tool");
  expect(toolPart).toBeDefined();
  expect(toolPart!.executed).toBe(false);
  expect(toolPart!.state.status).toBe("error");
  expect(toolPart!.state.metadata).toEqual({});
  expect(toolPart!.state.error).toEqual({ type: "tool.execution", message: "Tool not found" });
});

test("子会话：seedCount 只写增量（丢弃种子前缀）", () => {
  const messages = [
    { role: "user", content: "seed-1", timestamp: 100 },
    assistant([{ type: "text", text: "seed-2" }], { timestamp: 200 }),
    { role: "user", content: "new-1", timestamp: 300 },
    assistant([{ type: "text", text: "new-2" }], { timestamp: 400 }),
  ] as unknown as readonly AgentMessage[];

  const session = buildOpenCodeSession({
    info: makeInfo({ id: "session-20261111_000000_000-skill-a-r1" }),
    systemPrompt: "SYS",
    messages,
    parentID: "session-20261111_000000_000",
    seedCount: 2,
  });

  // 丢弃 2 条种子：只剩 system + 2 条增量；parentID 带到 info
  expect(session.messages.map((message) => message.type)).toEqual(["system", "user", "assistant"]);
  expect(session.info.parentID).toBe("session-20261111_000000_000");
  expect((session.messages[1] as { text: string }).text).toBe("new-1");
});

test("父会话：subagents 追加到末条 assistant 的 tool part", () => {
  const messages = [
    { role: "user", content: "hi", timestamp: 100 },
    assistant([{ type: "text", text: "done" }], { timestamp: 200, stopReason: "stop" }),
  ] as unknown as readonly AgentMessage[];

  const session = buildOpenCodeSession({
    info: makeInfo(),
    systemPrompt: "SYS",
    messages,
    subagents: [{ sessionID: "session-20261111_000000_000-skill-a-r1", description: "a (round 1)" }],
  });

  const last = session.messages.at(-1) as OpenCodeAssistantMessage;
  expect(last.type).toBe("assistant");
  const subagent = last.content.at(-1) as OpenCodeToolPart;
  expect(subagent.type).toBe("tool");
  expect(subagent.name).toBe("subagent");
  expect(subagent.state.metadata).toEqual({ sessionID: "session-20261111_000000_000-skill-a-r1" });
  expect(subagent.state.content[0]?.text).toContain('sessionID="session-20261111_000000_000-skill-a-r1"');
});

test("providerIdFromBaseUrl：host 映射 + custom 兜底", () => {
  expect(providerIdFromBaseUrl("https://api.deepseek.com/v1")).toBe("deepseek");
  expect(providerIdFromBaseUrl("https://gateway.example.com/x")).toBe("custom");
});

test("outcome 归一：truncated → succeeded（OpenCode 枚举无 truncated），failed 保留", () => {
  const messages = [{ role: "user", content: "hi", timestamp: 100 }] as unknown as readonly AgentMessage[];
  const truncated = buildOpenCodeSession({
    info: makeInfo({ outcome: "truncated" }),
    systemPrompt: "SYS",
    messages,
  });
  expect(truncated.info.outcome).toBe("succeeded");
  const failed = buildOpenCodeSession({
    info: makeInfo({ outcome: "failed" }),
    systemPrompt: "SYS",
    messages,
  });
  expect(failed.info.outcome).toBe("failed");
});
