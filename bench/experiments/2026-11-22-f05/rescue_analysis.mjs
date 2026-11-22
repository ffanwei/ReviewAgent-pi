#!/usr/bin/env node
/**
 * 只读分析（不调模型）：把回放 verdict 与 judge 标签重新对齐，量化
 * 「F-04 drop 全部 unverified」 vs 「F-04 drop 但 F-05 pass 返场」两种管线的差异。
 *
 * 用法：
 *   node bench/experiments/2026-11-22-f05/rescue_analysis.mjs \
 *     --replay full-flash.json --out rescue-flash.json
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
function arg(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

const replayPath = path.resolve(arg("--replay", "bench/experiments/2026-11-22-f05/full-flash.json"));
const resultsDir = path.resolve(
  arg("--results-dir", "D:/Project/bench/aacr-bench/evaluation/results/iterF91/reviewpi/baseline-f91-v3-20261121"),
);
const metricsPath = path.resolve(
  arg("--metrics", "bench/experiments/2026-11-21-f02/baseline-f91-v3/metrics.json"),
);
const outPath = path.resolve(arg("--out", "bench/experiments/2026-11-22-f05/rescue-analysis.json"));

const replay = JSON.parse(readFileSync(replayPath, "utf8"));
const metrics = JSON.parse(readFileSync(metricsPath, "utf8"));
const evalByInstance = new Map(metrics.eval_res.map((entry) => [entry.instance_id, entry]));

// (instance, file, line) → comment（同一位置多条时按出现顺序取；与 replay 一致）
const commentByKey = new Map();
for (const name of readdirSync(resultsDir)) {
  if (!name.endsWith(".json") || name.startsWith("metrics_")) continue;
  const result = JSON.parse(readFileSync(path.join(resultsDir, name), "utf8"));
  const evaluation = evalByInstance.get(result.instance_id);
  if (evaluation === undefined) continue;
  const byPosition = new Map();
  for (const comment of evaluation.generated_comments ?? []) {
    const key = `${comment.path}\u0000${comment.from_line}`;
    const list = byPosition.get(key) ?? [];
    list.push(comment);
    byPosition.set(key, list);
  }
  for (const [key, list] of byPosition) {
    commentByKey.set(`${result.instance_id}\u0000${key}`, list);
  }
}

const buckets = {
  pass: { count: 0, tp: 0, fp: 0, gt: new Set() },
  reject: { count: 0, tp: 0, fp: 0, gt: new Set() },
  uncertain: { count: 0, tp: 0, fp: 0, gt: new Set() },
};
for (const verdict of replay.verdicts) {
  const bucket = buckets[verdict.status];
  bucket.count += 1;
  const list = commentByKey.get(`${verdict.instance}\u0000${verdict.file}\u0000${verdict.line}`) ?? [];
  const comment = list.shift();
  if (comment === undefined) continue;
  if (comment.hit_new_gt === true) bucket.tp += 1;
  else bucket.fp += 1;
  for (const gt of verdict.matchedGt ?? comment.matched_gt_indices ?? []) {
    bucket.gt.add(`${verdict.instance}\u0000${gt}`);
  }
}

const allGt = new Set();
for (const bucket of Object.values(buckets)) {
  for (const key of bucket.gt) allGt.add(key);
}

const expectedNotes = metrics.summary.expected_notes;
const subsetGenerated = replay.inspected;
const subsetMatched = replay.verdicts.filter((verdict) => verdict.hitNewGt === true).length;
const p = subsetMatched / Math.max(1, subsetGenerated);
const r = allGt.size / expectedNotes;
const b = (2 * p * r) / Math.max(1e-9, p + r);

const kept = {
  generated: buckets.pass.count,
  matched: buckets.pass.tp,
  gt: buckets.pass.gt.size,
};
const keptP = kept.matched / Math.max(1, kept.generated);
const keptR = kept.gt / expectedNotes;
const keptB = (2 * keptP * keptR) / Math.max(1e-9, keptP + keptR);

const summary = {
  model: replay.model,
  scope: replay.scope,
  subset: {
    inspected: subsetGenerated,
    matched: subsetMatched,
    coveredGt: allGt.size,
    precision: p,
    recall: r,
    balanced: b,
  },
  byStatus: Object.fromEntries(
    Object.entries(buckets).map(([status, bucket]) => [
      status,
      { count: bucket.count, tp: bucket.tp, fp: bucket.fp, coveredGt: bucket.gt.size },
    ]),
  ),
  // F-04 drop 全部 unverified：子集全部消失（损失 = subset）。
  dropAllUnverified: { lostTp: subsetMatched, lostGt: allGt.size },
  // F-04 drop + F-05 pass 返场：只有 pass 项保留。
  dropUnverifiedKeepPass: {
    kept,
    keptPrecision: keptP,
    keptRecall: keptR,
    keptBalanced: keptB,
    lostTp: subsetMatched - kept.matched,
    lostGt: allGt.size - kept.gt,
  },
  // 对照：F-05 自己对 unverified 做 drop（reject 才删），uncertain 保留。
  f05DropRejectOnly: {
    keptGenerated: subsetGenerated - buckets.reject.count,
    keptMatched: subsetMatched - buckets.reject.tp,
    keptGt: allGt.size - buckets.reject.gt.size,
    lostTp: buckets.reject.tp,
    lostGt: buckets.reject.gt.size,
  },
};

writeFileSync(outPath, JSON.stringify(summary, null, 2) + "\n", "utf8");
console.log(JSON.stringify(summary, null, 2));
