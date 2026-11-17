import type { FetchFunction } from "@earendil-works/pi-ai";

import type { RetryPolicy } from "../shared/llm-retry.js";
import type { Finding } from "../contracts/finding.js";
import { DEFAULT_GATEWAY_MAX_TOKENS } from "../shared/config.js";
import type { ReviewTipsDocumentLike } from "./presentation-projection.js";
import { completeOneShot } from "./one-shot-llm.js";

/** 收尾总结（与候选修复同档）的运行时：呈现档模型 / oneShot 超时与重试 */
export interface ReportLlmRuntime {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly modelId: string;
  /** 单次尝试超时（`limits.timeouts.oneShotMs`） */
  readonly timeoutMs: number;
  /** 重试策略（`limits.retry` 的 oneShot 路径；缺省 = 全局 default） */
  readonly retry?: RetryPolicy;
}

/**
 * 收尾总结生成（ADR-0045 决策 2 / ADR-0057）：中文 tips（辅以 findings
 * 结构化字段）→ Markdown 总结报告，供 `saveReviewSummary` 上报。
 *
 * 口径（ADR-0057）：`findings` / `tips` 由调用方**先裁剪为平台最终收到的
 * 意见**（`mrReviewResult` 成功的条目）——总结必须与平台明细一致。
 *
 * 分流与降级链（产物必须有、内容允许降级）：
 * 0. **零已上报意见 ⇒ 确定性结构化模板，不调用模型**——确实无意见附
 *    「未发现缺陷」；有意见但全部没上报附「未上报任何检视意见」且不作星级
 *    评价（绝不谎报「未发现缺陷」），两者都省略意见速览节；
 * 1. 有意见 ⇒ 模型调用（输入 = 中文 tips + findings 摘要 + 权威统计与星级）；
 * 2. 投影降级 / 无 tips ⇒ 输入退为英文 findings（Q10 决策）；
 * 3. 模型调用失败 / 超时 ⇒ **确定性模板** Markdown（同一套结构化规范），
 *    `degradedReason` 留痕——`saveReviewSummary` 一定会被调用。
 */

/**
 * 零意见与零上报的说明句（ADR-0057；渲染在「意见分布」表之后）。
 * - 确实无意见：「本次检视未发现缺陷。」
 * - 有意见但全部没上报：「本次检视未向平台上报任何检视意见。」
 *   （绝不谎报「未发现缺陷」，也不展开平台没收到的明细）。
 */
export const NO_FINDING_NOTE = "本次检视未发现缺陷。";
export const NO_REPORTED_NOTE = "本次检视未向平台上报任何检视意见。";

/** diff 超 `limits.boundary.maxDiffChars` 跳过检视时的固定总结（ADR-0075，不调用模型） */
export const DIFF_TOO_LARGE_SUMMARY_MARKDOWN = "# 检视总结\n\nDiff 超大，跳过检视。";

/** 过滤后没有任何可检视文件时的固定总结（ADR-0078，不调用模型） */
export const NO_REVIEWABLE_FILES_SUMMARY_MARKDOWN =
  "# 检视总结\n\n无可检视文件，跳过检视。";

/**
 * 总结「检视总览」三行的运行统计（交付层组装；缺席时渲染 `—`）。
 * 口径：变更规模来自 diff 度量（hunk 数 / 变更行数——方法级统计的退化口径）；
 * 预算使用只报模型调用总数；资源加载用输入 token 合计（含缓存命中）。
 */
export interface ReviewSummaryMetrics {
  readonly changedFiles: number;
  /** diff 的 hunk 总数；不可度量为 null */
  readonly changedHunks: number | null;
  /** 新增行 + 删除行；不可度量为 null */
  readonly changedLines: number | null;
  /** 模型调用总数（主会话 + 规则 Skill，`ReviewRunResult.modelCalls`） */
  readonly modelCalls: number;
  /** 输入 token 合计 = 未命中 + 缓存命中 */
  readonly inputTokens: number;
}

export interface ReviewSummaryInput {
  /** 投影后的中文分组意见（投影降级 / 未配置引擎时缺席） */
  readonly tips?: ReviewTipsDocumentLike;
  /** 已成功上报的 findings（平台最终收到的意见；ADR-0057） */
  readonly findings: readonly Finding[];
  /**
   * 未被上报的 finding 条数（片级生成失败 / 上报失败 / 结构跳过 / 置信度
   * 过滤）。仅在 `findings` 为空时用于区分「确实零意见」与「有意见但没上报」。
   */
  readonly unreportedFindings?: number;
  /** 各片已上报的文件路径（按片序拼接；供总结提及平台已收到的结果） */
  readonly reportedFiles?: readonly string[];
  /** 检视总览的运行统计（缺席时三行渲染 `—`） */
  readonly metrics?: ReviewSummaryMetrics;
  readonly runtime: ReportLlmRuntime;
  readonly fetch?: FetchFunction;
}

export interface ReviewSummaryResult {
  readonly markdown: string;
  /** 模板降级的原因（模型路径成功时缺席） */
  readonly degradedReason?: string;
}

const SUMMARY_MAX_TOKENS = DEFAULT_GATEWAY_MAX_TOKENS;

/** 总结规范（用户定稿口径）：固定小节 + 权威数据，模型不得自行改判星级。 */
const SUMMARY_SYSTEM_PROMPT = [
  "你在代码检视结束后撰写中文 Markdown 总结报告。",
  "严格按下列结构输出，不增删小节、不改表格顺序：",
  "## 检视总览（表格三行：变更规模 / 预算使用 / 资源加载）；",
  "### 意见分布（表格四行，severity 依次为 fatal、major、minor、suggestion）；",
  "### 高优先级意见速览（只列 fatal / major，按严重级降序，每条一行 `N. [severity] file:line — 一句话`；没有则写「无。」）；",
  "### 星级评价（直接使用给定的星级与判据，不得自行改判）。",
  "所有数字、文件清单、星级只能来自用户消息给出的权威数据，不得编造或估算；",
  "权威数据为 null 的指标写成「—」。",
  "「一句话描述」可以改写 finding title，但不得改变其技术含义。",
  "只输出 Markdown 正文，不要外围代码围栏。",
].join("\n");

/** 严重级 → 规范里的展示名（与 candidate-normalize 的别名表同口径） */
const SEVERITY_LABELS: readonly {
  readonly severity: Finding["severity"];
  readonly label: "fatal" | "major" | "minor" | "suggestion";
}[] = [
  { severity: "P0", label: "fatal" },
  { severity: "P1", label: "major" },
  { severity: "P2", label: "minor" },
  { severity: "P3", label: "suggestion" },
];

const SEVERITY_RANK: Readonly<Record<Finding["severity"], number>> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

/**
 * 星级（硬判据，确定性计算；模型只复述不改判）：
 * - 2 = 存在 P0/P1（fatal/major），需整改后方可合入；
 * - 3 = 无 P0/P1，仅 P2/P3；
 * - 4 = 仅有 P3（suggestion）。
 *
 * ⭐（变更仅含配置/格式化/生成代码）不在本路径：零意见走固定文案（ADR-0057），
 * 本函数只在有已上报意见时调用。
 */
export function severityStars(findings: readonly Finding[]): 2 | 3 | 4 {
  const has = (severity: Finding["severity"]): boolean =>
    findings.some((finding) => finding.severity === severity);
  if (has("P0") || has("P1")) {
    return 2;
  }
  if (has("P2")) {
    return 3;
  }
  return 4;
}

const STAR_CRITERIA: Readonly<Record<2 | 3 | 4, string>> = {
  2: "存在 ≥1 条 major 或 fatal 意见，需整改后方可合入",
  3: "0 条 fatal，0 条 major，仅 minor + suggestion，代码逻辑正确可合入",
  4: "0 条 fatal / major / minor，仅 suggestion 且代码体现防御性设计",
};

function starText(stars: 2 | 3 | 4): string {
  return "⭐".repeat(stars);
}

export async function buildReviewSummary(input: ReviewSummaryInput): Promise<ReviewSummaryResult> {
  // 零已上报意见：不调用模型，直接按同一套结构化规范确定性渲染。
  // 区分两种零：确实没意见 → 「未发现缺陷」；有意见但没上报 → 只陈述上报事实
  // （ADR-0057，绝不把「没上报」说成「没问题」），且不作星级评价。
  if (input.findings.length === 0) {
    const unreported = (input.unreportedFindings ?? 0) > 0;
    return {
      markdown: renderStructuredSummary(input, {
        includePriority: false,
        note: unreported ? NO_REPORTED_NOTE : NO_FINDING_NOTE,
        ...(unreported ? { unevaluatedStars: true } : {}),
      }),
    };
  }
  const completion = await completeOneShot({
    baseUrl: input.runtime.baseUrl,
    apiKey: input.runtime.apiKey,
    modelId: input.runtime.modelId,
    system: SUMMARY_SYSTEM_PROMPT,
    user: buildSummaryUserMessage(input),
    timeoutMs: input.runtime.timeoutMs,
    ...(input.runtime.retry !== undefined ? { retry: input.runtime.retry } : {}),
    maxTokens: SUMMARY_MAX_TOKENS,
    purpose: "summary",
    ...(input.fetch !== undefined ? { fetch: input.fetch } : {}),
  });
  if (completion.ok) {
    const markdown = completion.text.trim();
    if (markdown !== "") {
      return { markdown };
    }
  }
  return {
    markdown: renderTemplateSummary(input),
    ...(completion.ok
      ? { degradedReason: "model returned empty summary" }
      : { degradedReason: completion.reason }),
  };
}

function buildSummaryUserMessage(input: ReviewSummaryInput): string {
  const rows = severityRows(input.findings);
  const priority = highPriorityLines(input.findings);
  const stars = severityStars(input.findings);
  const sections: string[] = [];
  sections.push("Authoritative run metrics (copy verbatim; do not recompute):");
  sections.push(
    JSON.stringify(
      {
        metrics: input.metrics ?? null,
        bySeverity: rows.map((row) => ({
          severity: row.label,
          count: row.count,
          files: row.files,
        })),
        stars,
        starText: starText(stars),
        starCriterion: STAR_CRITERIA[stars],
      },
      null,
      2,
    ),
  );
  sections.push("High-priority findings (fatal/major, display order):");
  sections.push(
    priority.length > 0 ? priority.map((line, index) => `${String(index + 1)}. ${line}`).join("\n") : "无。",
  );
  sections.push(
    input.tips !== undefined
      ? "Grouped review tips (Chinese, projected):"
      : "Projected Chinese tips are unavailable for this run; summarize from the English findings:",
  );
  sections.push(
    JSON.stringify(
      input.tips ?? input.findings.map((finding) => summaryFindingEntry(finding)),
      null,
      2,
    ),
  );
  sections.push("Structured finding summary (English source of truth):");
  sections.push(
    JSON.stringify(
      {
        total: input.findings.length,
        bySeverity: countBySeverity(input.findings),
        files: [...new Set(input.findings.map((finding) => finding.file))],
      },
      null,
      2,
    ),
  );
  if (input.reportedFiles !== undefined && input.reportedFiles.length > 0) {
    sections.push("Files already reported to the platform (in shard order):");
    sections.push(JSON.stringify(input.reportedFiles, null, 2));
  }
  return sections.join("\n");
}

interface SeverityRow {
  readonly label: "fatal" | "major" | "minor" | "suggestion";
  readonly count: number;
  readonly files: readonly string[];
}

function severityRows(findings: readonly Finding[]): readonly SeverityRow[] {
  return SEVERITY_LABELS.map(({ severity, label }) => {
    const ofSeverity = findings.filter((finding) => finding.severity === severity);
    return {
      label,
      count: ofSeverity.length,
      files: [...new Set(ofSeverity.map((finding) => finding.file))],
    };
  });
}

/** 高优先级（fatal/major）按严重级降序、同级保持上报顺序 */
function highPriorityLines(findings: readonly Finding[]): readonly string[] {
  return findings
    .map((finding, index) => ({ finding, index }))
    .filter(({ finding }) => finding.severity === "P0" || finding.severity === "P1")
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity] ||
        a.index - b.index,
    )
    .map(
      ({ finding }) =>
        `[${SEVERITY_LABELS.find((entry) => entry.severity === finding.severity)?.label ?? "suggestion"}] ` +
        `${finding.file}:${String(finding.line)} — ${finding.title}`,
    );
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function scaleCell(metrics: ReviewSummaryMetrics | undefined): string {
  if (metrics === undefined) {
    return "—";
  }
  // hunk / 行数同源（同一个 diff 度量）：任一不可得即整块标不可度量
  if (metrics.changedHunks === null || metrics.changedLines === null) {
    return `${formatCount(metrics.changedFiles)} 个文件 / 变更规模不可度量`;
  }
  return (
    `${formatCount(metrics.changedFiles)} 个文件 / ${formatCount(metrics.changedHunks)} 个 hunk` +
    `（${formatCount(metrics.changedLines)} 行变更）`
  );
}

interface StructuredSummaryOptions {
  /** 零意见 / 零上报：没有意见可速览，整节省略 */
  readonly includePriority?: boolean;
  /** 意见分布表之后的说明句（零意见 / 零上报的诚实口径） */
  readonly note?: string;
  /** 未上报任何意见时不给星级（不能把「没上报」评成「没问题」） */
  readonly unevaluatedStars?: boolean;
}

function renderStructuredSummary(
  input: ReviewSummaryInput,
  options: StructuredSummaryOptions = {},
): string {
  const rows = severityRows(input.findings);
  const priority = highPriorityLines(input.findings);
  const stars = severityStars(input.findings);
  const includePriority = options.includePriority ?? true;
  const lines: string[] = [
    "## 检视总览",
    "",
    "| 维度 | 统计 |",
    "|------|------|",
    `| 变更规模 | ${scaleCell(input.metrics)} |`,
    `| 预算使用 | ${input.metrics === undefined ? "—" : `${formatCount(input.metrics.modelCalls)} 次调用`} |`,
    `| 资源加载 | ${input.metrics === undefined ? "—" : `约 ${formatCount(input.metrics.inputTokens)} tokens`} |`,
    "",
    "### 意见分布",
    "",
    "| severity | 数量 | 涉及文件 |",
    "|----------|------|---------|",
    ...rows.map(
      (row) =>
        `| ${row.label} | ${String(row.count)} | ${row.files.length > 0 ? row.files.join(", ") : "—"} |`,
    ),
  ];
  if (options.note !== undefined) {
    lines.push("", options.note);
  }
  if (includePriority) {
    lines.push(
      "",
      "### 高优先级意见速览",
      "",
      ...(priority.length > 0
        ? priority.map((line, index) => `${String(index + 1)}. ${line}`)
        : ["无。"]),
    );
  }
  lines.push(
    "",
    "### 星级评价",
    "",
    options.unevaluatedStars === true
      ? "—（未上报任何检视意见，不作星级评价）"
      : `${starText(stars)} — ${STAR_CRITERIA[stars]}`,
  );
  return lines.join("\n");
}

function summaryFindingEntry(finding: Finding): Record<string, unknown> {
  return {
    file: finding.file,
    line: finding.line,
    severity: finding.severity,
    category: finding.category,
    title: finding.title,
  };
}

function countBySeverity(findings: readonly Finding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const finding of findings) {
    counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
  }
  return counts;
}

/** 确定性模板（降级档）：与模型路径同一套结构，只陈述事实，不做任何发挥 */
function renderTemplateSummary(input: ReviewSummaryInput): string {
  return renderStructuredSummary(input);
}
