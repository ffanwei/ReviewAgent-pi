import { describe, expect, test } from "vitest";

import type { McpReportEnvelope } from "../contracts/mcp-report.js";
import { MCP_REPORT_EVENT_TYPES } from "../contracts/mcp-report.js";
import type { RunProgressEvent } from "../contracts/progress.js";
import type { ReportConfig } from "./config.js";
import { createMcpReporter } from "./report.js";
import type { Transport, TransportResponse } from "./transport.js";

// 上报投递语义（ADR-0037 决策 5）：只入队、批量、FIFO、seq、背压、重试、
// 永不抛错。用可编程假 transport，不发真网络。

interface RecordedCall {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

type Outcome = "ok" | "reject" | "hang";

function fakeTransport(
  decide: (call: RecordedCall, index: number) => Outcome = () => "ok",
): Transport & { readonly calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async send(payload: string): Promise<TransportResponse> {
      const message = JSON.parse(payload) as Record<string, unknown>;
      const call: RecordedCall = {
        method: String(message.method),
        params: (message.params as Record<string, unknown> | undefined) ?? {},
      };
      calls.push(call);
      const outcome = decide(call, calls.length - 1);
      if (outcome === "reject") {
        throw new Error("network down");
      }
      if (outcome === "hang") {
        await new Promise(() => undefined);
      }
      if (message.id === undefined) {
        return { status: 202, contentType: "", body: "" };
      }
      const result =
        call.method === "initialize"
          ? { protocolVersion: "2025-06-18", serverInfo: { name: "fake", version: "1" } }
          : { content: [{ type: "text", text: "ok" }] };
      return {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: message.id, result }),
      };
    },
    close() {
      return Promise.resolve();
    },
  };
}

function reportConfig(overrides: Partial<ReportConfig> = {}): ReportConfig {
  return {
    server: { transport: "http", url: "http://127.0.0.1:1/mcp", headers: {}, timeoutMs: 100 },
    tool: "report_events",
    include: new Set(MCP_REPORT_EVENT_TYPES),
    batch: { maxEvents: 50, maxDelayMs: 60_000 },
    queue: { maxEvents: 1_000 },
    flushTimeoutMs: 2_000,
    findings: "summary",
    ...overrides,
  };
}

function phase(index: number): RunProgressEvent {
  return { kind: "phase", round: 1, phase: "Change Understanding", index, total: 6 };
}

function runStart(): RunProgressEvent {
  return {
    kind: "run",
    state: "start",
    caseId: "VUL4J-1",
    model: "deepseek-v4-flash",
    startedAt: "2026-11-04T10:15:00.000Z",
  };
}

function runEnd(): RunProgressEvent {
  return {
    kind: "run",
    state: "end",
    status: "ok",
    runId: "20261104_101500_000",
    durationMs: 1_234,
    usage: { inputTokens: 10, outputTokens: 2 },
    truncated: false,
    findings: { count: 1, bySeverity: { P0: 0, P1: 1, P2: 0, P3: 0 } },
  };
}

/** 取出所有 `tools/call` 的批量参数 */
function batchesOf(transport: { readonly calls: RecordedCall[] }): {
  readonly streamId: string;
  readonly events: readonly McpReportEnvelope[];
}[] {
  return transport.calls
    .filter((call) => call.method === "tools/call")
    .map((call) => call.params.arguments as { streamId: string; events: McpReportEnvelope[] });
}

describe("createMcpReporter", () => {
  test("握手一次；满 batch.maxEvents 即发，seq 1-based 严格递增", async () => {
    const transport = fakeTransport();
    const reporter = await createMcpReporter({
      config: reportConfig({ batch: { maxEvents: 3, maxDelayMs: 60_000 } }),
      clientVersion: "test",
      transport,
      streamId: "stream-1",
    });

    reporter.sink(phase(1));
    reporter.sink(phase(2));
    reporter.sink(phase(3));
    const stats = await reporter.flush(2_000);

    expect(transport.calls.filter((call) => call.method === "initialize")).toHaveLength(1);
    const batches = batchesOf(transport);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.streamId).toBe("stream-1");
    expect(batches[0]?.events.map((envelope) => envelope.seq)).toEqual([1, 2, 3]);
    expect(batches[0]?.events.map((envelope) => envelope.event.type)).toEqual([
      "phase",
      "phase",
      "phase",
    ]);
    expect(stats).toEqual({ sent: 3, failed: 0, dropped: 0, batches: 1 });
    await reporter.close();
  });

  test("include 过滤在入队前生效（未配置的类型不占队列）", async () => {
    const transport = fakeTransport();
    const reporter = await createMcpReporter({
      config: reportConfig({ include: new Set(["run.start"]), batch: { maxEvents: 1, maxDelayMs: 0 } }),
      clientVersion: "test",
      transport,
      streamId: "s",
    });
    reporter.sink({ kind: "tool", state: "start", name: "review.get_diff" });
    reporter.sink(phase(1));
    reporter.sink(runStart());
    await reporter.flush(2_000);

    const events = batchesOf(transport).flatMap((batch) => batch.events);
    expect(events.map((envelope) => envelope.event.type)).toEqual(["run.start"]);
    await reporter.close();
  });

  test("背压：队列溢出丢最旧并计数，run.end 带回 dropped", async () => {
    const transport = fakeTransport();
    const reporter = await createMcpReporter({
      config: reportConfig({
        batch: { maxEvents: 50, maxDelayMs: 60_000 },
        queue: { maxEvents: 2 },
      }),
      clientVersion: "test",
      transport,
      streamId: "s",
    });
    for (let index = 1; index <= 5; index += 1) {
      reporter.sink(phase(index));
    }
    reporter.sink(runEnd());
    await reporter.flush(2_000);

    const events = batchesOf(transport).flatMap((batch) => batch.events);
    // 队列上限 2：先塞 5 条 → 丢 1/2/3；随后 run.end 入队 → 丢 4
    expect(events.map((envelope) => envelope.seq)).toEqual([5, 6]);
    const end = events[1]?.event;
    expect(end).toMatchObject({ type: "run.end", dropped: 4, failed: 0 });
    await reporter.close();
  });

  test("重试：单批最多 3 次，前两次失败后成功仍算 sent", async () => {
    let failures = 2;
    const transport = fakeTransport((call) => {
      if (call.method !== "tools/call") {
        return "ok";
      }
      if (failures > 0) {
        failures -= 1;
        return "reject";
      }
      return "ok";
    });
    const reporter = await createMcpReporter({
      config: reportConfig({ batch: { maxEvents: 10, maxDelayMs: 60_000 } }),
      clientVersion: "test",
      transport,
      streamId: "s",
    });
    reporter.sink(phase(1));
    const stats = await reporter.flush(3_000);

    expect(stats.sent).toBe(1);
    expect(stats.failed).toBe(0);
    expect(stats.batches).toBe(3);
    await reporter.close();
  });

  test("重试耗尽：failed 计数，且 sink 绝不抛错", async () => {
    const transport = fakeTransport((call) => (call.method === "tools/call" ? "reject" : "ok"));
    const reporter = await createMcpReporter({
      config: reportConfig({ batch: { maxEvents: 10, maxDelayMs: 60_000 } }),
      clientVersion: "test",
      transport,
      streamId: "s",
    });
    expect(() => {
      reporter.sink(phase(1));
    }).not.toThrow();
    const stats = await reporter.flush(3_000);
    expect(stats).toEqual({ sent: 0, failed: 1, dropped: 0, batches: 3 });
    await reporter.close();
  });

  test("flush 超时只返回当前统计（不抛错、不阻塞进程）", async () => {
    const transport = fakeTransport((call) => (call.method === "tools/call" ? "hang" : "ok"));
    const reporter = await createMcpReporter({
      config: reportConfig({ batch: { maxEvents: 10, maxDelayMs: 60_000 } }),
      clientVersion: "test",
      transport,
      streamId: "s",
    });
    reporter.sink(phase(1));
    const startedAt = Date.now();
    const stats = await reporter.flush(80);
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(stats.sent).toBe(0);
  });

  test("close 之后 sink 静默丢弃，close 幂等", async () => {
    const transport = fakeTransport();
    const reporter = await createMcpReporter({
      config: reportConfig({ batch: { maxEvents: 10, maxDelayMs: 60_000 } }),
      clientVersion: "test",
      transport,
      streamId: "s",
    });
    reporter.sink(phase(1));
    await reporter.close();
    const before = transport.calls.length;
    reporter.sink(phase(2));
    await reporter.close();
    expect(transport.calls.length).toBe(before);
  });

  test("run.end 的 findings 档位：none 时不带 findings", async () => {
    const transport = fakeTransport();
    const reporter = await createMcpReporter({
      config: reportConfig({
        findings: "none",
        batch: { maxEvents: 10, maxDelayMs: 60_000 },
      }),
      clientVersion: "test",
      transport,
      streamId: "s",
    });
    reporter.sink(runEnd());
    await reporter.flush(2_000);
    const end = batchesOf(transport)[0]?.events[0]?.event;
    expect(end).toMatchObject({ type: "run.end", status: "ok" });
    expect(end !== undefined && "findings" in end).toBe(false);
    await reporter.close();
  });

  test("工具事件只出站名字与尺寸，不带入参摘要与失败详情", async () => {
    const transport = fakeTransport();
    const reporter = await createMcpReporter({
      config: reportConfig({ batch: { maxEvents: 10, maxDelayMs: 60_000 } }),
      clientVersion: "test",
      transport,
      streamId: "s",
    });
    reporter.sink({
      kind: "tool",
      state: "end",
      name: "review.get_diff",
      argumentsSummary: "path=src/Secret.java",
      detail: "Error: at com.example.Secret.java:12",
      durationMs: 12,
      ok: false,
      resultChars: 10,
      resultLines: 2,
    });
    await reporter.flush(2_000);
    const event = batchesOf(transport)[0]?.events[0]?.event;
    expect(event).toEqual({
      type: "tool.end",
      name: "review.get_diff",
      durationMs: 12,
      ok: false,
      resultChars: 10,
      resultLines: 2,
    });
    expect(JSON.stringify(event)).not.toContain("Secret.java");
    await reporter.close();
  });
});
