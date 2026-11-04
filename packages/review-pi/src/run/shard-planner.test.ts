import { describe, expect, test } from "vitest";
import { composeShardInput, planShards, type ShardLimits } from "./shard-planner.js";

function block(path: string, body: readonly string[] = ["@@ -1 +1 @@", "-old line", "+new line"]): string {
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...body].join("\n");
}

const LIMITS: ShardLimits = { maxShardChars: 1_000_000, maxShards: 12, contextSummaryChars: 8_000 };

describe("planShards：按文件块贪心装箱（绝不切 hunk）", () => {
  test("预算内：单片，diff 逐字节不变，摘要为空", () => {
    const input = [block("src/A.java"), block("src/B.java")].join("\n");
    const plan = planShards(input, LIMITS);
    expect(plan.shards).toHaveLength(1);
    expect(plan.shards[0]?.diff).toBe(input);
    expect(plan.shards[0]?.files).toEqual(["src/A.java", "src/B.java"]);
    expect(plan.shards[0]?.otherFilesSummary).toBe("");
    expect(composeShardInput(plan.shards[0]!)).toBe(input);
  });

  test("超预算：按顺序装片，每块恰好一次，拼回等于输入", () => {
    const a = block("src/A.java");
    const b = block("src/B.java");
    const c = block("src/C.java");
    const input = [a, b, c].join("\n");
    const plan = planShards(input, { ...LIMITS, maxShardChars: a.length + 1 + b.length });
    expect(plan.shards).toHaveLength(2);
    expect(plan.shards[0]?.files).toEqual(["src/A.java", "src/B.java"]);
    expect(plan.shards[1]?.files).toEqual(["src/C.java"]);
    expect(plan.shards.map((shard) => shard.diff).join("\n")).toBe(input);
    expect(plan.shards.map((shard) => shard.index)).toEqual([1, 2]);
  });

  test("单片超预算：报错点名文件与两个数字，不静默丢块", () => {
    const input = block("src/Huge.java", ["@@ -1 +1 @@", `+${"x".repeat(200)}`]);
    expect(() => planShards(input, { ...LIMITS, maxShardChars: 100 })).toThrow(
      /src\/Huge\.java.*超过单片预算 100 字符/,
    );
  });

  test("片数超上限：报错给出实际片数与上限", () => {
    const a = block("a.ts");
    const input = [a, block("b.ts"), block("c.ts")].join("\n");
    expect(() => planShards(input, { ...LIMITS, maxShardChars: a.length, maxShards: 2 })).toThrow(
      /需要 3 片.*超过上限 limits\.split\.maxShards=2/,
    );
  });

  test("摘要只列其他片的文件，含增删行数", () => {
    const a = block("src/A.java");
    const b = block("src/B.java", ["@@ -1,2 +1,3 @@", "-x", "+y", "+z"]);
    const input = [a, b].join("\n");
    const plan = planShards(input, { ...LIMITS, maxShardChars: a.length });
    expect(plan.shards).toHaveLength(2);
    const summary = plan.shards[0]?.otherFilesSummary ?? "";
    expect(summary).toContain("Other files changed in this MR (not shown in this shard):");
    expect(summary).toContain("- src/B.java (+2/-1)");
    expect(summary).not.toContain("src/A.java");
  });

  test("摘要超上限：按文件截断并留「还有 N 个文件」提示，总长不超上限", () => {
    const blocks = Array.from({ length: 30 }, (_, index) => block(`src/F${String(index)}.java`));
    const input = blocks.join("\n");
    const plan = planShards(input, {
      ...LIMITS,
      maxShardChars: Math.max(...blocks.map((entry) => entry.length)),
      maxShards: 64,
      contextSummaryChars: 120,
    });
    const summary = plan.shards[0]?.otherFilesSummary ?? "";
    expect(summary.length).toBeLessThanOrEqual(120);
    expect(summary).toMatch(/还有 \d+ 个文件未列出/);
  });

  test("前置内容（第一个 diff --git 之前）也参与装箱且可还原", () => {
    const input = `some preamble\n${block("src/A.java")}`;
    const plan = planShards(input, LIMITS);
    expect(plan.shards.map((shard) => shard.diff).join("\n")).toBe(input);
    expect(plan.shards[0]?.files).toEqual(["src/A.java"]);
  });

  test("空 diff：零片（调用方保持单遍路径）", () => {
    expect(planShards("", LIMITS).shards).toEqual([]);
  });

  test("非法预算：预检期直接报错", () => {
    expect(() => planShards(block("a.ts"), { ...LIMITS, maxShardChars: 0 })).toThrow(
      /maxShardChars 必须是正整数/,
    );
    expect(() => planShards(block("a.ts"), { ...LIMITS, maxShards: 0 })).toThrow(
      /maxShards 必须是正整数/,
    );
  });
});
