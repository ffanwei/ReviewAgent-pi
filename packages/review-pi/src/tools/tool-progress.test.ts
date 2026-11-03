import { expect, test } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { RunProgressEvent } from "../contracts/progress.js";
import { NO_OP_PROGRESS_SINK } from "../contracts/progress.js";
import { summarizeDetailLine, withToolProgress } from "./tool-progress.js";

// 工具进度包装层（ADR-0016）：主会话与 skill 会话共用同一份「开始/结束」发射
// 语义，避免两处各自判断成功与否而漂移。成功/失败判据 = 本仓既有失败前后缀
// 约定（工具返回文本以 "Error: " 开头即失败，见 loop 预算耗尽与抓取异常路径）。

function toolOf(execute: AgentTool["execute"]): AgentTool {
  return { name: "review_get_file", label: "review.get_file", description: "d", parameters: {}, execute };
}

function textResult(text: string): Awaited<ReturnType<AgentTool["execute"]>> {
  return { content: [{ type: "text", text }], details: {} };
}

test("成功调用：start 后 end，带结果尺寸、无 detail", async () => {
  const events: RunProgressEvent[] = [];
  const tool = withToolProgress(
    toolOf(async () => textResult("line one\nline two\nline three")),
    "review.get_file",
    (event) => events.push(event),
  );

  await tool.execute("call-1", { path: "src/a.ts" });

  expect(events[0]).toEqual({
    kind: "tool",
    state: "start",
    name: "review.get_file",
  });
  expect(events[1]).toMatchObject({
    kind: "tool",
    state: "end",
    name: "review.get_file",
    ok: true,
    resultChars: "line one\nline two\nline three".length,
    resultLines: 3,
  });
  expect((events[1] as { detail?: string }).detail).toBeUndefined();
});

test("工具返回 Error: 文本 = 失败，detail 只留一行", async () => {
  const events: RunProgressEvent[] = [];
  const tool = withToolProgress(
    toolOf(async () => textResult("Error: review.get_file: file not found\nstack")),
    "review.get_file",
    (event) => events.push(event),
  );

  await tool.execute("call-2", {});

  expect(events[1]).toMatchObject({
    kind: "tool",
    state: "end",
    ok: false,
    detail: "review.get_file: file not found",
  });
});

test("抛出的异常 = 失败，且原样上抛（投影不吞异常）", async () => {
  const events: RunProgressEvent[] = [];
  const tool = withToolProgress(
    toolOf(async () => {
      throw new Error("gateway exploded");
    }),
    "bash",
    (event) => events.push(event),
  );

  await expect(tool.execute("call-3", { command: "rg foo" })).rejects.toThrow("gateway exploded");

  expect(events.map((event) => (event.kind === "tool" ? event.state : event.kind))).toEqual(["start", "end"]);
  expect(events[1]).toMatchObject({ kind: "tool", ok: false, detail: "gateway exploded" });
});

test("包装层不改入参、不改结果，并透传 onUpdate 回调", async () => {
  const seen: unknown[] = [];
  const onUpdate = (): void => {
    seen.push("updated");
  };
  const tool = withToolProgress(
    toolOf(async (_id, params, _signal, update) => {
      update?.({ content: [{ type: "text", text: "partial" }], details: {} });
      return textResult(`echo:${JSON.stringify(params)}`);
    }),
    "review.get_file",
    () => {},
  );

  const result = await tool.execute("call-4", { path: "a.ts" }, undefined, onUpdate);

  expect(result.content).toEqual([{ type: "text", text: 'echo:{"path":"a.ts"}' }]);
  expect(seen).toEqual(["updated"]);
});

test("detail 摘要：剥掉 Error: 前缀并截断到 120 字符（省略号计入总长）", () => {
  expect(summarizeDetailLine("Error: review.get_file: file not found\nmore context")).toBe(
    "review.get_file: file not found",
  );
  const long = summarizeDetailLine(`Error: ${"y".repeat(400)}`);
  expect(long).toHaveLength(120);
  expect(long.endsWith("…")).toBe(true);
  expect(summarizeDetailLine(Error("boom"))).toBe("boom");
});

test("进度关（缺省 sink）：原样返回同一工具对象，不做结果文本统计", () => {
  const tool = toolOf(async () => textResult("whatever"));
  expect(withToolProgress(tool, "review.get_file", NO_OP_PROGRESS_SINK)).toBe(tool);
});
