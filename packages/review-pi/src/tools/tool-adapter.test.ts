import { expect, test } from "vitest";

import type { RunProgressEvent } from "../contracts/progress.js";
import { DEFAULT_REVIEW_RUNTIME } from "../shared/review-runtime.js";
import {
  buildAgentTools,
  type ToolAdapterHooks,
  type ToolCallInfo,
} from "./tool-adapter.js";
import type { ReviewToolkit } from "./toolkit.js";

// 工具适配器（ADR-0085）：wire 名、入参剥离、失败文本与 hooks 契约。

const PARAMETERS = {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
};

function toolkit(overrides: Partial<ReviewToolkit> = {}): ReviewToolkit {
  return {
    schemas: [
      {
        name: "review.get_diff",
        description: "get diff",
        parametersJson: JSON.stringify(PARAMETERS),
      },
    ],
    ledger: {} as ReviewToolkit["ledger"],
    micro: DEFAULT_REVIEW_RUNTIME.limits.micro,
    executeTool: async (name, args) => `${name}:${JSON.stringify(args)}`,
    ...overrides,
  };
}

async function execute(
  tool: ReturnType<typeof buildAgentTools>[number],
  args: Record<string, unknown>,
) {
  return tool.execute("call-1", args, undefined, undefined);
}

test("投影：wire 名、label 与入参剥离", () => {
  const [tool] = buildAgentTools(toolkit());

  expect(tool?.name).toBe("review_get_diff");
  expect(tool?.label).toBe("review.get_diff");
  expect(tool?.prepareArguments?.({ path: "a.ts", unknown: 1 })).toEqual({ path: "a.ts" });
});

test("成功：onResult 收到点分名与 JSON 入参", async () => {
  const calls: ToolCallInfo[] = [];
  const results: string[] = [];
  const [tool] = buildAgentTools(toolkit(), {
    onResult: (call, result) => {
      calls.push(call);
      results.push(result);
    },
  });

  const output = await execute(tool!, { path: "a.ts" });

  expect(output.content).toEqual([
    { type: "text", text: 'review.get_diff:{"path":"a.ts"}' },
  ]);
  expect(calls).toEqual([
    { name: "review.get_diff", argumentsJson: '{"path":"a.ts"}' },
  ]);
  expect(results).toEqual(['review.get_diff:{"path":"a.ts"}']);
});

test("失败：返回与 onError 都是最终 'Error: ' 文本", async () => {
  const errors: { call: ToolCallInfo; text: string }[] = [];
  const [tool] = buildAgentTools(
    toolkit({
      executeTool: async () => {
        throw new Error("boom");
      },
    }),
    {
      onError: (call, text) => errors.push({ call, text }),
    },
  );

  const output = await execute(tool!, { path: "a.ts" });

  expect(output.content).toEqual([{ type: "text", text: "Error: boom" }]);
  expect(errors).toEqual([
    {
      call: { name: "review.get_diff", argumentsJson: '{"path":"a.ts"}' },
      text: "Error: boom",
    },
  ]);
});

test("beforeExecute 返回 skip：不执行工具，原样回文本", async () => {
  let executed = false;
  const [tool] = buildAgentTools(
    toolkit({
      executeTool: async () => {
        executed = true;
        return "should not run";
      },
    }),
    {
      beforeExecute: () => ({ kind: "skip", text: "budget exhausted" }),
    },
  );

  const output = await execute(tool!, { path: "a.ts" });

  expect(executed).toBe(false);
  expect(output.content).toEqual([{ type: "text", text: "budget exhausted" }]);
});

test("进度包装：注入 progress 时发出 tool 事件", async () => {
  const events: RunProgressEvent[] = [];
  const [tool] = buildAgentTools(toolkit(), {
    progress: { emit: (event) => events.push(event) },
  });

  await execute(tool!, { path: "a.ts" });

  expect(events.length).toBeGreaterThan(0);
  expect(events.some((event) => event.kind === "tool")).toBe(true);
});

test("hooks 可选：无 hooks 时照常执行", async () => {
  const [tool] = buildAgentTools(toolkit());

  const output = await execute(tool!, { path: "a.ts" });

  expect(output.content).toEqual([
    { type: "text", text: 'review.get_diff:{"path":"a.ts"}' },
  ]);
});

test("跨适配器：主 loop 与 skill 风格 hooks 共用投影；skill 无预算截断", async () => {
  const source = toolkit();
  let loopBudget = 1;
  const loopTools = buildAgentTools(source, {
    beforeExecute: () => {
      if (loopBudget <= 0) {
        return { kind: "skip", text: "budget exhausted" };
      }
      loopBudget -= 1;
      return { kind: "run" };
    },
  });
  const skillCalls: string[] = [];
  const skillTools = buildAgentTools(source, {
    beforeExecute: () => {
      skillCalls.push("call");
      return { kind: "run" };
    },
  });

  expect(loopTools[0]?.name).toBe(skillTools[0]?.name);
  expect(loopTools[0]?.label).toBe(skillTools[0]?.label);
  expect(loopTools[0]?.prepareArguments?.({ path: "a", extra: 1 })).toEqual(
    skillTools[0]?.prepareArguments?.({ path: "a", extra: 1 }),
  );

  const first = await execute(loopTools[0]!, { path: "a" });
  const second = await execute(loopTools[0]!, { path: "a" });
  expect(first.content).toEqual([
    { type: "text", text: 'review.get_diff:{"path":"a"}' },
  ]);
  expect(second.content).toEqual([{ type: "text", text: "budget exhausted" }]);

  await execute(skillTools[0]!, { path: "a" });
  await execute(skillTools[0]!, { path: "a" });
  expect(skillCalls).toHaveLength(2);
});
