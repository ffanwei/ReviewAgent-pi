import type { FetchFunction } from "@earendil-works/pi-ai";

import type { Finding } from "../contracts/finding.js";
import { DEFAULT_GATEWAY_MAX_TOKENS } from "../shared/config.js";
import type { ReviewTipsDocumentLike } from "./presentation-projection.js";
import type { ReportLlmRuntime } from "./report-payload.js";
import { completeOneShot } from "./one-shot-llm.js";

/**
 * 收尾总结生成（ADR-0045 决策 2 / ADR-0057）：中文 tips（辅以 findings
 * 结构化字段）→ Markdown 总结报告，供 `saveReviewSummary` 上报。
 *
 * 口径（ADR-0057）：`findings` / `tips` 由调用方**先裁剪为平台最终收到的
 * 意见**（`mrReviewResult` 成功的条目）——总结必须与平台明细一致。
 *
 * 分流与降级链（产物必须有、内容允许降级）：
 * 0. **零已上报意见 ⇒ 固定文案**，不调用模型——确实无意见用
 *    `NO_FINDING_SUMMARY_MARKDOWN`；有意见但全部没上报用
 *    `NO_REPORTED_SUMMARY_MARKDOWN`（绝不谎报「未发现缺陷」）；
 * 1. 有意见 ⇒ 模型调用（输入 = 中文 tips + findings 摘要）；
 * 2. 投影降级 / 无 tips ⇒ 输入退为英文 findings（Q10 决策）；
 * 3. 模型调用失败 / 超时 ⇒ **确定性模板** Markdown（findings 计数 + 按文件清单），
 *    `degradedReason` 留痕——`saveReviewSummary` 一定会被调用。
 */

/**
 * 零意见时的固定总结（逐字节确定，不调用模型）：平台只需知道「看过、没问题」。
 * 与 `renderTemplateSummary` 的零意见分支共用同一段文本。
 */
export const NO_FINDING_SUMMARY_MARKDOWN = "# 检视总结\n\n本次检视未发现缺陷。";

/**
 * 本地有检视意见、但一条都没成功上报时的固定总结（ADR-0057）。
 *
 * 不能说「未发现缺陷」——那会把「没上报」谎报成「没问题」（与 ADR-0056 的
 * 诚实口径一致）；也不展开平台没收到的明细——总结必须与 `mrReviewResult`
 * 的覆盖面一致。
 */
export const NO_REPORTED_SUMMARY_MARKDOWN =
  "# 检视总结\n\n本次检视未向平台上报任何检视意见。";

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
  readonly runtime: ReportLlmRuntime;
  readonly fetch?: FetchFunction;
}

export interface ReviewSummaryResult {
  readonly markdown: string;
  /** 模板降级的原因（模型路径成功时缺席） */
  readonly degradedReason?: string;
}

const SUMMARY_MAX_TOKENS = DEFAULT_GATEWAY_MAX_TOKENS;

const SUMMARY_SYSTEM_PROMPT = [
  "You write the final summary report of a code review, in Chinese, as Markdown.",
  "Structure: a one-paragraph overview (what was reviewed, overall risk impression),",
  "then a severity breakdown of the findings, then per-file highlights",
  "(only files that have findings), then a closing note on residual risk.",
  "Be factual: only use the provided findings and tips; do not invent issues.",
  "Reply with the Markdown document only (no surrounding code fences).",
].join("\n");

export async function buildReviewSummary(input: ReviewSummaryInput): Promise<ReviewSummaryResult> {
  // 零已上报意见：固定文案直出，不调用模型（也绝不降级留痕——这不是降级）。
  // 区分两种零：确实没意见 → 「未发现缺陷」；有意见但没上报 → 只陈述上报事实
  // （ADR-0057，绝不把「没上报」说成「没问题」）。
  if (input.findings.length === 0) {
    return {
      markdown:
        (input.unreportedFindings ?? 0) > 0
          ? NO_REPORTED_SUMMARY_MARKDOWN
          : NO_FINDING_SUMMARY_MARKDOWN,
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
  const sections: string[] = [];
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

/** 确定性模板（降级档）：只陈述事实（计数 + 清单），不做任何发挥 */
function renderTemplateSummary(input: ReviewSummaryInput): string {
  const findings = input.findings;
  const lines: string[] = ["# 检视总结", ""];
  if (findings.length === 0) {
    return NO_FINDING_SUMMARY_MARKDOWN;
  }
  const counts = countBySeverity(findings);
  lines.push(
    `本次检视共发现 ${String(findings.length)} 条问题（${Object.entries(counts)
      .map(([severity, count]) => `${severity} ${String(count)}`)
      .join(" / ")}）。`,
    "",
    "## 按文件",
    "",
  );
  const byFile = new Map<string, readonly Finding[]>();
  for (const finding of findings) {
    const group = byFile.get(finding.file) ?? [];
    byFile.set(finding.file, [...group, finding]);
  }
  for (const [file, group] of byFile) {
    lines.push(`- \`${file}\`：${String(group.length)} 条`);
    for (const finding of group) {
      lines.push(
        `  - [${finding.severity}] ${finding.title}（line ${String(finding.line)}）`,
      );
    }
  }
  return lines.join("\n");
}
