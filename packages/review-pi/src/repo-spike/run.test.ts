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
    maxGroupChars: 120_000,
    maxGroups: 500,
    maxFiles: 20,
    maxFileChars: 100_000,
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
