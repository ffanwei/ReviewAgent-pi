import { expect, test } from "vitest";
import type { FetchFunction } from "@earendil-works/pi-ai";

import type { RetryPolicy } from "../shared/llm-retry.js";
import { createCandidateRepair } from "./candidate-repair.js";

// 有界一次性候选修复（P1 步骤 3）：只修信封字段，绝不编造证据；
// 调用失败 / 解析失败一律返回空数组，原候选继续走拦截链。

const NO_WAIT: RetryPolicy = {
  maxAttempts: 1,
  baseDelayMs: 0,
  maxDelayMs: 0,
  maxRetryAfterMs: 0,
};

function llm(fetch: FetchFunction): Parameters<typeof createCandidateRepair>[0] {
  return {
    baseUrl: "https://gw.example.com/v1",
    apiKey: "sk-repair-sentinel",
    modelId: "deepseek-v4-flash",
    timeoutMs: 5_000,
    retry: NO_WAIT,
    fetch,
  };
}

function completion(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("返回候选数组；提示词禁止编造证据且请求走结构化输出", async () => {
  const bodies: string[] = [];
  const fetch: FetchFunction = async (_url, init) => {
    bodies.push(String(init?.body ?? ""));
    return completion(
      JSON.stringify({
        candidates: [{ ...{}, id: "F001", severity: "P1", category: "CORRECTNESS" }],
      }),
    );
  };
  const repair = createCandidateRepair(llm(fetch));
  const candidates = await repair({ round: 1, candidates: [{ id: "F001" }] });

  expect(candidates).toHaveLength(1);
  const body = JSON.parse(bodies[0] ?? "{}") as {
    response_format?: { type?: string };
    messages?: { content?: string }[];
  };
  expect(body.response_format).toEqual({ type: "json_object" });
  const system = body.messages?.[0]?.content ?? "";
  expect(system).toContain("Do NOT invent evidence");
  expect(system).toContain("preserve the input id exactly");
  expect(system).not.toContain("sk-repair-sentinel");
});

test("HTTP 失败 → 空数组（不外溢到检视链）", async () => {
  const fetch: FetchFunction = async () => new Response("bad request", { status: 400 });
  const repair = createCandidateRepair(llm(fetch));
  await expect(repair({ round: 1, candidates: [{ id: "F001" }] })).resolves.toEqual([]);
});

test("回包不是合法 JSON → 空数组", async () => {
  const fetch: FetchFunction = async () => completion("not json at all");
  const repair = createCandidateRepair(llm(fetch));
  await expect(repair({ round: 1, candidates: [{ id: "F001" }] })).resolves.toEqual([]);
});

test("空候选集：不发请求", async () => {
  let calls = 0;
  const fetch: FetchFunction = async () => {
    calls += 1;
    return completion('{"candidates":[]}');
  };
  const repair = createCandidateRepair(llm(fetch));
  await expect(repair({ round: 1, candidates: [] })).resolves.toEqual([]);
  expect(calls).toBe(0);
});
