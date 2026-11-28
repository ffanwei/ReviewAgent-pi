import { expect, test } from "vitest";
import type { FetchFunction } from "@earendil-works/pi-ai";

import type { RetryPolicy } from "../shared/llm-retry.js";
import { invokeStructured, type StructuredCall, type StructuredParse } from "./structured-reply.js";

const NO_WAIT: RetryPolicy = {
  maxAttempts: 1,
  baseDelayMs: 0,
  maxDelayMs: 0,
  maxRetryAfterMs: 0,
};

function completion(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function llm(fetch: FetchFunction) {
  return {
    baseUrl: "https://gw.example.com/v1",
    apiKey: "sk-structured-sentinel",
    modelId: "deepseek-v4-flash",
    timeoutMs: 5_000,
    retry: NO_WAIT,
    fetch,
  };
}

function parseText(text: string): StructuredParse<string> {
  return text === "good"
    ? { ok: true, value: text }
    : { ok: false, failure: { kind: "schema", note: "expected good" } };
}

const CALL: StructuredCall<string> = {
  parse: parseText,
  maxRepairAttempts: 1,
};

test("解析成功：一次调用，不触发修复", async () => {
  let calls = 0;
  const fetch: FetchFunction = async () => {
    calls += 1;
    return completion("good");
  };
  const outcome = await invokeStructured({
    llm: llm(fetch),
    purpose: "coverage-repair",
    system: "system",
    user: "user",
    call: CALL,
  });
  expect(outcome).toMatchObject({ ok: true, value: "good", attempts: 1, recoveries: [] });
  expect(calls).toBe(1);
});

test("解析失败：有界重发一次，修复提示带畸形回包；成功后 attempts=2", async () => {
  const bodies: string[] = [];
  const fetch: FetchFunction = async (_url, init) => {
    bodies.push(String(init?.body ?? ""));
    return bodies.length === 1 ? completion("bad") : completion("good");
  };
  const outcome = await invokeStructured({
    llm: llm(fetch),
    purpose: "coverage-repair",
    system: "system",
    user: "original-user",
    call: CALL,
  });
  expect(outcome).toMatchObject({ ok: true, value: "good", attempts: 2, recoveries: ["repair"] });
  expect(bodies).toHaveLength(2);
  const repair = JSON.parse(bodies[1] ?? "{}") as { messages?: { content?: string }[] };
  expect(repair.messages?.[1]?.content ?? "").toContain("original-user");
  expect(repair.messages?.[1]?.content ?? "").toContain("bad");
  expect(repair.messages?.[1]?.content ?? "").toContain("expected good");
  expect(bodies[0] ?? "").not.toContain("sk-structured-sentinel");
  expect(bodies[1] ?? "").not.toContain("sk-structured-sentinel");
});

test("修复后仍不可解析：返回失败，不无限重试", async () => {
  let calls = 0;
  const fetch: FetchFunction = async () => {
    calls += 1;
    return completion("bad");
  };
  const outcome = await invokeStructured({
    llm: llm(fetch),
    purpose: "coverage-repair",
    system: "system",
    user: "user",
    call: CALL,
  });
  expect(outcome).toMatchObject({
    ok: false,
    failure: { kind: "schema", note: "expected good" },
    attempts: 2,
    recoveries: ["repair"],
  });
  expect(calls).toBe(2);
});

test("maxRepairAttempts=0：只调用一次，失败原样返回", async () => {
  let calls = 0;
  const fetch: FetchFunction = async () => {
    calls += 1;
    return completion("bad");
  };
  const outcome = await invokeStructured({
    llm: llm(fetch),
    purpose: "coverage-repair",
    system: "system",
    user: "user",
    call: { parse: parseText, maxRepairAttempts: 0 },
  });
  expect(outcome).toMatchObject({ ok: false, attempts: 1, recoveries: [] });
  expect(calls).toBe(1);
});

test("传输失败：不进入修复层，返回 transport", async () => {
  let calls = 0;
  const fetch: FetchFunction = async () => {
    calls += 1;
    return new Response("boom", { status: 500 });
  };
  const outcome = await invokeStructured({
    llm: llm(fetch),
    purpose: "coverage-repair",
    system: "system",
    user: "user",
    call: CALL,
  });
  expect(outcome).toMatchObject({ ok: false, failure: { kind: "transport" }, attempts: 1 });
  expect(calls).toBe(1);
});

test("自定义 repairUser / repairSystem 覆盖默认修复提示", async () => {
  const bodies: string[] = [];
  const fetch: FetchFunction = async (_url, init) => {
    bodies.push(String(init?.body ?? ""));
    return bodies.length === 1 ? completion("bad") : completion("good");
  };
  const outcome = await invokeStructured({
    llm: llm(fetch),
    purpose: "coverage-repair",
    system: "original-system",
    user: "original-user",
    call: {
      parse: parseText,
      maxRepairAttempts: 1,
      repairSystem: "repair-system",
      repairUser: (raw, failure) => `repair:${failure.note}:${raw}`,
    },
  });
  expect(outcome.ok).toBe(true);
  const repair = JSON.parse(bodies[1] ?? "{}") as {
    messages?: { content?: string }[];
  };
  expect(repair.messages?.[0]?.content).toBe("repair-system");
  expect(repair.messages?.[1]?.content).toBe("repair:expected good:bad");
});
