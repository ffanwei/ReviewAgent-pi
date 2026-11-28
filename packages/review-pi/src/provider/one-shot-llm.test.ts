import { expect, test, afterEach } from "vitest";
import type { FetchFunction } from "@earendil-works/pi-ai";

import type { RetryPolicy } from "../shared/llm-retry.js";
import {
  completeOneShot,
  setOneShotUsageSink,
  type OneShotCallSample,
} from "./one-shot-llm.js";

// ADR-0051：核外一次性调用（片级报文 / 收尾总结）的重试与分类。
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

test("空 completion：按 F-17 重试一次，仍空则原样返回", async () => {
  const { fetch, count } = scripted(() => completion("   "));
  const result = await completeOneShot({ ...BASE_INPUT, fetch });
  expect(result).toEqual({ ok: true, text: "   " });
  expect(count()).toBe(2);
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

test("json_schema：请求体原样带 schema；未声明时绝不带", async () => {
  const bodies: string[] = [];
  const fetch: FetchFunction = async (_url, init) => {
    bodies.push(String(init?.body ?? ""));
    return completion("{}");
  };
  const responseFormat = {
    type: "json_schema" as const,
    json_schema: {
      name: "verdicts",
      strict: true,
      schema: {
        type: "object",
        required: ["verdicts"],
        properties: { verdicts: { type: "array" } },
      },
    },
  };
  await completeOneShot({ ...BASE_INPUT, fetch, responseFormat });
  expect(JSON.parse(bodies[0] ?? "{}")).toMatchObject({ response_format: responseFormat });
  expect(bodies[0] ?? "").not.toContain("sk-oneshot-sentinel");
});

test("json_schema 被拒（400）→ json_object 再拒（400）→ 无 response_format 成功", async () => {
  const kinds: string[] = [];
  const fetch: FetchFunction = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      response_format?: { type?: string };
    };
    kinds.push(body.response_format?.type ?? "none");
    return body.response_format === undefined
      ? completion("recovered")
      : new Response("unsupported response_format", { status: 400 });
  };
  const result = await completeOneShot({
    ...BASE_INPUT,
    fetch,
    responseFormat: {
      type: "json_schema",
      json_schema: { name: "verdicts", schema: { type: "object" } },
    },
  });
  expect(result).toEqual({ ok: true, text: "recovered" });
  expect(kinds).toEqual(["json_schema", "json_object", "none"]);
});

test("json_schema 被拒（400）→ json_object 成功：只降一档，不丢结构化提示", async () => {
  const kinds: string[] = [];
  const fetch: FetchFunction = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      response_format?: { type?: string };
    };
    kinds.push(body.response_format?.type ?? "none");
    return body.response_format?.type === "json_object"
      ? completion("recovered")
      : new Response("unsupported schema", { status: 400 });
  };
  const result = await completeOneShot({
    ...BASE_INPUT,
    fetch,
    responseFormat: {
      type: "json_schema",
      json_schema: { name: "verdicts", schema: { type: "object" } },
    },
  });
  expect(result).toEqual({ ok: true, text: "recovered" });
  expect(kinds).toEqual(["json_schema", "json_object"]);
});

test("json_schema 遇非 400/422 失败：不降级，避免掩盖坏请求", async () => {
  let calls = 0;
  const fetch: FetchFunction = async () => {
    calls += 1;
    return new Response("forbidden", { status: 403 });
  };
  const result = await completeOneShot({
    ...BASE_INPUT,
    fetch,
    responseFormat: {
      type: "json_schema",
      json_schema: { name: "verdicts", schema: { type: "object" } },
    },
  });
  expect(result.ok).toBe(false);
  expect(calls).toBe(1);
});

// ---- usage 解析与进程级观测（ADR-0066 的整任务账本数据面） ----

afterEach(() => {
  setOneShotUsageSink(null);
});

function completionWithUsage(content: string, usage: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content } }],
      usage,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

test("响应 usage：折算为未命中输入 / 输出 / 缓读 / 缓写，并进入结果", async () => {
  const { fetch } = scripted(() =>
    completionWithUsage("ok", {
      prompt_tokens: 100,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 },
    }),
  );
  const result = await completeOneShot({ ...BASE_INPUT, fetch, purpose: "tips" });
  expect(result).toEqual({
    ok: true,
    text: "ok",
    usage: {
      inputTokens: 50,
      outputTokens: 20,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
    },
  });
});

test("usage sink：成功调用记样本；无 usage 仍计调用；失败尝试不记样本", async () => {
  const samples: OneShotCallSample[] = [];
  setOneShotUsageSink((sample) => samples.push(sample));

  const withUsage = scripted(() =>
    completionWithUsage("ok", {
      prompt_tokens: 10,
      completion_tokens: 2,
      prompt_cache_hit_tokens: 3,
    }),
  );
  await completeOneShot({ ...BASE_INPUT, fetch: withUsage.fetch, purpose: "summary" });

  const withoutUsage = scripted(() => completion("ok"));
  await completeOneShot({ ...BASE_INPUT, fetch: withoutUsage.fetch, purpose: "candidate-repair" });

  const failing = scripted(() => new Response("boom", { status: 500 }));
  await completeOneShot({ ...BASE_INPUT, fetch: failing.fetch });

  expect(samples).toHaveLength(2);
  expect(samples[0]).toEqual({
    modelId: BASE_INPUT.modelId,
    purpose: "summary",
    usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 3 },
  });
  expect(samples[1]).toEqual({
    modelId: BASE_INPUT.modelId,
    purpose: "candidate-repair",
  });
});

test("finish_reason 与 reasoning_tokens：透传到结果（供截断判定与观测）", async () => {
  const fetch: FetchFunction = async () =>
    new Response(
      JSON.stringify({
        choices: [
          { message: { role: "assistant", content: "partial" }, finish_reason: "length" },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          completion_tokens_details: { reasoning_tokens: 4 },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  const result = await completeOneShot({
    ...BASE_INPUT,
    fetch,
    purpose: "summary",
    retryOnTruncation: false,
  });
  expect(result).toEqual({
    ok: true,
    text: "partial",
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
    finishReason: "length",
    reasoningTokens: 4,
  });
});

test("回包未带 finish_reason / reasoning_tokens：结果不出现这两个键（不虚增字段）", async () => {
  const { fetch } = scripted(() => completion("plain"));
  const result = await completeOneShot({ ...BASE_INPUT, fetch });
  expect(result).toEqual({ ok: true, text: "plain" });
});

test("F-17：空 content 触发一次翻倍预算重试，usage 相加", async () => {
  const { fetch, count } = scripted((request) =>
    request === 1
      ? new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "" }, finish_reason: "length" }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      : new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 20, completion_tokens: 7 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
  );
  const result = await completeOneShot({ ...BASE_INPUT, fetch, maxTokens: 1_024 });
  expect(count()).toBe(2);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.text).toBe("ok");
    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 12 });
  }
});

test("F-17：retryOnTruncation=false 时不追加请求", async () => {
  const { fetch, count } = scripted(() =>
    new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "" }, finish_reason: "length" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  const result = await completeOneShot({ ...BASE_INPUT, fetch, retryOnTruncation: false });
  expect(count()).toBe(1);
  expect(result).toEqual({ ok: true, text: "", finishReason: "length" });
});
