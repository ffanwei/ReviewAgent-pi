import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  createRequestTimelineWriter,
  describeThrownError,
  formatRequestTimelineSummary,
  hostOfBaseUrl,
  pickTimelineHeaders,
  REQUEST_TIMELINE_FILENAME,
  type TimelineRequestLine,
} from "./request-timeline.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "review-pi-timeline-"));
}

function requestLine(overrides: Partial<TimelineRequestLine> = {}): TimelineRequestLine {
  return {
    v: 1,
    ts: 1_000,
    kind: "request",
    runId: null,
    requestId: 3,
    replay: 0,
    site: "main",
    round: 1,
    phase: "risk_classification",
    phaseIndex: 2,
    model: "deepseek-v4-flash",
    baseUrlHost: "gw.example.com",
    sentAt: 1_000,
    headersAt: 1_200,
    streamStartedAt: 1_300,
    firstDeltaAt: 12_000,
    lastDeltaAt: 16_000,
    endedAt: 16_300,
    stopReason: "error",
    deltaCount: 12,
    deltaChars: 900,
    attempts: 1,
    error: { kind: "transport", code: "UND_ERR_SOCKET", message: "terminated" },
    ...overrides,
  };
}

describe("request timeline writer", () => {
  test("逐行追加 JSONL；摘要取最后一条失败的 request 行", () => {
    const dir = tempDir();
    const writer = createRequestTimelineWriter(dir);
    try {
      writer.sink({
        v: 1,
        ts: 1,
        kind: "attempt",
        runId: null,
        requestId: 1,
        replay: 0,
        site: "main",
        model: "m",
        baseUrlHost: "h",
        attempt: 1,
        sentAt: 1,
        headersAt: 2,
        status: 200,
        error: null,
        durationMs: 1,
      });
      writer.sink(requestLine());
      expect(writer.summary()).toContain("UND_ERR_SOCKET");
    } finally {
      writer.close();
    }
    const lines = readFileSync(join(dir, REQUEST_TIMELINE_FILENAME), "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string });
    expect(lines.map((line) => line.kind)).toEqual(["attempt", "request"]);
  });

  test("行数触顶后写一条 truncated 并停止追加", () => {
    const dir = tempDir();
    const writer = createRequestTimelineWriter(dir, { maxLines: 1 });
    try {
      writer.sink(requestLine({ requestId: 1 }));
      writer.sink(requestLine({ requestId: 2 }));
    } finally {
      writer.close();
    }
    const lines = readFileSync(join(dir, REQUEST_TIMELINE_FILENAME), "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; requestId?: number });
    expect(lines.map((line) => line.kind)).toEqual(["request", "truncated"]);
    expect(lines[0]?.requestId).toBe(1);
  });

  test("追加模式保留已有行（收尾 one-shot 续写单片 pass 的文件）", () => {
    const dir = tempDir();
    const first = createRequestTimelineWriter(dir);
    first.sink(requestLine({ requestId: 1 }));
    first.close();
    const second = createRequestTimelineWriter(dir, { mode: "a" });
    second.sink(requestLine({ requestId: 2 }));
    second.close();
    const text = readFileSync(join(dir, REQUEST_TIMELINE_FILENAME), "utf8");
    expect(text).toContain('"requestId":1');
    expect(text).toContain('"requestId":2');
  });

  test("close 幂等；close 后不再写入", () => {
    const dir = tempDir();
    const writer = createRequestTimelineWriter(dir);
    writer.close();
    writer.close();
    writer.sink(requestLine());
    expect(readFileSync(join(dir, REQUEST_TIMELINE_FILENAME), "utf8")).toBe("");
  });
});

describe("request timeline redaction", () => {
  test("headers 只投影白名单（authorization / set-cookie 永不落地）", () => {
    const headers = new Headers({
      "content-type": "text/event-stream",
      "x-request-id": "req-1",
      "retry-after": "3",
      authorization: "Bearer super-secret",
      "set-cookie": "session=secret",
      "x-api-key": "secret",
    });
    expect(pickTimelineHeaders(headers)).toEqual({
      "content-type": "text/event-stream",
      "x-request-id": "req-1",
      "retry-after": "3",
    });
  });

  test("headers 无白名单命中时返回 undefined（不写空对象）", () => {
    expect(pickTimelineHeaders(new Headers({ authorization: "Bearer x" }))).toBeUndefined();
  });

  test("异常归因取第一层 cause 的 code/errno/syscall，丢弃地址", () => {
    const error = new TypeError("terminated", {
      cause: Object.assign(new Error("other side closed"), {
        code: "UND_ERR_SOCKET",
        errno: -4077,
        syscall: "read",
        address: "10.0.0.1",
        port: 443,
        hostname: "internal-gw",
      }),
    });
    const described = describeThrownError(error);
    expect(described).toEqual({
      kind: "transport",
      name: "TypeError",
      code: "UND_ERR_SOCKET",
      errno: -4077,
      syscall: "read",
      message: "terminated",
    });
    expect(JSON.stringify(described)).not.toContain("10.0.0.1");
    expect(JSON.stringify(described)).not.toContain("internal-gw");
  });

  test("AbortError / TimeoutError 归为 timeout", () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(describeThrownError(abort).kind).toBe("timeout");
  });

  test("baseUrl → host（path / query 不落地）", () => {
    expect(hostOfBaseUrl("https://gw.example.com/v1?key=secret")).toBe("gw.example.com");
    expect(hostOfBaseUrl(undefined)).toBe("api.deepseek.com");
    expect(hostOfBaseUrl("not a url")).toBe("(unparsed)");
  });
});

describe("request timeline summary", () => {
  test("失败摘要人读一行：阶段 / 尝试 / 首字 / 流 / 断流空档 / 归因", () => {
    const line = formatRequestTimelineSummary(requestLine());
    expect(line).toContain("#3");
    expect(line).toContain("main");
    expect(line).toContain("phase 2 risk_classification");
    expect(line).toContain("r1");
    expect(line).toContain("尝试 1 次");
    expect(line).toContain("首字 11.0s");
    expect(line).toContain("流 4.0s");
    expect(line).toContain("断流空档 0.3s");
    expect(line).toContain("UND_ERR_SOCKET");
  });

  test("首字未到达时明确写「未到达」，不伪造秒数", () => {
    const line = formatRequestTimelineSummary(
      requestLine({ firstDeltaAt: null, lastDeltaAt: null }),
    );
    expect(line).toContain("首字 未到达");
    expect(line).not.toContain("断流空档");
  });
});
