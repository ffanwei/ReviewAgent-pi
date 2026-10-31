import { expect, test, vi } from "vitest";
import type { Context, UserMessage } from "@review-agent-pi/pi-ai";
import { fakeFetch } from "./fake-fetch.js";
import {
  GATEWAY_MAX_TOKENS,
  LOCKED_EFFORT_LABEL,
  REVIEW_MODEL_ID,
  assistantText,
  maxTokensFor,
  runReviewTurn,
} from "./pi-client.js";

// pi-ai 序列化缝（内核变量面）：真 provider + 真 SDK 序列化路径 + fake 传输适配器。
// wireBody = onPayload 序列化点捕获的请求原文（审计 requests[].wireBody 真源）。
// 请求面对齐 DSH deepseek 画像：官方直连不传 max_tokens（t 系列审计 wireBody 无此键）；
// 网关档例外——显式发送输出预算，避免继承网关请求默认值（实测 2048 静默截断）。
// 锁档纪律（DSH 线 ADR-0002）：审计 effort 标签 "default"，线上档位 reasoning_effort "high"。
// 零网络纪律：全链只经注入的 fetch；globalThis.fetch 被替换为抛错探针仍全程可用。

const API_KEY = "offline-test";

function user(text: string): UserMessage {
  return { role: "user", content: text, timestamp: 0 };
}

const BASE_CONTEXT: Context = {
  systemPrompt: "You are the reviewer.",
  messages: [user("Review the diff.")],
};

test("runReviewTurn：onPayload 序列化点捕获 wireBody 原文（模型 / 锁档 effort / 无 max_tokens / 无 tools）", async () => {
  const script = fakeFetch([
    { text: '{"summary":"ok"}', usage: { promptTokens: 100, completionTokens: 20, cacheReadTokens: 40 } },
  ]);
  const { message, wire } = await runReviewTurn({
    context: BASE_CONTEXT,
    apiKey: API_KEY,
    fetch: script.fetch,
  });

  expect(message.stopReason).toBe("stop");

  const parsed = JSON.parse(wire.wireBody) as Record<string, unknown>;
  expect(parsed.model).toBe("deepseek-v4-flash");
  expect(parsed.messages).toEqual([
    { role: "system", content: "You are the reviewer." },
    { role: "user", content: "Review the diff." },
  ]);
  expect(parsed.thinking).toEqual({ type: "enabled" });
  expect(parsed.reasoning_effort).toBe("high");
  expect(parsed.stream).toBe(true);
  // DSH deepseek 画像不传 max_tokens（t 系列审计 wireBody 无此键）；本用例无工具。
  expect("max_tokens" in parsed).toBe(false);
  expect("tools" in parsed).toBe(false);

  expect(wire.model).toBe(REVIEW_MODEL_ID);
  expect(wire.effort).toBe(LOCKED_EFFORT_LABEL);
  // 审计 requests[].messages ≡ wireBody.messages（同源投影，不允许两套序列化）。
  expect(wire.messages).toEqual(parsed.messages);
  expect(wire.tools).toEqual([]);
});

test("runReviewTurn：两段 content delta 拼接为回复文本，usage 按缓存口径折算", async () => {
  const script = fakeFetch([
    {
      text: '{"id":"F001","severity":"high"}',
      usage: { promptTokens: 100, completionTokens: 20, cacheReadTokens: 40 },
    },
  ]);
  const { message } = await runReviewTurn({ context: BASE_CONTEXT, apiKey: API_KEY, fetch: script.fetch });

  expect(message.stopReason).toBe("stop");
  expect(assistantText(message)).toBe('{"id":"F001","severity":"high"}');
  // pi-ai openai-completions：input = max(0, prompt_tokens − cacheRead − cacheWrite)。
  expect(message.usage).toMatchObject({ input: 60, output: 20, cacheRead: 40 });
});

test("runReviewTurn：assistant 回复回填上下文重放（deepseek 画像补空 reasoning_content）", async () => {
  const script = fakeFetch([
    { text: "phase-1 reply", usage: { promptTokens: 10, completionTokens: 5, cacheReadTokens: 0 } },
    { text: "phase-2 reply", usage: { promptTokens: 20, completionTokens: 6, cacheReadTokens: 0 } },
  ]);
  const turn1 = await runReviewTurn({ context: BASE_CONTEXT, apiKey: API_KEY, fetch: script.fetch });
  const turn2 = await runReviewTurn({
    context: {
      ...BASE_CONTEXT,
      messages: [...BASE_CONTEXT.messages, turn1.message, user("Phase 2: verify the finding.")],
    },
    apiKey: API_KEY,
    fetch: script.fetch,
  });

  expect(assistantText(turn1.message)).toBe("phase-1 reply");
  expect(assistantText(turn2.message)).toBe("phase-2 reply");

  // deepseek 画像 requiresReasoningContentOnAssistantMessages：无 thinking 的重放
  // assistant 条目补 reasoning_content: ""（pi 内核身份，审计如实记录实际序列化）。
  const parsed = JSON.parse(turn2.wire.wireBody) as { messages: unknown[] };
  expect(parsed.messages).toEqual([
    { role: "system", content: "You are the reviewer." },
    { role: "user", content: "Review the diff." },
    { role: "assistant", content: "phase-1 reply", reasoning_content: "" },
    { role: "user", content: "Phase 2: verify the finding." },
  ]);
});

test("runReviewTurn：零网络纪律——globalThis.fetch 抛错探针不被触碰", async () => {
  const originalFetch = globalThis.fetch;
  const networkProbe = vi.fn(() => {
    throw new Error("network access is disabled in offline tests");
  });
  globalThis.fetch = networkProbe as unknown as typeof globalThis.fetch;
  try {
    const script = fakeFetch([
      { text: "ok", usage: { promptTokens: 1, completionTokens: 1, cacheReadTokens: 0 } },
    ]);
    const { message } = await runReviewTurn({ context: BASE_CONTEXT, apiKey: API_KEY, fetch: script.fetch });
    expect(message.stopReason).toBe("stop");
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect(networkProbe).not.toHaveBeenCalled();
});

test("runReviewTurn：stopReason error（finish_reason content_filter）→ 缝显式抛错", async () => {
  const script = fakeFetch([
    {
      text: "partial",
      finishReason: "content_filter",
      usage: { promptTokens: 1, completionTokens: 1, cacheReadTokens: 0 },
    },
  ]);
  await expect(
    runReviewTurn({ context: BASE_CONTEXT, apiKey: API_KEY, fetch: script.fetch }),
  ).rejects.toThrow(/content_filter/);
});

// ---- 网关注入（#4）：baseUrl 经 model.baseUrl 展开缝，自由 model id（#45 语义） ----

const GATEWAY_URL = "https://gw.example.com/v1";

test("runReviewTurn：缺省 baseUrl → 官方 api.deepseek.com；请求 URL 由 fake 适配器留痕", async () => {
  const script = fakeFetch([
    { text: "ok", usage: { promptTokens: 1, completionTokens: 1, cacheReadTokens: 0 } },
  ]);
  await runReviewTurn({ context: BASE_CONTEXT, apiKey: API_KEY, fetch: script.fetch });
  expect(script.requests[0]?.url).toBe("https://api.deepseek.com/chat/completions");
});

test("runReviewTurn：baseUrl 覆盖 → 请求命中网关端点（${baseUrl}/chat/completions）", async () => {
  const script = fakeFetch([
    { text: "ok", usage: { promptTokens: 1, completionTokens: 1, cacheReadTokens: 0 } },
  ]);
  await runReviewTurn({
    context: BASE_CONTEXT,
    apiKey: API_KEY,
    baseUrl: GATEWAY_URL,
    fetch: script.fetch,
  });
  expect(script.requests[0]?.url).toBe(`${GATEWAY_URL}/chat/completions`);
});

test("runReviewTurn：目录外自由 model id 可发（钉住模型画像作模板），wire 与捕获面一致", async () => {
  const script = fakeFetch([
    { text: "ok", usage: { promptTokens: 1, completionTokens: 1, cacheReadTokens: 0 } },
  ]);
  const { wire } = await runReviewTurn({
    context: BASE_CONTEXT,
    apiKey: API_KEY,
    baseUrl: GATEWAY_URL,
    modelId: "custom-gateway-model",
    fetch: script.fetch,
  });
  const parsed = JSON.parse(wire.wireBody) as Record<string, unknown>;
  // wire 携带自由 id；锁档序列化（thinking/reasoning_effort）不随 id 改变
  expect(parsed.model).toBe("custom-gateway-model");
  expect(wire.model).toBe("custom-gateway-model");
  expect(parsed.thinking).toEqual({ type: "enabled" });
  expect(parsed.reasoning_effort).toBe("high");
});

test("maxTokensFor：官方直连不发；网关档显式预算；配置值恒优先（ADR-0025）", () => {
  expect(maxTokensFor(undefined)).toBeUndefined();
  expect(maxTokensFor("https://api.deepseek.com")).toBeUndefined();
  expect(maxTokensFor("https://api.deepseek.com/")).toBeUndefined();
  expect(maxTokensFor("  https://api.deepseek.com  ")).toBeUndefined();
  // 判档归一化（ADR-0026）：scheme/host 大小写不改变档位——否则官方直连也发
  // max_tokens，ADR-0002 的 wire 字节对齐会悄悄破掉
  expect(maxTokensFor("HTTPS://API.DEEPSEEK.COM")).toBeUndefined();
  expect(maxTokensFor("https://api.deepseek.com//")).toBeUndefined();
  // 路径不同就不是官方端点（/v1 是另一个 base URL）
  expect(maxTokensFor("https://api.deepseek.com/v1")).toBe(GATEWAY_MAX_TOKENS);
  expect(maxTokensFor(GATEWAY_URL)).toBe(GATEWAY_MAX_TOKENS);
  // 配置了 reviewer.maxOutputTokens 即优先（官方直连也发）——字段可空，null = 自动判档
  expect(maxTokensFor(GATEWAY_URL, 8192)).toBe(8192);
  expect(maxTokensFor(undefined, 16384)).toBe(16384);
  expect(maxTokensFor(GATEWAY_URL, null)).toBe(GATEWAY_MAX_TOKENS);
  // 取值校验在配置层（fail fast），这里只做整数化
  expect(maxTokensFor(GATEWAY_URL, 8192.9)).toBe(8192);
});

test("runReviewTurn：网关档 wire 显式带 max_tokens（不继承网关请求默认值）", async () => {
  const script = fakeFetch([
    { text: "ok", usage: { promptTokens: 1, completionTokens: 1, cacheReadTokens: 0 } },
  ]);
  const { wire } = await runReviewTurn({
    context: BASE_CONTEXT,
    apiKey: API_KEY,
    baseUrl: GATEWAY_URL,
    fetch: script.fetch,
  });
  const parsed = JSON.parse(wire.wireBody) as Record<string, unknown>;
  expect(parsed.max_tokens).toBe(GATEWAY_MAX_TOKENS);
});

test("runReviewTurn：配置 maxOutputTokens 覆盖经网关请求落到 wire", async () => {
  const script = fakeFetch([
    { text: "ok", usage: { promptTokens: 1, completionTokens: 1, cacheReadTokens: 0 } },
  ]);
  const { wire } = await runReviewTurn({
    context: BASE_CONTEXT,
    apiKey: API_KEY,
    baseUrl: GATEWAY_URL,
    maxOutputTokens: 8192,
    fetch: script.fetch,
  });
  expect((JSON.parse(wire.wireBody) as Record<string, unknown>).max_tokens).toBe(8192);
});

test("runReviewTurn：modelId 空白 → fail fast（自由 id 非空校验）", async () => {
  const script = fakeFetch([
    { text: "ok", usage: { promptTokens: 1, completionTokens: 1, cacheReadTokens: 0 } },
  ]);
  await expect(
    runReviewTurn({ context: BASE_CONTEXT, apiKey: API_KEY, modelId: "   ", fetch: script.fetch }),
  ).rejects.toThrow(/model id/);
  expect(script.requests).toHaveLength(0);
});
