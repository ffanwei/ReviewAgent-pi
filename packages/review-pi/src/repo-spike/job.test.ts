import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";

import {
  createJob,
  fingerprintGroups,
  fingerprintPlan,
  isTransientError,
  loadJob,
  usageTotal,
  validateJob,
  writeJob,
} from "./job.js";
import type { SyntheticGroup } from "./types.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "repo-spike-job-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function group(files: { path: string; content: string }[]): SyntheticGroup {
  return {
    group: {
      index: 1,
      key: "test",
      files: files.map((file) => ({ path: file.path, size: file.content.length })),
      estimatedChars: 100,
    },
    diff: "",
    files: files.map((file) => file.path),
    snapshot: files,
    chars: 100,
    skipped: [],
  };
}

test("job：写入 / 读取 / hash 校验；快照内容变化被拒绝", async () => {
  const out = tempDir();
  const groups = [group([{ path: "a.ts", content: "a" }])];
  const hashes = {
    snapshotHash: fingerprintGroups(groups),
    planHash: fingerprintPlan(groups),
    configHash: "sha256:config",
  };
  const job = createJob({
    outDir: out,
    repoPath: "/repo",
    now: new Date("2026-11-25T00:00:00.000Z"),
    maxTotalTokens: 0,
    hashes,
    groups,
  });
  await writeJob(job);
  const loaded = await loadJob(out);
  expect(loaded?.jobId).toBe(job.jobId);
  expect(() => validateJob(job, hashes)).not.toThrow();
  expect(() =>
    validateJob(job, { ...hashes, snapshotHash: fingerprintGroups([group([{ path: "a.ts", content: "b" }])]) }),
  ).toThrow(/cannot resume: snapshot/);
});

test("job：plan 指纹忽略内容，snapshot 指纹覆盖内容", () => {
  const one = [group([{ path: "a.ts", content: "a" }])];
  const two = [group([{ path: "a.ts", content: "b" }])];
  expect(fingerprintPlan(one)).toBe(fingerprintPlan(two));
  expect(fingerprintGroups(one)).not.toBe(fingerprintGroups(two));
});

test("job：usageTotal 缺省 cacheReadTokens 按 0", () => {
  expect(usageTotal({ inputTokens: 3, outputTokens: 2 })).toBe(5);
  expect(usageTotal({ inputTokens: 3, outputTokens: 2, cacheReadTokens: 4 })).toBe(9);
  expect(usageTotal(undefined)).toBe(0);
});

test("job：临时错误与永久错误分流", () => {
  expect(isTransientError(new Error("500 upstream unavailable"))).toBe(true);
  expect(isTransientError(new Error("429 rate limit"))).toBe(true);
  expect(isTransientError(new Error("Connection error."))).toBe(true);
  expect(isTransientError(new Error("ETIMEDOUT"))).toBe(true);
  expect(isTransientError(new Error("401 unauthorized"))).toBe(false);
  expect(isTransientError(new Error("invalid api key"))).toBe(false);
  expect(isTransientError(new Error("config missing"))).toBe(false);
});
