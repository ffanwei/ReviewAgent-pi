import { afterEach, describe, expect, test, vi } from "vitest";

import { DEFAULT_LIMITS, type GroupingLimits } from "../shared/config.js";
import { completeOneShot } from "../shared/one-shot-llm.js";
import { planGroupedShards, shouldGroupReview, type GroupingLlm } from "./review-grouping.js";

vi.mock("../shared/one-shot-llm.js", () => ({ completeOneShot: vi.fn() }));

const mockedComplete = vi.mocked(completeOneShot);

function block(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    "-old line",
    "+new line",
  ].join("\n");
}

function limits(overrides: Partial<GroupingLimits> = {}): GroupingLimits {
  return { ...DEFAULT_LIMITS.grouping, ...overrides };
}

function llm(): GroupingLlm {
  return {
    baseUrl: "https://example.test/v1",
    apiKey: "key",
    modelId: "group-model",
    fetch: (async () => {
      throw new Error("unused");
    }) as unknown as GroupingLlm["fetch"],
    timeoutMs: 1_000,
  };
}

afterEach(() => {
  mockedComplete.mockReset();
});

describe("planGroupedShards：路径兜底与体积/组数上限", () => {
  test("无模型：按顶层目录分组，每个文件恰好一次", async () => {
    const diff = [block("src/a.ts"), block("src/b.ts"), block("lib/c.ts")].join("\n");
    const plan = await planGroupedShards(diff, limits({ minFilesPerGroup: 1 }), 8_000, null);

    expect(plan.source).toBe("path");
    expect(plan.shards.length).toBeGreaterThan(1);
    const files = plan.shards.flatMap((shard) => shard.files).sort();
    expect(files).toEqual(["lib/c.ts", "src/a.ts", "src/b.ts"]);
    expect(plan.shards.map((shard) => shard.index)).toEqual(
      plan.shards.map((_, index) => index + 1),
    );
  });

  test("每组文件数上限：同目录超限时按顺序切块", async () => {
    const diff = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"].map(block).join("\n");
    const plan = await planGroupedShards(diff, limits({ maxFilesPerShard: 2, minFilesPerGroup: 1 }), 8_000, null);

    expect(plan.shards.length).toBe(3);
    expect(plan.shards.flatMap((shard) => shard.files).sort()).toEqual([
      "a.ts", "b.ts", "c.ts", "d.ts", "e.ts",
    ]);
  });

  test("组数上限：合并相邻最小片，不丢文件", async () => {
    const diff = ["a/a.ts", "b/b.ts", "c/c.ts", "d/d.ts", "e/e.ts"].map(block).join("\n");
    const plan = await planGroupedShards(diff, limits({ maxShards: 2, minFilesPerGroup: 1 }), 8_000, null);

    expect(plan.shards.length).toBeLessThanOrEqual(2);
    expect(plan.shards.flatMap((shard) => shard.files).sort()).toEqual([
      "a/a.ts", "b/b.ts", "c/c.ts", "d/d.ts", "e/e.ts",
    ]);
  });
  test("碎组合并：1–2 个文件的组并入相邻组", async () => {
    const paths = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "lib/e.ts", "lib/f.ts", "lib/g.ts"];
    const diff = paths.map(block).join("\n");
    mockedComplete.mockResolvedValue({
      ok: true,
      text: JSON.stringify({
        groups: [
          { label: "single", files: [0] },
          { label: "rest", files: [1, 2, 3, 4, 5, 6] },
        ],
      }),
    });

    const plan = await planGroupedShards(diff, limits(), 8_000, llm());

    expect(plan.source).toBe("llm");
    expect(plan.shards).toHaveLength(1);
    expect(plan.shards.flatMap((shard) => shard.files).sort()).toEqual([...paths].sort());
  });
});

describe("planGroupedShards：LLM 分组与兜底", () => {
  test("合法 LLM 输出被采用，组顺序按最小文件序号", async () => {
    const diff = [block("src/z.ts"), block("src/y.ts"), block("lib/x.ts")].join("\n");
    mockedComplete.mockResolvedValue({
      ok: true,
      text: JSON.stringify({
        groups: [
          { label: "lib", files: [2] },
          { label: "src", files: [0, 1] },
        ],
      }),
    });

    const plan = await planGroupedShards(diff, limits({ minFilesPerGroup: 1 }), 8_000, llm());

    expect(plan.source).toBe("llm");
    expect(plan.shards).toHaveLength(2);
    expect(plan.shards[0]?.files).toEqual(["src/z.ts", "src/y.ts"]);
    expect(plan.shards[1]?.files).toEqual(["lib/x.ts"]);
    expect(mockedComplete).toHaveBeenCalledTimes(1);
    expect(mockedComplete.mock.calls[0]?.[0]).toMatchObject({ purpose: "grouping" });
  });

  test("非法输出重试一次；仍非法则 fallback 路径分组", async () => {
    const diff = [block("src/a.ts"), block("lib/b.ts")].join("\n");
    mockedComplete.mockResolvedValue({ ok: true, text: "not json" });

    const plan = await planGroupedShards(diff, limits({ minFilesPerGroup: 1 }), 8_000, llm());

    expect(mockedComplete).toHaveBeenCalledTimes(2);
    expect(plan.source).toBe("fallback");
    expect(plan.error).toBeTruthy();
    expect(plan.shards.flatMap((shard) => shard.files).sort()).toEqual(["lib/b.ts", "src/a.ts"]);
  });

  test("遗漏文件视为非法，不丢文件", async () => {
    const diff = [block("a.ts"), block("b.ts"), block("c.ts")].join("\n");
    mockedComplete.mockResolvedValue({
      ok: true,
      text: JSON.stringify({ groups: [{ label: "x", files: [0, 1] }] }),
    });

    const plan = await planGroupedShards(diff, limits({ minFilesPerGroup: 1 }), 8_000, llm());

    expect(plan.source).toBe("fallback");
    expect(plan.shards.flatMap((shard) => shard.files).sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
  });
});

describe("shouldGroupReview：小 PR 跳过与触发条件", () => {
  test("文件数和字符数都不超过小 PR 阈值 → 不分组", () => {
    expect(shouldGroupReview(7, 60_000, limits())).toBe(false);
  });

  test("文件数超小 PR 阈值 → 分组", () => {
    expect(shouldGroupReview(9, 60_000, limits())).toBe(true);
  });

  test("字符数超小 PR 阈值 → 分组", () => {
    expect(shouldGroupReview(7, 130_000, limits())).toBe(true);
  });

  test("极小 PR → 不分组", () => {
    expect(shouldGroupReview(3, 10_000, limits())).toBe(false);
  });

  test("大 PR → 分组", () => {
    expect(shouldGroupReview(187, 498_000, limits())).toBe(true);
  });
});
