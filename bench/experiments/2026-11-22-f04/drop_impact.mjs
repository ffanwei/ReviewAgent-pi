#!/usr/bin/env node
/**
 * F-04 离线 drop 影响：warn 不改输出；drop 会移除 unverified 候选。
 * 用已有 judge 标签重算 P/R/B，估计 drop 的误杀。
 *
 * 用法：
 *   node bench/experiments/2026-11-22-f04/drop_impact.mjs \
 *     --metrics bench/experiments/2026-11-21-f02/baseline-f91-v3/metrics.json \
 *     --results-dir D:/.../baseline-f91-v3-20261121 \
 *     --out bench/experiments/2026-11-22-f04/drop-impact.json
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
const metricsPath = path.resolve(arg("--metrics"));
const resultsDir = path.resolve(arg("--results-dir"));
const outPath = path.resolve(arg("--out"));
const minMatchChars = Number(arg("--min-match-chars", "30"));
const repoRoot = path.resolve(arg("--repo-root", "D:/Project/bench/aacr-bench/evaluation/repo"));

const metrics = JSON.parse(readFileSync(metricsPath, "utf8"));
const evalByInstance = new Map(metrics.eval_res.map((entry) => [entry.instance_id, entry]));
const resultByInstance = new Map();
for (const name of readdirSync(resultsDir)) {
  if (!name.endsWith(".json") || name.startsWith("metrics_")) continue;
  try {
    const result = JSON.parse(readFileSync(path.join(resultsDir, name), "utf8"));
    resultByInstance.set(result.instance_id, result);
  } catch {
    // ignore
  }
}

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

let total = 0;
let grounded = 0;
let unverified = 0;
let unverifiable = 0;
let unmatched = 0;
let baselineGenerated = 0;
let baselineMatched = 0;
let dropGenerated = 0;
let dropMatched = 0;
const coveredBefore = new Set();
const coveredAfter = new Set();

for (const [instanceId, evaluation] of evalByInstance) {
  const result = resultByInstance.get(instanceId);
  if (!result?.audit_path) continue;
  const audit = JSON.parse(readFileSync(result.audit_path, "utf8"));
  const comments = evaluation.generated_comments ?? [];
  const statuses = comments.map(() => "unverifiable"); // 未被 audit 匹配到的默认保留
  const byKey = new Map();
  comments.forEach((comment, index) => {
    const key = `${comment.path}\u0000${comment.from_line}`;
    const list = byKey.get(key) ?? [];
    list.push(index);
    byKey.set(key, list);
  });
  for (const finding of audit.findings ?? []) {
    total += 1;
    const text = readHeadFile(result.repo, result.head_commit, finding.file);
    const status = groundFindingEvidence(finding, text, minMatchChars).status;
    if (status === "grounded") grounded += 1;
    else if (status === "unverified") unverified += 1;
    else unverifiable += 1;
    const key = `${finding.file}\u0000${finding.line}`;
    const candidates = byKey.get(key);
    const index = candidates?.shift();
    if (index === undefined) {
      unmatched += 1;
      continue;
    }
    statuses[index] = status;
  }
  comments.forEach((comment, index) => {
    const hit = comment.hit_new_gt === true;
    baselineGenerated += 1;
    if (hit) baselineMatched += 1;
    for (const gt of comment.matched_gt_indices ?? []) coveredBefore.add(`${instanceId}\u0000${gt}`);
    if (statuses[index] !== "unverified") {
      for (const gt of comment.matched_gt_indices ?? []) coveredAfter.add(`${instanceId}\u0000${gt}`);
    } else {
      dropGenerated += 1;
      if (hit) dropMatched += 1;
    }
  });
}

const expected = metrics.summary.expected_notes;
const p0 = baselineMatched / baselineGenerated;
const r0 = coveredBefore.size / expected;
const b0 = (2 * p0 * r0) / (p0 + r0);
const p1 = (baselineMatched - dropMatched) / (baselineGenerated - dropGenerated);
const r1 = coveredAfter.size / expected;
const b1 = (2 * p1 * r1) / (p1 + r1);
const summary = {
  mode: "drop-hypothesis",
  minMatchChars,
  findings: total,
  grounded,
  unverified,
  unverifiable,
  unmatchedEvalComments: unmatched,
  baseline: {
    generated: baselineGenerated,
    matched: baselineMatched,
    coveredGt: coveredBefore.size,
    precision: p0,
    recall: r0,
    balanced: b0,
  },
  dropped: {
    generated: dropGenerated,
    matched: dropMatched,
    gtLost: coveredBefore.size - coveredAfter.size,
  },
  afterDrop: {
    generated: baselineGenerated - dropGenerated,
    matched: baselineMatched - dropMatched,
    coveredGt: coveredAfter.size,
    precision: p1,
    recall: r1,
    balanced: b1,
  },
};
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(summary, null, 2) + "\n", "utf8");
console.log(JSON.stringify(summary, null, 2));
