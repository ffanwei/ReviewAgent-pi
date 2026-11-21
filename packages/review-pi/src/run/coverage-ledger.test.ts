import { describe, expect, test } from "vitest";

import type { CoverageLedger, HunkCoverage } from "../contracts/coverage.js";
import {
  assertCoverageInvariant,
  backfillCandidates,
  buildCoverageLedger,
  closeCoverage,
  emptyCoverageLedger,
  markNoIssue,
  mergeCoverageLedgers,
  truncatedRangesFromShardRecords,
} from "./coverage-ledger.js";

function diffOf(file: string, hunks: readonly string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    ...hunks,
  ].join("\n");
}

const TWO_HUNKS = diffOf("src/a.ts", [
  "@@ -1,2 +1,3 @@\n const a = 1;\n+const b = 2;\n ctx",
  "@@ -10,2 +11,2 @@\n-old\n+new\n ctx",
]);

const MULTI = [
  diffOf("src/b.ts", ["@@ -1,1 +1,1 @@\n-x\n+y"]),
  diffOf("src/a.ts", ["@@ -1,1 +1,1 @@\n-p\n+q"]),
].join("\n");

const DELETED = [
  "diff --git a/old.ts b/old.ts",
  "deleted file mode 100644",
  "--- a/old.ts",
  "+++ /dev/null",
  "@@ -1,1 +0,0 @@",
  "-bye",
].join("\n");

const BINARY = [
  "diff --git a/img.png b/img.png",
  "Binary files a/img.png and b/img.png differ",
].join("\n");

const MODE_ONLY = [
  "diff --git a/run.sh b/run.sh",
  "old mode 100644",
  "new mode 100755",
].join("\n");

const ADDED = [
  "diff --git a/new.ts b/new.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/new.ts",
  "@@ -0,0 +1,1 @@",
  "+hello",
].join("\n");

const TRUNCATED_DIFF = diffOf("src/c.ts", ["@@ -1,1 +1,1 @@\n-a\n+b"]);

const REPEATED = [
  diffOf("src/x.ts", ["@@ -1,1 +1,1 @@\n-a\n+b"]),
  diffOf("src/x.ts", ["@@ -10,1 +10,1 @@\n-c\n+d"]),
].join("\n");

const UNATTRIBUTED = "@@ -1,1 +1,1 @@\n-x\n+y";

function fileOf(ledger: CoverageLedger, path: string) {
  const file = ledger.files.find((entry) => entry.file === path);
  expect(file).toBeDefined();
  return file as NonNullable<typeof file>;
}

function hunkOf(ledger: CoverageLedger, path: string, index: number): HunkCoverage {
  const hunk = fileOf(ledger, path).hunks.find((entry) => entry.index === index);
  expect(hunk).toBeDefined();
  return hunk as HunkCoverage;
}

describe("buildCoverageLedger", () => {
  test("单文件多 hunk：分母、区间与默认 not-reached(no-signal)", () => {
    const ledger = buildCoverageLedger(TWO_HUNKS);

    expect(ledger.files).toHaveLength(1);
    const file = fileOf(ledger, "src/a.ts");
    expect(file.hunks).toHaveLength(2);
    expect(hunkOf(ledger, "src/a.ts", 1)).toMatchObject({
      index: 1,
      old: { start: 1, count: 2 },
      new: { start: 1, count: 3 },
      status: "not-reached",
      cause: "no-signal",
    });
    expect(hunkOf(ledger, "src/a.ts", 2)).toMatchObject({
      index: 2,
      old: { start: 10, count: 2 },
      new: { start: 11, count: 2 },
      status: "not-reached",
      cause: "no-signal",
    });
    expect(ledger.counts).toMatchObject({
      hunks: 2,
      candidate: 0,
      noIssue: 0,
      notReached: 2,
      outOfHunk: 0,
    });
    expect(ledger.counts.byCause["no-signal"]).toBe(2);
    assertCoverageInvariant(ledger);
  });

  test("多文件按路径排序，与 diff 顺序无关", () => {
    const ledger = buildCoverageLedger(MULTI);
    expect(ledger.files.map((file) => file.file)).toEqual(["src/a.ts", "src/b.ts"]);
    assertCoverageInvariant(ledger);
  });

  test("删除 / binary / 无 hunk 文件进 excluded，不进分母", () => {
    const ledger = buildCoverageLedger([DELETED, BINARY, MODE_ONLY].join("\n"));

    expect(ledger.files).toHaveLength(0);
    expect(ledger.excluded).toEqual([
      { path: "img.png", reason: "binary" },
      { path: "old.ts", reason: "deleted" },
      { path: "run.sh", reason: "no-hunks" },
    ]);
    expect(ledger.counts.hunks).toBe(0);
    assertCoverageInvariant(ledger);
  });

  test("新增文件进入分母，旧侧空区间合法", () => {
    const ledger = buildCoverageLedger(ADDED);
    expect(hunkOf(ledger, "new.ts", 1)).toMatchObject({
      old: { start: 0, count: 0 },
      new: { start: 1, count: 1 },
      status: "not-reached",
    });
    assertCoverageInvariant(ledger);
  });

  test("同一路径的多个 diff 块合并，hunk 序号连续", () => {
    const ledger = buildCoverageLedger(REPEATED);
    expect(ledger.files).toHaveLength(1);
    expect(ledger.files[0]?.hunks.map((hunk) => hunk.index)).toEqual([1, 2]);
    assertCoverageInvariant(ledger);
  });

  test("无法归属的 hunk 计入 unattributedHunks，不进入文件分母", () => {
    const ledger = buildCoverageLedger(UNATTRIBUTED);
    expect(ledger.files).toHaveLength(0);
    expect(ledger.unattributedHunks).toBe(1);
    expect(ledger.counts.hunks).toBe(0);
    assertCoverageInvariant(ledger);
  });

  test("截取丢弃的 hunk 接回分母并标 not-reached(truncated)", () => {
    const ledger = buildCoverageLedger(TRUNCATED_DIFF, {
      truncated: [
        { file: "src/c.ts", index: 2, old: { start: 5, count: 1 }, new: { start: 5, count: 1 } },
        { file: "src/c.ts", index: 3, old: { start: 9, count: 1 }, new: { start: 9, count: 1 } },
      ],
    });

    expect(ledger.files[0]?.hunks).toHaveLength(3);
    expect(hunkOf(ledger, "src/c.ts", 1).cause).toBe("no-signal");
    expect(hunkOf(ledger, "src/c.ts", 2)).toMatchObject({
      status: "not-reached",
      cause: "truncated",
    });
    expect(hunkOf(ledger, "src/c.ts", 3)).toMatchObject({
      status: "not-reached",
      cause: "truncated",
    });
    expect(ledger.counts.byCause.truncated).toBe(2);
    assertCoverageInvariant(ledger);
  });

  test("截取留痕引用未知文件 / 重复序号 / 非法区间时显式抛错", () => {
    expect(() =>
      buildCoverageLedger(TWO_HUNKS, {
        truncated: [
          { file: "nope.ts", index: 1, old: { start: 1, count: 1 }, new: { start: 1, count: 1 } },
        ],
      }),
    ).toThrow(/unknown file/);

    expect(() =>
      buildCoverageLedger(TWO_HUNKS, {
        truncated: [
          { file: "src/a.ts", index: 1, old: { start: 1, count: 1 }, new: { start: 1, count: 1 } },
        ],
      }),
    ).toThrow(/duplicate hunk index/);

    expect(() =>
      buildCoverageLedger(TWO_HUNKS, {
        truncated: [
          { file: "src/a.ts", index: 3, old: { start: 0, count: 1 }, new: { start: 0, count: 1 } },
        ],
      }),
    ).toThrow(/invalid line range/);
  });

  test("同一输入 → 同一账本（确定性）", () => {
    const first = buildCoverageLedger(TWO_HUNKS);
    const second = buildCoverageLedger(TWO_HUNKS);
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe("truncatedRangesFromShardRecords", () => {
  test("展开 dropped 区间；diff 前置块不产生区间", () => {
    const ranges = truncatedRangesFromShardRecords([
      {
        path: "src/c.ts",
        originalChars: 100,
        keptChars: 50,
        hunks: 2,
        keptHunks: 1,
        droppedHunks: 1,
        dropped: [
          { index: 2, old: { start: 5, count: 1 }, new: { start: 5, count: 1 } },
        ],
        droppedAdded: 1,
        droppedRemoved: 1,
      },
      {
        path: "",
        originalChars: 10,
        keptChars: 5,
        hunks: 1,
        keptHunks: 0,
        droppedHunks: 1,
        dropped: [],
        droppedAdded: 1,
        droppedRemoved: 0,
      },
    ]);

    expect(ranges).toEqual([
      {
        file: "src/c.ts",
        index: 2,
        old: { start: 5, count: 1 },
        new: { start: 5, count: 1 },
      },
    ]);
  });
});

describe("backfillCandidates", () => {
  test("按新侧行号回填 candidate，并记录来源与 finding id", () => {
    const base = buildCoverageLedger(TWO_HUNKS);
    const updated = backfillCandidates(
      base,
      [
        { id: "F001", file: "src/a.ts", line: 1 },
        { id: "F002", file: "src\\a.ts", line: 11 },
        { id: "F003", file: "./src/a.ts", line: 3 },
        { id: "F004", file: "src/a.ts", line: 99 },
      ],
      "main",
    );

    expect(hunkOf(updated, "src/a.ts", 1)).toMatchObject({
      status: "candidate",
      findingIds: ["F001", "F003"],
      sources: ["main"],
    });
    expect(hunkOf(updated, "src/a.ts", 2)).toMatchObject({
      status: "candidate",
      findingIds: ["F002"],
      sources: ["main"],
    });
    expect(updated.counts).toMatchObject({
      candidate: 2,
      notReached: 0,
      outOfHunk: 1,
    });
    expect(base.counts.notReached).toBe(2);
    assertCoverageInvariant(updated);
  });

  test("finding id 与来源去重", () => {
    const base = buildCoverageLedger(TWO_HUNKS);
    const once = backfillCandidates(
      base,
      [
        { id: "F001", file: "src/a.ts", line: 1 },
        { id: "F001", file: "src/a.ts", line: 2 },
      ],
      "main",
    );
    expect(hunkOf(once, "src/a.ts", 1).findingIds).toEqual(["F001"]);
    expect(hunkOf(once, "src/a.ts", 1).sources).toEqual(["main"]);

    const twice = backfillCandidates(
      once,
      [{ id: "F001", file: "src/a.ts", line: 2 }],
      "sweep",
    );
    expect(hunkOf(twice, "src/a.ts", 1).sources).toEqual(["main", "sweep"]);
  });

  test("与 no-issue 冲突时显式抛错", () => {
    const base = buildCoverageLedger(TWO_HUNKS);
    const claimed = markNoIssue(base, [{ file: "src/a.ts", hunkIndex: 1, reason: "仅格式化" }]);
    expect(() =>
      backfillCandidates(
        claimed,
        [{ id: "F001", file: "src/a.ts", line: 1 }],
        "main",
      ),
    ).toThrow(/conflicts with no-issue/);
  });
});

describe("markNoIssue", () => {
  test("显式声明 no-issue 并更新计数", () => {
    const base = buildCoverageLedger(TWO_HUNKS);
    const claimed = markNoIssue(base, [
      { file: "src/a.ts", hunkIndex: 1, reason: "仅格式化" },
    ]);

    expect(hunkOf(claimed, "src/a.ts", 1)).toMatchObject({
      status: "no-issue",
      reason: "仅格式化",
    });
    expect(claimed.counts).toMatchObject({ noIssue: 1, notReached: 1 });
    assertCoverageInvariant(claimed);
  });

  test("空理由 / 未知文件 / 未知 hunk / candidate 冲突都抛错", () => {
    const base = buildCoverageLedger(TWO_HUNKS);

    expect(() =>
      markNoIssue(base, [{ file: "src/a.ts", hunkIndex: 1, reason: "   " }]),
    ).toThrow(/requires a reason/);
    expect(() =>
      markNoIssue(base, [{ file: "nope.ts", hunkIndex: 1, reason: "x" }]),
    ).toThrow(/unknown file/);
    expect(() =>
      markNoIssue(base, [{ file: "src/a.ts", hunkIndex: 99, reason: "x" }]),
    ).toThrow(/unknown hunk/);

    const candidate = backfillCandidates(
      base,
      [{ id: "F001", file: "src/a.ts", line: 1 }],
      "main",
    );
    expect(() =>
      markNoIssue(candidate, [{ file: "src/a.ts", hunkIndex: 1, reason: "x" }]),
    ).toThrow(/already has candidates/);
  });

  test("重复声明同一理由幂等；不同理由抛错", () => {
    const base = buildCoverageLedger(TWO_HUNKS);
    const claimed = markNoIssue(base, [
      { file: "src/a.ts", hunkIndex: 1, reason: "仅格式化" },
    ]);
    const again = markNoIssue(claimed, [
      { file: "src/a.ts", hunkIndex: 1, reason: "仅格式化" },
    ]);
    expect(again).toEqual(claimed);
    expect(() =>
      markNoIssue(claimed, [{ file: "src/a.ts", hunkIndex: 1, reason: "另一个理由" }]),
    ).toThrow(/different reason/);
  });
});

describe("closeCoverage", () => {
  test("把 no-signal 收口为本次 run 的原因", () => {
    const base = buildCoverageLedger(TWO_HUNKS);
    const closed = closeCoverage(base, "flow-error");

    expect(closed.counts.byCause["flow-error"]).toBe(2);
    expect(closed.counts.byCause["no-signal"]).toBe(0);
    expect(
      closed.files[0]?.hunks.every(
        (hunk) => hunk.status === "not-reached" && hunk.cause === "flow-error",
      ),
    ).toBe(true);
    assertCoverageInvariant(closed);
  });

  test("首个具体原因优先，truncated / candidate / no-issue 不被覆盖", () => {
    const base = buildCoverageLedger(TRUNCATED_DIFF, {
      truncated: [
        { file: "src/c.ts", index: 2, old: { start: 5, count: 1 }, new: { start: 5, count: 1 } },
        { file: "src/c.ts", index: 3, old: { start: 9, count: 1 }, new: { start: 9, count: 1 } },
      ],
    });
    const withCandidate = backfillCandidates(
      base,
      [{ id: "F001", file: "src/c.ts", line: 1 }],
      "main",
    );
    const first = closeCoverage(withCandidate, "flow-error");
    const second = closeCoverage(first, "budget");

    expect(hunkOf(second, "src/c.ts", 1).status).toBe("candidate");
    expect(hunkOf(second, "src/c.ts", 2).cause).toBe("truncated");
    expect(hunkOf(second, "src/c.ts", 3).cause).toBe("truncated");
    expect(second.counts.byCause["flow-error"]).toBe(0);
    expect(second.counts.byCause.budget).toBe(0);
    assertCoverageInvariant(second);
  });

  test("正常结束时 no-signal 保持不变", () => {
    const base = buildCoverageLedger(TWO_HUNKS);
    expect(closeCoverage(base)).toBe(base);
  });
});

describe("mergeCoverageLedgers", () => {
  test("分片账本合并：文件并集、计数求和、顺序无关", () => {
    const left = buildCoverageLedger(diffOf("src/a.ts", ["@@ -1,1 +1,1 @@\n-x\n+y"]));
    const right = buildCoverageLedger(diffOf("src/b.ts", ["@@ -1,1 +1,1 @@\n-x\n+y"]));

    const merged = mergeCoverageLedgers([left, right]);
    expect(merged.files.map((file) => file.file)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(merged.counts.hunks).toBe(2);
    expect(mergeCoverageLedgers([right, left])).toEqual(merged);
    expect(mergeCoverageLedgers([])).toEqual(emptyCoverageLedger());
    assertCoverageInvariant(merged);
  });

  test("outOfHunk 跨片求和", () => {
    const left = buildCoverageLedger(diffOf("src/a.ts", ["@@ -1,1 +1,1 @@\n-x\n+y"]));
    const right = buildCoverageLedger(diffOf("src/b.ts", ["@@ -1,1 +1,1 @@\n-x\n+y"]));
    const leftMiss = backfillCandidates(
      left,
      [{ id: "F001", file: "src/a.ts", line: 99 }],
      "main",
    );
    const rightMiss = backfillCandidates(
      right,
      [{ id: "F002", file: "src/b.ts", line: 99 }],
      "main",
    );

    expect(mergeCoverageLedgers([leftMiss, rightMiss]).counts.outOfHunk).toBe(2);
  });

  test("同一文件出现在多个片 → 抛错", () => {
    const ledger = buildCoverageLedger(TWO_HUNKS);
    expect(() => mergeCoverageLedgers([ledger, ledger])).toThrow(
      /duplicate file across shards/,
    );
  });
});

describe("assertCoverageInvariant", () => {
  test("正常账本通过校验", () => {
    const base = buildCoverageLedger(TWO_HUNKS);
    const updated = backfillCandidates(
      base,
      [{ id: "F001", file: "src/a.ts", line: 1 }],
      "main",
    );
    const claimed = markNoIssue(updated, [
      { file: "src/a.ts", hunkIndex: 2, reason: "仅格式化" },
    ]);
    expect(() => assertCoverageInvariant(claimed)).not.toThrow();
  });

  test("计数不一致 / hunk 序号断裂 / candidate 缺 findingIds 抛错", () => {
    const base = buildCoverageLedger(TWO_HUNKS);
    expect(() =>
      assertCoverageInvariant({
        ...base,
        counts: { ...base.counts, hunks: 99 },
      }),
    ).toThrow(/counts\.hunks/);

    const first = hunkOf(base, "src/a.ts", 1);
    expect(() =>
      assertCoverageInvariant({
        ...base,
        files: [
          {
            file: "src/a.ts",
            hunks: [first, { ...hunkOf(base, "src/a.ts", 2), index: 3 }],
          },
        ],
        counts: { ...base.counts, hunks: 2, notReached: 2 },
      }),
    ).toThrow(/contiguous/);

    expect(() =>
      assertCoverageInvariant({
        ...base,
        files: [
          {
            file: "src/a.ts",
            hunks: [{ ...first, status: "candidate" }],
          },
        ],
        counts: {
          hunks: 1,
          candidate: 1,
          noIssue: 0,
          notReached: 0,
          outOfHunk: 0,
          byCause: { ...base.counts.byCause },
        },
      }),
    ).toThrow(/no findingIds/);
  });
});
