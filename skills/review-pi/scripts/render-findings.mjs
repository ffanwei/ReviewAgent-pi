#!/usr/bin/env node
/**
 * review-pi Agent Skill — deterministic finding renderer.
 *
 * Reads the CLI's stdout document (or `<runs>/reviews_all.json`) and, when
 * available, the sibling `reviews_tips_zh.json`; emits one Markdown report.
 * The point is cross-host consistency: the host agent pastes this instead of
 * inventing its own grouping, and no P3 finding is silently dropped.
 *
 * Usage:
 *   node scripts/render-findings.mjs --input review.stdout.json
 *   node scripts/render-findings.mjs --input <task>/runs/reviews_all.json --tips <task>/runs/reviews_tips_zh.json
 *   node scripts/render-findings.mjs --input review.stdout.json --format json
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const SEVERITIES = [
  { key: "P0", label: "P0 · Fatal" },
  { key: "P1", label: "P1 · Major" },
  { key: "P2", label: "P2 · Minor" },
  { key: "P3", label: "P3 · Suggestion" },
];

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }
  if (args.help === true) {
    process.stdout.write(helpText());
    return;
  }

  try {
    const inputPath = requireInput(args);
    const document = readJson(inputPath);
    const findings = extractFindings(document);
    const tips = loadTips(args, document, inputPath);
    const meta = extractMeta(document);

    const format = args.json === true ? "json" : (args.format ?? "markdown");
    if (format === "json") {
      process.stdout.write(`${JSON.stringify(buildJsonReport(meta, findings), null, 2)}\n`);
      return;
    }
    const markdown = renderMarkdown(meta, findings, tips);
    if (typeof args.output === "string") {
      const outPath = path.resolve(process.cwd(), args.output);
      writeFileSync(outPath, markdown, "utf8");
      process.stdout.write(`${outPath}\n`);
      return;
    }
    process.stdout.write(markdown);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function parseArgs(argv) {
  const out = Object.create(null);
  const valueFlags = new Set(["input", "tips", "format", "output"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (typeof token !== "string" || !token.startsWith("--")) {
      throw new Error(`无法识别的参数：${String(token)}`);
    }
    const eq = token.indexOf("=");
    const key = eq === -1 ? token.slice(2) : token.slice(2, eq);
    if (key === "help" || key === "json") {
      if (eq !== -1) throw new Error(`布尔旗标不接受值：--${key}`);
      out[key] = true;
      continue;
    }
    if (!valueFlags.has(key)) throw new Error(`未知旗标：--${key}（--help 查看用法）`);
    if (eq !== -1) {
      out[key] = token.slice(eq + 1);
    } else {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`旗标缺值：--${key}`);
      out[key] = next;
      index += 1;
    }
  }
  return out;
}

function requireInput(args) {
  if (typeof args.input !== "string") {
    throw new Error("缺少 --input <path>（review-pi 的 stdout JSON 或 reviews_all.json）");
  }
  const inputPath = path.resolve(process.cwd(), args.input);
  if (!existsSync(inputPath)) throw new Error(`--input 不存在：${inputPath}`);
  return inputPath;
}

function readJson(filePath) {
  const text = readFileSync(filePath, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`不是合法 JSON：${filePath}（${error instanceof Error ? error.message : String(error)}）`);
  }
}

function extractFindings(document) {
  if (Array.isArray(document)) return document;
  if (document !== null && typeof document === "object" && Array.isArray(document.findings)) {
    return document.findings;
  }
  throw new Error("输入里没有 findings 数组：期望 review-pi stdout 文档或 reviews_all.json 信封");
}

function extractMeta(document) {
  if (Array.isArray(document) || document === null || typeof document !== "object") return {};
  return {
    ok: document.ok,
    caseId: document.caseId,
    runId: document.runId,
    truncated: document.truncated,
    rounds: document.rounds,
    toolCalls: document.toolCalls,
    auditPath: document.auditPath,
  };
}

function loadTips(args, document, inputPath) {
  if (typeof args.tips === "string") {
    return parseTips(readJson(path.resolve(process.cwd(), args.tips)));
  }
  const candidates = [];
  if (typeof document?.auditPath === "string") {
    candidates.push(path.join(path.dirname(document.auditPath), "..", "runs", "reviews_tips_zh.json"));
  }
  candidates.push(path.join(path.dirname(inputPath), "reviews_tips_zh.json"));
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        return parseTips(readJson(candidate));
      } catch {
        return new Map();
      }
    }
  }
  return new Map();
}

function parseTips(document) {
  const map = new Map();
  if (!Array.isArray(document)) return map;
  for (const group of document) {
    const entries = Array.isArray(group?.reviewTips) ? group.reviewTips : [];
    for (const entry of entries) {
      if (typeof entry?.id === "string") map.set(entry.id, entry);
    }
  }
  return map;
}

function buildJsonReport(meta, findings) {
  const counts = countSeverities(findings);
  return {
    ok: true,
    caseId: meta.caseId ?? null,
    runId: meta.runId ?? null,
    truncated: meta.truncated ?? null,
    total: findings.length,
    counts,
    findings: findings.map((finding) => ({
      id: finding?.id ?? null,
      severity: finding?.severity ?? null,
      category: finding?.category ?? null,
      file: finding?.file ?? null,
      line: finding?.line ?? null,
      title: finding?.title ?? null,
      confidence: finding?.confidence ?? null,
      rule: finding?.rule ?? null,
    })),
  };
}

function renderMarkdown(meta, findings, tips) {
  const counts = countSeverities(findings);
  const lines = ["## 检视结果", ""];

  const metaBits = [];
  if (meta.caseId) metaBits.push(`案例 \`${meta.caseId}\``);
  if (meta.runId) metaBits.push(`runId \`${meta.runId}\``);
  if (meta.rounds !== undefined) metaBits.push(`轮次 ${meta.rounds}`);
  if (meta.toolCalls !== undefined) metaBits.push(`工具调用 ${meta.toolCalls}`);
  if (metaBits.length > 0) lines.push(`- ${metaBits.join(" · ")}`);

  lines.push(
    `- 意见：P0 ${counts.P0} · P1 ${counts.P1} · P2 ${counts.P2} · P3 ${counts.P3}（共 ${findings.length}）`,
  );
  if (meta.truncated === true) {
    lines.push("- **截断：是** —— 本次检视在轮次或工具预算内结束，结论可能不完整（exit 0 不代表覆盖完整）。");
  }
  if (findings.length === 0) {
    lines.push("", meta.truncated === true ? "本次检视未产出意见（存在截断，不能据此判断无缺陷）。" : "本次检视未发现缺陷。");
    lines.push("");
    return lines.join("\n");
  }

  for (const severity of SEVERITIES) {
    const group = findings.filter((finding) => finding?.severity === severity.key);
    if (group.length === 0) continue;
    lines.push("", `### ${severity.label}（${group.length}）`, "");
    for (const finding of group) {
      lines.push(...renderFinding(finding, tips.get(finding?.id)));
      lines.push("");
    }
  }
  return lines.join("\n").replace(/\n+$/, "\n");
}

function renderFinding(finding, tip) {
  const file = typeof finding?.file === "string" ? finding.file : "(unknown file)";
  const line = finding?.line ?? "?";
  const category = finding?.category ?? "未分类";
  const subcategory =
    typeof finding?.tips?.subcategory === "string" && finding.tips.subcategory.trim() !== ""
      ? ` / ${finding.tips.subcategory.trim()}`
      : "";
  const title = finding?.title ?? "(无标题)";
  const lines = [`- **\`${file}:${line}\`** [${category}${subcategory}] ${title}`];

  const meta = [];
  if (typeof finding?.confidence === "number") meta.push(`置信度 ${formatConfidence(finding.confidence)}`);
  if (typeof finding?.rule === "string" && finding.rule !== "") meta.push(`规则 \`${finding.rule}\``);
  if (meta.length > 0) lines.push(`  - ${meta.join(" · ")}`);

  const description = firstNonEmpty(tip?.review, finding?.tips?.review, finding?.description);
  if (description !== undefined) {
    if (description.includes("\n")) {
      lines.push("  - 说明：", "");
      lines.push(...blockquote(description, "    "));
    } else {
      lines.push(`  - 说明：${inline(description)}`);
    }
  }

  const evidence = Array.isArray(finding?.evidence) ? finding.evidence.filter((item) => typeof item === "string") : [];
  if (evidence.length > 0) {
    lines.push("  - 证据：");
    for (const item of evidence) {
      if (item.includes("\n")) {
        lines.push(...blockquote(item, "    "));
      } else {
        lines.push(`    - \`${item.replace(/`/g, "'")}\``);
      }
    }
  }

  const suggestion = firstNonEmpty(tip?.suggestion, finding?.tips?.suggestion);
  if (suggestion !== undefined) {
    lines.push("  - 建议：", "");
    lines.push(...blockquote(suggestion, "    "));
  }
  return lines;
}

function countSeverities(findings) {
  const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const finding of findings) {
    const severity = finding?.severity;
    if (typeof severity === "string" && Object.hasOwn(counts, severity)) counts[severity] += 1;
  }
  return counts;
}

function formatConfidence(value) {
  return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

function inline(text) {
  return text.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
}

function blockquote(text, indent) {
  return text.split(/\r?\n/).map((line) => `${indent}> ${line}`.replace(/\s+$/, ""));
}

function fail(message) {
  process.stderr.write(`review-pi skill render-findings: ${message}\n`);
  process.exitCode = 1;
}

function helpText() {
  return `usage: node scripts/render-findings.mjs --input <path> [options]

  --input <path>    review-pi stdout JSON (single document) or <runs>/reviews_all.json
  --tips <path>     reviews_tips_zh.json (default: auto-discover next to the input / audit path)
  --format <fmt>    markdown (default) or json (counts + compact finding list)
  --output <path>   write Markdown to a file instead of stdout
  --json            alias for --format json
  --help            this text
`;
}

main(process.argv.slice(2));
