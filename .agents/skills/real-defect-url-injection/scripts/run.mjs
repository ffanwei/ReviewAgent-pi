#!/usr/bin/env node
/**
 * 真实缺陷回放（默认 VUL4J-38 / CVE-2014-4172）。
 *
 * 做法：
 *   1. 从 data/vul4j/materialized-cases.json 取一条真实修复案；
 *   2. 把 `.cache` 里的修复后仓库复制两份：fixed（干净底座）与 defect（回滚修复）；
 *   3. `git apply -R` 回滚修复补丁，得到“重新引入漏洞”的副本；
 *   4. `git diff --no-index fixed defect` 生成待检视 diff；
 *   5. 真实调用 review-pi（用户级配置里的模型/key），把 diff / findings / audit / verdict
 *      归档到 repo-diff-skill-result/real-defect-url-injection/<时间戳>/。
 *
 * 用法：
 *   node .agents/skills/real-defect-url-injection/scripts/run.mjs
 *   node ... --case VUL4J-38 --model deepseek-v4.1-flash
 *   node ... --dry-run --keep-temp
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  RESULT_ROOT,
  REPO_ROOT,
  cleanupTemp,
  copyTree,
  displayPath,
  ensureDir,
  evaluateFindings,
  fail,
  gitDiffNoIndex,
  loadRunResult,
  makeTemp,
  parseArgs,
  relativeToRepo,
  rewriteDiffPaths,
  run,
  runReview,
  sha256,
  stamp,
  writeJson,
  writeVerdict,
} from "../../_shared/review-eval.mjs";

const SKILL = "real-defect-url-injection";
const CASES_PATH = join(REPO_ROOT, "data", "vul4j", "materialized-cases.json");

const args = parseArgs(process.argv.slice(2));
const caseId = typeof args.case === "string" ? args.case : "VUL4J-38";

if (!existsSync(CASES_PATH)) {
  fail(`缺少真实缺陷清单：${displayPath(CASES_PATH)}（先按 data/vul4j 的说明物化 VUL4J 案例）`);
}

const cases = JSON.parse(readFileSync(CASES_PATH, "utf8"));
const caseData = Array.isArray(cases) ? cases.find((item) => item.caseId === caseId) : undefined;
if (caseData === undefined) {
  fail(`materialized-cases.json 里没有 ${caseId}`);
}
if (typeof caseData.repoPath !== "string" || typeof caseData.truth?.fixPatch !== "string") {
  fail(`${caseId} 缺少 repoPath 或 truth.fixPatch，无法回放`);
}

const repoSource = resolve(REPO_ROOT, caseData.repoPath);
if (!existsSync(repoSource)) {
  fail(`真实仓库快照不存在：${displayPath(repoSource)}。先物化该 VUL4J 案例（不要联网重拉）`);
}

const runDir =
  typeof args.out === "string"
    ? resolve(args.out)
    : join(RESULT_ROOT, SKILL, stamp());
ensureDir(runDir);

const temp = makeTemp(SKILL);
const fixedDir = join(temp, "fixed");
const defectDir = join(temp, "defect");
const patchPath = join(temp, "fix.patch");

process.stdout.write(`[${SKILL}] case=${caseId}\n`);
process.stdout.write(`[${SKILL}] 真实快照：${displayPath(repoSource)}\n`);
process.stdout.write(`[${SKILL}] 归档目录：${displayPath(runDir)}\n`);

copyTree(repoSource, fixedDir);
copyTree(repoSource, defectDir);
writeFileSync(patchPath, caseData.truth.fixPatch, "utf8");

// 回滚真实修复：defect 副本回到“缺陷仍在”的状态。
const apply = run(
  "git",
  ["-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "apply", "-R", "--whitespace=nowarn", patchPath],
  { cwd: defectDir },
);
if (apply.status !== 0) {
  cleanupTemp(temp, false);
  fail(`回滚修复补丁失败（exit ${String(apply.status)}）：${apply.stderr || apply.stdout}`);
}

const rawDiff = gitDiffNoIndex("fixed", "defect", temp);
const defectDiff = rewriteDiffPaths(rawDiff, "fixed", "defect");
const diffPath = join(runDir, "defect.diff");
writeFileSync(diffPath, defectDiff, "utf8");

const truth = {
  caseId,
  source: "vul4j",
  repoSlug: caseData.extensions?.repoSlug ?? null,
  fixSha: caseData.extensions?.fixSha ?? null,
  fixCommitUrl: caseData.extensions?.fixCommitUrl ?? null,
  cveId: caseData.extensions?.cveId ?? null,
  cweId: caseData.extensions?.cweId ?? null,
  issueDescription: caseData.issueDescription ?? "",
  locations: Array.isArray(caseData.truth.locations) ? caseData.truth.locations : [],
  keywords: ["inject", "encod", "escap", "query", "parameter", "url", "cwe-74"],
  lineTolerance: 5,
};
writeJson(join(runDir, "ground-truth.json"), truth);

if (args["dry-run"] === true) {
  writeJson(join(runDir, "meta.json"), {
    skill: SKILL,
    caseId,
    createdAt: new Date().toISOString(),
    mode: "dry-run",
    repoSource: relativeToRepo(repoSource),
    diffPath: "defect.diff",
    diffSha256: sha256(defectDiff),
    baseRepo: relativeToRepo(repoSource),
    tempKept: true,
  });
  process.stdout.write(`[${SKILL}] dry-run：已生成 ${displayPath(diffPath)}，未调用模型\n`);
  process.stdout.write(`[${SKILL}] 临时底座保留在 ${fixedDir}\n`);
  process.exit(0);
}

process.stdout.write(`[${SKILL}] 调用真实模型检视（可能耗时数分钟）...\n`);
const review = runReview({
  // 直接读已物化的修复后快照（只读）；fixed 副本只用于生成 diff，
  // 这样 verdict.md 里的复现命令不会指向已被清理的临时目录。
  repoDir: repoSource,
  diffPath,
  runDir,
  model: typeof args.model === "string" ? args.model : undefined,
  ruleSkillDir: typeof args["rule-skill"] === "string" ? args["rule-skill"] : undefined,
});

const { findings, record } = loadRunResult(runDir);
const evaluation = evaluateFindings(findings, truth);

writeJson(join(runDir, "meta.json"), {
  skill: SKILL,
  caseId,
  createdAt: new Date().toISOString(),
  mode: "real",
  repoSource: relativeToRepo(repoSource),
  diffPath: "defect.diff",
  diffSha256: sha256(defectDiff),
  reviewExitCode: review.status,
  reviewDurationMs: review.durationMs,
  command: review.command,
  model: record?.model ?? (typeof args.model === "string" ? args.model : null),
  tempKept: args["keep-temp"] === true,
  tempDir: args["keep-temp"] === true ? fixedDir : null,
});

const verdict = writeVerdict({
  runDir,
  skill: SKILL,
  caseId,
  title: `真实缺陷回放：${caseId}${truth.cveId !== null ? ` (${truth.cveId})` : ""}`,
  truth,
  findings,
  evaluation,
  review,
  record,
  meta: { source: truth.source, repoSlug: truth.repoSlug, fixCommitUrl: truth.fixCommitUrl },
});

cleanupTemp(temp, args["keep-temp"] === true);

process.stdout.write(`[${SKILL}] review-pi exit=${String(review.status)}，findings=${String(findings.length)}，判定=${verdict.detected ? "捕获" : "未捕获"}\n`);
process.stdout.write(`[${SKILL}] 归档：${displayPath(runDir)}\n`);

if (args["fail-on-miss"] === true && !verdict.detected) {
  process.exit(2);
}
if (review.status !== 0) {
  process.exit(review.status ?? 1);
}
