import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";

import { fakeFetch, type FakeReply } from "../provider/fake-fetch.js";
import { runRepoSpike } from "./run.js";
import type { RepoSpikeOptions } from "./types.js";

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function write(root: string, rel: string, content: string): void {
  const full = path.join(root, ...rel.split("/"));
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function options(root: string, out: string, overrides: Partial<RepoSpikeOptions> = {}): RepoSpikeOptions {
  return {
    repoPath: root,
    outDir: out,
    groupBy: "none",
    maxFilesPerGroup: 10,
    maxGroupChars: 80_000,
    maxGroups: 500,
    maxFiles: 20,
    maxFileChars: 120_000,
    maxRounds: 1,
    groupConcurrency: 1,
    includeTests: false,
    dryRun: false,
    ...overrides,
  };
}

const ZERO = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 } as const;

/** 一轮零工具：六相位各一条回复（stageCompression 缺省 off）。 */
function sixPhase(): FakeReply[] {
  return [
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: '{"candidates":[]}', usage: ZERO },
    { text: '{"verdicts":[],"complete":true}', usage: ZERO },
  ];
}

afterAll(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dry-run：枚举 + 分组 + 合成 diff，不触模型，写 plan", async () => {
  const root = tempDir("repo-spike-run-root-");
  const out = tempDir("repo-spike-run-out-");
  write(root, "src/a.ts", "export const a = 1;\n");
  write(root, "src/b.ts", "export const b = 2;\n");

  const code = await runRepoSpike(
    options(root, out, { dryRun: true }),
    { now: () => new Date("2026-11-24T00:00:00.000Z") },
  );

  expect(code).toBe(0);
  expect(existsSync(path.join(out, "repo-review-plan.json"))).toBe(true);
  expect(existsSync(path.join(out, "repo-spike-plan.json"))).toBe(true);
  expect(existsSync(path.join(out, "repo-review-result.json"))).toBe(false);

  const plan = JSON.parse(readFileSync(path.join(out, "repo-review-plan.json"), "utf8")) as {
    mode: string;
    groups: { key: string; files: string[] }[];
    files: { discovered: number; selected: number };
  };
  expect(plan.mode).toBe("repo-review-plan");
  expect(plan.files).toMatchObject({ discovered: 2, selected: 2 });
  expect(plan.groups).toHaveLength(2);
  expect(plan.groups.map((group) => group.files)).toEqual([["src/a.ts"], ["src/b.ts"]]);
});

test("dry-run：大文件超过 maxGroupChars 但不超过 maxFileChars 时单独成组", async () => {
  const root = tempDir("repo-spike-run-root-");
  const out = tempDir("repo-spike-run-out-");
  write(root, "src/a/small-one.ts", "a".repeat(1_000));
  write(root, "src/a/small-two.ts", "b".repeat(1_000));
  write(root, "src/a/z-large.ts", "c".repeat(5_000));

  const code = await runRepoSpike(
    options(root, out, { dryRun: true, groupBy: "directory", maxGroupChars: 3_000 }),
    { now: () => new Date("2026-11-24T00:00:00.000Z") },
  );

  expect(code).toBe(0);
  const plan = JSON.parse(readFileSync(path.join(out, "repo-review-plan.json"), "utf8")) as {
    groups: { files: string[]; soloLarge?: boolean }[];
    skippedFiles: { path: string; reason: string }[];
  };
  expect(plan.groups).toEqual([
    expect.objectContaining({ files: ["src/a/small-one.ts", "src/a/small-two.ts"] }),
    expect.objectContaining({ files: ["src/a/z-large.ts"], soloLarge: true }),
  ]);
  expect(plan.skippedFiles).toEqual([]);
});

test("repo 模式：模型消息是中性文件快照 + scan 提示，run.json source=repo-scan", async () => {
  const root = tempDir("repo-spike-run-root-");
  const out = tempDir("repo-spike-run-out-");
  write(root, "src/a.ts", "export const a = 1;\n");

  const script = fakeFetch(sixPhase());
  const bodies: string[] = [];
  const captureFetch: typeof script.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    bodies.push(await request.clone().text());
    return script.fetch(input, init);
  };
  const code = await runRepoSpike(options(root, out), {
    apiKey: "test-key",
    baseUrl: "http://example.invalid",
    fetch: captureFetch,
    now: () => new Date("2026-11-24T00:00:00.000Z"),
  });

  expect(code).toBe(0);
  expect(bodies).toHaveLength(6);
  const first = bodies[0] ?? "";
  expect(first).toContain("仓库快照");
  expect(first).toContain("Repository snapshot under review.");
  expect(first).toContain("=== src/a.ts ===");
  expect(first).not.toContain("new file mode");
  expect(first).not.toContain("Unified diff");
  // 六阶段消息也不能出现 MR 的变更语义。
  expect(bodies.join("\n")).not.toContain("本次合并请求的 unified diff");

  const runDirs = readdirSync(path.join(out, "runs"));
  expect(runDirs).toHaveLength(1);
  const record = JSON.parse(
    readFileSync(path.join(out, "runs", runDirs[0] ?? "", "runs", "run.json"), "utf8"),
  ) as { source: string };
  expect(record.source).toBe("repo-scan");
});

test("路径修复：候选 file 少数拼写错误 → 修正到真实送检文件（ADR-0120）", async () => {
  const root = tempDir("repo-spike-run-root-");
  const out = tempDir("repo-spike-run-out-");
  write(root, "src/util/helper.ts", "export const helper = 1;\n");

  const candidate = {
    id: "F001",
    severity: "P2",
    category: "可维护",
    file: "src/utli/helper.ts",
    line: 1,
    title: "导出常量未使用",
    description: "该常量未被引用。",
    evidence: ["src/utli/helper.ts:1 export const helper = 1;"],
    rule: "",
    confidence: 0.9,
    tips: {
      review: "[缺陷类型] 未使用。影响评估：无。",
      suggestion: "[重构思路] 删除。代码示例：```删除```",
      subcategory: "未使用代码",
    },
  };
  const script = fakeFetch([
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: `{"candidates":[${JSON.stringify(candidate)}]}`, usage: ZERO },
    {
      text: '{"verdicts":[{"id":"F001","pass":true,"reason":"ok"}],"complete":true}',
      usage: ZERO,
    },
  ]);
  const code = await runRepoSpike(options(root, out), {
    apiKey: "test-key",
    baseUrl: "http://example.invalid",
    fetch: script.fetch,
    now: () => new Date("2026-11-24T00:00:00.000Z"),
  });

  expect(code).toBe(0);
  const result = JSON.parse(readFileSync(path.join(out, "repo-review-result.json"), "utf8")) as {
    findings: { file: string }[];
    coverage: { files: { path: string; state: string; findingIds?: string[] }[] };
  };
  expect(result.findings).toHaveLength(1);
  expect(result.findings[0]?.file).toBe("src/util/helper.ts");
  expect(result.coverage.files).toEqual([
    { path: "src/util/helper.ts", state: "candidate", findingIds: ["F001"] },
  ]);

  const groupDir = readdirSync(path.join(out, "runs"))[0] ?? "";
  const reviews = JSON.parse(
    readFileSync(path.join(out, "runs", groupDir, "runs", "reviews_all.json"), "utf8"),
  ) as { findings: { file: string }[] };
  expect(reviews.findings[0]?.file).toBe("src/util/helper.ts");
  const record = JSON.parse(
    readFileSync(path.join(out, "runs", groupDir, "runs", "run.json"), "utf8"),
  ) as { baseline?: { audit?: { pathRepairs?: { from: string; to: string }[] } } };
  expect(record.baseline?.audit?.pathRepairs).toEqual([
    { from: "src/utli/helper.ts", to: "src/util/helper.ts", distance: 2 },
  ]);
});

test("真跑：通用建议类抑制在 repo 模式同样生效，审计留痕", async () => {
  const root = tempDir("repo-spike-run-root-");
  const out = tempDir("repo-spike-run-out-");
  write(root, "src/a.ts", "export const a = 1;\n");
  const candidate = {
    id: "F001",
    severity: "P3",
    category: "可维护",
    file: "src/a.ts",
    line: 1,
    title: "缺少导出常量注释",
    description: "导出的常量没有说明用途。",
    evidence: ["src/a.ts:1 export const a = 1;"],
    rule: "MAINTAINABILITY-001",
    confidence: 0.7,
    tips: {
      review: "[缺陷类型] 缺少注释。影响评估：可读性下降。",
      suggestion: "[重构思路] 补充一行注释。代码示例：`// a`",
      subcategory: "注释",
    },
  };
  const script = fakeFetch([
    ...sixPhase().slice(0, 4),
    { text: `{"candidates":[${JSON.stringify(candidate)}]}`, usage: ZERO },
    {
      text: '{"verdicts":[{"id":"F001","pass":true,"reason":"ok"}],"complete":true}',
      usage: ZERO,
    },
  ]);
  const code = await runRepoSpike(options(root, out), {
    apiKey: "test-key",
    baseUrl: "http://example.invalid",
    fetch: script.fetch,
    now: () => new Date("2026-11-24T00:00:00.000Z"),
  });

  expect(code).toBe(0);
  const result = JSON.parse(readFileSync(path.join(out, "repo-review-result.json"), "utf8")) as {
    findings: unknown[];
    groups: { auditPath?: string }[];
  };
  expect(result.findings).toEqual([]);
  const auditPath = result.groups[0]?.auditPath;
  expect(auditPath).toBeDefined();
  const audit = JSON.parse(readFileSync(auditPath as string, "utf8")) as {
    genericReview?: { dropped: number; bySeverity: Record<string, number> };
  };
  expect(audit.genericReview).toMatchObject({ dropped: 1, bySeverity: { P3: 1 } });
});

test("真跑：每组一次 runReviewOutcome，findings 合并后写独立结果", async () => {
  const root = tempDir("repo-spike-run-root-");
  const out = tempDir("repo-spike-run-out-");
  write(root, "src/a.ts", "export const a = 1;\n");
  write(root, "src/b.ts", "export const b = 2;\n");

  const script = fakeFetch([...sixPhase(), ...sixPhase()]);
  const code = await runRepoSpike(options(root, out), {
    apiKey: "test-key",
    baseUrl: "http://example.invalid",
    fetch: script.fetch,
    now: () => new Date("2026-11-24T00:00:00.000Z"),
  });

  expect(code).toBe(0);
  expect(script.requests).toHaveLength(12);

  const result = JSON.parse(readFileSync(path.join(out, "repo-review-result.json"), "utf8")) as {
    mode: string;
    groups: { status: string; files: string[]; findingsCount: number }[];
    findings: unknown[];
    files: { selected: number };
    coverage: {
      summary: { selected: number; candidate: number; noIssue: number; notReached: number };
      files: { path: string; state: string }[];
    };
  };
  expect(result.mode).toBe("repo");
  expect(result.files.selected).toBe(2);
  expect(result.groups).toHaveLength(2);
  expect(result.groups.every((group) => group.status === "reviewed")).toBe(true);
  expect(result.findings).toEqual([]);
  expect(result.coverage.summary).toEqual({
    selected: 2,
    candidate: 0,
    noIssue: 2,
    notReached: 0,
  });
  expect(result.coverage.files.map((item) => item.state)).toEqual(["no-issue", "no-issue"]);
  // 过渡期旧文件名仍写一份，内容一致。
  expect(existsSync(path.join(out, "repo-spike-result.json"))).toBe(true);
  const legacy = readFileSync(path.join(out, "repo-spike-result.json"), "utf8");
  expect(legacy).toBe(readFileSync(path.join(out, "repo-review-result.json"), "utf8"));
});

function sixPhaseWithUsage(usage: FakeReply["usage"]): FakeReply[] {
  return sixPhase().map((reply) => ({ ...reply, usage }));
}

test("resume：done 组不重新请求，job 完成", async () => {
  const root = tempDir("repo-spike-run-root-");
  const out = tempDir("repo-spike-run-out-");
  write(root, "src/a.ts", "export const a = 1;\n");
  write(root, "src/b.ts", "export const b = 2;\n");

  const first = fakeFetch([
    ...sixPhaseWithUsage({ promptTokens: 10, completionTokens: 0, cacheReadTokens: 0 }),
    ...sixPhaseWithUsage({ promptTokens: 10, completionTokens: 0, cacheReadTokens: 0 }),
  ]);
  const code = await runRepoSpike(options(root, out), {
    apiKey: "test-key",
    baseUrl: "http://example.invalid",
    fetch: first.fetch,
    now: () => new Date("2026-11-24T00:00:00.000Z"),
  });
  expect(code).toBe(0);

  const job = JSON.parse(readFileSync(path.join(out, "job.json"), "utf8")) as {
    status: string;
    spentTokens: number;
    groups: { status: string; attempts: number }[];
  };
  expect(job.status).toBe("completed");
  expect(job.groups.map((group) => group.status)).toEqual(["done", "done"]);
  expect(job.spentTokens).toBeGreaterThan(0);

  const second = fakeFetch([]);
  const resumeCode = await runRepoSpike(options(root, out, { resume: true }), {
    apiKey: "test-key",
    baseUrl: "http://example.invalid",
    fetch: second.fetch,
    now: () => new Date("2026-11-24T01:00:00.000Z"),
  });
  expect(resumeCode).toBe(0);
  expect(second.requests).toHaveLength(0);
});

test("预算：达到 maxTotalTokens 后停止派发，剩余组 not-reached；resume 可继续", async () => {
  const root = tempDir("repo-spike-run-root-");
  const out = tempDir("repo-spike-run-out-");
  write(root, "src/a.ts", "export const a = 1;\n");
  write(root, "src/b.ts", "export const b = 2;\n");

  const first = fakeFetch(
    sixPhaseWithUsage({ promptTokens: 10, completionTokens: 0, cacheReadTokens: 0 }),
  );
  const code = await runRepoSpike(options(root, out, { groupConcurrency: 1, maxTotalTokens: 1 }), {
    apiKey: "test-key",
    baseUrl: "http://example.invalid",
    fetch: first.fetch,
    now: () => new Date("2026-11-24T00:00:00.000Z"),
  });
  expect(code).toBe(2);

  const job = JSON.parse(readFileSync(path.join(out, "job.json"), "utf8")) as {
    status: string;
    groups: { status: string; skipReason?: string }[];
  };
  expect(job.status).toBe("partial");
  expect(job.groups.map((group) => group.status)).toEqual(["done", "skipped"]);
  expect(job.groups[1]?.skipReason).toBe("budget-exhausted");

  const partial = JSON.parse(readFileSync(path.join(out, "repo-review-result.json"), "utf8")) as {
    coverage: { summary: { notReached: number }; files: { state: string; reason?: string }[] };
  };
  expect(partial.coverage.summary.notReached).toBe(1);
  expect(partial.coverage.files.some((file) => file.reason === "budget-exhausted")).toBe(true);

  const second = fakeFetch(sixPhase());
  const resumeCode = await runRepoSpike(options(root, out, { resume: true, groupConcurrency: 1 }), {
    apiKey: "test-key",
    baseUrl: "http://example.invalid",
    fetch: second.fetch,
    now: () => new Date("2026-11-24T01:00:00.000Z"),
  });
  expect(resumeCode).toBe(0);
  expect(second.requests).toHaveLength(6);
  const done = JSON.parse(readFileSync(path.join(out, "job.json"), "utf8")) as {
    status: string;
    groups: { status: string }[];
  };
  expect(done.status).toBe("completed");
  expect(done.groups.map((group) => group.status)).toEqual(["done", "done"]);
});

test("resume：快照内容变化 → 拒绝续跑", async () => {
  const root = tempDir("repo-spike-run-root-");
  const out = tempDir("repo-spike-run-out-");
  write(root, "src/a.ts", "export const a = 1;\n");

  const first = fakeFetch(sixPhase());
  await runRepoSpike(options(root, out), {
    apiKey: "test-key",
    baseUrl: "http://example.invalid",
    fetch: first.fetch,
    now: () => new Date("2026-11-24T00:00:00.000Z"),
  });

  write(root, "src/a.ts", "export const a = 2;\n");
  const second = fakeFetch([]);
  await expect(
    runRepoSpike(options(root, out, { resume: true }), {
      apiKey: "test-key",
      baseUrl: "http://example.invalid",
      fetch: second.fetch,
      now: () => new Date("2026-11-24T01:00:00.000Z"),
    }),
  ).rejects.toThrow(/cannot resume: snapshot/);
});

test("临时错误：同一组按 groupAttempts 重试", async () => {
  const root = tempDir("repo-spike-run-root-");
  const out = tempDir("repo-spike-run-out-");
  write(root, "src/a.ts", "export const a = 1;\n");

  const script = fakeFetch(sixPhase());
  let failedOnce = false;
  const flaky: typeof script.fetch = async (input, init) => {
    if (!failedOnce) {
      failedOnce = true;
      throw new Error("500 upstream unavailable");
    }
    return script.fetch(input, init);
  };
  const code = await runRepoSpike(options(root, out, { groupAttempts: 2 }), {
    apiKey: "test-key",
    baseUrl: "http://example.invalid",
    fetch: flaky,
    now: () => new Date("2026-11-24T00:00:00.000Z"),
  });
  expect(code).toBe(0);
  expect(script.requests).toHaveLength(6);
  const job = JSON.parse(readFileSync(path.join(out, "job.json"), "utf8")) as {
    groups: { status: string; attempts: number }[];
  };
  expect(job.groups[0]?.status).toBe("done");
  expect(job.groups[0]?.attempts).toBe(2);
});

test("永久错误：不按 groupAttempts 重试", async () => {
  const root = tempDir("repo-spike-run-root-");
  const out = tempDir("repo-spike-run-out-");
  write(root, "src/a.ts", "export const a = 1;\n");

  const fetchImpl: typeof globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: "unauthorized" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  const code = await runRepoSpike(options(root, out, { groupAttempts: 3 }), {
    apiKey: "test-key",
    baseUrl: "http://example.invalid",
    fetch: fetchImpl,
    now: () => new Date("2026-11-24T00:00:00.000Z"),
  });
  expect(code).toBe(1);
  const job = JSON.parse(readFileSync(path.join(out, "job.json"), "utf8")) as {
    groups: { status: string; attempts: number }[];
  };
  expect(job.groups[0]?.status).toBe("failed");
  expect(job.groups[0]?.attempts).toBe(1);
});

test("上报缝：每个 reviewed 组完成后回调一次，携带组文件与 findings", async () => {
  const root = tempDir("repo-spike-run-root-");
  const out = tempDir("repo-spike-run-out-");
  write(root, "src/a.ts", "export const a = 1;\n");
  write(root, "src/b.ts", "export const b = 2;\n");

  const calls: { index: number; key: string; files: readonly string[] }[] = [];
  const code = await runRepoSpike(options(root, out, { groupBy: "files", maxFilesPerGroup: 1 }), {
    apiKey: "test-key",
    baseUrl: "http://example.invalid",
    fetch: fakeFetch([...sixPhase(), ...sixPhase()]).fetch,
    now: () => new Date("2026-11-24T00:00:00.000Z"),
    onGroupReviewed: async (batch) => {
      calls.push({ index: batch.index, key: batch.key, files: batch.files });
      expect(batch.findings).toEqual([]);
    },
  });

  expect(code).toBe(0);
  expect(calls).toHaveLength(2);
  expect(calls.map((call) => call.files)).toEqual([["src/a.ts"], ["src/b.ts"]]);
});

test("上报缝：回调抛错不影响检视结果与退出码", async () => {
  const root = tempDir("repo-spike-run-root-");
  const out = tempDir("repo-spike-run-out-");
  write(root, "src/a.ts", "export const a = 1;\n");

  const code = await runRepoSpike(options(root, out), {
    apiKey: "test-key",
    baseUrl: "http://example.invalid",
    fetch: fakeFetch(sixPhase()).fetch,
    now: () => new Date("2026-11-24T00:00:00.000Z"),
    onGroupReviewed: () => Promise.reject(new Error("report down")),
  });

  expect(code).toBe(0);
  expect(existsSync(path.join(out, "repo-review-result.json"))).toBe(true);
});

test("续跑：done 组不触发上报缝", async () => {
  const root = tempDir("repo-spike-run-root-");
  const out = tempDir("repo-spike-run-out-");
  write(root, "src/a.ts", "export const a = 1;\n");

  const deps = {
    apiKey: "test-key",
    baseUrl: "http://example.invalid",
    fetch: fakeFetch(sixPhase()).fetch,
    now: () => new Date("2026-11-24T00:00:00.000Z"),
  } as const;
  expect(await runRepoSpike(options(root, out), deps)).toBe(0);

  let reportCalls = 0;
  expect(
    await runRepoSpike(options(root, out, { resume: true }), {
      ...deps,
      onGroupReviewed: async () => {
        reportCalls += 1;
      },
    }),
  ).toBe(0);
  expect(reportCalls).toBe(0);
});

test("语言规则：repo 开关打开时只在 Phase 5 注入 <rules for>", async () => {
  const root = tempDir("repo-spike-run-root-");
  const out = tempDir("repo-spike-run-out-");
  write(root, "src/a.ts", "export const a = 1;\n");

  const script = fakeFetch(sixPhase());
  const bodies: string[] = [];
  const captureFetch: typeof script.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    bodies.push(await request.clone().text());
    return script.fetch(input, init);
  };
  const code = await runRepoSpike(options(root, out), {
    apiKey: "test-key",
    baseUrl: "http://example.invalid",
    fetch: captureFetch,
    now: () => new Date("2026-11-24T00:00:00.000Z"),
    languageRules: { mr: false, repo: true },
  });

  expect(code).toBe(0);
  expect(bodies).toHaveLength(6);
  expect(bodies[0]).not.toContain("<rules for=");
  expect(bodies[4]).toContain("<rules for=");
  expect(bodies[4]).toContain("src/a.ts");
  expect(bodies[4]).toContain("以下是与本组文件语言相关的缺陷检查清单。");
});

test("语言规则：缺省关闭时 Phase 5 不注入规则", async () => {
  const root = tempDir("repo-spike-run-root-");
  const out = tempDir("repo-spike-run-out-");
  write(root, "src/a.ts", "export const a = 1;\n");

  const script = fakeFetch(sixPhase());
  const bodies: string[] = [];
  const captureFetch: typeof script.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    bodies.push(await request.clone().text());
    return script.fetch(input, init);
  };
  const code = await runRepoSpike(options(root, out), {
    apiKey: "test-key",
    baseUrl: "http://example.invalid",
    fetch: captureFetch,
    now: () => new Date("2026-11-24T00:00:00.000Z"),
  });

  expect(code).toBe(0);
  expect(bodies[4]).not.toContain("<rules for=");
});
