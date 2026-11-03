import type { Usage } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import type { LlmUsage } from "../contracts/llm.js";
import { ZERO_USAGE, addUsage, piUsageToLlmUsage } from "./usage-map.js";

// usage 口径映射（测量常量面：与 DSH 线 deepseek 口径对账）。
// - inputTokens   ← pi Usage.input（miss 口径，pi-ai 已按 prompt_tokens − hit − write 折算）
// - outputTokens  ← pi Usage.output（含思考 token）
// - cacheReadTokens ← pi Usage.cacheRead（DSH deepseek 路径恒置，含 0）
// - cacheWriteTokens：DeepSeek 无对应字段 → 仅在 pi cacheWrite > 0 时置（不虚增）

function piUsage(overrides: Partial<Usage> = {}): Usage {
  return {
    input: 100,
    output: 50,
    cacheRead: 240,
    cacheWrite: 0,
    totalTokens: 390,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...overrides,
  };
}

test("pi Usage 映射为 DSH 口径：cacheReadTokens 恒置、cacheWriteTokens 仅非零时置", () => {
  expect(piUsageToLlmUsage(piUsage())).toEqual({
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 240,
  });
  expect(piUsageToLlmUsage(piUsage())).not.toHaveProperty("cacheWriteTokens");

  expect(piUsageToLlmUsage(piUsage({ cacheWrite: 32 }))).toEqual({
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 240,
    cacheWriteTokens: 32,
  });
});

test("零值 pi Usage 映射为全零（cacheReadTokens 为 0）", () => {
  expect(piUsageToLlmUsage(piUsage({ input: 0, output: 0, cacheRead: 0 }))).toEqual({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
  });
});

test("ZERO_USAGE 是无 cache 字段的零值起点", () => {
  expect(ZERO_USAGE).toEqual({ inputTokens: 0, outputTokens: 0 });
});

test("addUsage 纯函数累加，cache 字段按出现即保持的规则合并", () => {
  const plain: LlmUsage = { inputTokens: 1, outputTokens: 2 };
  expect(addUsage(plain, ZERO_USAGE)).toEqual({ inputTokens: 1, outputTokens: 2 });

  const withRead: LlmUsage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 10 };
  const summed = addUsage(plain, withRead);
  expect(summed).toEqual({ inputTokens: 2, outputTokens: 4, cacheReadTokens: 10 });
  expect(summed).not.toHaveProperty("cacheWriteTokens");

  const withWrite: LlmUsage = { inputTokens: 1, outputTokens: 2, cacheWriteTokens: 5 };
  expect(addUsage(withWrite, withWrite)).toEqual({
    inputTokens: 2,
    outputTokens: 4,
    cacheWriteTokens: 10,
  });
});

test("addUsage 不改写入参（不可变纪律）", () => {
  const a: LlmUsage = { inputTokens: 1, outputTokens: 2 };
  const b: LlmUsage = { inputTokens: 3, outputTokens: 4, cacheReadTokens: 7 };
  addUsage(a, b);
  expect(a).toEqual({ inputTokens: 1, outputTokens: 2 });
  expect(b).toEqual({ inputTokens: 3, outputTokens: 4, cacheReadTokens: 7 });
});
