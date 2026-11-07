import type { Finding } from "../contracts/finding.js";
import { findingMergeKey } from "../run/findings-merge.js";
import type { ReviewTipsDocumentLike, ReviewTipLike } from "./presentation-projection.js";
import { LEVEL_BY_SEVERITY, type SemanticTipEntry } from "./report-payload.js";

/**
 * 统一 tips 组装（ADR-0045 统一 tips）：把各片统一生成调用登记的语义字段，
 * 按合并键 join 回 **merged findings**，组装成 `reviews_tips_zh.json` 的
 * 12 键形态（10 键 + `id` + `level`，只增不删——用户约束）。
 *
 * 与 mrReviewResult **同一份生成、两个投影**：
 * - 报文（片级、即发）：`code` 必填单行、`filePath` 规范化、`level` 四档；
 * - tips（聚合、落盘）：`code` 允许空串（ADR-0017 老契约）、`filePath` 用
 *   finding 原文、`severity` 四档（ADR-0052，与 `level` 同值）。
 *
 * 确定性纪律（与 ADR-0017 `buildReviewTipsDocument` 同口径，本模块是包内
 * 独立实现——根仓 `src/presentation/tips.ts` 不进包）：
 * - **置信度过滤（ADR-0052）**：`finding.confidence < limits.confidence.min`
 *   的意见在去重前丢弃（有意丢弃，不算 uncovered）；
 * - 同文件同 `line` 去重只留首条（ADR-0023；merged findings 已按
 *   文件→行号→严重度→title 排序，首见即确定）；
 * - 顶层数组按 finding 首见序建文件组，组内按 lineNum 升序（稳定）；
 * - `severity` / `confidence` 沿用 ADR-0017 单源映射；`source` / `ruleId`
 *   来自片级登记（聚合重编号后无法重推）。
 */

/** `severity` → tips 四档（ADR-0052：与平台 `level` 同值，P3 = Suggestion） */
const TIP_SEVERITY_BY_CODE: Readonly<Record<Finding["severity"], string>> = {
  P0: "Fatal",
  P1: "Major",
  P2: "Minor",
  P3: "Suggestion",
};

/** confidence 分档阈值（ADR-0052：≥0.7 High、≥0.5 Medium、其余 Low；非有限数按 Low） */
const CONFIDENCE_HIGH_MIN = 0.7;
const CONFIDENCE_MEDIUM_MIN = 0.5;

/** 置信度显示档 → 该档的置信度上界（过滤未 join 到 finding 的 tip 时用） */
const CONFIDENCE_BUCKET_CEILING: Readonly<Record<string, number>> = {
  Low: CONFIDENCE_MEDIUM_MIN,
  Medium: CONFIDENCE_HIGH_MIN,
  High: Number.POSITIVE_INFINITY,
};

export interface AssembleUnifiedTipsInput {
  /** 聚合（合并重编号后）findings——`record.baseline.findings` */
  readonly mergedFindings: readonly Finding[];
  /** 各片语义登记的并集（键 = 合并键；首见优先，由调用方合并时保证） */
  readonly semanticByMergeKey: ReadonlyMap<string, SemanticTipEntry>;
  /** 键 = **merged** finding id（CLI 按 `--repo` 重抽；取不到即缺席 ⇒ code 空串） */
  readonly codeByFinding: Readonly<Record<string, string>>;
  /**
   * 置信度过滤阈值（ADR-0052：`limits.confidence.min`）。缺席 = 不过滤
   * （内核直调 / 单测形态）；CLI 真跑恒传配置值（缺省 0.5）。
   */
  readonly minConfidence?: number;
  /**
   * 未覆盖的具体原因（键 = 合并键）：由片级上报编排累积（片级失败 / 逐条被拒）。
   * 缺席 = 只有覆盖面事实、没有原因（留痕回落「原因未知」）。
   */
  readonly uncoveredReasonByMergeKey?: ReadonlyMap<string, string>;
}

/** 未获统一生成覆盖的一条 finding（留痕文案 + 具体原因） */
export interface UncoveredFinding {
  /** `file:line (id)`：与既有 stderr 文案一致，可直接定位到 finding */
  readonly label: string;
  /** 具体失败原因（片级 / 逐条 / 未知） */
  readonly reason: string;
}

/** 原因缺席时的回落文案（不编原因：观测缺口如实呈现） */
export const UNKNOWN_UNCOVERED_REASON = "未登记（原因未知）";

export interface UnifiedTipsOutcome {
  /** 12 键 tips 文档（零覆盖时为 `[]`——调用方决定是否改走 engine 回落） */
  readonly tips: ReviewTipsDocumentLike;
  /** 未获语义覆盖的 merged findings（逐条带原因，stderr 留痕用） */
  readonly uncovered: readonly UncoveredFinding[];
  /** 因置信度低于阈值而被丢弃的意见数（ADR-0052 留痕；阈值缺席恒 0） */
  readonly droppedByConfidence: number;
}

/** tips 文档里的意见总条数（覆盖面判定：「全灭」= 有 findings 但计数为 0） */
export function countTips(tips: ReviewTipsDocumentLike): number {
  return tips.reduce((total, file) => total + file.reviewTips.length, 0);
}

/**
 * engine 回落路径的 12 键对齐：引擎 tips（10 键）按 `(file, line)` join 回
 * merged findings，注入 `id` / `level` 并把 `severity` 归一到同一套四档映射
 * （ADR-0052：第三方引擎若仍按三档产 P3→Minor，回落路径也不会与 `level`
 * 分叉）——让 `reviews_tips_zh.json` 在统一路径与回落路径下**形状一致**
 * （12 键且 `severity === level`）。join 不上的 tip 保持 10 键（只增不删，
 * 绝不因对齐失败丢字段）。
 */
export function withUnifiedKeys(
  tips: ReviewTipsDocumentLike,
  mergedFindings: readonly Finding[],
): ReviewTipsDocumentLike {
  const findingByLine = findingByLineOf(mergedFindings);
  return tips.map((file) => ({
    filePath: file.filePath,
    reviewTips: file.reviewTips.map((tip) => {
      const finding = findingByLine.get(fileLineKey(file.filePath, tip.lineNum));
      if (finding === undefined) {
        return tip;
      }
      return {
        ...tip,
        id: finding.id,
        severity: TIP_SEVERITY_BY_CODE[finding.severity],
        level: LEVEL_BY_SEVERITY[finding.severity],
      };
    }),
  }));
}

/**
 * 对任意来源的 tips 文档（统一生成 / 引擎回落）按置信度过滤（ADR-0052）。
 *
 * - tip 带 `id`（统一路径 / 回落注入后）⇒ 按 finding id 用**数字 confidence**
 *   精确判（同文件同行的低置信兄弟不会误伤本条）；
 * - 无 `id`（第三方引擎原样 10 键）⇒ 按 `(file, line)` join，取该行**最高**
 *   confidence（与「过滤先于同行去重」同口径：同行只要有一条够格就保留）；
 * - join 不上（引擎自造条目）⇒ 用展示档上界保守判（Low 上界 0.5、Medium
 *   上界 0.7、High 视为无上界）；未知档位不丢（不因无法判断而误删）。
 *
 * 空组不落盘（与 ADR-0017「只含有意见的文件」一致）。返回过滤后的文档与
 * 丢弃条数；对已过滤文档幂等。
 */
export function filterTipsDocumentByConfidence(
  tips: ReviewTipsDocumentLike,
  mergedFindings: readonly Finding[],
  minConfidence: number,
): { readonly tips: ReviewTipsDocumentLike; readonly dropped: number } {
  const findingById = new Map<string, Finding>();
  const maxConfidenceByLine = new Map<string, number>();
  for (const finding of mergedFindings) {
    if (!findingById.has(finding.id)) {
      findingById.set(finding.id, finding);
    }
    const key = fileLineKey(finding.file, finding.line);
    const previous = maxConfidenceByLine.get(key);
    if (previous === undefined || finding.confidence > previous) {
      maxConfidenceByLine.set(key, finding.confidence);
    }
  }
  let dropped = 0;
  const filtered: ReviewTipsDocumentLike = tips
    .map((file) => ({
      filePath: file.filePath,
      reviewTips: file.reviewTips.filter((tip) => {
        const byId = tip.id !== undefined ? findingById.get(tip.id) : undefined;
        const lineConfidence = maxConfidenceByLine.get(fileLineKey(file.filePath, tip.lineNum));
        const numeric = byId?.confidence ?? lineConfidence;
        const drop =
          numeric !== undefined
            ? numeric < minConfidence
            : confidenceBucketDropped(tip.confidence, minConfidence);
        if (drop) {
          dropped += 1;
        }
        return !drop;
      }),
    }))
    .filter((file) => file.reviewTips.length > 0);
  return { tips: filtered, dropped };
}

/** (file, line) → finding 索引（首见优先：与 tips 去重口径同源） */
function findingByLineOf(mergedFindings: readonly Finding[]): Map<string, Finding> {
  const findingByLine = new Map<string, Finding>();
  for (const finding of mergedFindings) {
    const key = fileLineKey(finding.file, finding.line);
    if (!findingByLine.has(key)) {
      findingByLine.set(key, finding);
    }
  }
  return findingByLine;
}

function fileLineKey(file: string, line: number): string {
  return `${file}\u0000${String(line)}`;
}

/** 无数字 confidence 时的保守判定：档位上界 ≤ 阈值即丢弃 */
function confidenceBucketDropped(bucket: string, minConfidence: number): boolean {
  const ceiling = CONFIDENCE_BUCKET_CEILING[bucket];
  return ceiling !== undefined && ceiling <= minConfidence;
}

export function assembleUnifiedTips(input: AssembleUnifiedTipsInput): UnifiedTipsOutcome {
  const groups = new Map<string, ReviewTipLike[]>();
  const uncovered: UncoveredFinding[] = [];
  let droppedByConfidence = 0;
  // ADR-0023：同文件同 line 去重只留首条（finding 源序——merged 顺序已确定）；
  // 被去重掉的 finding 不算 uncovered（是故意丢弃，不是生成失败）。
  // ADR-0052：置信度过滤在去重前——低置信的那条不占行位，同行更高置信条目可见。
  const seenLines = new Map<string, Set<number>>();
  for (const finding of input.mergedFindings) {
    if (input.minConfidence !== undefined && finding.confidence < input.minConfidence) {
      droppedByConfidence += 1;
      continue;
    }
    let lines = seenLines.get(finding.file);
    if (lines === undefined) {
      lines = new Set<number>();
      seenLines.set(finding.file, lines);
    }
    if (lines.has(finding.line)) {
      continue;
    }
    lines.add(finding.line);
    const mergeKey = findingMergeKey(finding);
    const entry = input.semanticByMergeKey.get(mergeKey);
    if (entry === undefined) {
      uncovered.push({
        label: `${finding.file}:${String(finding.line)} (${finding.id})`,
        reason: input.uncoveredReasonByMergeKey?.get(mergeKey) ?? UNKNOWN_UNCOVERED_REASON,
      });
      continue;
    }
    const tip = toUnifiedTip(finding, entry, input.codeByFinding[finding.id] ?? "");
    const group = groups.get(finding.file);
    if (group === undefined) {
      groups.set(finding.file, [tip]);
    } else {
      group.push(tip);
    }
  }
  const tips: ReviewTipsDocumentLike = [...groups.entries()].map(([filePath, reviewTips]) => ({
    filePath,
    reviewTips,
  }));
  return { tips, uncovered, droppedByConfidence };
}

/** merged finding + 语义登记 → 12 键 tip（确定性，无 I/O） */
function toUnifiedTip(
  finding: Finding,
  entry: SemanticTipEntry,
  code: string,
): ReviewTipLike {
  return {
    id: finding.id,
    code,
    review: entry.review,
    suggestion: entry.suggestion,
    category: entry.category,
    subcategory: entry.subcategory,
    severity: TIP_SEVERITY_BY_CODE[finding.severity],
    level: LEVEL_BY_SEVERITY[finding.severity],
    ruleId: entry.ruleId,
    lineNum: finding.line,
    source: entry.source,
    confidence: confidenceOf(finding.confidence),
  };
}

/** confidence 0–1 → High/Medium/Low（ADR-0052 阈值；不编高置信） */
function confidenceOf(value: number): string {
  if (!Number.isFinite(value)) {
    return "Low";
  }
  if (value >= CONFIDENCE_HIGH_MIN) {
    return "High";
  }
  if (value >= CONFIDENCE_MEDIUM_MIN) {
    return "Medium";
  }
  return "Low";
}
