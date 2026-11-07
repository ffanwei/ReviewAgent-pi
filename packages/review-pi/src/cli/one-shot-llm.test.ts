import { expect, test } from "vitest";
import type { FetchFunction } from "@earendil-works/pi-ai";

import type { RetryPolicy } from "../shared/llm-retry.js";
import { completeOneShot } from "./one-shot-llm.js";

// ADR-0051：CLI 自有一次性调用（片级报文 / 收尾总结）的重试与分类。
// 纪律：每次尝试独立超时；只有结构化可重试信号才重放；失败收敛为 ok:false，绝不抛出。

const NO_WAIT: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 0,
  maxDelayMs: 0,
  maxRetryAfterMs: 30_000,
};

const BASE_INPUT = {
  baseUrl: "https://gw.example.com/v1",
  apiKey: "sk-oneshot-sentinel",
  modelId: "deepseek-v4-flash",
  system: "system",
  user: "user",
  timeoutMs: 5_000,
  retry: NO_WAIT,
} as const;

function completion(content: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function scripted(handler: (request: number) => Response | Promise<Response>): {
  fetch: FetchFunction;
  count: () => number;
} {
  let requests = 0;
  const fetch: FetchFunction = async () => {
    requests += 1;
    return handler(requests);
  };
  return { fetch, count: () => requests };
}

test("首次成功：一次请求，返回文本", async () => {
  const { fetch, count } = scripted(() => completion("hello"));
  const result = await completeOneShot({ ...BASE_INPUT, fetch });
  expect(result).toEqual({ ok: true, text: "hello" });
  expect(count()).toBe(1);
});

test("可重试的 5xx：前两次失败后成功 → 共 3 次尝试", async () => {
  const { fetch, count } = scripted((request) =>
    request < 3 ? new Response("upstream down", { status: 503 }) : completion("recovered"),
  );
  const result = await completeOneShot({ ...BASE_INPUT, fetch });
  expect(result).toEqual({ ok: true, text: "recovered" });
  expect(count()).toBe(3);
});

test("重试耗尽：返回人话原因并标注尝试次数（不抛错）", async () => {
  const { fetch, count } = scripted(() => new Response("boom", { status: 502 }));
  const result = await completeOneShot({ ...BASE_INPUT, fetch });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toContain("HTTP 502");
    expect(result.reason).toContain("after 3 attempts");
  }
  expect(count()).toBe(3);
});

test("不可重试的 4xx（400）：只发一次", async () => {
  const { fetch, count } = scripted(() => new Response("bad request", { status: 400 }));
  const result = await completeOneShot({ ...BASE_INPUT, fetch });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toContain("HTTP 400");
    expect(result.reason).not.toContain("after");
  }
  expect(count()).toBe(1);
});

test("配额类 429（余额 / 额度）：不重试", async () => {
  const { fetch, count } = scripted(
    () =>
      new Response('{"error":{"message":"insufficient_quota: balance exhausted"}}', {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
  );
  const result = await completeOneShot({ ...BASE_INPUT, fetch });
  expect(result.ok).toBe(false);
  expect(count()).toBe(1);
});

test("Retry-After 超过上限：不重试（避免把一次失败拖成几分钟）", async () => {
  const { fetch, count } = scripted(
    () => new Response("slow down", { status: 429, headers: { "retry-after": "120" } }),
  );
  const result = await completeOneShot({ ...BASE_INPUT, fetch });
  expect(result.ok).toBe(false);
  expect(count()).toBe(1);
});

test("空 completion：确定性非法输出，不重试", async () => {
  const { fetch, count } = scripted(() => completion("   "));
  const result = await completeOneShot({ ...BASE_INPUT, fetch });
  // 空串仍是合法 content → 调用方（summary）自行按空串降级；这里只断言不放大请求
  expect(result).toEqual({ ok: true, text: "   " });
  expect(count()).toBe(1);
});

test("非法 JSON：确定性输出问题，不重试", async () => {
  const { fetch, count } = scripted(() => new Response("这不是 JSON", { status: 200 }));
  const result = await completeOneShot({ ...BASE_INPUT, fetch });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toContain("not valid JSON");
  }
  expect(count()).toBe(1);
});

test("缺 content：确定性输出问题，不重试", async () => {
  const { fetch, count } = scripted(
    () => new Response(JSON.stringify({ choices: [{ message: {} }] }), { status: 200 }),
  );
  const result = await completeOneShot({ ...BASE_INPUT, fetch });
  expect(result.ok).toBe(false);
  expect(count()).toBe(1);
});

test("传输异常 → 重试后成功", async () => {
  const { fetch, count } = scripted((request) => {
    if (request === 1) {
      throw new TypeError("fetch failed");
    }
    return completion("ok");
  });
  const result = await completeOneShot({ ...BASE_INPUT, fetch });
  expect(result).toEqual({ ok: true, text: "ok" });
  expect(count()).toBe(2);
});

test("分段 content 数组：取 text 块拼接", async () => {
  const { fetch } = scripted(() =>
    completion([
      { type: "text", text: "line one" },
      { type: "text", text: "line two" },
    ]),
  );
  const result = await completeOneShot({ ...BASE_INPUT, fetch });
  expect(result).toEqual({ ok: true, text: "line one\nline two" });
});

test("结构化输出：请求体带 response_format，未声明时绝不带", async () => {
  const bodies: string[] = [];
  const fetch: FetchFunction = async (_url, init) => {
    bodies.push(String(init?.body ?? ""));
    return completion("{}");
  };
  await completeOneShot({ ...BASE_INPUT, fetch, responseFormat: "json_object" });
  expect(JSON.parse(bodies[0] ?? "{}")).toMatchObject({ response_format: { type: "json_object" } });

  await completeOneShot({ ...BASE_INPUT, fetch });
  expect(JSON.parse(bodies[1] ?? "{}")).not.toHaveProperty("response_format");
});

test("结构化输出不被支持（400）：去掉 response_format 重试一次并成功", async () => {
  const bodies: string[] = [];
  const fetch: FetchFunction = async (_url, init) => {
    const body = String(init?.body ?? "");
    bodies.push(body);
    return JSON.parse(body).response_format !== undefined
      ? new Response("response_format unsupported", { status: 400 })
      : completion("recovered");
  };
  const result = await completeOneShot({ ...BASE_INPUT, fetch, responseFormat: "json_object" });
  expect(result).toEqual({ ok: true, text: "recovered" });
  expect(bodies).toHaveLength(2);
  expect(JSON.parse(bodies[1] ?? "{}")).not.toHaveProperty("response_format");
});
