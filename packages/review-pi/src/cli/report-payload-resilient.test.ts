import { expect, test } from "vitest";

import type { FetchFunction } from "@earendil-works/pi-ai";

import type { Finding } from "../contracts/finding.js";
import { buildShardReportResilient } from "./report-payload.js";

// 片级报文生成的分批重试（ADR-0058）：全量一次成功 = 零额外调用；失败才按
// 条数二分，部分成功照常回报，仍失败的逐条登记 uncovered。

const RUNTIME = {
  apiKey: "offline-test",
  baseUrl: "http://127.0.0.1:9/v1",
  modelId: "test-model",
  timeoutMs: 5_000,
  retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, maxRetryAfterMs: 0 },
} as const;

function finding(id: string, overrides: Partial<Finding> = {}): Finding {
  return {
    id,
    severity: "P2",
    category: "SECURITY",
    file: "src/Foo.java",
    line: 10,
    title: `Defect ${id}`,
    description: "User input flows into a dangerous sink.",
    evidence: [`src/Foo.java:10 ${id}`],
    rule: "",
    confidence: 0.9,
    ...overrides,
  };
}

function tipFor(id: string): Record<string, string> {
  return {
    id,
    category: "安全",
    subcategory: "输入校验",
    review: `[安全] ${id} 未校验。影响评估：可被利用。`,
    suggestion: `[重构思路] 校验 ${id}。代码示例：\`check(${id});\``,
  };
}

/**
 * 假网关：从 user message 解析本批 finding id；`failWhen` 命中的批次抛
 * TimeoutError（与真实超时同形：name=TimeoutError，可重试）。
 */
function gateway(options: { readonly failWhen?: (ids: readonly string[]) => boolean } = {}): {
  readonly fetch: FetchFunction;
  readonly calls: readonly (readonly string[])[];
} {
  const calls: string[][] = [];
  const fetch: FetchFunction = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      messages?: readonly { readonly role: string; readonly content: string }[];
    };
    const user = body.messages?.[1]?.content ?? "";
    const entries = JSON.parse(user.slice(user.indexOf("["))) as readonly { readonly id: string }[];
    const ids = entries.map((entry) => entry.id);
    calls.push(ids);
    if (options.failWhen?.(ids) ?? false) {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      throw error;
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: JSON.stringify({ tips: ids.map(tipFor) }) } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return { fetch, calls };
}

function codeFor(findings: readonly Finding[]): Record<string, string> {
  return Object.fromEntries(findings.map((entry) => [entry.id, `line-of-${entry.id};`]));
}

test("全量一次成功：不拆分、零额外调用、不产生 split 留痕", async () => {
  const findings = [finding("F001"), finding("F002", { file: "src/Bar.java", line: 20 })];
  const stub = gateway();
  const run = await buildShardReportResilient({
    findings,
    codeByFinding: codeFor(findings),
    runtime: RUNTIME,
    fetch: stub.fetch,
  });

  expect(run.split).toBeUndefined();
  expect(stub.calls).toEqual([["F001", "F002"]]);
  expect(run.outcome.kind).toBe("ok");
  if (run.outcome.kind !== "ok") {
    return;
  }
  expect(run.outcome.files.map((file) => file.filePath)).toEqual(["src/Foo.java", "src/Bar.java"]);
  expect(run.outcome.files.flatMap((file) => file.reviewTips)).toHaveLength(2);
});

test("全量超时 → 二分重试，两批都成功（合并回完整报文，顺序不变）", async () => {
  const findings = [
    finding("F001"),
    finding("F002", { line: 11 }),
    finding("F003", { file: "src/Bar.java", line: 20 }),
    finding("F004", { file: "src/Bar.java", line: 21 }),
  ];
  const stub = gateway({ failWhen: (ids) => ids.length > 2 });
  const run = await buildShardReportResilient({
    findings,
    codeByFinding: codeFor(findings),
    runtime: RUNTIME,
    fetch: stub.fetch,
  });

  // 首次全量 + 两个半批
  expect(stub.calls).toEqual([
    ["F001", "F002", "F003", "F004"],
    ["F001", "F002"],
    ["F003", "F004"],
  ]);
  expect(run.split).toEqual({ batches: 2, succeeded: 2 });
  expect(run.outcome.kind).toBe("ok");
  if (run.outcome.kind !== "ok") {
    return;
  }
  expect(run.outcome.files.map((file) => [file.filePath, file.reviewTips.length])).toEqual([
    ["src/Foo.java", 2],
    ["src/Bar.java", 2],
  ]);
  expect(run.outcome.uncoveredByKey.size).toBe(0);
});

test("部分批次失败：成功条目照常上报，失败条目逐条登记 uncovered（不放空包）", async () => {
  const findings = [finding("F001"), finding("F002", { line: 11 }), finding("F003", { line: 12 })];
  // 只允许单条批次成功：两条及以上都超时
  const stub = gateway({ failWhen: (ids) => ids.length > 1 });
  const run = await buildShardReportResilient(
    { findings, codeByFinding: codeFor(findings), runtime: RUNTIME, fetch: stub.fetch },
    { maxSplitDepth: 1 },
  );

  expect(run.split).toEqual({ batches: 2, succeeded: 1 });
  expect(run.outcome.kind).toBe("ok");
  if (run.outcome.kind !== "ok") {
    return;
  }
  // 只有 F003 单独成批成功；F001/F002 所在批仍失败
  expect(run.outcome.files.map((file) => file.findings.map((entry) => entry.id))).toEqual([["F003"]]);
  expect([...run.outcome.uncoveredByKey.keys()].sort()).toHaveLength(2);
  for (const reason of run.outcome.uncoveredByKey.values()) {
    expect(reason).toContain("已拆分为更小批次仍失败");
  }
});

test("全部批次失败：整片失败，原因带拆分次数", async () => {
  const findings = [finding("F001"), finding("F002", { line: 11 })];
  const stub = gateway({ failWhen: () => true });
  const run = await buildShardReportResilient(
    { findings, codeByFinding: codeFor(findings), runtime: RUNTIME, fetch: stub.fetch },
    { maxSplitDepth: 1 },
  );

  expect(run.outcome.kind).toBe("failed");
  if (run.outcome.kind !== "failed") {
    return;
  }
  expect(run.outcome.reason).toContain("拆分为 2 批后仍全部失败");
  expect(run.outcome.reason).toContain("aborted due to timeout");
  expect(run.split).toEqual({ batches: 2, succeeded: 0 });
});

test("maxSplitDepth=0：回退到不拆分（与 ADR-0058 之前的行为一致）", async () => {
  const findings = [finding("F001"), finding("F002", { line: 11 })];
  const stub = gateway({ failWhen: () => true });
  const run = await buildShardReportResilient(
    { findings, codeByFinding: codeFor(findings), runtime: RUNTIME, fetch: stub.fetch },
    { maxSplitDepth: 0 },
  );

  expect(stub.calls).toEqual([["F001", "F002"]]);
  expect(run.split).toBeUndefined();
  expect(run.outcome.kind).toBe("failed");
});

test("单条 finding 失败：没有可拆的批次，原样失败", async () => {
  const findings = [finding("F001")];
  const stub = gateway({ failWhen: () => true });
  const run = await buildShardReportResilient({
    findings,
    codeByFinding: codeFor(findings),
    runtime: RUNTIME,
    fetch: stub.fetch,
  });

  expect(stub.calls).toEqual([["F001"]]);
  expect(run.split).toBeUndefined();
  expect(run.outcome.kind).toBe("failed");
});

test("拆分批次只尝试一次：不继承全量调用的重试次数", async () => {
  const findings = [
    finding("F001"),
    finding("F002", { line: 11 }),
    finding("F003", { file: "src/Bar.java", line: 20 }),
  ];
  const stub = gateway({ failWhen: (ids) => ids.length > 1 });
  const run = await buildShardReportResilient(
    {
      findings,
      codeByFinding: codeFor(findings),
      runtime: {
        ...RUNTIME,
        retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, maxRetryAfterMs: 0 },
      },
      fetch: stub.fetch,
    },
    { maxSplitDepth: 1 },
  );

  // 全量：3 次尝试全超时（3 次调用）；拆分后每批只 1 次：两条的批失败、
  // 一条的批成功 → 共 3 + 2 次
  expect(stub.calls).toHaveLength(5);
  expect(run.split).toEqual({ batches: 2, succeeded: 1 });
});

test("同一文件横跨两批：合并为一个文件组，tips 保持原 finding 顺序", async () => {
  const findings = [finding("F001", { line: 10 }), finding("F002", { line: 11 })];
  const stub = gateway({ failWhen: (ids) => ids.length > 1 });
  const run = await buildShardReportResilient({
    findings,
    codeByFinding: codeFor(findings),
    runtime: RUNTIME,
    fetch: stub.fetch,
  });

  expect(run.outcome.kind).toBe("ok");
  if (run.outcome.kind !== "ok") {
    return;
  }
  expect(run.outcome.files).toHaveLength(1);
  expect(run.outcome.files[0]?.reviewTips.map((tip) => tip.lineNum)).toEqual(["10", "11"]);
  expect(run.outcome.files[0]?.findings.map((entry) => entry.id)).toEqual(["F001", "F002"]);
});

test("拆分成功时语义登记与全覆盖一致（tips 侧不会漏条）", async () => {
  const findings = [finding("F001"), finding("F002", { line: 11 })];
  const stub = gateway({ failWhen: (ids) => ids.length > 1 });
  const run = await buildShardReportResilient({
    findings,
    codeByFinding: codeFor(findings),
    runtime: RUNTIME,
    fetch: stub.fetch,
  });

  expect(run.outcome.kind).toBe("ok");
  if (run.outcome.kind !== "ok") {
    return;
  }
  // 页面上两个 finding 都有语义条目（tips 的 12 键来源），且没有 uncovered
  expect(run.outcome.semanticByKey.size).toBe(2);
  expect(run.outcome.uncoveredByKey.size).toBe(0);
});
