import { afterEach, expect, test } from "vitest";

import {
  createTimelineRecorder,
  setRequestTimelineSink,
  type RequestTimelineEntry,
} from "./request-timeline.js";

// recorder（ADR-0089）：attempt / request 两种行与生命周期状态机的唯一实现。

let entries: RequestTimelineEntry[] = [];

function collect(): RequestTimelineEntry[] {
  entries = [];
  setRequestTimelineSink((entry) => entries.push(entry));
  return entries;
}

afterEach(() => {
  setRequestTimelineSink(null);
});

function clock(start = 1_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("attempt + request 行：字段、计数与 headers 白名单", () => {
  collect();
  const time = clock();
  const recorder = createTimelineRecorder({
    scope: { site: "main", round: 1, phase: "Change Understanding" },
    model: "m",
    baseUrl: "https://example.com/path?token=x",
    now: time.now,
    requestId: 7,
  });

  const probe = recorder.beginAttempt();
  time.advance(10);
  recorder.endAttempt(probe, {
    headersAt: 1_010,
    status: 200,
    responseHeaders: new Headers({
      "content-type": "text/event-stream",
      authorization: "secret",
    }),
  });
  time.advance(5);
  recorder.markStreamStarted();
  time.advance(2);
  recorder.markDelta(3);
  time.advance(1);
  recorder.markDelta(4);
  recorder.markBytes(100);
  recorder.setUsage({ inputTokens: 1, outputTokens: 2 });
  time.advance(1);
  recorder.finish({ stopReason: "stop" });

  expect(entries).toHaveLength(2);
  const [attempt, request] = entries;
  expect(attempt).toMatchObject({
    kind: "attempt",
    requestId: 7,
    replay: 0,
    site: "main",
    model: "m",
    baseUrlHost: "example.com",
    attempt: 1,
    sentAt: 1_000,
    headersAt: 1_010,
    status: 200,
    durationMs: 10,
    error: null,
    headers: { "content-type": "text/event-stream" },
  });
  expect(request).toMatchObject({
    kind: "request",
    requestId: 7,
    sentAt: 1_000,
    headersAt: 1_010,
    streamStartedAt: 1_015,
    firstDeltaAt: 1_017,
    lastDeltaAt: 1_018,
    deltaCount: 2,
    deltaChars: 7,
    bytes: 100,
    attempts: 1,
    stopReason: "stop",
    error: null,
    usage: { inputTokens: 1, outputTokens: 2 },
  });
  expect(
    (attempt as { headers?: Record<string, string> }).headers?.authorization,
  ).toBeUndefined();
});

test("错误归因与 finish 幂等", () => {
  collect();
  const recorder = createTimelineRecorder({
    scope: { site: "skill", skill: "s" },
    model: "m",
    now: () => 0,
  });

  const probe = recorder.beginAttempt();
  recorder.endAttempt(probe, {
    error: { kind: "transport", message: "boom" },
  });
  recorder.finish({ error: { kind: "transport", message: "body" } });
  recorder.finish({ error: { kind: "transport", message: "ignored" } });

  expect(entries).toHaveLength(2);
  expect(entries[1]).toMatchObject({
    kind: "request",
    error: { kind: "transport", message: "body" },
    attempts: 1,
  });
});

test("进程级 requestId 唯一（同一次逻辑请求的 replay 共享）", () => {
  const first = createTimelineRecorder({ scope: { site: "main" }, model: "m" });
  const second = createTimelineRecorder({ scope: { site: "main" }, model: "m" });
  const replay = createTimelineRecorder({
    scope: { site: "main" },
    model: "m",
    requestId: first.requestId,
    replay: 1,
  });

  expect(first.requestId).not.toBe(second.requestId);
  expect(replay.requestId).toBe(first.requestId);
});
