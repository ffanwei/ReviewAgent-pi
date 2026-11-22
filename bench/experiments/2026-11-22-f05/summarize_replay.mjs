#!/usr/bin/env node
/**
 * 把 replay_verify.mjs 的输出汇总成 markdown（多模型对照）。
 *
 * 用法：
 *   node bench/experiments/2026-11-22-f05/summarize_replay.mjs \
 *     full-flash.json full-pro.json --out replay-report.md
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outPath = path.resolve(
  outIndex >= 0 ? args[outIndex + 1] : "bench/experiments/2026-11-22-f05/replay-report.md",
);
const files = args.filter((_, index) => index !== outIndex && index !== outIndex + 1);
if (files.length === 0) {
  console.error("usage: summarize_replay.mjs <replay.json...> [--out report.md]");
  process.exit(1);
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function reasonClass(reason) {
  if (reason.startsWith("excerpt unavailable")) return "excerpt-unavailable";
  if (reason.startsWith("verifier request failed")) return "transport-failed";
  if (reason.startsWith("verifier reply unparseable")) return "unparseable";
  if (/^uncertain:/i.test(reason)) return "uncertain-insufficient";
  return "other";
}

const runs = files.map((file) => ({ file, data: JSON.parse(readFileSync(path.resolve(file), "utf8")) }));

const lines = [];
lines.push("# F-05 回放结果（独立证伪核验）", "");
lines.push("口径：v3 iterF91 的 F-04 `unverified` findings；每条 finding 一次 one-shot；");
lines.push("输入 = finding + 行号附近 80 行片段（max 8k 字符）；标签按 `(file, line)` 对齐 judge。", "");
lines.push("## 汇总", "");
lines.push("| 模型 | 样本 | pass | reject | uncertain | 请求失败 | 解析失败 | 拒绝 TP | 拒绝 FP | 丢掉 GT | tokens |");
lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const { data } of runs) {
  lines.push(
    `| ${data.model} | ${data.inspected} | ${data.pass} | ${data.reject} | ${data.uncertain} | ${data.transportFailed ?? 0} | ${data.unparseable ?? 0} | ${data.rejectedTp} | ${data.rejectedFp} | ${data.rejectedGt} | ${data.tokens.total.toLocaleString("en-US")} |`,
  );
}

lines.push("", "## 核验子集指标（仅被核验的 findings，不是全量 320）", "");
lines.push("| 模型 | 阶段 | generated | matched | covered GT | P | R | B |");
lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const { data } of runs) {
  const { baseline, afterReject } = data.subset;
  lines.push(
    `| ${data.model} | 核验前 | ${baseline.generated} | ${baseline.matched} | ${baseline.coveredGt} | ${pct(baseline.precision)} | ${pct(baseline.recall)} | ${pct(baseline.balanced)} |`,
  );
  lines.push(
    `| ${data.model} | 拒绝后 | ${afterReject.generated} | ${afterReject.matched} | ${afterReject.coveredGt} | ${pct(afterReject.precision)} | ${pct(afterReject.recall)} | ${pct(afterReject.balanced)} |`,
  );
}

lines.push("", "## 判定分布", "");
lines.push("| 模型 | pass | reject | uncertain: 片段不足 | excerpt 不可得 | 传输失败 | 解析失败 |");
lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const { data } of runs) {
  const counts = { "excerpt-unavailable": 0, "transport-failed": 0, unparseable: 0, "uncertain-insufficient": 0, other: 0 };
  for (const verdict of data.verdicts) {
    if (verdict.status === "pass" || verdict.status === "reject") continue;
    counts[reasonClass(verdict.reason)] += 1;
  }
  lines.push(
    `| ${data.model} | ${data.pass} | ${data.reject} | ${counts["uncertain-insufficient"]} | ${counts["excerpt-unavailable"]} | ${counts["transport-failed"]} | ${counts.unparseable} |`,
  );
}

lines.push("", "## 被拒绝的 findings", "");
for (const { data } of runs) {
  const rejects = data.verdicts.filter((verdict) => verdict.status === "reject");
  lines.push("", `### ${data.model}（${rejects.length} 条）`, "");
  if (rejects.length === 0) {
    lines.push("无。");
    continue;
  }
  lines.push("| instance | file:line | judge | reason |");
  lines.push("| --- | --- | --- | --- |");
  for (const verdict of rejects) {
    const label = verdict.hitNewGt === true ? "TP" : verdict.hitNewGt === false ? "FP" : "—";
    const reason = verdict.reason.replace(/\|/g, "\\|").slice(0, 160);
    lines.push(`| ${verdict.instance} | ${verdict.file}:${verdict.line} | ${label} | ${reason} |`);
  }
}

writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
console.log(`wrote ${outPath}`);
