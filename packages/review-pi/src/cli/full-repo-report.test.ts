import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";

import type { Finding } from "../contracts/finding.js";
import type { TaskCallResult } from "../contracts/mcp-task.js";
import type { FullRepoLifecycle } from "../mcp/full-repo-lifecycle.js";
import type { MrReviewResultArgs } from "../mcp/task-tools.js";
import { reportFullRepoBatch } from "./full-repo-report.js";

const dirs: string[] = [];

function tempRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "full-repo-report-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 1;\nexport const b = 2;\n");
  writeFileSync(path.join(dir, "src", "b.ts"), "export const c = 3;\n");
  return dir;
}

afterAll(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function finding(): Finding {
  return {
    id: "F001",
    severity: "P1",
    category: "可靠性",
    file: "src/a.ts",
    line: 2,
    title: "空指针",
    description: "未判空。",
    evidence: ["src/a.ts:2"],
    rule: "",
    confidence: 0.9,
    tips: {
      review: "[缺陷类型] 未判空。影响评估：请求路径 NPE。",
      suggestion: "[重构思路] 判空。代码示例：```if (a == null) return;```",
      subcategory: "空指针安全",
    },
  };
}

function fakeLifecycle(
  result: TaskCallResult = { ok: true },
): FullRepoLifecycle & { readonly calls: Omit<MrReviewResultArgs, "taskId">[] } {
  const calls: Omit<MrReviewResultArgs, "taskId">[] = [];
  return {
    calls,
    started: true,
    start: async () => ({ ok: true }),
    reportFile: async (args) => {
      calls.push(args);
      return result;
    },
    reportCurrentTips: async () => ({ ok: true }),
    finish: async () => ({ ok: true, waitedMs: 0 }),
  };
}

test("按文件上报：有意见带 8 字段 tip，无意见文件补空包", async () => {
  const repoPath = tempRepo();
  const lifecycle = fakeLifecycle();
  const logs: string[] = [];

  await reportFullRepoBatch({
    taskId: "repo-1",
    repoPath,
    batch: {
      index: 1,
      key: "src",
      files: ["src/a.ts", "src/b.ts"],
      findings: [finding()],
    },
    lifecycle,
    log: (line) => logs.push(line),
  });

  expect(lifecycle.calls.map((call) => call.filePath)).toEqual(["src/a.ts", "src/b.ts"]);
  const tip = lifecycle.calls[0]?.reviewTips[0];
  expect(tip).toEqual({
    code: "export const b = 2;",
    review: "[缺陷类型] 未判空。\n\n影响评估：请求路径 NPE。",
    suggestion: "[重构思路] 判空。\n\n代码示例：\n```if (a == null) return;```",
    category: "可靠性",
    subcategory: "空指针安全",
    level: "Major",
    ruleId: null,
    lineNum: "2",
  });
  expect(lifecycle.calls[1]?.reviewTips).toEqual([]);
  expect(logs.join("\n")).toContain("已上报 2 文件 / 1 条意见（补空 1）");
});

test("上报失败只留痕：不抛错，失败文件不重复补空包", async () => {
  const repoPath = tempRepo();
  const lifecycle = fakeLifecycle({ ok: false, reason: "server rejected" });
  const logs: string[] = [];

  await expect(
    reportFullRepoBatch({
      taskId: "repo-1",
      repoPath,
      batch: {
        index: 1,
        key: "src",
        files: ["src/a.ts", "src/b.ts"],
        findings: [finding()],
      },
      lifecycle,
      log: (line) => logs.push(line),
    }),
  ).resolves.toBeUndefined();

  // a.ts 有过一次上报尝试（失败），不再补空包；b.ts 正常补空。
  expect(lifecycle.calls.map((call) => call.filePath)).toEqual(["src/a.ts", "src/b.ts"]);
  expect(logs.join("\n")).toContain("server rejected");
});

test("非法 filePath 的 finding 跳过，不阻塞同批文件", async () => {
  const repoPath = tempRepo();
  const lifecycle = fakeLifecycle();
  const logs: string[] = [];

  await reportFullRepoBatch({
    taskId: "repo-1",
    repoPath,
    batch: {
      index: 1,
      key: "src",
      files: ["src/a.ts"],
      findings: [{ ...finding(), file: "../escape.ts" }],
    },
    lifecycle,
    log: (line) => logs.push(line),
  });

  expect(lifecycle.calls.map((call) => call.filePath)).toEqual(["src/a.ts"]);
  expect(logs.join("\n")).toContain("跳过文件组");
});
