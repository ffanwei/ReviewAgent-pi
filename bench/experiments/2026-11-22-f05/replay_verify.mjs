#!/usr/bin/env node
/**
 * F-05 离线回放：对已有 findings 跑独立证伪核验，和已有 judge 标签比对。
 * 一条 finding 一次 one-shot；优先只跑 F-04 unverified。
 *
 * 用法：
 *   node bench/experiments/2026-11-22-f05/replay_verify.mjs \
 *     --scope unverified \
 *     --out bench/experiments/2026-11-22-f05/replay.json
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { groundFindingEvidence } from "../../../packages/review-pi/dist/gate/evidence-grounding.js";
import {
  excerptAroundLine,
  verifyFinding,
} from "../../../packages/review-pi/dist/gate/independent-verifier.js";

const args = process.argv.slice(2);
function arg(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

const resultsDir = path.resolve(
  arg("--results-dir", "D:/Project/bench/aacr-bench/evaluation/results/iterF91/reviewpi/baseline-f91-v3-20261121"),
);
const metricsPath = path.resolve(
  arg("--metrics", "bench/experiments/2026-11-21-f02/baseline-f91-v3/metrics.json"),
);
const repoRoot = path.resolve(arg("--repo-root", "D:/Project/bench/aacr-bench/evaluation/repo"));
const configPath = path.resolve(arg("--config", "C:/Users/Li/.PiAgent/benchmark-f03-serial.jsonc"));
const scope = arg("--scope", "unverified");
const modelOverride = arg("--model", "");
const contextLines = Number(arg("--context-lines", "40"));
const limit = Number(arg("--limit", "0"));
const concurrency = Number(arg("--concurrency", "3"));
const maxTokens = Number(arg("--max-tokens", "4096"));
const outPath = path.resolve(arg("--out", "bench/experiments/2026-11-22-f05/replay.json"));
const minMatchChars = Number(arg("--min-match-chars", "30"));

const rawConfig = readFileSync(configPath, "utf8").replace(/^\s*\/\/.*$/gm, "");
const config = JSON.parse(rawConfig);
const llm = {
  baseUrl: config.reviewer.baseUrl,
  apiKey: config.reviewer.apiKey,
  modelId: modelOverride || config.model.default,
  timeoutMs: 120_000,
  maxTokens,
};

const metrics = JSON.parse(readFileSync(metricsPath, "utf8"));
const evalByInstance = new Map(metrics.eval_res.map((entry) => [entry.instance_id, entry]));

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

const work = [];
for (const name of readdirSync(resultsDir)) {
  if (!name.endsWith(".json") || name.startsWith("metrics_")) continue;
  const result = JSON.parse(readFileSync(path.join(resultsDir, name), "utf8"));
  if (!result.audit_path) continue;
  const audit = JSON.parse(readFileSync(result.audit_path, "utf8"));
  const evaluation = evalByInstance.get(result.instance_id);
  if (evaluation === undefined) continue;
  const commentsByKey = new Map();
  for (const comment of evaluation.generated_comments ?? []) {
    const key = `${comment.path}\u0000${comment.from_line}`;
    const list = commentsByKey.get(key) ?? [];
    list.push(comment);
    commentsByKey.set(key, list);
  }
  for (const finding of audit.findings ?? []) {
    const fileText = readHeadFile(result.repo, result.head_commit, finding.file);
    const grounding = groundFindingEvidence(finding, fileText, minMatchChars);
    if (scope === "unverified" && grounding.status !== "unverified") continue;
    const comment = commentsByKey.get(`${finding.file}\u0000${finding.line}`)?.shift();
    work.push({ result, evaluation, finding, fileText, comment });
  }
}
if (limit > 0) work.splice(limit);

const verdicts = [];
let cursor = 0;
let finished = 0;
async function worker() {
  while (true) {
    const index = cursor;
    cursor += 1;
    if (index >= work.length) return;
    const item = work[index];
    const excerpt = item.fileText === null ? null : excerptAroundLine(item.fileText, item.finding.line, contextLines);
    const outcome = await verifyFinding({ finding: item.finding, excerpt }, llm);
    verdicts[index] = outcome;
    finished += 1;
    if (finished % 10 === 0 || finished === work.length) {
      process.stderr.write(`[replay] ${String(finished)}/${String(work.length)}\n`);
    }
  }
}
await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));

let pass = 0;
let reject = 0;
let uncertain = 0;
let failed = 0;
let unparseable = 0;
let transportFailed = 0;
let rejectedTp = 0;
let rejectedFp = 0;
let rejectedGt = 0;
let totalInput = 0;
let totalOutput = 0;
let totalCache = 0;
const rejectedGtKeys = new Set();
const keptGtKeys = new Set();
let baselineGenerated = 0;
let baselineMatched = 0;
const coveredBefore = new Set();
const coveredAfter = new Set();

for (let index = 0; index < work.length; index += 1) {
  const item = work[index];
  const verdict = verdicts[index];
  if (verdict.status === "pass") pass += 1;
  else if (verdict.status === "reject") reject += 1;
  else uncertain += 1;
  if (verdict.requestFailed) failed += 1;
  if (verdict.reason.startsWith("verifier reply unparseable")) unparseable += 1;
  if (verdict.reason.startsWith("verifier request failed")) transportFailed += 1;
  totalInput += verdict.usage.inputTokens ?? 0;
  totalOutput += verdict.usage.outputTokens ?? 0;
  totalCache += verdict.usage.cacheReadTokens ?? 0;
  const comment = item.comment;
  if (comment !== undefined) {
    baselineGenerated += 1;
    if (comment.hit_new_gt === true) baselineMatched += 1;
    const gtKeys = (comment.matched_gt_indices ?? []).map((gt) => `${item.result.instance_id}\u0000${gt}`);
    for (const key of gtKeys) coveredBefore.add(key);
    if (verdict.status === "reject") {
      if (comment.hit_new_gt === true) rejectedTp += 1;
      else rejectedFp += 1;
      for (const key of gtKeys) rejectedGtKeys.add(key);
    } else {
      for (const key of gtKeys) coveredAfter.add(key);
    }
  }
}
for (const key of coveredBefore) {
  if (!rejectedGtKeys.has(key)) keptGtKeys.add(key);
}
rejectedGt = rejectedGtKeys.size;

// 只针对被核验子集的指标（不是全量 320）
const p0 = baselineMatched / Math.max(1, baselineGenerated);
const r0 = coveredBefore.size / metrics.summary.expected_notes;
const b0 = (2 * p0 * r0) / Math.max(1e-9, p0 + r0);
const afterMatched = baselineMatched - rejectedTp;
const afterGenerated = baselineGenerated - reject;
const p1 = afterMatched / Math.max(1, afterGenerated);
const r1 = keptGtKeys.size / metrics.summary.expected_notes;
const b1 = (2 * p1 * r1) / Math.max(1e-9, p1 + r1);

const summary = {
  scope,
  model: llm.modelId,
  inspected: work.length,
  pass,
  reject,
  uncertain,
  requestFailed: failed,
  unparseable,
  transportFailed,
  rejectedTp,
  rejectedFp,
  rejectedGt,
  tokens: { input: totalInput, output: totalOutput, cacheRead: totalCache, total: totalInput + totalOutput + totalCache },
  subset: {
    baseline: { generated: baselineGenerated, matched: baselineMatched, coveredGt: coveredBefore.size, precision: p0, recall: r0, balanced: b0 },
    afterReject: { generated: afterGenerated, matched: afterMatched, coveredGt: keptGtKeys.size, precision: p1, recall: r1, balanced: b1 },
  },
  verdicts: work.map((item, index) => ({
    instance: item.result.instance_id,
    file: item.finding.file,
    line: item.finding.line,
    status: verdicts[index].status,
    reason: verdicts[index].reason,
    hitNewGt: item.comment?.hit_new_gt ?? null,
    matchedGt: item.comment?.matched_gt_indices ?? [],
    ...(verdicts[index].rawReply !== undefined ? { rawReply: verdicts[index].rawReply } : {}),
  })),
};
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(summary, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ ...summary, verdicts: undefined }, null, 2));
