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
