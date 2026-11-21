import { describe, expect, test } from "vitest";
import type { FetchFunction } from "@earendil-works/pi-ai";

import type { CoverageRepairLimits } from "../shared/config-limits.js";
import type { RetryPolicy } from "../shared/llm-retry.js";
import { buildCoverageLedger } from "./coverage-ledger.js";
import {
  extractDiffHunks,
  parseCoverageRepairReply,
  planCoverageRepairUnits,
  repairCoverageGaps,
} from "./coverage-repair.js";

const NO_WAIT: RetryPolicy = {
  maxAttempts: 1,
  baseDelayMs: 0,
  maxDelayMs: 0,
  maxRetryAfterMs: 0,
};

const LIMITS: CoverageRepairLimits = {
  enabled: true,
  maxRequests: 1,
  maxChars: 24_000,
  maxHunksPerRequest: 6,
};

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,3 @@",
  " const a = 1;",
  "+const b = 2;",
  " ctx",
  "@@ -10,2 +11,2 @@",
  "-old",
  "+new",
  " ctx",
  "diff --git a/src/b.ts b/src/b.ts",
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -1,1 +1,1 @@",
  "-x",
  "+y",
].join("\n");

/** 单文件版本：执行器测试只关心一个补漏请求 */
const DIFF_A = DIFF.split("diff --git a/src/b.ts")[0]!.trimEnd();

function completion(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function llm(fetch: FetchFunction) {
  return {
    baseUrl: "https://gw.example.com/v1",
    apiKey: "sk-coverage-sentinel",
    modelId: "deepseek-v4-flash",
    timeoutMs: 5_000,
    retry: NO_WAIT,
    fetch,
  };
}

function candidate(line: number, title = "空指针风险"): Record<string, unknown> {
  return {
    id: "CR001",
    severity: "P1",
    category: "可靠性",
    file: "src/a.ts",
    line,
    title,
    description: "新增行可能解引用空值",
    evidence: ["+const b = 2;"],
    rule: "NULL_SAFETY",
    confidence: 0.8,
  };
}

describe("extractDiffHunks / planCoverageRepairUnits", () => {
  test("hunk 正文与文件内序号和账本对齐", () => {
    const hunks = extractDiffHunks(DIFF);
    expect(hunks.get("src/a.ts")?.map((hunk) => hunk.index)).toEqual([1, 2]);
    expect(hunks.get("src/a.ts")?.[0]?.text).toContain("+const b = 2;");
    expect(hunks.get("src/a.ts")?.[1]?.new).toEqual({ start: 11, count: 2 });
    expect(hunks.get("src/b.ts")?.[0]?.index).toBe(1);
  });

  test("按 maxHunksPerRequest / maxChars 装箱；wholeFile 与 partial 正确", () => {
    const ledger = buildCoverageLedger(DIFF);
    const plan = planCoverageRepairUnits({
      diff: DIFF,
      ledger,
      limits: { ...LIMITS, maxRequests: 10, maxHunksPerRequest: 1 },
    });
    expect(plan.units.map((unit) => [unit.file, unit.hunks.map((hunk) => hunk.index)])).toEqual([
      ["src/a.ts", [1]],
      ["src/a.ts", [2]],
      ["src/b.ts", [1]],
    ]);
    expect(plan.units.every((unit) => unit.wholeFile)).toBe(true);
    expect(plan.skipped).toEqual([]);
  });

  test("超过 maxRequests 的缺口进 skipped（后续按 budget 收口）", () => {
    const ledger = buildCoverageLedger(DIFF);
    const plan = planCoverageRepairUnits({
      diff: DIFF,
      ledger,
      limits: { ...LIMITS, maxRequests: 1, maxHunksPerRequest: 1 },
    });
    expect(plan.units).toHaveLength(1);
    expect(plan.skipped.map((target) => `${target.file}#${String(target.hunkIndex)}`)).toEqual([
      "src/a.ts#2",
      "src/b.ts#1",
    ]);
  });

  test("已有候选的文件只带未覆盖 hunk（partial）", () => {
    const ledger = buildCoverageLedger(DIFF);
    // 手工把 hunk 1 标成 candidate，避免依赖 finding 行号匹配
    const withCandidate = {
      ...ledger,
      files: ledger.files.map((file) =>
        file.file === "src/a.ts"
          ? {
              ...file,
              hunks: file.hunks.map((hunk, index) =>
                index === 0
                  ? { ...hunk, status: "candidate" as const, findingIds: ["F001"] }
                  : hunk,
              ),
            }
          : file,
      ),
    };
    const plan = planCoverageRepairUnits({
      diff: DIFF,
      ledger: withCandidate,
      limits: { ...LIMITS, maxRequests: 10 },
    });
    const aUnits = plan.units.filter((unit) => unit.file === "src/a.ts");
    expect(aUnits).toHaveLength(1);
    expect(aUnits[0]?.wholeFile).toBe(false);
    expect(aUnits[0]?.hunks.map((hunk) => hunk.index)).toEqual([2]);
  });

  test("预算优先给整文件空缺口（wholeFile）", () => {
    const ledger = buildCoverageLedger(DIFF);
    const withCandidate = {
      ...ledger,
      files: ledger.files.map((file) =>
        file.file === "src/a.ts"
          ? {
              ...file,
              hunks: file.hunks.map((hunk, index) =>
                index === 0
                  ? { ...hunk, status: "candidate" as const, findingIds: ["F001"] }
                  : hunk,
              ),
            }
          : file,
      ),
    };
    const plan = planCoverageRepairUnits({
      diff: DIFF,
      ledger: withCandidate,
      limits: { ...LIMITS, maxRequests: 1 },
    });
    expect(plan.units).toHaveLength(1);
    expect(plan.units[0]?.file).toBe("src/b.ts");
    expect(plan.units[0]?.wholeFile).toBe(true);
  });
});

describe("parseCoverageRepairReply", () => {
  test("解析 no-issue / candidate；未知 hunk 与越界候选计 invalid", () => {
    const ledger = buildCoverageLedger(DIFF);
    const plan = planCoverageRepairUnits({
      diff: DIFF,
      ledger,
      limits: { ...LIMITS, maxRequests: 10 },
    });
    const unit = plan.units.find((entry) => entry.file === "src/a.ts");
    expect(unit).toBeDefined();
    const parsed = parseCoverageRepairReply(
      JSON.stringify({
        receipts: [
          { kind: "no-issue", hunk: 1, reason: "仅新增常量" },
          { kind: "candidate", hunk: 2, candidate: candidate(11) },
          { kind: "no-issue", hunk: 99, reason: "不在本次单元" },
          { kind: "candidate", hunk: 2, candidate: candidate(99) },
          { kind: "no-issue", hunk: 1, reason: " " },
        ],
      }),
      unit!,
    );
    expect(parsed.noIssue).toHaveLength(1);
    expect(parsed.noIssue[0]?.hunkIndex).toBe(1);
    expect(parsed.candidates).toHaveLength(1);
    expect(parsed.coveredHunks).toHaveLength(2);
    expect(parsed.invalid).toBe(3);
  });

  test("非 JSON / 缺 receipts → invalid=1", () => {
    const ledger = buildCoverageLedger(DIFF);
    const plan = planCoverageRepairUnits({ diff: DIFF, ledger, limits: LIMITS });
    const unit = plan.units[0];
    expect(unit).toBeDefined();
    expect(parseCoverageRepairReply("not json", unit!).invalid).toBe(1);
    expect(parseCoverageRepairReply('{"items":[]}', unit!).invalid).toBe(1);
  });
});

describe("repairCoverageGaps", () => {
  test("no-issue + candidate 回填账本；候选走候选门；审计计数", async () => {
    const ledger = buildCoverageLedger(DIFF_A);
    const bodies: string[] = [];
    const fetch: FetchFunction = async (_url, init) => {
      bodies.push(String(init?.body ?? ""));
      return completion(
        JSON.stringify({
          receipts: [
            { kind: "no-issue", hunk: 1, reason: "仅新增常量，无副作用" },
            { kind: "candidate", hunk: 2, candidate: candidate(11) },
          ],
        }),
      );
    };

    const result = await repairCoverageGaps({
      diff: DIFF_A,
      ledger,
      findings: [],
      limits: { ...LIMITS, maxRequests: 10 },
      llm: llm(fetch),
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.file).toBe("src/a.ts");
    const a = result.ledger.files.find((file) => file.file === "src/a.ts");
    expect(a?.hunks[0]?.status).toBe("no-issue");
    expect(a?.hunks[0]?.reason).toBe("仅新增常量，无副作用");
    expect(a?.hunks[1]?.status).toBe("candidate");
    expect(a?.hunks[1]?.sources).toEqual(["repair"]);
    expect(result.audit).toMatchObject({
      enabled: true,
      requests: 1,
      failedRequests: 0,
      hunksSent: 2,
      hunksCovered: 2,
      noIssue: 1,
      acceptedFindings: 1,
    });
    expect(bodies).toHaveLength(1);
    const body = JSON.parse(bodies[0] ?? "{}") as {
      response_format?: { type?: string };
      messages?: { content?: string }[];
    };
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages?.[0]?.content ?? "").not.toContain("sk-coverage-sentinel");
    expect(body.messages?.[1]?.content ?? "").toContain("### Hunk 1");
  });

  test("候选与已有意见重复 → 候选门拒绝，hunk 保持未覆盖", async () => {
    const ledger = buildCoverageLedger(DIFF_A);
    const existing = {
      id: "F001",
      severity: "P1" as const,
      category: "可靠性",
      file: "src/a.ts",
      line: 11,
      title: "空指针风险",
      description: "已有意见",
      evidence: ["+new"],
      rule: "NULL_SAFETY",
      confidence: 0.8,
    };
    const fetch: FetchFunction = async () =>
      completion(
        JSON.stringify({
          receipts: [{ kind: "candidate", hunk: 2, candidate: candidate(11) }],
        }),
      );
    const result = await repairCoverageGaps({
      diff: DIFF_A,
      ledger,
      findings: [existing],
      limits: { ...LIMITS, maxRequests: 10 },
      llm: llm(fetch),
    });
    expect(result.findings).toHaveLength(0);
    expect(result.audit.acceptedFindings).toBe(0);
    expect(result.audit.rejectedCandidates).toBe(1);
    const a = result.ledger.files.find((file) => file.file === "src/a.ts");
    expect(a?.hunks[1]?.status).toBe("not-reached");
  });

  test("调用失败 → 账本不变，failedRequests 记账", async () => {
    const ledger = buildCoverageLedger(DIFF_A);
    const fetch: FetchFunction = async () => new Response("boom", { status: 500 });
    const result = await repairCoverageGaps({
      diff: DIFF_A,
      ledger,
      findings: [],
      limits: LIMITS,
      llm: llm(fetch),
    });
    expect(result.findings).toHaveLength(0);
    expect(result.audit.failedRequests).toBe(1);
    expect(result.ledger).toEqual(ledger);
  });

  test("超过 maxRequests 的缺口标 not-reached(budget)", async () => {
    const ledger = buildCoverageLedger(DIFF_A);
    const fetch: FetchFunction = async () =>
      completion(JSON.stringify({ receipts: [{ kind: "no-issue", hunk: 1, reason: "无问题" }] }));
    const result = await repairCoverageGaps({
      diff: DIFF_A,
      ledger,
      findings: [],
      limits: { ...LIMITS, maxRequests: 1, maxHunksPerRequest: 1 },
      llm: llm(fetch),
    });
    const a = result.ledger.files.find((file) => file.file === "src/a.ts");
    expect(a?.hunks[0]?.status).toBe("no-issue");
    expect(a?.hunks[1]?.status).toBe("not-reached");
    expect(a?.hunks[1]?.cause).toBe("budget");
    expect(result.audit.skippedByBudget).toBe(1);
  });

  test("enabled=false → 不请求、不改账本", async () => {
    const ledger = buildCoverageLedger(DIFF_A);
    let calls = 0;
    const fetch: FetchFunction = async () => {
      calls += 1;
      return completion('{"receipts":[]}');
    };
    const result = await repairCoverageGaps({
      diff: DIFF_A,
      ledger,
      findings: [],
      limits: { ...LIMITS, enabled: false },
      llm: llm(fetch),
    });
    expect(calls).toBe(0);
    expect(result.ledger).toEqual(ledger);
    expect(result.audit.enabled).toBe(false);
  });
});
