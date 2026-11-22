#!/usr/bin/env node
/**
 * F-04 历史回放：用编译后的 evidence-grounding 模块核对已有审计里的 findings。
 * 零模型；只读结果 JSON / 审计 / 仓库 head 文件。
 *
 * 用法：
 *   node bench/experiments/2026-11-22-f04/eval_grounding.mjs \
 *     --results-dir D:/.../baseline-f91-v3-20261121 \
 *     --out bench/experiments/2026-11-22-f04/v3.json
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { groundFindingEvidence } from "../../../packages/review-pi/dist/gate/evidence-grounding.js";

const args = process.argv.slice(2);
function arg(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

const resultsDir = path.resolve(arg("--results-dir"));
const outPath = path.resolve(arg("--out"));
const minMatchChars = Number(arg("--min-match-chars", "30"));
const repoRoot = path.resolve(arg("--repo-root", "D:/Project/bench/aacr-bench/evaluation/repo"));

const cache = new Map();
function readHeadFile(repo, commit, file) {
  const key = `${repo}\u0000${commit}\u0000${file}`;
  if (cache.has(key)) return cache.get(key);
  let text = null;
  try {
    text = execFileSync(
      "git",
      ["-c", "core.longpaths=true", "-C", path.join(repoRoot, repo.replace("/", "__")), "show", `${commit}:${file}`],
      { encoding: "utf8", errors: "replace", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
    );
  } catch {
    text = null;
  }
  cache.set(key, text);
  return text;
}

const summary = {
  resultsDir,
  minMatchChars,
  findings: 0,
  checkedCandidates: 0,
  groundedFindings: 0,
  unverifiedFindings: 0,
  unverifiableFindings: 0,
  checkedEntries: 0,
  matchedEntries: 0,
};
const details = [];

for (const name of readdirSync(resultsDir)) {
  if (!name.endsWith(".json") || name.startsWith("metrics_")) continue;
  let result;
  try {
    result = JSON.parse(readFileSync(path.join(resultsDir, name), "utf8"));
  } catch {
    continue;
  }
  if (!result.audit_path) continue;
  let audit;
  try {
    audit = JSON.parse(readFileSync(result.audit_path, "utf8"));
  } catch {
    continue;
  }
  for (const finding of audit.findings ?? []) {
    summary.findings += 1;
    const text = readHeadFile(result.repo, result.head_commit, finding.file);
    const grounded = groundFindingEvidence(finding, text, minMatchChars);
    summary.checkedCandidates += 1;
    summary.checkedEntries += grounded.checkedEntries;
    summary.matchedEntries += grounded.matchedEntries;
    if (grounded.status === "grounded") summary.groundedFindings += 1;
    else if (grounded.status === "unverified") summary.unverifiedFindings += 1;
    else summary.unverifiableFindings += 1;
    if (details.length < 50 && grounded.status !== "grounded") {
      details.push({
        instance: result.instance_id,
        file: finding.file,
        line: finding.line,
        status: grounded.status,
        evidence: (finding.evidence ?? []).slice(0, 2),
      });
    }
  }
}

mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({ summary, examples: details }, null, 2) + "\n", "utf8");
console.log(JSON.stringify(summary, null, 2));
