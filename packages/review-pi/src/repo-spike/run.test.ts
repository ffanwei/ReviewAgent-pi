import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  expect(existsSync(path.join(out, "repo-spike-plan.json"))).toBe(true);
  expect(existsSync(path.join(out, "repo-spike-result.json"))).toBe(false);

  const plan = JSON.parse(readFileSync(path.join(out, "repo-spike-plan.json"), "utf8")) as {
    groups: { key: string; files: string[] }[];
    files: { discovered: number; selected: number };
  };
  expect(plan.files).toMatchObject({ discovered: 2, selected: 2 });
  expect(plan.groups).toHaveLength(2);
  expect(plan.groups.map((group) => group.files)).toEqual([["src/a.ts"], ["src/b.ts"]]);
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

  const result = JSON.parse(readFileSync(path.join(out, "repo-spike-result.json"), "utf8")) as {
    groups: { status: string; files: string[]; findingsCount: number }[];
    findings: unknown[];
    files: { selected: number };
  };
  expect(result.files.selected).toBe(2);
  expect(result.groups).toHaveLength(2);
  expect(result.groups.every((group) => group.status === "reviewed")).toBe(true);
  expect(result.findings).toEqual([]);
});
