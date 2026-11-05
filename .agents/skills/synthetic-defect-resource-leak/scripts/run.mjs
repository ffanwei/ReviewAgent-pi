#!/usr/bin/env node
/**
 * 合成缺陷注入（默认 GEN-RES-001 / 资源未释放）。
 *
 * 做法：
 *   1. 复制 testdata 多语言夹具仓两份：base（干净底座）与 defect（注入缺陷）；
 *   2. 在 defect 里新增 `service/cmd/config.go`：打开文件后不在任何路径 close；
 *   3. `git diff --no-index base defect` 生成待检视 diff；
 *   4. 真实调用 review-pi，并显式装载 general-code-review 规则包；
 *   5. 把 diff / findings / audit / verdict 归档到
 *      repo-diff-skill-result/synthetic-defect-resource-leak/<时间戳>/。
 *
 * 用法：
 *   node .agents/skills/synthetic-defect-resource-leak/scripts/run.mjs
 *   node ... --model deepseek-v4.1-flash
 *   node ... --no-rule-skill          # 不装载规则包，测纯检视
 *   node ... --dry-run --keep-temp
 */

import { existsSync, writeFileSync } from "node:fs";
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
  runReview,
  sha256,
  stamp,
  writeJson,
  writeVerdict,
} from "../../_shared/review-eval.mjs";

const SKILL = "synthetic-defect-resource-leak";
const CASE_ID = "synthetic-resource-leak";
const FIXTURE = join(REPO_ROOT, "packages", "review-pi", "testdata", "repos", "multilang");
const RULE_PACK = join(REPO_ROOT, "packages", "review-pi", "testdata", "rule-skills", "general-code-review");

const args = parseArgs(process.argv.slice(2));
const fixture = typeof args.fixture === "string" ? resolve(args.fixture) : FIXTURE;
if (!existsSync(fixture)) {
  fail(`夹具仓不存在：${displayPath(fixture)}`);
}

const runDir =
  typeof args.out === "string"
    ? resolve(args.out)
    : join(RESULT_ROOT, SKILL, stamp());
ensureDir(runDir);

// 注入内容：新增一个 Go 文件，os.Open 之后在成功/失败路径都没有 Close。
const INJECTED_PATH = "service/cmd/config.go";
const INJECTED_SOURCE = `package main

import "os"

// ReadConfig loads the first chunk of a configuration file.
func ReadConfig(path string) (string, error) {
\tfile, err := os.Open(path)
\tif err != nil {
\t\treturn "", err
\t}
\tbuffer := make([]byte, 256)
\tsize, err := file.Read(buffer)
\tif err != nil {
\t\treturn "", err
\t}
\treturn string(buffer[:size]), nil
}
`;

const temp = makeTemp(SKILL);
const baseDir = join(temp, "base");
const defectDir = join(temp, "defect");

process.stdout.write(`[${SKILL}] 夹具仓：${displayPath(fixture)}\n`);
process.stdout.write(`[${SKILL}] 归档目录：${displayPath(runDir)}\n`);

copyTree(fixture, baseDir);
copyTree(fixture, defectDir);
const injectedFile = join(defectDir, INJECTED_PATH);
ensureDir(join(defectDir, "service", "cmd"));
writeFileSync(injectedFile, INJECTED_SOURCE, "utf8");

const rawDiff = gitDiffNoIndex("base", "defect", temp);
const defectDiff = rewriteDiffPaths(rawDiff, "base", "defect");
const diffPath = join(runDir, "defect.diff");
writeFileSync(diffPath, defectDiff, "utf8");

const truth = {
  caseId: CASE_ID,
  ruleId: "GEN-RES-001",
  ruleTitle: "Resource not released on the error path",
  file: INJECTED_PATH,
  locations: [{ file: INJECTED_PATH, lineStart: 6, lineEnd: 17, defectNature: "RESOURCE_LEAK" }],
  ruleIds: ["GEN-RES-001"],
  // 行范围只用于展示；命中必须靠“文件 + 泄漏关键词”或“文件 + 规则 id”，
  // 否则同一文件里的其它 finding 会被误算成命中。
  locationIsSufficient: false,
  // 用泄漏语义的短语，而不是裸 "close"/"leak"：避免把
  // “Open-read-close plumbing” 或 “leaked io.EOF sentinel” 误判成文件句柄泄漏。
  keywords: [
    "file descriptor",
    "never closed",
    "not closed",
    "unclosed",
    "without closing",
    "missing close",
    "resource leak",
    "defer file.Close",
    "file.Close()",
  ],
  lineTolerance: 3,
};
writeJson(join(runDir, "ground-truth.json"), truth);

if (args["dry-run"] === true) {
  writeJson(join(runDir, "meta.json"), {
    skill: SKILL,
    caseId: CASE_ID,
    createdAt: new Date().toISOString(),
    mode: "dry-run",
    fixture: relativeToRepo(fixture),
    diffPath: "defect.diff",
    diffSha256: sha256(defectDiff),
    tempKept: true,
  });
  process.stdout.write(`[${SKILL}] dry-run：已生成 ${displayPath(diffPath)}，未调用模型\n`);
  process.stdout.write(`[${SKILL}] 临时底座保留在 ${baseDir}\n`);
  process.exit(0);
}

const useRulePack = args["no-rule-skill"] !== true && existsSync(RULE_PACK);
process.stdout.write(
  `[${SKILL}] 调用真实模型检视${useRulePack ? "（装载 general-code-review 规则包）" : "（不装载规则包）"}...\n`,
);
const review = runReview({
  // base 副本只用于生成 diff；检视直接读夹具仓本身，保证复现命令长期可用。
  repoDir: fixture,
  diffPath,
  runDir,
  model: typeof args.model === "string" ? args.model : undefined,
  ruleSkillDir: useRulePack ? RULE_PACK : undefined,
});

const { findings, record } = loadRunResult(runDir);
const evaluation = evaluateFindings(findings, truth);

writeJson(join(runDir, "meta.json"), {
  skill: SKILL,
  caseId: CASE_ID,
  createdAt: new Date().toISOString(),
  mode: "real",
  fixture: relativeToRepo(fixture),
  diffPath: "defect.diff",
  diffSha256: sha256(defectDiff),
  injectedFile: INJECTED_PATH,
  rulePack: useRulePack ? relativeToRepo(RULE_PACK) : null,
  reviewExitCode: review.status,
  reviewDurationMs: review.durationMs,
  command: review.command,
  model: record?.model ?? (typeof args.model === "string" ? args.model : null),
  tempKept: args["keep-temp"] === true,
  tempDir: args["keep-temp"] === true ? baseDir : null,
});

const verdict = writeVerdict({
  runDir,
  skill: SKILL,
  caseId: CASE_ID,
  title: "合成缺陷注入：资源未释放 (GEN-RES-001)",
  truth,
  findings,
  evaluation,
  review,
  record,
  meta: { source: "testdata/multilang", injectedFile: INJECTED_PATH, rulePack: useRulePack ? relativeToRepo(RULE_PACK) : null },
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
