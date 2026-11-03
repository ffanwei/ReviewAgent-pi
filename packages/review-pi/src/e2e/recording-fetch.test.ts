import { expect, test } from "vitest";
import type { FetchFunction } from "@earendil-works/pi-ai";
import { recordingFetch } from "./recording-fetch.js";

// 真跑传输 tee（#4，R2 断言真源）：包裹真 fetch，逐请求旁路捕获 SSE 流里的
// 原始 usage（prompt_tokens / completion_tokens / cacheRead）与回显 model，
// 对 SDK 侧完全透明（tee 分支直通，字节不变）。e2e 用 Σ fold(rawUsage_i)
// 与 RunRecord.baseline.usage 逐字段对账——两条独立解析路径读同一份线上字节。
// 离线纪律：底层 fetch 全脚本注入，零网络。

const SSE_URL = "https://gw.example.com/v1/chat/completions";

function sseResponse(status: number, chunks: readonly string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

/** 单个 SSE 事件 → "data: <json>\n\n" 帧 */
function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function underlyingOf(
  handler: (url: string) => Response | Promise<Response>,
): { fetch: FetchFunction; urls: string[] } {
  const urls: string[] = [];
  const fetch: FetchFunction = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    void init;
    return handler(url);
  };
  return { fetch, urls };
}

test("透传：caller 侧读到的字节与底层响应完全一致（tee 不改流）", async () => {
  const chunks = [sseData({ model: "m", choices: [] }), "data: [DONE]\n\n"];
  const underlying = underlyingOf(() => sseResponse(200, chunks));
  const recorder = recordingFetch(underlying.fetch);
  const response = await recorder.fetch(SSE_URL, { method: "POST" });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  // 期望文本独立构造（tee 后原流已锁定，不能复读原响应）
  expect(await response.text()).toBe(chunks.join(""));
});

test("捕获：最终 usage 帧的原始三字段逐项入账，回显 model 留痕", async () => {
  const underlying = underlyingOf(() =>
    sseResponse(200, [
      sseData({ model: "deepseek-v4-flash", choices: [{ delta: { content: "a" } }] }),
      sseData({ model: "deepseek-v4-flash", choices: [{ delta: { content: "b" } }] }),
      sseData({ model: "deepseek-v4-flash", choices: [], usage: { prompt_tokens: 100, completion_tokens: 7, prompt_cache_hit_tokens: 40 } }),
      "data: [DONE]\n\n",
    ]),
  );
  const recorder = recordingFetch(underlying.fetch);
  await (await recorder.fetch(SSE_URL, { method: "POST" })).text();
  const requests = await recorder.settle();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    url: SSE_URL,
    status: 200,
    respondedModel: "deepseek-v4-flash",
    rawUsage: { promptTokens: 100, completionTokens: 7, cacheReadTokens: 40 },
  });
});

test("捕获：cacheRead 兜底口径 prompt_tokens_details.cached_tokens（pi-ai 折算同源）", async () => {
  const underlying = underlyingOf(() =>
    sseResponse(200, [
      sseData({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 6 } } }),
      "data: [DONE]\n\n",
    ]),
  );
  const recorder = recordingFetch(underlying.fetch);
  await (await recorder.fetch(SSE_URL, { method: "POST" })).text();
  const requests = await recorder.settle();
  expect(requests[0]?.rawUsage).toEqual({ promptTokens: 10, completionTokens: 2, cacheReadTokens: 6 });
});

test("捕获：多请求按发起序入账（六回合形态），逐请求独立 usage", async () => {
  let call = 0;
  const underlying = underlyingOf(() => {
    call += 1;
    return sseResponse(200, [
      sseData({ model: "m", choices: [], usage: { prompt_tokens: call * 10, completion_tokens: 1 } }),
      "data: [DONE]\n\n",
    ]);
  });
  const recorder = recordingFetch(underlying.fetch);
  for (let index = 0; index < 3; index++) {
    await (await recorder.fetch(SSE_URL, { method: "POST" })).text();
  }
  const requests = await recorder.settle();
  expect(requests.map((request) => request.rawUsage?.promptTokens)).toEqual([10, 20, 30]);
});

test("捕获：流里无 usage 帧 → rawUsage 缺席（e2e 断言面可见，不静默造零）", async () => {
  const underlying = underlyingOf(() => sseResponse(200, [sseData({ model: "m", choices: [] }), "data: [DONE]\n\n"]));
  const recorder = recordingFetch(underlying.fetch);
  await (await recorder.fetch(SSE_URL, { method: "POST" })).text();
  const requests = await recorder.settle();
  expect(requests[0]?.rawUsage).toBeUndefined();
});

test("捕获：非 2xx → errorBody 摘录入账（诊断用），不解析 SSE", async () => {
  const underlying = underlyingOf(() =>
    new Response(JSON.stringify({ error: { message: "insufficient balance" } }), {
      status: 402,
      headers: { "content-type": "application/json" },
    }),
  );
  const recorder = recordingFetch(underlying.fetch);
  const response = await recorder.fetch(SSE_URL, { method: "POST" });
  await response.text();
  const requests = await recorder.settle();
  expect(requests[0]).toMatchObject({ url: SSE_URL, status: 402, errorBody: expect.stringContaining("insufficient balance") });
  expect(requests[0]?.rawUsage).toBeUndefined();
});

test("捕获：坏帧不致命——畸形 data 行跳过，捕获侧异常降级为 captureError 入账", async () => {
  const underlying = underlyingOf(() =>
    sseResponse(200, [
      "data: {not json\n\n",
      sseData({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 1 } }),
      "data: [DONE]\n\n",
    ]),
  );
  const recorder = recordingFetch(underlying.fetch);
  await (await recorder.fetch(SSE_URL, { method: "POST" })).text();
  const requests = await recorder.settle();
  expect(requests[0]?.rawUsage).toEqual({ promptTokens: 5, completionTokens: 1, cacheReadTokens: 0 });
});
