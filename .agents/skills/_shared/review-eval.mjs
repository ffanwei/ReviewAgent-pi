/**
 * 两个「diff 检视技能」的共享执行层。
 *
 * 只做确定性动作：构造 diff、调用 review-pi、读产物、判定命中、写归档。
 * 不读配置、不碰 API key——凭据由 review-pi 自己从用户级 PiAgent.jsonc 装载。
 *
 * 目录约定：
 *   .agents/skills/_shared/review-eval.mjs   ← 本文件
 *   .agents/skills/<skill>/scripts/run.mjs   ← 各技能入口
 *   仓根/repo-diff-skill-result/<skill>/<时间戳>/
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 仓根（从 .agents/skills/_shared/ 上溯三级）。 */
export const REPO_ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

/** 归档根：仓根/repo-diff-skill-result。 */
export const RESULT_ROOT = join(REPO_ROOT, "repo-diff-skill-result");

/** review-pi 的进程入口（bin 会校验 dist 新鲜度）。 */
export const REVIEW_PI_BIN = join(REPO_ROOT, "packages", "review-pi", "bin", "review-pi.js");

/** 通用失败：打印人话并以非零退出。 */
export function fail(message) {
  process.stderr.write(`\n[review-diff-skill] ${message}\n`);
  process.exit(1);
}

/**
 * 轻量参数解析：`--key value` / `--flag` / `--key=value`。
 * 布尔旗标（dry-run / keep-temp / fail-on-miss / no-rule-skill）缺省 false。
 */
export function parseArgs(argv) {
  const out = Object.create(null);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) fail(`无法识别的参数：${token}`);
    const eq = token.indexOf("=");
    if (eq !== -1) {
      out[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

/** 本地时间戳：YYYYMMDD-HHmmss（用于归档目录，避免覆盖）。 */
export function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 复制目录（保留字节，不做换行转换）。 */
export function copyTree(src, dst) {
  cpSync(src, dst, { recursive: true });
}

/** 建临时目录（默认在系统临时目录下）。 */
export function makeTemp(prefix) {
  return mkdtempSync(join(tmpdir(), `review-diff-skill-${prefix}-`));
}

/** 执行子进程，返回 { status, stdout, stderr }。 */
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    timeout: options.timeoutMs ?? 0,
    env: options.env ?? process.env,
  });
  if (result.error !== undefined) {
    throw new Error(`${command} 启动失败：${result.error.message}`);
  }
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * `git diff --no-index`：把一个“干净副本”和一个“缺陷副本”压成标准 unified diff。
 * 关闭 autocrlf/safecrlf，避免 Windows 上把换行警告刷满 stderr，也避免改字节。
 * 退出码 1 = 有差异（正常），0 = 无差异（视为构造失败）。
 */
export function gitDiffNoIndex(beforeDir, afterDir, cwd) {
  const result = run(
    "git",
    [
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.safecrlf=false",
      "diff",
      "--no-index",
      "--no-color",
      "--unified=3",
      "--",
      beforeDir,
      afterDir,
    ],
    { cwd },
  );
  if (result.status === 0) {
    throw new Error("两个副本没有差异，diff 构造失败");
  }
  if (result.status !== 1) {
    throw new Error(`git diff --no-index 失败（exit ${String(result.status)}）：${result.stderr}`);
  }
  return result.stdout;
}

/**
 * 把 `git diff --no-index` 输出里的临时目录前缀改写成仓库相对路径：
 *   a/fixed/foo.java → a/foo.java
 *   b/defect/foo.java → b/foo.java
 */
export function rewriteDiffPaths(diffText, beforeLabel, afterLabel) {
  return diffText
    .split("\n")
    .map((line) =>
      line
        // 修改/删除：a/<before>、b/<after>；新文件：两侧都可能用 after 路径。
        .replaceAll(`a/${beforeLabel}/`, "a/")
        .replaceAll(`a/${afterLabel}/`, "a/")
        .replaceAll(`b/${beforeLabel}/`, "b/")
        .replaceAll(`b/${afterLabel}/`, "b/"),
    )
    .join("\n");
}

/** 把 `--rule-skill` 目录的绝对路径转成归档里的可读记录。 */
export function relativeToRepo(path) {
  const normalized = resolve(path).replaceAll("\\", "/");
  const repo = REPO_ROOT.replaceAll("\\", "/");
  return normalized.startsWith(`${repo}/`) ? normalized.slice(repo.length + 1) : normalized;
}

/**
 * 真实调用 review-pi。产物全部落进 runDir：
 *   runDir/result/runs/...    （reviews_en.json / run.json / 转录）
 *   runDir/result/audit/...   （审计）
 *   runDir/.review-pi-session.json（cwd 索引）
 */
export function runReview({ repoDir, diffPath, runDir, ruleSkillDir, model, issue, taskId = "result", timeoutMs = 20 * 60 * 1000 }) {
  ensureDir(runDir);
  const args = [
    REVIEW_PI_BIN,
    "review",
    "--repo",
    resolve(repoDir),
    "--mr-diff",
    resolve(diffPath),
    "--taskId",
    taskId,
    "--tasks-dir",
    resolve(runDir),
    "--no-progress",
  ];
  if (model !== undefined) args.push("--model", model);
  if (ruleSkillDir !== undefined) args.push("--rule-skill", resolve(ruleSkillDir));
  if (issue !== undefined) args.push("--issue", issue);

  const startedAt = Date.now();
  const result = run(process.execPath, args, { cwd: runDir, timeoutMs, maxBuffer: 128 * 1024 * 1024 });
  const durationMs = Date.now() - startedAt;

  writeFileSync(join(runDir, "stdout.json"), result.stdout, "utf8");
  writeFileSync(join(runDir, "stderr.log"), result.stderr, "utf8");

  return {
    ...result,
    durationMs,
    command: [process.execPath, ...args],
  };
}

/** 读取一次 run 的 findings 与 RunRecord；产物缺失时给出空集而不是抛错。 */
export function loadRunResult(runDir, taskId = "result") {
  const taskDir = join(runDir, taskId);
  const reviewsPath = join(taskDir, "runs", "reviews_en.json");
  const recordPath = join(taskDir, "runs", "run.json");
  const reviews = existsSync(reviewsPath) ? readJson(reviewsPath) : null;
  const record = existsSync(recordPath) ? readJson(recordPath) : null;
  return {
    taskDir,
    reviewsPath,
    recordPath,
    findings: Array.isArray(reviews?.findings) ? reviews.findings : [],
    record,
  };
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 判定命中：
 *   1) 文件 + 行号落在 truth.locations 的容差内；或
 *   2) 文件匹配 + 文案命中关键词；或
 *   3) 文件匹配 + finding.rule 命中 truth.ruleIds。
 * 每条 finding 都记录 matchedBy，避免“只看总数”的黑盒结论。
 */
export function evaluateFindings(findings, truth) {
  const tolerance = truth.lineTolerance ?? 5;
  const keywords = Array.isArray(truth.keywords) ? truth.keywords : [];
  const ruleIds = Array.isArray(truth.ruleIds) ? truth.ruleIds : [];
  const keywordRe = keywords.length > 0 ? new RegExp(keywords.map(escapeRegExp).join("|"), "i") : null;
  const locations = Array.isArray(truth.locations) ? truth.locations : [];

  const rows = findings.map((finding) => {
    const fileHit =
      locations.some((location) => sameFile(finding.file, location.file)) ||
      (truth.file !== undefined && sameFile(finding.file, truth.file));
    const locationHit = locations.find(
      (location) =>
        sameFile(finding.file, location.file) &&
        Number(finding.line) >= Number(location.lineStart) - tolerance &&
        Number(finding.line) <= Number(location.lineEnd) + tolerance,
    );
    const text = [finding.title, finding.description, ...(finding.evidence ?? [])].join("\n");
    const keywordHit = keywordRe !== null && keywordRe.test(text);
    const ruleHit = ruleIds.some((id) => String(finding.rule ?? "").includes(id));
    const locationIsSufficient = truth.locationIsSufficient !== false;
    const byLocation = locationIsSufficient && locationHit !== undefined;
    const byRule = fileHit && ruleHit;
    const byKeyword = fileHit && keywordHit;
    const detected = byLocation || byRule || byKeyword;
    return {
      id: finding.id,
      severity: finding.severity,
      category: finding.category,
      file: finding.file,
      line: finding.line,
      title: finding.title,
      rule: finding.rule ?? "",
      detected,
      matchedBy: byLocation ? "location" : byRule ? "rule" : byKeyword ? "file+keyword" : "none",
      matchedLocation:
        locationHit !== undefined
          ? { file: locationHit.file, lineStart: locationHit.lineStart, lineEnd: locationHit.lineEnd }
          : null,
    };
  });

  const hits = rows.filter((row) => row.detected);
  return { detected: hits.length > 0, hits, rows };
}

function countSeverities(rows) {
  const counts = new Map();
  for (const row of rows) {
    const key = String(row.severity ?? "unknown");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort());
}

function quoteCommand(parts) {
  return parts
    .map((part) => (/[\s"&<>|]/.test(part) ? `"${part.replaceAll('"', '\\"')}"` : part))
    .join(" ");
}

/**
 * 写 verdict.json / verdict.md。verdict.md 是给人看的；verdict.json 是给后续脚本/汇总用的。
 */
export function writeVerdict({ runDir, skill, caseId, title, truth, findings, evaluation, review, record, meta }) {
  const severityCounts = countSeverities(evaluation.rows);
  const status = review.status === 0 ? "completed" : "review-failed";
  const verdict = {
    skill,
    caseId,
    title,
    generatedAt: new Date().toISOString(),
    status,
    detected: evaluation.detected,
    findingCount: findings.length,
    severityCounts,
    matchedFindings: evaluation.hits,
    findings: evaluation.rows,
    model: record?.model ?? null,
    reviewExitCode: review.status,
    reviewDurationMs: review.durationMs,
    command: quoteCommand(review.command),
    truth,
    meta,
  };
  writeJson(join(runDir, "verdict.json"), verdict);

  const lines = [];
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`- 运行状态：${status === "completed" ? "完成" : "**失败**（不能把空 findings 当作漏报）"}`);
  lines.push(`- 判定：**${evaluation.detected ? "捕获" : status === "completed" ? "未捕获" : "未判定"}**`);
  lines.push(`- 模型：${record?.model ?? "(见 run.json)"}`);
  lines.push(`- findings：${findings.length}（${Object.entries(severityCounts).map(([severity, count]) => `${severity} ${count}`).join(" / ") || "无"}）`);
  lines.push(`- review-pi 退出码：${String(review.status)}，耗时 ${(review.durationMs / 1000).toFixed(1)}s`);
  lines.push(`- 真值：\`${caseId}\``);
  lines.push("");
  if (evaluation.hits.length > 0) {
    lines.push("## 命中");
    lines.push("");
    lines.push("| finding | severity | 文件:行 | 标题 | 命中方式 |");
    lines.push("|---|---|---|---|---|");
    for (const hit of evaluation.hits) {
      lines.push(`| ${hit.id} | ${hit.severity} | \`${hit.file}:${hit.line}\` | ${hit.title} | ${hit.matchedBy} |`);
    }
    lines.push("");
  }
  lines.push("## 全部 findings");
  lines.push("");
  if (evaluation.rows.length === 0) {
    lines.push("(无)");
  } else {
    lines.push("| finding | severity | 文件:行 | 标题 | 命中 |");
    lines.push("|---|---|---|---|---|");
    for (const row of evaluation.rows) {
      lines.push(`| ${row.id} | ${row.severity} | \`${row.file}:${row.line}\` | ${row.title} | ${row.detected ? "✅" : "—"} |`);
    }
  }
  lines.push("");
  lines.push("## 复现");
  lines.push("");
  lines.push("```bash");
  lines.push(quoteCommand(review.command));
  lines.push("```");
  lines.push("");
  writeFileSync(join(runDir, "verdict.md"), `${lines.join("\n")}\n`, "utf8");

  return verdict;
}

/** 清理临时目录（--keep-temp 时跳过）。 */
export function cleanupTemp(tempDir, keep) {
  if (keep) return;
  rmSync(tempDir, { recursive: true, force: true });
}

/** 把路径压成归档里可读的形式。 */
export function displayPath(path) {
  return relativeToRepo(path);
}
