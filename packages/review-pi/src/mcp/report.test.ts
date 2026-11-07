import { describe, expect, test } from "vitest";

import type { McpReportEnvelope } from "../contracts/mcp-report.js";
import { MCP_REPORT_EVENT_TYPES } from "../contracts/mcp-report.js";
import type { RunProgressEvent } from "../contracts/progress.js";
import type { ReportConfig } from "./config.js";
import { ProtocolError } from "./protocol.js";
import { createMcpReporter, type TaskCallTrace } from "./report.js";
import type { Transport, TransportResponse } from "./transport.js";

// 上报投递语义（ADR-0037 决策 5）：只入队、批量、FIFO、seq、背压、重试、
// 永不抛错。用可编程假 transport，不发真网络。

interface RecordedCall {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

type Outcome = "ok" | "isError" | "reject" | "hang" | "serverError" | "http4xx" | "http5xx";

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
        throw new ProtocolError("transport", "network down");
      }
      if (outcome === "hang") {
        await new Promise(() => undefined);
      }
      if (outcome === "http4xx" || outcome === "http5xx") {
        return {
          status: outcome === "http4xx" ? 404 : 503,
          contentType: "text/plain",
          body: "unavailable",
        };
      }
      if (message.id === undefined) {
        return { status: 202, contentType: "", body: "" };
      }
      if (outcome === "serverError") {
        return {
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "method not found" },
          }),
        };
      }
      const result =
        call.method === "initialize"
          ? { protocolVersion: "2025-06-18", serverInfo: { name: "fake", version: "1" } }
          : outcome === "isError"
            ? { content: [{ type: "text", text: "tool rejected" }], isError: true }
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
    server: { transport: "http", handshake: "auto", url: "http://127.0.0.1:1/mcp", headers: {}, timeoutMs: 100 },
    tool: "report_events",
    task: true,
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

  test("分片字段透传：run.start/end 的 shards 计数与事件 shard 标签（ADR-0039）", async () => {
    const transport = fakeTransport();
    const reporter = await createMcpReporter({
      config: reportConfig({ batch: { maxEvents: 10, maxDelayMs: 60_000 } }),
      clientVersion: "test",
      transport,
      streamId: "s",
    });
    reporter.sink({ ...runStart(), shards: { total: 2 } } as RunProgressEvent);
    reporter.sink({
      kind: "phase",
      round: 1,
      phase: "Change Understanding",
      index: 1,
      total: 6,
      shard: { index: 1, total: 2 },
    });
    reporter.sink({ ...runEnd(), shards: { total: 2, ok: 2, failed: 0 } } as RunProgressEvent);
    await reporter.flush(2_000);

    const events = batchesOf(transport).flatMap((batch) => batch.events.map((envelope) => envelope.event));
    expect(events[0]).toMatchObject({ type: "run.start", shards: { total: 2 } });
    expect(events[1]).toMatchObject({ type: "phase", shard: { index: 1, total: 2 } });
    expect(events[2]).toMatchObject({
      type: "run.end",
      shards: { total: 2, ok: 2, failed: 0 },
    });
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

describe("业务 tool 面（ADR-0045）", () => {
  /** 取出全部业务 `tools/call`（非批量事件通道） */
  function taskCallsOf(transport: { readonly calls: RecordedCall[] }): {
    readonly name: string;
    readonly args: Record<string, unknown>;
  }[] {
    return transport.calls
      .filter((call) => call.method === "tools/call")
      .map((call) => ({
        name: String(call.params.name),
        args: (call.params.arguments ?? {}) as Record<string, unknown>,
      }))
      .filter((call) => call.name !== "report_events");
  }

  test("startTask / saveReviewSummary / mrReviewResult：平铺参数直发，成功即 ok", async () => {
    const transport = fakeTransport();
    const reporter = await createMcpReporter({
      config: reportConfig(),
      clientVersion: "test",
      transport,
      streamId: "s",
    });

    expect(await reporter.task.startTask({ taskId: "t-1" })).toEqual({ ok: true });
    expect(
      await reporter.task.saveReviewSummary({ taskId: "t-1", markdownContent: "# 总结" }),
    ).toEqual({
      ok: true,
    });
    expect(
      await reporter.task.reportFileResult({
        taskId: "t-1",
        filePath: "src/Foo.java",
        reviewTips: [
          {
            code: "int x = 1;",
            review: "[缺陷类型] 描述。影响评估：x。",
            suggestion: "[重构思路] 思路。代码示例：```x```",
            category: "可靠性",
            subcategory: "空指针",
            level: "Major",
            ruleId: null,
            lineNum: "3",
          },
        ],
      }),
    ).toEqual({ ok: true });

    const calls = taskCallsOf(transport);
    expect(calls.map((call) => call.name)).toEqual([
      "startTask",
      "saveReviewSummary",
      "mrReviewResult",
    ]);
    expect(calls[0]?.args).toEqual({ taskId: "t-1" });
    expect(calls[1]?.args).toEqual({ taskId: "t-1", markdownContent: "# 总结" });
    expect(calls[2]?.args).toMatchObject({
      taskId: "t-1",
      filePath: "src/Foo.java",
      reviewTips: [{ lineNum: "3", category: "可靠性" }],
    });
    await reporter.close();
  });

  test("onTaskCall：成功 / isError 都留痕输入、输出、耗时与原始回包", async () => {
    const traces: TaskCallTrace[] = [];
    const transport = fakeTransport((call) =>
      call.method === "tools/call" && call.params.name === "endTask" ? "isError" : "ok",
    );
    const reporter = await createMcpReporter({
      config: reportConfig(),
      clientVersion: "test",
      transport,
      streamId: "s",
      onTaskCall: (trace) => traces.push(trace),
    });

    expect(await reporter.task.startTask({ taskId: "t-1" })).toEqual({ ok: true });
    expect(await reporter.task.endTask({ taskId: "t-1" })).toEqual({
      ok: false,
      reason: "server error: tool rejected",
    });

    expect(traces).toHaveLength(2);
    expect(traces[0]).toMatchObject({
      tool: "startTask",
      arguments: { taskId: "t-1" },
      ok: true,
      responseText: "ok",
    });
    expect(traces[1]).toMatchObject({
      tool: "endTask",
      arguments: { taskId: "t-1" },
      ok: false,
      reason: "server error: tool rejected",
      responseText: "tool rejected",
    });
    expect(traces[0]?.startedAt).toBeLessThanOrEqual(traces[1]?.startedAt ?? 0);
    expect(traces.every((trace) => trace.durationMs >= 0)).toBe(true);
    await reporter.close();
  });

  test("initialize 被 404 拒绝 → 降级无状态直调，业务 tool 照常可用（Postman 同形）", async () => {
    const calls: { method: string; name?: string }[] = [];
    const transport: Transport = {
      async send(payload: string): Promise<TransportResponse> {
        const message = JSON.parse(payload) as { id?: number; method: string; params?: { name?: string } };
        calls.push({ method: message.method, ...(message.params?.name !== undefined ? { name: message.params.name } : {}) });
        if (message.method === "initialize") {
          return { status: 404, contentType: "", body: "" };
        }
        if (message.id === undefined) {
          return { status: 202, contentType: "", body: "" };
        }
        return {
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { content: [{ type: "text", text: "ok" }] },
          }),
        };
      },
      close() {
        return Promise.resolve();
      },
    };
    const reporter = await createMcpReporter({
      config: reportConfig(),
      clientVersion: "test",
      transport,
      streamId: "s",
    });

    expect(reporter.handshake).toBe("stateless");
    expect(await reporter.task.startTask({ taskId: "t-1" })).toEqual({ ok: true });
    // 没有 initialized 通知：initialize 之后直接 tools/call
    expect(calls.map((call) => call.method)).toEqual(["initialize", "tools/call"]);
    expect(calls[1]?.name).toBe("startTask");
    await reporter.close();
  });

  test("endTask：服务端 isError → ok:false 带原因；不重试", async () => {
    const transport = fakeTransport((call) =>
      call.method === "tools/call" && call.params.name === "endTask" ? "isError" : "ok",
    );
    const reporter = await createMcpReporter({
      config: reportConfig(),
      clientVersion: "test",
      transport,
      streamId: "s",
    });
    const before = transport.calls.length;
    const outcome = await reporter.task.endTask({ taskId: "t-1" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toContain("server error");
    }
    // `isError: true` 是服务端业务拒绝，重试不会变好：只发一次
    const failedCalls = transport.calls
      .slice(before)
      .filter((call) => call.method === "tools/call" && call.params.name === "endTask");
    expect(failedCalls).toHaveLength(1);
    await reporter.close();
  });

  test("传输失败 → 共 3 次尝试（2 次重试）后 ok:false", async () => {
    const transport = fakeTransport((call) =>
      call.method === "tools/call" && call.params.name === "startTask" ? "reject" : "ok",
    );
    const reporter = await createMcpReporter({
      config: reportConfig(),
      clientVersion: "test",
      transport,
      streamId: "s",
    });
    const before = transport.calls.length;
    const outcome = await reporter.task.startTask({ taskId: "t-1" });
    expect(outcome.ok).toBe(false);
    const failedCalls = transport.calls
      .slice(before)
      .filter((call) => call.method === "tools/call" && call.params.name === "startTask");
    expect(failedCalls).toHaveLength(3);
    await reporter.close();
  });

  test("传输失败后重试成功 → ok:true（第 3 次尝试）", async () => {
    let remainingFailures = 2;
    const transport = fakeTransport((call) => {
      if (
        call.method === "tools/call" &&
        call.params.name === "startTask" &&
        remainingFailures > 0
      ) {
        remainingFailures -= 1;
        return "reject";
      }
      return "ok";
    });
    const reporter = await createMcpReporter({
      config: reportConfig(),
      clientVersion: "test",
      transport,
      streamId: "s",
    });
    const before = transport.calls.length;
    const outcome = await reporter.task.startTask({ taskId: "t-1" });
    expect(outcome).toEqual({ ok: true });
    const startCalls = transport.calls
      .slice(before)
      .filter((call) => call.method === "tools/call" && call.params.name === "startTask");
    expect(startCalls).toHaveLength(3);
    await reporter.close();
  });

  test("JSON-RPC server-error 不重试（确定性失败）", async () => {
    const transport = fakeTransport((call) =>
      call.method === "tools/call" && call.params.name === "startTask" ? "serverError" : "ok",
    );
    const reporter = await createMcpReporter({
      config: reportConfig(),
      clientVersion: "test",
      transport,
      streamId: "s",
    });
    const before = transport.calls.length;
    const outcome = await reporter.task.startTask({ taskId: "t-1" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toContain("MCP error");
    }
    const startCalls = transport.calls
      .slice(before)
      .filter((call) => call.method === "tools/call" && call.params.name === "startTask");
    expect(startCalls).toHaveLength(1);
    await reporter.close();
  });

  test("HTTP 4xx 不重试；HTTP 5xx 重试 3 次", async () => {
    for (const outcome of ["http4xx", "http5xx"] as const) {
      const transport = fakeTransport((call) =>
        call.method === "tools/call" && call.params.name === "startTask" ? outcome : "ok",
      );
      const reporter = await createMcpReporter({
        config: reportConfig(),
        clientVersion: "test",
        transport,
        streamId: "s",
      });
      const before = transport.calls.length;
      expect((await reporter.task.startTask({ taskId: "t-1" })).ok).toBe(false);
      const startCalls = transport.calls
        .slice(before)
        .filter((call) => call.method === "tools/call" && call.params.name === "startTask");
      expect(startCalls).toHaveLength(outcome === "http5xx" ? 3 : 1);
      await reporter.close();
    }
  });

  test("close 之后 → ok:false（reporter closed），不再发请求", async () => {
    const transport = fakeTransport();
    const reporter = await createMcpReporter({
      config: reportConfig(),
      clientVersion: "test",
      transport,
      streamId: "s",
    });
    await reporter.close();
    const before = transport.calls.length;
    expect(await reporter.task.startTask({ taskId: "t-1" })).toEqual({
      ok: false,
      reason: "reporter closed",
    });
    expect(transport.calls.length).toBe(before);
  });

  test("tool = null（事件通道关闭，ADR-0045 后默认形态）：sink 静默丢弃、批量机制不启动、业务面照常", async () => {
    const transport = fakeTransport();
    const reporter = await createMcpReporter({
      config: reportConfig({ tool: null }),
      clientVersion: "test",
      transport,
      streamId: "s",
    });

    reporter.sink(runStart());
    reporter.sink(phase(1));
    reporter.sink(runEnd());
    const stats = await reporter.flush(200);

    // 事件一个没发（除握手外零 tools/call），队列恒空
    expect(transport.calls.filter((call) => call.method === "tools/call")).toHaveLength(0);
    expect(stats).toEqual({ sent: 0, failed: 0, dropped: 0, batches: 0 });

    // 业务面不受影响
    expect(await reporter.task.startTask({ taskId: "t-1" })).toEqual({ ok: true });
    expect(
      transport.calls.filter((call) => call.method === "tools/call").map((call) => call.params.name),
    ).toEqual(["startTask"]);
    await reporter.close();
  });
});
