#!/usr/bin/env node
/**
 * 从一次 record / once 运行产物（run.json + reviews_tips_zh.json + mcp 留痕）
 * 提取场景期望块（ADR-0090 重录辅助；只读，不写）。
 *
 * 用法：node scripts/offline-replay/expect-from-run.mjs <laneTasksDir> [mcpCallsJson]
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const tasksDir = process.argv[2];
if (tasksDir === undefined) {
  process.stderr.write("usage: expect-from-run.mjs <laneTasksDir> [mcpCallsJson]\n");
  process.exit(1);
}

const record = JSON.parse(await readFile(join(tasksDir, "runs", "run.json"), "utf8"));
const baseline = record.baseline;
const expect = {
  findings: (baseline.findings ?? []).map((f) => ({
    file: f.file,
    line: f.line,
    severity: f.severity,
    title: f.title,
    rule: f.rule,
  })),
  phaseRecords: (baseline.audit?.phaseLog ?? []).length,
  rounds: baseline.rounds,
};

try {
  const tips = JSON.parse(await readFile(join(tasksDir, "runs", "reviews_tips_zh.json"), "utf8"));
  expect.tips = Array.isArray(tips) && tips.length > 0 ? "present" : "present-empty";
  if (Array.isArray(tips) && tips.length > 0) {
    expect.tipFilePaths = tips.map((group) => group.filePath);
    expect.tipCounts = tips.map((group) => group.reviewTips?.length ?? 0);
  }
} catch {
  expect.tips = "absent";
}

const mcpSource = process.argv[3] ?? join(tasksDir, "runs", "mcp.json");
try {
  const calls = JSON.parse(await readFile(mcpSource, "utf8"));
  const list = Array.isArray(calls) ? calls : (calls.calls ?? []);
  expect.mcpCalls = list.map((call) => call.name ?? call.tool);
  const reports = list.filter((call) => (call.name ?? call.tool) === "mrReviewResult");
  if (reports.length > 0) {
    expect.mcpFilePathCounts = reports.map((call) =>
      call.args?.filePath ?? call.input?.filePath ?? "",
    );
  }
} catch {
  if (process.argv[3] !== undefined) {
    throw new Error(`无法读取 MCP 调用留痕：${mcpSource}`);
  }
}

process.stdout.write(`${JSON.stringify(expect, null, 2)}\n`);
