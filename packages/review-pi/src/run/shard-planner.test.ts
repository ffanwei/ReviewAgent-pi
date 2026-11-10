import { describe, expect, test } from "vitest";
import {
  composeShardInput,
  formatShardTruncationNotice,
  planShards,
  type ShardLimits,
} from "./shard-planner.js";

function block(path: string, body: readonly string[] = ["@@ -1 +1 @@", "-old line", "+new line"]): string {
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...body].join("\n");
}

/** 多 hunk 块（每个 hunk 由 `-` / `+` / 上下文行组成，便于精确算前缀长度） */
function hunksBlock(path: string, hunkCount: number, padding: number): string {
  const body: string[] = [];
  for (let index = 0; index < hunkCount; index += 1) {
    const line = index * 10 + 1;
    body.push(
      `@@ -${String(line)},2 +${String(line)},2 @@`,
      `-old line ${String(index)}`,
      `+new line ${String(index)} ${"x".repeat(padding)}`,
      ` context ${String(index)}`,
    );
  }
  return block(path, body);
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

  test("单片超预算：按整 hunk 截取（保留文件头 + 前缀完整 hunk），留痕可读", () => {
    const text = hunksBlock("src/Huge.java", 5, 200);
    const lines = text.split("\n");
    const hunkStarts = lines
      .map((line, index) => (line.startsWith("@@ ") ? index : -1))
      .filter((index) => index >= 0);
    const prefixOf = (hunks: number): string =>
      lines.slice(0, hunkStarts[hunks] ?? lines.length).join("\n");
    const budget = prefixOf(2).length;

    const plan = planShards(text, { ...LIMITS, maxShardChars: budget });
    expect(plan.shards).toHaveLength(1);
    const shard = plan.shards[0]!;
    expect(shard.files).toEqual(["src/Huge.java"]);
    // 只保留前 2 个完整 hunk：第 3 个 hunk 的文件头 / 半截都不出现
    expect(shard.diff).toBe(prefixOf(2));
    expect(shard.diff).not.toContain("+new line 2");
    expect(shard.chars).toBe(budget);
    expect(shard.truncated).toHaveLength(1);
    expect(shard.truncated[0]).toEqual({
      path: "src/Huge.java",
      originalChars: text.length,
      keptChars: budget,
      hunks: 5,
      keptHunks: 2,
      droppedHunks: 3,
      droppedAdded: 3,
      droppedRemoved: 3,
    });
  });

  test("退化情形：文件头 + 首个 hunk 单独超预算时保留首个 hunk，不报错", () => {
    const text = hunksBlock("src/Wide.java", 3, 400);
    const plan = planShards(text, { ...LIMITS, maxShardChars: 100 });
    const shard = plan.shards[0]!;
    const record = shard.truncated[0]!;
    expect(record.keptHunks).toBe(1);
    expect(record.droppedHunks).toBe(2);
    expect(record.keptChars).toBeGreaterThan(100);
    expect(shard.diff).toContain("+new line 0");
    expect(shard.diff).not.toContain("+new line 1");
  });

  test("无 hunk 的块（二进制 / 纯头部）无法安全截取：原样保留、不留痕", () => {
    const text = block("src/Odd.bin", [`+${"y".repeat(200)}`]);
    const plan = planShards(text, { ...LIMITS, maxShardChars: 50 });
    expect(plan.shards[0]?.diff).toBe(text);
    expect(plan.shards[0]?.truncated).toEqual([]);
  });

  test("formatShardTruncationNotice：汇总文件数 / 丢弃 hunk 数 / 保留字符数", () => {
    expect(
      formatShardTruncationNotice([
        {
          path: "src/A.java",
          originalChars: 100_000,
          keptChars: 70_000,
          hunks: 10,
          keptHunks: 7,
          droppedHunks: 3,
          droppedAdded: 20,
          droppedRemoved: 5,
        },
        {
          path: "src/B.java",
          originalChars: 90_000,
          keptChars: 60_000,
          hunks: 4,
          keptHunks: 3,
          droppedHunks: 1,
          droppedAdded: 8,
          droppedRemoved: 2,
        },
      ]),
    ).toBe(
      "已截取检视 2 个超预算文件（丢弃 4 个完整 hunk，保留 130000 字符），明细见审计 shardTruncation",
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

  test("同一文件的多个 hunk 永远同片（JSON 等多 hunk 文件不会被切坏）", () => {
    const manifest = [
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -1,3 +1,3 @@",
      " {",
      '-  "a": 1,',
      '+  "a": 2,',
      " }",
      "@@ -40,3 +40,3 @@",
      " {",
      '-  "b": 1,',
      '+  "b": 2,',
      " }",
    ].join("\n");
    const source = block("src/App.ts");
    const input = [manifest, source].join("\n");
    const plan = planShards(input, {
      ...LIMITS,
      maxShardChars: Math.max(manifest.length, source.length),
    });
    expect(plan.shards).toHaveLength(2);
    expect(plan.shards[0]?.files).toEqual(["package.json"]);
    expect(plan.shards[0]?.diff).toBe(manifest);
    expect(plan.shards.map((shard) => shard.diff).join("\n")).toBe(input);
  });

  test("正文行以 diff --git 开头也不会被误判为块边界（有 +/-/空格前缀）", () => {
    const tricky = [
      "diff --git a/notes.txt b/notes.txt",
      "--- a/notes.txt",
      "+++ b/notes.txt",
      "@@ -1,2 +1,2 @@",
      "-diff --git a/old b/old",
      "+diff --git a/new b/new",
    ].join("\n");
    const plan = planShards(tricky, LIMITS);
    expect(plan.shards).toHaveLength(1);
    expect(plan.shards[0]?.files).toEqual(["notes.txt"]);
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
