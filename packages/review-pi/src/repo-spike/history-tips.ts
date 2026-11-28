// 历史意见失效检查（R-21）：纯判定核心。
//
// 输入：`.aireview/history_review_tips.json`（平台在上次检视后回放的历史意见，
// `patchLine` = 我们上次上报的 `code` 源码行）+ 本次 repo 检视结果。
//
// 判定矩阵（详见 R-21 票）：
//   文件层：不在磁盘 → 规则失效「文件已删除」；not-reached → 规则保留。
//   已检视文件：锚点分类（exact / edited / gone）× 配对信号
//   （硬档 / 位置命中文本不过线 / 软档 / 无）→ 规则失效「重复」、规则保留
//   或 LLM 候选（锚点变更或配对疑问）。
//
// 结构约束：位置匹配（patchLine ≡ finding 引用的当前源码行）成立 ⟹ 锚点
// exact——「位置命中」只出现在 exact 行，矩阵无重叠，每条意见恰一路径。
//
// 本模块零 I/O（文件内容与磁盘状态由调用方注入）、零模型；LLM 裁决在
// `history-verdict.ts`，编排在 `history-invalidation.ts`。
//
// 保守原则：误失效（把仍成立的意见从平台抹掉）代价高于漏失效——一切
// 拿不准的路径都落在保留或 LLM 候选，绝不直接失效。

import { titleSimilarity } from "../finding/finding-key.js";
import type { HistoryTipsLimits } from "../shared/config-limits.js";

/** 历史意见文件的固定路径（相对仓库根，POSIX 分隔） */
export const HISTORY_TIPS_RELATIVE_PATH = ".aireview/history_review_tips.json";

/** 上报 reason 的中文枚举（服务端契约：reason 是 string；枚举是我们单侧
 * 的发送纪律。verdict → reason 的映射收口在 `reasonFromVerdict` 单点，
 * 将来 reason 改用 LLM 结论只改这一个函数） */
export const INVALIDATION_REASONS = ["文件已删除", "重复", "已修复"] as const;
export type InvalidationReason = (typeof INVALIDATION_REASONS)[number];

/** 锚点三态 + 不可评估（patchLine 缺失时按无变更信号处理） */
export type AnchorState = "exact" | "edited" | "gone" | "unknown";

/** 判定矩阵里的配对信号（同文件、针对单条历史意见） */
export type PairSignal =
  | { readonly kind: "hard-duplicate"; readonly matchedFindingId: string }
  | { readonly kind: "pair-question"; readonly findingIds: readonly string[] }
  | { readonly kind: "soft-candidate"; readonly findingIds: readonly string[] }
  | { readonly kind: "none" };

/** 一条历史意见（准入与归一之后） */
export interface HistoryTipEntry {
  readonly tipsId: number;
  readonly status: string;
  /** 仓根相对 POSIX 路径 */
  readonly filePath: string;
  readonly lineNum: number;
  /** 剥掉 diff 前缀（+/-）并 trim 后的代码锚点行 */
  readonly patchLine: string;
  readonly reviewMsg: string;
}

export interface LoadHistoryTipsOutcome {
  /** 准入通过（status ∈ 配置集且字段合法）的条目 */
  readonly entries: readonly HistoryTipEntry[];
  readonly total: number;
  readonly skippedInvalidated: number;
  readonly skippedStatus: number;
  readonly invalidEntries: number;
}

/** 从平台历史文件原文解析 + 准入。JSON 坏 / 非数组 = 丢弃（调用方打一行日志）。 */
export function parseHistoryTipsDocument(
  raw: string,
  limits: HistoryTipsLimits,
): LoadHistoryTipsOutcome | undefined {
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(document)) {
    return undefined;
  }
  const entries: HistoryTipEntry[] = [];
  const seen = new Set<number>();
  let skippedInvalidated = 0;
  let skippedStatus = 0;
  let invalidEntries = 0;
  for (const item of document) {
    if (typeof item !== "object" || item === null) {
      invalidEntries += 1;
      continue;
    }
    const record = item as Record<string, unknown>;
    const status = typeof record.status === "string" ? record.status.trim() : "";
    if (status === "INVALIDATED") {
      skippedInvalidated += 1;
      continue;
    }
    if (!limits.statuses.includes(status)) {
      skippedStatus += 1;
      continue;
    }
    const tipsId = readTipsId(record.id);
    if (tipsId === undefined) {
      invalidEntries += 1;
      continue;
    }
    if (seen.has(tipsId)) {
      // 同 tipsId 重复：首条有效（与平台按 id 定位的行为一致）
      invalidEntries += 1;
      continue;
    }
    const lineNum = readLineNum(record.lineNum);
    if (lineNum === undefined) {
      invalidEntries += 1;
      continue;
    }
    const filePath = readFilePath(record.filePath);
    if (filePath === undefined) {
      invalidEntries += 1;
      continue;
    }
    const rawPatchLine = typeof record.patchLine === "string" ? record.patchLine : "";
    const rawReviewMsg = typeof record.reviewMsg === "string" ? record.reviewMsg.trim() : "";
    seen.add(tipsId);
    entries.push({
      tipsId,
      status,
      filePath,
      lineNum,
      patchLine: stripDiffPrefix(rawPatchLine).trim(),
      reviewMsg: rawReviewMsg,
    });
  }
  return {
    entries,
    total: document.length,
    skippedInvalidated,
    skippedStatus,
    invalidEntries,
  };
}

/** `id`：数字字符串 / number 均可；必须 ≤ 2^53（tipsId 契约是 int64，JS 安全上界） */
function readTipsId(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) {
    return value <= Number.MAX_SAFE_INTEGER ? value : undefined;
  }
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return parsed <= Number.MAX_SAFE_INTEGER ? parsed : undefined;
  }
  return undefined;
}

/** `lineNum`：正整数（number / 数字字符串） */
function readLineNum(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) {
    return value;
  }
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

/** `filePath`：与报文同一口径的仓根相对 POSIX 归一；非法（绝对路径 / `..`）= undefined */
function readFilePath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  const normalized = value.trim().replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    return undefined;
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return undefined;
  }
  return segments.join("/");
}

/** 剥掉 unified diff 行前缀（`+` / `-`）；平台把上报的 code 存成 patchLine 时可能带。 */
export function stripDiffPrefix(line: string): string {
  if (line.startsWith("+") || line.startsWith("-")) {
    return line.slice(1);
  }
  return line;
}

// ---------------------------------------------------------------------------
// 锚点分类
// ---------------------------------------------------------------------------

/** 模糊锚点的编辑距离阈值：超过即视为「行没了」（编辑距离按字符数归一，
 * 长行放宽：距离 ≤ max(2, floor(len/6))）。阈值待真实数据回校（sidecar 记分数）。 */
export function anchorEditDistanceBudget(lineLength: number): number {
  return Math.max(2, Math.floor(lineLength / 6));
}

/** 锚点分类：精确（trim 后整行相等，一遍廉价扫描）/ edited（无精确行但存在
 * 近似行——第二遍有界编辑距离，仅精确未命中才走）/ gone / unknown。 */
export function classifyAnchor(
  fileLines: readonly string[],
  patchLine: string,
): { readonly state: AnchorState; readonly bestLine: number | undefined } {
  const target = patchLine.trim();
  if (target === "") {
    return { state: "unknown", bestLine: undefined };
  }
  for (let index = 0; index < fileLines.length; index += 1) {
    if ((fileLines[index] ?? "").trim() === target) {
      return { state: "exact", bestLine: index + 1 };
    }
  }
  let bestLine: number | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < fileLines.length; index += 1) {
    const trimmed = (fileLines[index] ?? "").trim();
    if (trimmed === "") {
      continue;
    }
    const distance = boundedEditDistance(
      trimmed,
      target,
      anchorEditDistanceBudget(Math.max(trimmed.length, target.length)),
    );
    if (distance < bestDistance) {
      bestDistance = distance;
      bestLine = index + 1;
    }
  }
  if (bestLine !== undefined) {
    return { state: "edited", bestLine };
  }
  return { state: "gone", bestLine: undefined };
}

/** 有界编辑距离（Levenshtein）：超过预算返回 Infinity，不付出 O(n²) 全量。 */
function boundedEditDistance(left: string, right: string, budget: number): number {
  if (Math.abs(left.length - right.length) > budget) {
    return Number.POSITIVE_INFINITY;
  }
  const a = [...left];
  const b = [...right];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const value = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        substitution,
      );
      current.push(value);
      if (value < rowMin) {
        rowMin = value;
      }
    }
    if (rowMin > budget) {
      return Number.POSITIVE_INFINITY;
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

// ---------------------------------------------------------------------------
// 配对信号
// ---------------------------------------------------------------------------

/** 参与匹配的 finding 投影（呈现集——实际已上报给平台的意见） */
export interface FindingForMatch {
  readonly id: string;
  readonly line: number;
  readonly title: string;
  /** tips.review（剥模板词后）；缺席时只用 title */
  readonly reviewText?: string;
}

/** 硬档文本下限：位置匹配已承担主要证据，文本只需排除「完全在说另一件事」。
 * 软档阈值（无位置佐证）：与候选门同根因去重同口径。均待真实数据回校。 */
export const HARD_DUPLICATE_TEXT_FLOOR = 0.3;
export const SOFT_DUPLICATE_TEXT_FLOOR = 0.5;

/** 位置匹配窗口：与 finding-key 同根因口径（±5 行） */
export const PAIR_LINE_WINDOW = 5;

/** tips.review 模板词（比较前剥掉，避免脚手架稀释相似度） */
const REVIEW_TEMPLATE_MARKERS = ["[缺陷类型]", "影响评估：", "[重构思路]", "代码示例："];

export function stripReviewTemplate(text: string): string {
  let out = text;
  for (const marker of REVIEW_TEMPLATE_MARKERS) {
    out = out.split(marker).join(" ");
  }
  return out.trim();
}

/** 历史意见 vs 单条 finding 的文本相似度（title / tips.review 剥模板词，取最大） */
export function reviewSimilarity(reviewMsg: string, finding: FindingForMatch): number {
  const byTitle = titleSimilarity(reviewMsg, finding.title);
  const byReview =
    finding.reviewText !== undefined && finding.reviewText.length > 0
      ? titleSimilarity(reviewMsg, stripReviewTemplate(finding.reviewText))
      : 0;
  return Math.max(byTitle, byReview);
}

/**
 * 配对信号判定（矩阵第 2 层）。调用方保证 findings 是该文件**已上报**集合。
 *
 * - hard-duplicate：位置命中（行号 ±5 且该行源码 === patchLine）∧ 文本 ≥ 硬档
 *   下限，取文本最相似的那条；逐条最优匹配（多条旧意见可映射同一 finding）；
 * - pair-question：位置命中但文本不过线（「同行两个问题」的边界，交 LLM）；
 * - soft-candidate：无位置命中但同文件文本 ≥ 软阈（问题挪行 / 换行引用）；
 * - none：无任何信号。
 */
export function matchPairSignal(
  entry: HistoryTipEntry,
  fileLines: readonly string[],
  findings: readonly FindingForMatch[],
): PairSignal {
  const locationMatches: { finding: FindingForMatch; similarity: number }[] = [];
  const softMatches: { finding: FindingForMatch; similarity: number }[] = [];
  const anchor = entry.patchLine.trim();
  for (const finding of findings) {
    const similarity = reviewSimilarity(entry.reviewMsg, finding);
    const inWindow = Math.abs(finding.line - entry.lineNum) <= PAIR_LINE_WINDOW;
    // 锚点为空（patchLine 缺失）不可能有位置命中：空行撞空行不算匹配。
    const codeEquals =
      anchor !== "" && inWindow && (fileLines[finding.line - 1] ?? "").trim() === anchor;
    if (codeEquals) {
      locationMatches.push({ finding, similarity });
    } else if (similarity >= SOFT_DUPLICATE_TEXT_FLOOR) {
      softMatches.push({ finding, similarity });
    }
  }
  if (locationMatches.length > 0) {
    locationMatches.sort((left, right) => right.similarity - left.similarity);
    const best = locationMatches[0];
    if (best !== undefined && best.similarity >= HARD_DUPLICATE_TEXT_FLOOR) {
      return { kind: "hard-duplicate", matchedFindingId: best.finding.id };
    }
    return {
      kind: "pair-question",
      findingIds: locationMatches.map((match) => match.finding.id),
    };
  }
  if (softMatches.length > 0) {
    softMatches.sort((left, right) => right.similarity - left.similarity);
    return {
      kind: "soft-candidate",
      findingIds: softMatches.map((match) => match.finding.id),
    };
  }
  return { kind: "none" };
}

// ---------------------------------------------------------------------------
// 判定矩阵
// ---------------------------------------------------------------------------

/** 已检视文件内单条意见的矩阵结果 */
export type MatrixDecision =
  | {
      readonly kind: "invalidate";
      readonly reason: Extract<InvalidationReason, "重复">;
      readonly matchedFindingId: string;
    }
  | { readonly kind: "keep"; readonly cause: "no-signal" }
  | { readonly kind: "llm"; readonly signal: LlmCandidateSignal };

export interface LlmCandidateSignal {
  readonly anchor: AnchorState;
  readonly anchorLine: number | undefined;
  readonly pair: PairSignal;
}

/**
 * 已检视文件内的矩阵（#1–#8 行）。文件层（file-removed / not-reached）由
 * 编排层决定，不在这里。
 */
export function evaluateMatrix(
  entry: HistoryTipEntry,
  fileLines: readonly string[],
  findings: readonly FindingForMatch[],
): MatrixDecision {
  const anchor = classifyAnchor(fileLines, entry.patchLine);
  const pair = matchPairSignal(entry, fileLines, findings);
  if (pair.kind === "hard-duplicate") {
    return { kind: "invalidate", reason: "重复", matchedFindingId: pair.matchedFindingId };
  }
  // #4：锚点无变更信号（exact / unknown）且无任何配对信号 → 免模型保留。
  // patchLine 缺失（unknown）按无变更信号处理，只能被软档配对拉进 LLM。
  if ((anchor.state === "exact" || anchor.state === "unknown") && pair.kind === "none") {
    return { kind: "keep", cause: "no-signal" };
  }
  return {
    kind: "llm",
    signal: { anchor: anchor.state, anchorLine: anchor.bestLine, pair },
  };
}

// ---------------------------------------------------------------------------
// LLM 裁决 → 上报 reason（单点映射：将来 reason 改用模型结论只改这里）
// ---------------------------------------------------------------------------

export type HistoryVerdict = "fixed" | "persist" | "duplicate" | "unclear";

export const HISTORY_VERDICTS = ["fixed", "persist", "duplicate", "unclear"] as const;

export function reasonFromVerdict(verdict: HistoryVerdict): InvalidationReason | undefined {
  if (verdict === "fixed") {
    return "已修复";
  }
  if (verdict === "duplicate") {
    return "重复";
  }
  return undefined;
}

/** 裁决回包的合法 verdict 值（宽松解析用） */
export function parseVerdictValue(value: unknown): HistoryVerdict | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  return (HISTORY_VERDICTS as readonly string[]).includes(trimmed)
    ? (trimmed as HistoryVerdict)
    : undefined;
}
