#!/usr/bin/env node
/**
 * VUL4J 聚合评测：对已物化的 VUL4J 案例真跑 review-pi，并计算召回率 / 精准度。
 *
 * 与 `.agents/skills/*` 的差别：
 *   - 那些技能是「单例归档」（跑一例、判是否捕获、写 verdict.md）；
 *   - 本脚本是「跨例聚合」：一次跑 N 例，输出 micro/macro 指标与未命中清单。
 *
 * 指标口径（刻意保守，避免把“未判定”冒充误报）：
 *   - 命中只认 **文件 + 行号容差**（默认 ±5）；同文件关键词/规则命中只作诊断，不计入分子。
 *   - locationRecall   = 被命中的真值位置数 / 真值位置总数
 *   - caseRecall       = 至少命中一个真值位置的案例数 / 案例总数
 *   - precisionLoc     = 命中真值位置的 findings 数 / findings 总数（保守下界）
 *   - unjudged         = 未命中真值位置的 findings 数（VUL4J 未标注其他缺陷，不能直接算误报）
 *   - recallAtP0P1     = 被 P0/P1 finding 命中的真值位置数 / 真值位置总数
 *
 * 用法：
 *   node scripts/eval/vul4j-eval.mjs --dry-run
 *   node scripts/eval/vul4j-eval.mjs --cases VUL4J-38,VUL4J-52,VUL4J-79
 *   node scripts/eval/vul4j-eval.mjs --cases-file data/vul4j/materialized-cases-10.json --dry-run
 *   node scripts/eval/vul4j-eval.mjs --cases VUL4J-38 --model deepseek-v4.1-flash
 *   node scripts/eval/vul4j-eval.mjs --runs-dir repo-diff-skill-result/vul4j-eval/<stamp>
 *   node scripts/eval/vul4j-eval.mjs --runs-dir <stamp> --severity-sweep
 *   node scripts/eval/vul4j-eval.mjs --runs-dir <stamp> --severity-min P1
 *   node scripts/eval/vul4j-eval.mjs --runs-dir <stamp> --confidence-sweep
 *   node scripts/eval/vul4j-eval.mjs --runs-dir <stamp> --confidence-min 0.7
 *
 * 产物：<out>/<caseId>/（stdout/stderr/tasks）+ <out>/metrics.json + <out>/report.md
 * 归档根 `repo-diff-skill-result/` 已 gitignore。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  REPO_ROOT,
  ensureDir,
  fail,
  loadRunResult,
  parseArgs,
  relativeToRepo,
  runReview,
  stamp,
  writeJson,
} from "../../.agents/skills/_shared/review-eval.mjs";

const DEFAULT_CASES_PATH = join(REPO_ROOT, "data", "vul4j", "materialized-cases.json");
const DIFFS_DIR = join(REPO_ROOT, ".cache", "datasets", "vul4j-diffs");
const RESULT_ROOT = join(REPO_ROOT, "repo-diff-skill-result", "vul4j-eval");

const args = parseArgs(process.argv.slice(2));
const CASES_PATH =
  typeof args["cases-file"] === "string" ? resolve(args["cases-file"]) : DEFAULT_CASES_PATH;
const tolerance = readInt(args.tolerance, 5);
const model = typeof args.model === "string" ? args.model : undefined;
const ruleSkillDir = typeof args["rule-skill"] === "string" ? resolve(args["rule-skill"]) : undefined;
const reuseRoot = typeof args["runs-dir"] === "string" ? resolve(args["runs-dir"]) : undefined;
const issueMode = args.issue === true;
const timeoutMs = readInt(args["timeout-ms"], 20 * 60 * 1000);
const severityMinRaw = typeof args["severity-min"] === "string" ? args["severity-min"].toUpperCase() : undefined;
const severityMinRank = severityMinRaw === undefined ? undefined : parseSeverity(severityMinRaw);
const severitySweep = args["severity-sweep"] === true;
const confidenceMin = readConfidence(args["confidence-min"], 0);
const confidenceSweep = args["confidence-sweep"] === true;

if (args["dry-run"] !== true && !existsSync(CASES_PATH)) {
  fail(`缺少案例清单：${relativeToRepo(CASES_PATH)}`);
}

const allCases = existsSync(CASES_PATH)
  ? JSON.parse(readFileSync(CASES_PATH, "utf8"))
  : [];
const selectedIds =
  typeof args.cases === "string"
    ? args.cases.split(",").map((id) => id.trim()).filter((id) => id !== "")
    : allCases.map((item) => item.caseId);
const cases = allCases.filter((item) => selectedIds.includes(item.caseId));

if (cases.length === 0) {
  fail(`没有可评的案例（已物化：${allCases.map((c) => c.caseId).join(", ") || "无"}）`);
}

if (args["dry-run"] === true) {
  const totalLocations = cases.reduce((sum, item) => sum + truthLocations(item).length, 0);
  process.stdout.write(
    `[vul4j-eval] dry-run：${cases.length} 例，真值位置 ${String(totalLocations)} 个，容差 ±${String(tolerance)}\n`,
  );
  for (const item of cases) {
    const repo = resolve(REPO_ROOT, item.repoPath ?? "");
    const diff = join(DIFFS_DIR, `${item.caseId}.diff`);
    process.stdout.write(
      `  ${item.caseId}  locs=${String(truthLocations(item).length)}  repo=${existsSync(repo) ? "ok" : "MISSING"}  diff=${existsSync(diff) ? "ok" : "MISSING"}\n`,
    );
  }
  process.exit(0);
}

const outDir =
  typeof args.out === "string"
    ? resolve(args.out)
    : join(RESULT_ROOT, stamp());
ensureDir(outDir);

process.stdout.write(`[vul4j-eval] ${cases.length} 例，容差 ±${String(tolerance)}，归档 ${relativeToRepo(outDir)}\n`);

const caseInputs = [];
for (const caseData of cases) {
  const caseId = caseData.caseId;
  const runDir = reuseRoot === undefined ? join(outDir, caseId) : join(reuseRoot, caseId);
  let findings = [];

  if (reuseRoot !== undefined) {
    process.stdout.write(`[vul4j-eval] ${caseId}：复用 ${relativeToRepo(runDir)}\n`);
    if (!existsSync(runDir)) fail(`复用目录不存在：${relativeToRepo(runDir)}`);
    findings = loadRunResult(runDir).findings;
  } else {
    const repoDir = resolve(REPO_ROOT, caseData.repoPath ?? "");
    const diffPath = join(DIFFS_DIR, `${caseId}.diff`);
    if (!existsSync(repoDir)) fail(`${caseId} 仓库快照不存在：${relativeToRepo(repoDir)}`);
    if (!existsSync(diffPath)) fail(`${caseId} MR diff 不存在：${relativeToRepo(diffPath)}`);
    process.stdout.write(`[vul4j-eval] ${caseId}：真实调用模型检视（可能耗时数分钟）...\n`);
    const review = runReview({
      repoDir,
      diffPath,
      runDir,
      ruleSkillDir,
      model,
      timeoutMs,
      issue: issueMode ? caseData.issueDescription : undefined,
    });
    if (review.status !== 0) {
      process.stderr.write(`[vul4j-eval] ${caseId} review 退出码 ${String(review.status)}，findings 可能不完整（见 stderr.log）\n`);
    }
    findings = loadRunResult(runDir).findings;
  }

  caseInputs.push({ caseData, runDir, findings });
}

// severity 阈值扫描：undefined = 不裁剪（ALL），0..3 = 只保留 P0..Pn。
const sweepRanks = severitySweep ? [undefined, 0, 1, 2, 3] : [severityMinRank];
const evaluations = sweepRanks.map((rank) => {
  const evaluated = caseInputs.map(({ caseData, runDir, findings }) =>
    evaluateCase(caseData, findings, tolerance, runDir, rank, confidenceMin),
  );
  return {
    minSeverity: rank === undefined ? "ALL" : `P${String(rank)}`,
    cases: evaluated,
    metrics: aggregate(evaluated, tolerance),
  };
});
const primaryLabel = severityMinRank === undefined ? "ALL" : `P${String(severityMinRank)}`;
const primary = evaluations.find((item) => item.minSeverity === primaryLabel) ?? evaluations[0];

// confidence 阈值扫描：在 primary severity 口径上再按 confidence 下限裁剪。
const confidenceLevels = confidenceSweep ? [0, 0.3, 0.5, 0.7, 0.8] : [confidenceMin];
const confidenceEvaluations = confidenceLevels.map((level) => {
  const evaluated = caseInputs.map(({ caseData, runDir, findings }) =>
    evaluateCase(caseData, findings, tolerance, runDir, severityMinRank, level),
  );
  return {
    minConfidence: level,
    cases: evaluated,
    metrics: aggregate(evaluated, tolerance),
  };
});
const primaryConfidence =
  confidenceEvaluations.find((item) => item.minConfidence === confidenceMin) ??
  confidenceEvaluations[0];

for (const row of primary.cases) {
  process.stdout.write(
    `[vul4j-eval] ${row.caseId}：findings=${String(row.findings)}，命中位置 ${String(row.locationsHit)}/${String(row.locations)}，precision=${row.precisionLoc.toFixed(2)}，recall=${row.locationRecall.toFixed(2)}\n`,
  );
}

const metrics = primary.metrics;
const payload = {
  generatedAt: new Date().toISOString(),
  model: model ?? "(run.json)",
  ruleSkill: ruleSkillDir === undefined ? null : relativeToRepo(ruleSkillDir),
  issueMode,
  tolerance,
  severityMin: primary.minSeverity,
  confidenceMin: primaryConfidence.minConfidence,
  cases: primary.cases,
  metrics,
  severitySweep:
    evaluations.length > 1
      ? evaluations.map((item) => ({ minSeverity: item.minSeverity, metrics: item.metrics }))
      : undefined,
  confidenceSweep:
    confidenceEvaluations.length > 1
      ? confidenceEvaluations.map((item) => ({
          minConfidence: item.minConfidence,
          metrics: item.metrics,
        }))
      : undefined,
};
writeJson(join(outDir, "metrics.json"), payload);
writeFileSync(join(outDir, "report.md"), renderReport(payload));

process.stdout.write(
  `[vul4j-eval] 汇总（severity ${severityLabel(primary.minSeverity)}，confidence ≥ ${primaryConfidence.minConfidence.toFixed(2)}）：${outDir}\n`,
);
process.stdout.write(
  `  micro recall=${(metrics.locationRecallMicro * 100).toFixed(1)}%  macro=${(metrics.locationRecallMacro * 100).toFixed(1)}%  case=${(metrics.caseRecall * 100).toFixed(1)}%  precision(loc)=${(metrics.precisionLocation * 100).toFixed(1)}%  unjudged=${String(metrics.unjudged)}\n`,
);
if (payload.severitySweep !== undefined) {
  process.stdout.write("[vul4j-eval] severity 扫描：\n");
  for (const item of payload.severitySweep) {
    const m = item.metrics;
    process.stdout.write(
      `  保留 ${severityLabel(item.minSeverity)}：位置召回 ${(m.locationRecallMicro * 100).toFixed(1)}%（${String(m.locationsHit)}/${String(m.truthLocations)}），精准度 ${(m.precisionLocation * 100).toFixed(1)}%，findings ${String(m.findings)}（非测试 ${String(m.mainFindings)}），案例召回 ${(m.caseRecall * 100).toFixed(1)}%\n`,
    );
  }
}
if (payload.confidenceSweep !== undefined) {
  process.stdout.write("[vul4j-eval] confidence 扫描：\n");
  for (const item of payload.confidenceSweep) {
    const m = item.metrics;
    process.stdout.write(
      `  保留 confidence ≥ ${item.minConfidence.toFixed(2)}：位置召回 ${(m.locationRecallMicro * 100).toFixed(1)}%（${String(m.locationsHit)}/${String(m.truthLocations)}），精准度 ${(m.precisionLocation * 100).toFixed(1)}%，findings ${String(m.findings)}（非测试 ${String(m.mainFindings)}），案例召回 ${(m.caseRecall * 100).toFixed(1)}%\n`,
    );
  }
}

if (args["fail-on-miss"] === true && metrics.locationRecallMicro < 1) {
  process.exit(2);
}

// ───────────────────────────── 判定与聚合 ─────────────────────────────

function truthLocations(caseData) {
  const locations = caseData?.truth?.locations;
  return Array.isArray(locations) ? locations : [];
}

function normalizePath(value) {
  return String(value ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "");
}

function sameFile(left, right) {
  const a = normalizePath(left);
  const b = normalizePath(right);
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function severityOf(finding) {
  return String(finding.severity ?? "UNKNOWN").toUpperCase();
}

/** confidence 缺失 / 非有限数按 1 处理（不因数据缺口误删） */
function confidenceOf(finding) {
  const value = Number(finding.confidence);
  return Number.isFinite(value) ? value : 1;
}

function evaluateCase(caseData, findings, tol, runDir, minRank, minConfidence) {
  const locations = truthLocations(caseData);
  const confidenceFloor = minConfidence ?? 0;
  const keptFindings = findings.filter((finding) => {
    if (minRank !== undefined && severityRank(severityOf(finding)) > minRank) {
      return false;
    }
    return confidenceOf(finding) >= confidenceFloor;
  });
  const rows = keptFindings.map((finding) => {
    const line = Number(finding.line);
    const matchedLocation = locations.find(
      (location) =>
        sameFile(finding.file, location.file) &&
        line >= Number(location.lineStart) - tol &&
        line <= Number(location.lineEnd) + tol,
    );
    return {
      id: finding.id,
      severity: severityOf(finding),
      category: finding.category ?? null,
      file: finding.file,
      line: finding.line,
      title: finding.title ?? "",
      confidence: confidenceOf(finding),
      matchedLocation: matchedLocation ?? null,
      severityBucket: severityRank(severityOf(finding)),
      testFile: isTestFile(finding.file, caseData),
    };
  });

  // 每个真值位置是否被至少一条 finding 命中（同一 finding 可覆盖多个位置，但去重计数）。
  const locationHits = locations.map((location, index) => {
    const hits = rows.filter(
      (row) =>
        sameFile(row.file, location.file) &&
        Number(row.line) >= Number(location.lineStart) - tol &&
        Number(row.line) <= Number(location.lineEnd) + tol,
    );
    return {
      index,
      file: location.file,
      lineStart: location.lineStart,
      lineEnd: location.lineEnd,
      defectNature: location.defectNature ?? null,
      hit: hits.length > 0,
      hitByP0P1: hits.some((row) => row.severityBucket <= 1),
      hitFindingIds: hits.map((row) => row.id),
    };
  });

  const locationsHit = locationHits.filter((item) => item.hit).length;
  const locationsHitP0P1 = locationHits.filter((item) => item.hitByP0P1).length;
  // VUL4J 的 truth 明确排除测试文件（extensions.excludedTestFiles），
  // 因此测试文件上的 findings 单独计数，不进入精准度分母。
  const mainRows = rows.filter((row) => !row.testFile);
  const matchedFindingsAll = rows.filter((row) => row.matchedLocation !== null).length;
  const matchedFindings = mainRows.filter((row) => row.matchedLocation !== null).length;

  return {
    caseId: caseData.caseId,
    repoSlug: caseData.extensions?.repoSlug ?? null,
    cveId: caseData.extensions?.cveId ?? null,
    cweId: caseData.extensions?.cweId ?? null,
    runDir: relativeToRepo(runDir),
    locations: locations.length,
    locationsHit,
    locationRecall: locations.length === 0 ? 0 : locationsHit / locations.length,
    locationsHitP0P1,
    recallAtP0P1: locations.length === 0 ? 0 : locationsHitP0P1 / locations.length,
    findings: rows.length,
    mainFindings: mainRows.length,
    testFileFindings: rows.length - mainRows.length,
    matchedFindings,
    matchedFindingsAll,
    precisionLoc: mainRows.length === 0 ? 0 : matchedFindings / mainRows.length,
    precisionLocAll: rows.length === 0 ? 0 : matchedFindingsAll / rows.length,
    unjudged: mainRows.length - matchedFindings,
    severityCounts: countBy(rows.map((row) => row.severity)),
    locationHits,
    rows,
  };
}

/**
 * 判断 finding 是否落在 VUL4J 明确排除的测试文件上。
 * 优先用案例自带的 excludedTestFiles；缺失时退化为 /src/test/ 或 /test/ 路径启发。
 */
function isTestFile(file, caseData) {
  const raw = caseData?.extensions?.excludedTestFiles;
  const excluded = Array.isArray(raw) ? raw : typeof raw === "string" && raw !== "" ? [raw] : [];
  if (excluded.some((item) => sameFile(file, item))) return true;
  const normalized = normalizePath(file);
  return normalized.includes("/src/test/") || normalized.startsWith("src/test/") || normalized.includes("/test/");
}

function aggregate(cases, tol) {
  const truthTotal = cases.reduce((sum, item) => sum + item.locations, 0);
  const hitTotal = cases.reduce((sum, item) => sum + item.locationsHit, 0);
  const hitP0P1Total = cases.reduce((sum, item) => sum + item.locationsHitP0P1, 0);
  const findingsTotal = cases.reduce((sum, item) => sum + item.findings, 0);
  const mainFindingsTotal = cases.reduce((sum, item) => sum + item.mainFindings, 0);
  const testFileTotal = cases.reduce((sum, item) => sum + item.testFileFindings, 0);
  const matchedTotal = cases.reduce((sum, item) => sum + item.matchedFindings, 0);
  const matchedAllTotal = cases.reduce((sum, item) => sum + item.matchedFindingsAll, 0);
  return {
    cases: cases.length,
    tolerance: tol,
    truthLocations: truthTotal,
    locationsHit: hitTotal,
    locationRecallMicro: truthTotal === 0 ? 0 : hitTotal / truthTotal,
    locationRecallMacro:
      cases.length === 0 ? 0 : cases.reduce((sum, item) => sum + item.locationRecall, 0) / cases.length,
    caseRecall: cases.length === 0 ? 0 : cases.filter((item) => item.locationsHit > 0).length / cases.length,
    locationsHitP0P1: hitP0P1Total,
    recallAtP0P1: truthTotal === 0 ? 0 : hitP0P1Total / truthTotal,
    findings: findingsTotal,
    mainFindings: mainFindingsTotal,
    testFileFindings: testFileTotal,
    matchedFindings: matchedTotal,
    precisionLocation: mainFindingsTotal === 0 ? 0 : matchedTotal / mainFindingsTotal,
    precisionLocationAll: findingsTotal === 0 ? 0 : matchedAllTotal / findingsTotal,
    unjudged: mainFindingsTotal - matchedTotal,
    severityCounts: countBy(cases.flatMap((item) => item.rows.map((row) => row.severity))),
  };
}

function severityRank(severity) {
  const match = /^P([0-3])$/.exec(severity);
  return match === null ? 9 : Number(match[1]);
}

function parseSeverity(raw) {
  if (!/^P[0-3]$/.test(raw)) fail(`--severity-min 只接受 P0/P1/P2/P3，收到：${raw}`);
  return Number(raw.slice(1));
}

function severityLabel(minSeverity) {
  return minSeverity === "ALL" ? "P0–P3（全部）" : `P0–${minSeverity}`;
}

function countBy(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort());
}

function renderReport(payload) {
  const m = payload.metrics;
  const lines = [];
  lines.push("# VUL4J 聚合评测");
  lines.push("");
  lines.push(`- 生成时间：${payload.generatedAt}`);
  lines.push(`- 模型：${payload.model}`);
  lines.push(`- 规则 Skill：${payload.ruleSkill ?? "未加载"}`);
  lines.push(`- issue 上下文：${payload.issueMode ? "传入真值描述（非盲测）" : "未传入（盲测，推荐）"}`);
  lines.push(`- 行号容差：±${String(m.tolerance)}`);
  lines.push(`- severity 阈值：${severityLabel(payload.severityMin)}`);
  lines.push(`- confidence 阈值：≥ ${Number(payload.confidenceMin ?? 0).toFixed(2)}`);
  lines.push("- 场景：`.cache/datasets/vul4j-diffs/` 的规范修复提交 diff（base → fixed）；真值行号按 fixed 侧计。");
  lines.push("");
  lines.push("## 汇总");
  lines.push("");
  lines.push("| 指标 | 值 |");
  lines.push("|---|---|");
  lines.push(`| 案例数 | ${String(m.cases)} |`);
  lines.push(`| 真值位置数 | ${String(m.truthLocations)} |`);
  lines.push(`| 位置级召回（micro） | ${pct(m.locationRecallMicro)}（${String(m.locationsHit)}/${String(m.truthLocations)}） |`);
  lines.push(`| 位置级召回（macro） | ${pct(m.locationRecallMacro)} |`);
  lines.push(`| 案例级召回 | ${pct(m.caseRecall)} |`);
  lines.push(`| P0/P1 位置召回 | ${pct(m.recallAtP0P1)}（${String(m.locationsHitP0P1)}/${String(m.truthLocations)}） |`);
  lines.push(`| 精准度（排除测试文件） | ${pct(m.precisionLocation)}（${String(m.matchedFindings)}/${String(m.mainFindings)}） |`);
  lines.push(`| 精准度（全部 findings） | ${pct(m.precisionLocationAll)} |`);
  lines.push(`| 未判定 findings（非测试） | ${String(m.unjudged)} |`);
  lines.push(`| 测试文件 findings（不计入精准度） | ${String(m.testFileFindings)} |`);
  lines.push("");
  lines.push("> 精准度口径：只有「文件 + 行号容差」命中真值位置才算命中；VUL4J 的 truth 明确排除测试文件，" +
    "因此测试文件上的 findings 单独计数；其余未判定 findings 不等于误报（数据集未标注同 diff 的其他缺陷）。");
  lines.push("");
  if (payload.severitySweep !== undefined) {
    lines.push("## severity 阈值扫描");
    lines.push("");
    lines.push("> 只保留 severity 达到阈值（P0 最高）的 findings 后重新计算；P3 等于全部已知 findings。");
    lines.push("");
    lines.push("| 阈值 | 位置召回（micro） | 精准度（非测试） | findings | 非测试 | 测试文件 | 未判定 | 案例召回 |");
    lines.push("|---|---|---|---|---|---|---|---|");
    for (const item of payload.severitySweep) {
      const mm = item.metrics;
      lines.push(
        `| ${severityLabel(item.minSeverity)} | ${pct(mm.locationRecallMicro)}（${String(mm.locationsHit)}/${String(mm.truthLocations)}） | ${pct(mm.precisionLocation)} | ${String(mm.findings)} | ${String(mm.mainFindings)} | ${String(mm.testFileFindings)} | ${String(mm.unjudged)} | ${pct(mm.caseRecall)} |`,
      );
    }
    lines.push("");
  }
  if (payload.confidenceSweep !== undefined) {
    lines.push("## confidence 阈值扫描");
    lines.push("");
    lines.push("> 只保留 `confidence ≥ 阈值` 的 findings 后重新计算（severity 保持主口径）；0 = 不过滤。");
    lines.push("");
    lines.push("| 阈值 | 位置召回（micro） | 精准度（非测试） | findings | 非测试 | 测试文件 | 未判定 | 案例召回 |");
    lines.push("|---|---|---|---|---|---|---|---|");
    for (const item of payload.confidenceSweep) {
      const mm = item.metrics;
      lines.push(
        `| ≥ ${Number(item.minConfidence).toFixed(2)} | ${pct(mm.locationRecallMicro)}（${String(mm.locationsHit)}/${String(mm.truthLocations)}） | ${pct(mm.precisionLocation)} | ${String(mm.findings)} | ${String(mm.mainFindings)} | ${String(mm.testFileFindings)} | ${String(mm.unjudged)} | ${pct(mm.caseRecall)} |`,
      );
    }
    lines.push("");
  }
  lines.push("## 分案例");
  lines.push("");
  lines.push("| 案例 | CWE | 位置召回 | 精准度（非测试） | findings | 测试文件 | 未判定 | severity |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const item of payload.cases) {
    lines.push(
      `| ${item.caseId} | ${item.cweId ?? "-"} | ${pct(item.locationRecall)}（${String(item.locationsHit)}/${String(item.locations)}） | ${pct(item.precisionLoc)} | ${String(item.findings)} | ${String(item.testFileFindings)} | ${String(item.unjudged)} | ${formatCounts(item.severityCounts)} |`,
    );
  }
  lines.push("");
  lines.push("## 未命中的真值位置");
  lines.push("");
  for (const item of payload.cases) {
    const missed = item.locationHits.filter((location) => !location.hit);
    if (missed.length === 0) continue;
    lines.push(`### ${item.caseId}`);
    lines.push("");
    for (const location of missed) {
      lines.push(`- \`${location.file}:${String(location.lineStart)}-${String(location.lineEnd)}\`（${location.defectNature ?? "未标注"}）`);
    }
    lines.push("");
  }
  lines.push("## 未命中真值位置的非测试 findings");
  lines.push("");
  for (const item of payload.cases) {
    const unjudged = item.rows.filter((row) => row.matchedLocation === null && !row.testFile);
    if (unjudged.length === 0) continue;
    lines.push(`### ${item.caseId}`);
    lines.push("");
    lines.push("| id | severity | 文件:行 | 标题 |");
    lines.push("|---|---|---|---|");
    for (const row of unjudged) {
      lines.push(`| ${row.id} | ${row.severity} | \`${row.file}:${String(row.line)}\` | ${row.title} |`);
    }
    lines.push("");
  }
  lines.push("## 测试文件 findings（VUL4J truth 排除，不计入精准度）");
  lines.push("");
  const testRows = payload.cases.flatMap((item) =>
    item.rows.filter((row) => row.testFile).map((row) => ({ caseId: item.caseId, ...row })),
  );
  if (testRows.length === 0) {
    lines.push("(无)");
  } else {
    lines.push("| 案例 | id | severity | 文件:行 | 标题 |");
    lines.push("|---|---|---|---|---|");
    for (const row of testRows) {
      lines.push(
        `| ${row.caseId} | ${row.id} | ${row.severity} | \`${row.file}:${String(row.line)}\` | ${row.title} |`,
      );
    }
  }
  lines.push("");
  lines.push("## 复现");
  lines.push("");
  lines.push("```bash");
  const severityArg = payload.severityMin === "ALL" ? "" : ` --severity-min ${payload.severityMin}`;
  const confidenceArg =
    Number(payload.confidenceMin ?? 0) > 0
      ? ` --confidence-min ${Number(payload.confidenceMin).toFixed(2)}`
      : "";
  lines.push(`node scripts/eval/vul4j-eval.mjs --cases ${payload.cases.map((item) => item.caseId).join(",")} --tolerance ${String(m.tolerance)}${severityArg}${confidenceArg}`);
  lines.push("```");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatCounts(counts) {
  return Object.entries(counts)
    .map(([key, value]) => `${key}:${String(value)}`)
    .join(" ") || "-";
}

function readInt(raw, fallback) {
  if (raw === undefined || raw === true || raw === false) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) fail(`参数需要非负整数，收到：${String(raw)}`);
  return value;
}

function readConfidence(raw, fallback) {
  if (raw === undefined || raw === true || raw === false) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    fail(`--confidence-min 只接受 0–1，收到：${String(raw)}`);
  }
  return value;
}
