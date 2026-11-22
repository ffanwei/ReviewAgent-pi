#!/usr/bin/env node
/**
 * 诊断：对上一轮回放中“解析失败”的 findings 重跑核验器，打印原始回包，
 * 用于判断是截断、非 JSON 还是空 content。
 *
 * 用法：
 *   node bench/experiments/2026-11-22-f05/probe_unparseable.mjs --from full-flash.json
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
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

const fromPath = path.resolve(arg("--from", "bench/experiments/2026-11-22-f05/full-flash.json"));
const resultsDir = path.resolve(
  arg("--results-dir", "D:/Project/bench/aacr-bench/evaluation/results/iterF91/reviewpi/baseline-f91-v3-20261121"),
);
const repoRoot = path.resolve(arg("--repo-root", "D:/Project/bench/aacr-bench/evaluation/repo"));
const configPath = path.resolve(arg("--config", "C:/Users/Li/.PiAgent/benchmark-f03-serial.jsonc"));
const minMatchChars = Number(arg("--min-match-chars", "30"));

const previous = JSON.parse(readFileSync(fromPath, "utf8"));
const failures = new Map();
for (const verdict of previous.verdicts) {
  if (verdict.reason.startsWith("verifier reply unparseable")) {
    failures.set(`${verdict.instance}\u0000${verdict.file}\u0000${verdict.line}`, verdict);
  }
}
if (failures.size === 0) {
  console.log("no unparseable verdicts in", fromPath);
  process.exit(0);
}

const rawConfig = readFileSync(configPath, "utf8").replace(/^\s*\/\/.*$/gm, "");
const config = JSON.parse(rawConfig);
const baseLlm = {
  baseUrl: config.reviewer.baseUrl,
  apiKey: config.reviewer.apiKey,
  modelId: previous.model,
  timeoutMs: 120_000,
};

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
  if (!previous.verdicts.some((verdict) => verdict.instance === result.instance_id)) continue;
  const fileTextCache = new Map();
  for (const finding of audit.findings ?? []) {
    if (!fileTextCache.has(finding.file)) {
      fileTextCache.set(finding.file, readHeadFile(result.repo, result.head_commit, finding.file));
    }
    const fileText = fileTextCache.get(finding.file);
    if (groundFindingEvidence(finding, fileText, minMatchChars).status !== "unverified") continue;
    const key = `${result.instance_id}\u0000${finding.file}\u0000${finding.line}`;
    if (!failures.has(key)) continue;
    work.push({ result, finding, fileText });
  }
}

console.log(`probing ${String(work.length)} previously-unparseable findings`);
for (const [index, item] of work.entries()) {
  const excerpt = item.fileText === null ? null : excerptAroundLine(item.fileText, item.finding.line, 80);
  for (const maxTokens of [1536, 4096]) {
    const outcome = await verifyFinding({ finding: item.finding, excerpt }, { ...baseLlm, maxTokens });
    const raw = (outcome.rawReply ?? outcome.reason).replace(/\s+/g, " ").slice(0, 180);
    process.stdout.write(
      `${String(index + 1).padStart(2)} ${item.finding.file}:${String(item.finding.line)} max=${String(maxTokens)} -> ${outcome.status} | ${raw}\n`,
    );
  }
}
