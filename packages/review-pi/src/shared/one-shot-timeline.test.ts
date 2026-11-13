import { afterEach, describe, expect, test } from "vitest";

import type { FetchFunction } from "@earendil-works/pi-ai";
import {
  setRequestTimelineSink,
  type RequestTimelineEntry,
} from "../observability/request-timeline.js";
import { completeOneShot } from "./one-shot-llm.js";

/** 2xx 响应头已到、正文读到一半断掉（Node fetch 的 `TypeError: terminated`） */
function brokenBodyResponse(error: unknown): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(error);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const INPUT = {
  baseUrl: "https://gw.example.com/v1",
  apiKey: "offline-test",
  modelId: "deepseek-v4-flash",
  system: "system",
  user: "user",
  timeoutMs: 5_000,
} as const;

const NO_DELAY = { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, maxRetryAfterMs: 0 };

afterEach(() => {
  setRequestTimelineSink(null);
});

describe("一次性调用归因（ADR-0076 决策 6）", () => {
  test("2xx 之后读 body 断掉 = 传输失败，不再冒名「不是合法 JSON」，且不重试", async () => {
    let calls = 0;
    const fetch: FetchFunction = async () => {
      calls += 1;
      return brokenBodyResponse(
        new TypeError("terminated", { cause: { code: "UND_ERR_SOCKET" } }),
      );
    };
    const result = await completeOneShot({ ...INPUT, fetch, retry: NO_DELAY });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("response body read failed");
      expect(result.reason).toContain("terminated");
      expect(result.reason).not.toContain("not valid JSON");
    }
    // retryable 仍为 false：本次只改标签，不改重试语义
    expect(calls).toBe(1);
  });

  test("真正的非法 JSON 仍归为确定性 malformed（不因上面那条改动被吞掉）", async () => {
    const fetch: FetchFunction = async () => new Response("not json", { status: 200 });
    const result = await completeOneShot({ ...INPUT, fetch, retry: NO_DELAY });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("not valid JSON");
    }
  });
});

describe("一次性调用请求时间线", () => {
  test("attempt + request 两行；用途映射到 site，且不带流字段", async () => {
    const entries: RequestTimelineEntry[] = [];
    setRequestTimelineSink((entry) => entries.push(entry));
    const fetch: FetchFunction = async () =>
      jsonResponse({
        choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      });
    const result = await completeOneShot({
      ...INPUT,
      purpose: "tips",
      fetch,
      retry: NO_DELAY,
    });
    expect(result.ok).toBe(true);

    expect(entries.map((entry) => entry.kind)).toEqual(["attempt", "request"]);
    const request = entries[1];
    if (request?.kind !== "request") {
      throw new Error("expected request line");
    }
    expect(request.site).toBe("shard-report");
    expect(request.baseUrlHost).toBe("gw.example.com");
    expect(request.attempts).toBe(1);
    expect(request.stopReason).toBeNull();
    expect(request.firstDeltaAt).toBeNull();
    expect(request.error).toBeNull();
    expect(request.usage).toEqual({
      inputTokens: 5,
      outputTokens: 2,
      cacheReadTokens: 0,
    });
  });

  test("重试路径：每次尝试一行 attempt，request 行记总尝试次数与最终错误", async () => {
    const entries: RequestTimelineEntry[] = [];
    setRequestTimelineSink((entry) => entries.push(entry));
    let calls = 0;
    const fetch: FetchFunction = async () => {
      calls += 1;
      if (calls < 3) {
        return new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 });
      }
      return jsonResponse({
        choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
      });
    };
    const result = await completeOneShot({
      ...INPUT,
      purpose: "summary",
      fetch,
      retry: NO_DELAY,
    });
    expect(result.ok).toBe(true);

    const attempts = entries.filter((entry) => entry.kind === "attempt");
    expect(attempts).toHaveLength(3);
    expect(attempts.map((entry) => (entry.kind === "attempt" ? entry.attempt : 0))).toEqual([
      1, 2, 3,
    ]);
    const request = entries.find((entry) => entry.kind === "request");
    if (request?.kind !== "request") {
      throw new Error("expected request line");
    }
    expect(request.site).toBe("summary");
    expect(request.attempts).toBe(3);
    expect(request.error).toBeNull();
  });

  test("最终失败：request 行带 status 与归因", async () => {
    const entries: RequestTimelineEntry[] = [];
    setRequestTimelineSink((entry) => entries.push(entry));
    const fetch: FetchFunction = async () =>
      new Response(JSON.stringify({ error: { message: "nope" } }), { status: 400 });
    const result = await completeOneShot({ ...INPUT, purpose: "candidate-repair", fetch });
    expect(result.ok).toBe(false);
    const request = entries.find((entry) => entry.kind === "request");
    if (request?.kind !== "request") {
      throw new Error("expected request line");
    }
    expect(request.site).toBe("repair");
    expect(request.error?.kind).toBe("http");
    expect(request.error?.status).toBe(400);
  });
});
