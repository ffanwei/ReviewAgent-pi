import type { FetchFunction } from "@earendil-works/pi-ai";

import type { RetryPolicy } from "../shared/llm-retry.js";
import { completeOneShot } from "../provider/one-shot-llm.js";
import type { Finding } from "../contracts/finding.js";
import { DEFAULT_GATEWAY_MAX_TOKENS } from "../shared/config.js";
import type { ReviewTipsDocumentLike } from "./presentation-projection.js";

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
 * 0. **零已上报意见 ⇒ 确定性结构化模板，不调用模型**——三种「零」共用四节
 *    结构与指标，但说明句 / 星级按事实区分（ADR-0103）：确实无意见给
 *    「未发现缺陷」+ ⭐⭐⭐⭐；有意见但全部没上报、过滤后无可检视文件都
 *    不谎报「未发现缺陷」，也不作星级评价；
 * 1. 有意见 ⇒ 模型调用（输入 = 中文 tips + findings 摘要 + 权威统计与星级）；
 * 2. 投影降级 / 无 tips ⇒ 输入退为英文 findings（Q10 决策）；
 * 3. 模型回包截断（`finish_reason=length`）/ 结构或内容不合格 / 改判星级 ⇒
 *    拒绝并回落确定性模板（`sanitizeSummaryMarkdown`，输出面兜底，不改请求字节）；
 * 4. 模型调用失败 / 超时 ⇒ **确定性模板** Markdown（同一套结构化规范），
 *    `degradedReason` 留痕——`saveReviewSummary` 一定会被调用。
 */

/** 确实无意见（ADR-0103） */
export const NO_FINDING_NOTE = "本次检视未发现缺陷。";

/** 本地有意见但一条都没上报成功（ADR-0103） */
export const NO_REPORTED_NOTE = "本次检视未向平台上报任何检视意见。";

/** 过滤后没有任何可检视文件（ADR-0103） */
export const NO_REVIEWABLE_NOTE = "无可检视文件，跳过检视。";

/** 零上报时的星级行：绝不把「没上报」评成「没问题」 */
export const UNREPORTED_STAR_LINE = "—（未上报任何检视意见，不作星级评价）";
/** 未检视任何文件时的星级行 */
export const NOT_REVIEWED_STAR_LINE = "—（未检视任何文件，不作星级评价）";

/** diff 超 `limits.boundary.maxDiffChars` 跳过检视时的固定总结（ADR-0075，不调用模型） */
export const DIFF_TOO_LARGE_SUMMARY_MARKDOWN = "# 检视总结\n\nDiff 超大，跳过检视。";

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
   * 与严重级过滤）。仅在 `findings` 为空时用于区分「确实零意见」与
   * 「有意见但没上报」（ADR-0103）。
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
  /**
   * 模型回包里的思考 token（观测用；已含在 outputTokens 内）。
   * 缺席 = 响应未带该字段。不参与任何内容判定。
   */
  readonly reasoningTokens?: number;
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
  "总览与意见分布两张表格的单元格必须**逐字复制**用户消息中 overviewRows / distributionRows 的标签与值（含单位、逗号、括号与「—」），不得重排、改写或合并；",
  "高优先级速览每条必须保留「N. [severity] file:line —」前缀、编号与顺序，只可改写破折号后的描述；没有 fatal / major 时该节只写「无。」；",
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
  2: "存在 ≥1 条 major 或 fatal 意见",
  3: "0 条 fatal，0 条 major，仅 minor / suggestion",
  4: "0 条 fatal / major / minor，仅 suggestion",
};

/** 零意见专用判据：不能沿用「仅 suggestion」的措辞（ADR-0103） */
const ZERO_FINDING_CRITERION = "0 条 fatal / major / minor / suggestion（未发现缺陷）";

function starText(stars: 2 | 3 | 4): string {
  return "⭐".repeat(stars);
}

const SUMMARY_OVERVIEW_HEADING = "## 检视总览";
const SUMMARY_DISTRIBUTION_HEADING = "### 意见分布";
const SUMMARY_PRIORITY_HEADING = "### 高优先级意见速览";
const SUMMARY_STARS_HEADING = "### 星级评价";

export type SummarySanitizeResult =
  | { readonly ok: true; readonly markdown: string }
  | { readonly ok: false; readonly reason: string };

/**
 * 输出面兜底（不改请求字节、不碰 thinking）：把模型回包裁剪成规范文档。
 *
 * 模型可能把思考过程写进 `content`（网关把 reasoning 内联、或模型直接复述指令），
 * 于是回包 = 前言 + 正式文档，甚至 = 草稿 + 正式文档。规则：
 * - 从**后往前**找 `## 检视总览` 起点：思考里的草稿会被跳过，取最后一份完整文档；
 * - 小节必须齐全且有序（有已上报意见时含「高优先级意见速览」）；
 * - 星级行必须以权威星数开头（不改判），否则拒绝；
 * - 总览三行 / 意见分布四行的值与权威数据逐项一致；高优先级速览的条数、顺序、
 *   严重级与 `file:line` 与权威一致（一句话可改写，但不得漏项 / 换项）；
 * - 除四个规定标题外不得出现其它标题（多出的 `##` / `###` 一律拒绝）；
 * - 只保留到星级行为止，前面的前言与后面的客套话一律丢弃；
 * - 整篇被 ``` 围栏包住时先剥围栏。
 *
 * 拒绝 = 调用方回落确定性模板（`degradedReason` 留痕），绝不把半截/被改判/数字
 * 与权威数据不一致的总结外发。
 */
export function sanitizeSummaryMarkdown(
  text: string,
  findings: readonly Finding[],
  metrics?: ReviewSummaryMetrics,
): SummarySanitizeResult {
  // 网关/模型可能把思考包成 `<think>…</think>` 或只留下闭合标签；先剥掉
  // 第一个 `## 检视总览` 之前的思考包装，再走原有的围栏/结构校验。
  const lines = stripSummaryFence(stripLeadingReasoningWrapper(text)).split("\n");
  const required =
    findings.length > 0
      ? [
          SUMMARY_OVERVIEW_HEADING,
          SUMMARY_DISTRIBUTION_HEADING,
          SUMMARY_PRIORITY_HEADING,
          SUMMARY_STARS_HEADING,
        ]
      : [SUMMARY_OVERVIEW_HEADING, SUMMARY_DISTRIBUTION_HEADING, SUMMARY_STARS_HEADING];
  const expectedStars = findings.length > 0 ? severityStars(findings) : null;
  let contentIssue: string | null = null;

  for (let start = lines.length - 1; start >= 0; start -= 1) {
    if (lines[start]?.trim() !== SUMMARY_OVERVIEW_HEADING) {
      continue;
    }
    const candidate = lines.slice(start);
    const positions = sectionPositions(candidate, required);
    if (positions === null) {
      continue;
    }
    const starsHeading = positions[positions.length - 1];
    if (starsHeading === undefined) {
      continue;
    }
    const starLine = firstContentLine(candidate, starsHeading + 1);
    const starTextLine = starLine === null ? undefined : candidate[starLine];
    if (
      starLine === null ||
      starTextLine === undefined ||
      !starLineMatches(starTextLine, expectedStars)
    ) {
      continue;
    }
    const issue = validateSummaryContent(
      candidate,
      positions,
      starLine,
      findings,
      metrics,
    );
    if (issue !== null) {
      contentIssue ??= issue;
      continue;
    }
    return {
      ok: true,
      markdown: candidate.slice(0, starLine + 1).join("\n").trimEnd(),
    };
  }
  return {
    ok: false,
    reason:
      contentIssue !== null
        ? `summary content does not match authoritative data (${contentIssue})`
        : "missing or malformed sections (## 检视总览 … ### 星级评价)",
  };
}

/**
 * 剥掉模型回包里的思考包装：`<think>…</think>` 或「前言 …</think>」。
 *
 * 不能只按第一个 `## 检视总览` 定位：思考草稿里本身就可能带这个标题，
 * 甚至是一份结构看起来完整的草稿。因此以**最后一个** `</think>` 为边界，
 * 只保留它后面的正文；如果思考之后没有正式文档，剥完为空，交给结构校验
 * 回落确定性模板，绝不把思考里的草稿外发。
 *
 * 兼容 `</think>## 检视总览` 同一行（没有换行）的形态。
 */
function stripLeadingReasoningWrapper(text: string): string {
  const closeTag = /<\/think\s*>/giu;
  let lastCloseEnd = -1;
  for (const match of text.matchAll(closeTag)) {
    lastCloseEnd = (match.index ?? 0) + match[0].length;
  }
  if (lastCloseEnd < 0) {
    return text;
  }
  return text.slice(lastCloseEnd).trimStart();
}

/** 去掉整篇外层围栏（``` / ```markdown）与首尾空行；围栏只剥一层 */
function stripSummaryFence(text: string): string {
  const lines = text.replace(/\r\n/gu, "\n").split("\n");
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim() === "") {
    start += 1;
  }
  if (start < end && /^```/u.test(lines[start]?.trim() ?? "")) {
    start += 1;
  }
  while (end > start && lines[end - 1]?.trim() === "") {
    end -= 1;
  }
  if (end > start && (lines[end - 1]?.trim() ?? "") === "```") {
    end -= 1;
  }
  return lines.slice(start, end).join("\n").trim();
}

/** 小节标题必须逐行匹配、且按顺序出现；缺失/乱序返回 null */
function sectionPositions(lines: readonly string[], headings: readonly string[]): number[] | null {
  const positions: number[] = [];
  let cursor = 0;
  for (const heading of headings) {
    let found = -1;
    for (let index = cursor; index < lines.length; index += 1) {
      if (lines[index]?.trim() === heading) {
        found = index;
        break;
      }
    }
    if (found === -1) {
      return null;
    }
    positions.push(found);
    cursor = found + 1;
  }
  return positions;
}

function firstContentLine(lines: readonly string[], from: number): number | null {
  for (let index = from; index < lines.length; index += 1) {
    if ((lines[index]?.trim() ?? "") !== "") {
      return index;
    }
  }
  return null;
}

/** 星级行判据：星数必须等于权威值（有意见时）/ 四星或未评价（零意见时） */
function starLineMatches(line: string, expected: 2 | 3 | 4 | null): boolean {
  // 容忍列表符 / 引用符 / 加粗：`- ⭐⭐ …`、`**⭐⭐ …**` 仍按同一行判星级
  const normalized = line
    .trim()
    .replace(/^[-+>]\s*/u, "")
    .replace(/^\*{1,2}\s*/u, "");
  const stars = /^⭐+/u.exec(normalized)?.[0].length ?? 0;
  if (expected === null) {
    return stars === 4 || normalized.startsWith("—（");
  }
  return stars === expected;
}

/** 规范文档只允许这四个标题；多出的任何 Markdown 标题都算内容违规 */
const SUMMARY_ALLOWED_HEADINGS: ReadonlySet<string> = new Set([
  SUMMARY_OVERVIEW_HEADING,
  SUMMARY_DISTRIBUTION_HEADING,
  SUMMARY_PRIORITY_HEADING,
  SUMMARY_STARS_HEADING,
]);

/**
 * 内容校验（ADR-0104）：结构对了还不够，表格与速览必须与权威数据逐项一致。
 * 返回 null = 通过；字符串 = 拒绝原因（进 `degradedReason`）。
 */
function validateSummaryContent(
  lines: readonly string[],
  positions: readonly number[],
  starLine: number,
  findings: readonly Finding[],
  metrics: ReviewSummaryMetrics | undefined,
): string | null {
  for (let index = 0; index <= starLine; index += 1) {
    const text = (lines[index] ?? "").trim();
    if (/^#{1,6}(\s|$)/u.test(text) && !SUMMARY_ALLOWED_HEADINGS.has(text)) {
      return `unexpected heading: ${text}`;
    }
  }
  const overview = sectionLines(lines, positions, 0, starLine);
  const overviewIssue = validateOverviewSection(overview, metrics);
  if (overviewIssue !== null) {
    return overviewIssue;
  }
  const distribution = sectionLines(lines, positions, 1, starLine);
  const distributionIssue = validateDistributionSection(distribution, findings);
  if (distributionIssue !== null) {
    return distributionIssue;
  }
  if (findings.length > 0) {
    const priority = sectionLines(lines, positions, 2, starLine);
    const priorityIssue = validatePrioritySection(priority, findings);
    if (priorityIssue !== null) {
      return priorityIssue;
    }
  }
  return null;
}

function sectionLines(
  lines: readonly string[],
  positions: readonly number[],
  index: number,
  starLine: number,
): readonly string[] {
  const start = (positions[index] ?? 0) + 1;
  const end =
    index + 1 < positions.length ? (positions[index + 1] ?? lines.length) : starLine + 1;
  return lines.slice(start, end);
}

/** Markdown 表格数据行（表头与分隔行被丢弃）；缺表返回 null */
function tableDataRows(lines: readonly string[]): readonly (readonly string[])[] | null {
  const rows: string[][] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) {
      continue;
    }
    const cells = trimmed
      .replace(/^\|/u, "")
      .replace(/\|$/u, "")
      .split("|")
      .map((cell) => cell.trim());
    if (cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell))) {
      continue;
    }
    rows.push(cells);
  }
  if (rows.length < 2) {
    return null;
  }
  return rows.slice(1);
}

function validateOverviewSection(
  lines: readonly string[],
  metrics: ReviewSummaryMetrics | undefined,
): string | null {
  const rows = tableDataRows(lines);
  if (rows === null) {
    return "overview table missing";
  }
  const expected = overviewRows(metrics);
  if (rows.length !== expected.length) {
    return `overview table must have ${String(expected.length)} rows`;
  }
  for (let index = 0; index < expected.length; index += 1) {
    const row = rows[index] ?? [];
    const want = expected[index];
    if (want === undefined) {
      return "overview table mismatch";
    }
    if ((row[0] ?? "") !== want.label) {
      return `overview row ${String(index + 1)} label mismatch`;
    }
    if ((row[1] ?? "") !== want.value) {
      return `overview row ${String(index + 1)} value mismatch`;
    }
  }
  return null;
}

function validateDistributionSection(
  lines: readonly string[],
  findings: readonly Finding[],
): string | null {
  const rows = tableDataRows(lines);
  if (rows === null) {
    return "distribution table missing";
  }
  const expected = distributionRows(findings);
  if (rows.length !== expected.length) {
    return `distribution table must have ${String(expected.length)} rows`;
  }
  for (let index = 0; index < expected.length; index += 1) {
    const row = rows[index] ?? [];
    const want = expected[index];
    if (want === undefined) {
      return "distribution table mismatch";
    }
    if ((row[0] ?? "") !== want.label) {
      return `distribution row ${String(index + 1)} label mismatch`;
    }
    if ((row[1] ?? "") !== want.count) {
      return `distribution row ${String(index + 1)} count mismatch`;
    }
    if ((row[2] ?? "") !== want.files) {
      return `distribution row ${String(index + 1)} files mismatch`;
    }
  }
  return null;
}

function validatePrioritySection(
  lines: readonly string[],
  findings: readonly Finding[],
): string | null {
  const items = lines.map((line) => line.trim()).filter((line) => line !== "");
  const expected = highPriorityEntries(findings);
  if (expected.length === 0) {
    return items.length === 1 && items[0] === "无。" ? null : "priority section must be exactly 无。";
  }
  if (items.length !== expected.length) {
    return `priority section must list ${String(expected.length)} item(s)`;
  }
  for (let index = 0; index < expected.length; index += 1) {
    const item = items[index] ?? "";
    const match = /^(\d+)\.\s+\[(fatal|major|minor|suggestion)\]\s+(.+?)\s+—\s+\S/u.exec(item);
    if (match === null) {
      return `priority item ${String(index + 1)} is not in canonical form`;
    }
    if (match[1] !== String(index + 1)) {
      return `priority item ${String(index + 1)} numbering mismatch`;
    }
    const want = expected[index];
    if (want === undefined) {
      return "priority item mismatch";
    }
    if (match[2] !== want.label) {
      return `priority item ${String(index + 1)} severity mismatch`;
    }
    if ((match[3] ?? "").trim() !== want.location) {
      return `priority item ${String(index + 1)} location mismatch`;
    }
  }
  return null;
}

export type ZeroSummaryReason = "no-findings" | "unreported" | "no-reviewable-files";

/**
 * 三种「零」共用四节结构与指标，但说明句 / 星级按事实区分（ADR-0103）：
 * 只有「确实无意见」才给 ⭐⭐⭐⭐；没上报 / 没检视都不作星级评价。
 */
export function renderZeroFindingSummary(
  metrics?: ReviewSummaryMetrics,
  reason: ZeroSummaryReason = "no-findings",
): string {
  const variant =
    reason === "no-findings"
      ? { note: NO_FINDING_NOTE }
      : reason === "unreported"
        ? { note: NO_REPORTED_NOTE, starLine: UNREPORTED_STAR_LINE }
        : { note: NO_REVIEWABLE_NOTE, starLine: NOT_REVIEWED_STAR_LINE };
  return renderStructuredSummary(
    { findings: [], ...(metrics !== undefined ? { metrics } : {}) },
    { includePriority: false, ...variant },
  );
}

export async function buildReviewSummary(input: ReviewSummaryInput): Promise<ReviewSummaryResult> {
  // 零已上报意见：不调用模型，直接按同一套结构化规范确定性渲染。
  // ADR-0103：结构与指标共用，但说明句 / 星级按事实区分。
  if (input.findings.length === 0) {
    const unreported = (input.unreportedFindings ?? 0) > 0;
    return {
      markdown: renderZeroFindingSummary(
        input.metrics,
        unreported ? "unreported" : "no-findings",
      ),
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
    const withReasoning = (result: ReviewSummaryResult): ReviewSummaryResult =>
      completion.reasoningTokens === undefined
        ? result
        : { ...result, reasoningTokens: completion.reasoningTokens };
    if (completion.text.trim() === "") {
      return withReasoning({
        markdown: renderTemplateSummary(input),
        degradedReason: "model returned empty summary",
      });
    }
    // 输出预算被吃光 = 半截总结，宁可降级也不外发（deepseek 系 max_tokens 含思考）
    if (completion.finishReason === "length") {
      return withReasoning({
        markdown: renderTemplateSummary(input),
        degradedReason: "model summary truncated (finish_reason=length)",
      });
    }
    const sanitized = sanitizeSummaryMarkdown(completion.text, input.findings, input.metrics);
    if (!sanitized.ok) {
      return withReasoning({
        markdown: renderTemplateSummary(input),
        degradedReason: `model summary rejected: ${sanitized.reason}`,
      });
    }
    return withReasoning({ markdown: sanitized.markdown });
  }
  return {
    markdown: renderTemplateSummary(input),
    degradedReason: completion.reason,
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
        // 表格单元格的权威字符串（ADR-0104：模型逐字复制，内容校验逐字比对）
        overviewRows: overviewRows(input.metrics),
        distributionRows: distributionRows(input.findings),
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
interface HighPriorityEntry {
  readonly label: "fatal" | "major" | "minor" | "suggestion";
  readonly location: string;
  readonly title: string;
}

function highPriorityEntries(findings: readonly Finding[]): readonly HighPriorityEntry[] {
  return findings
    .map((finding, index) => ({ finding, index }))
    .filter(({ finding }) => finding.severity === "P0" || finding.severity === "P1")
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity] ||
        a.index - b.index,
    )
    .map(({ finding }) => ({
      label: SEVERITY_LABELS.find((entry) => entry.severity === finding.severity)?.label ?? "suggestion",
      location: `${finding.file}:${String(finding.line)}`,
      title: finding.title,
    }));
}

function highPriorityLines(findings: readonly Finding[]): readonly string[] {
  return highPriorityEntries(findings).map(
    (entry) => `[${entry.label}] ${entry.location} — ${entry.title}`,
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

/** 总览表三行（渲染与内容校验共用单源） */
interface OverviewRow {
  readonly label: "变更规模" | "预算使用" | "资源加载";
  readonly value: string;
}

function overviewRows(metrics: ReviewSummaryMetrics | undefined): readonly OverviewRow[] {
  return [
    { label: "变更规模", value: scaleCell(metrics) },
    {
      label: "预算使用",
      value: metrics === undefined ? "—" : `${formatCount(metrics.modelCalls)} 次调用`,
    },
    {
      label: "资源加载",
      value: metrics === undefined ? "—" : `约 ${formatCount(metrics.inputTokens)} tokens`,
    },
  ];
}

/** 意见分布表四行（渲染与内容校验共用单源） */
interface DistributionRow {
  readonly label: SeverityRow["label"];
  readonly count: string;
  readonly files: string;
}

function distributionRows(findings: readonly Finding[]): readonly DistributionRow[] {
  return severityRows(findings).map((row) => ({
    label: row.label,
    count: String(row.count),
    files: row.files.length > 0 ? row.files.join(", ") : "—",
  }));
}

interface StructuredSummaryOptions {
  /** 零意见：没有意见可速览，整节省略 */
  readonly includePriority?: boolean;
  /** 意见分布表之后的说明句（零意见的固定口径） */
  readonly note?: string;
  /** 覆盖星级行（零上报 / 未检视时写「不作星级评价」） */
  readonly starLine?: string;
}

/** 结构化渲染只依赖已上报 findings 与总览指标，不要求完整总结输入 */
type StructuredSummaryInput = Pick<ReviewSummaryInput, "findings" | "metrics">;

function renderStructuredSummary(
  input: StructuredSummaryInput,
  options: StructuredSummaryOptions = {},
): string {
  const rows = distributionRows(input.findings);
  const priority = highPriorityLines(input.findings);
  const stars = severityStars(input.findings);
  const includePriority = options.includePriority ?? true;
  const lines: string[] = [
    "## 检视总览",
    "",
    "| 维度 | 统计 |",
    "|------|------|",
    ...overviewRows(input.metrics).map((row) => `| ${row.label} | ${row.value} |`),
    "",
    "### 意见分布",
    "",
    "| severity | 数量 | 涉及文件 |",
    "|----------|------|---------|",
    ...rows.map((row) => `| ${row.label} | ${row.count} | ${row.files} |`),
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
    options.starLine ??
      `${starText(stars)} — ${
        input.findings.length === 0 ? ZERO_FINDING_CRITERION : STAR_CRITERIA[stars]
      }`,
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
