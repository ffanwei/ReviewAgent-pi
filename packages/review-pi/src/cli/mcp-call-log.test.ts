import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import type { TaskCallTrace } from "../mcp/report.js";
import {
  MCP_CALL_LOG_FILENAME,
  MCP_CALL_LOG_VERSION,
  McpCallLog,
  writeMcpCallLog,
} from "./mcp-call-log.js";

// mcp.json 留痕（与 session 转录同目录）：四个业务调用的输入 / 输出 / 时间。
// 纯形状断言 + 一次真实落盘（临时目录）。

const ISO = "2026-11-07T09:00:00.000Z";

function trace(overrides: Partial<TaskCallTrace> = {}): TaskCallTrace {
  return {
    tool: "startTask",
    arguments: { taskId: "t-1" },
    startedAt: Date.parse(ISO),
    durationMs: 12,
    ok: true,
    responseText: '{"code":0}',
    ...overrides,
  };
}

test("document：tool / startedAt / durationMs / input / output 全量保留", () => {
  const log = new McpCallLog(() => ISO);
  log.record(trace());
  log.record({
    tool: "mrReviewResult",
    arguments: { taskId: "t-1", filePath: "src/Foo.java", reviewTips: [] },
    startedAt: Date.parse(ISO),
    durationMs: 34,
    ok: true,
  });

  expect(log.size).toBe(2);
  expect(log.document("t-1")).toEqual({
    version: MCP_CALL_LOG_VERSION,
    taskId: "t-1",
    calls: [
      {
        tool: "startTask",
        startedAt: ISO,
        durationMs: 12,
        ok: true,
        input: { taskId: "t-1" },
        output: { ok: true, response: '{"code":0}' },
      },
      {
        tool: "mrReviewResult",
        startedAt: ISO,
        durationMs: 34,
        ok: true,
        input: { taskId: "t-1", filePath: "src/Foo.java", reviewTips: [] },
        output: { ok: true },
      },
    ],
  });
});

test("失败调用：output 带 reason；服务端 isError 正文保留为 response", () => {
  const log = new McpCallLog(() => ISO);
  log.record(
    trace({
      tool: "endTask",
      ok: false,
      reason: "server error: tool rejected",
      responseText: "tool rejected",
    }),
  );
  expect(log.document("t-1").calls[0]?.output).toEqual({
    ok: false,
    reason: "server error: tool rejected",
    response: "tool rejected",
  });
});

test("零调用：size = 0（调用方据此不写文件）", () => {
  expect(new McpCallLog().size).toBe(0);
});

test("writeMcpCallLog：原子写 mcp.json 到指定目录（含目录创建）", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "review-pi-mcp-log-")), "runs");
  const log = new McpCallLog(() => ISO);
  log.record(trace());
  const target = await writeMcpCallLog(dir, log.document("t-1"));

  expect(target).toBe(join(dir, MCP_CALL_LOG_FILENAME));
  const parsed = JSON.parse(await readFile(target, "utf8")) as unknown;
  expect(parsed).toMatchObject({
    version: MCP_CALL_LOG_VERSION,
    taskId: "t-1",
    calls: [{ tool: "startTask", startedAt: ISO, durationMs: 12, ok: true }],
  });
});
