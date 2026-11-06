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
 *   finding 原文、`severity` 三档（ADR-0017 单源）与 `level` 四档并存对账。
 *
 * 确定性纪律（与 ADR-0017 `buildReviewTipsDocument` 同口径，本模块是包内
 * 独立实现——根仓 `src/presentation/tips.ts` 不进包）：
 * - 同文件同 `line` 去重只留首条（ADR-0023；merged findings 已按
 *   文件→行号→严重度→title 排序，首见即确定）；
 * - 顶层数组按 finding 首见序建文件组，组内按 lineNum 升序（稳定）；
 * - `severity` / `confidence` 沿用 ADR-0017 单源映射；`source` / `ruleId`
 *   来自片级登记（聚合重编号后无法重推）。
 */

/** `severity` → tips 三档（ADR-0017 单源：P3 折进 Minor，不丢条） */
const TIP_SEVERITY_BY_CODE: Readonly<Record<Finding["severity"], string>> = {
  P0: "Fatal",
  P1: "Major",
  P2: "Minor",
  P3: "Minor",
};

/** confidence 分档阈值（ADR-0017：≥0.8 High、≥0.5 Medium、其余 Low；非有限数按 Low） */
const CONFIDENCE_HIGH_MIN = 0.8;
const CONFIDENCE_MEDIUM_MIN = 0.5;

export interface AssembleUnifiedTipsInput {
  /** 聚合（合并重编号后）findings——`record.baseline.findings` */
  readonly mergedFindings: readonly Finding[];
  /** 各片语义登记的并集（键 = 合并键；首见优先，由调用方合并时保证） */
  readonly semanticByMergeKey: ReadonlyMap<string, SemanticTipEntry>;
  /** 键 = **merged** finding id（CLI 按 `--repo` 重抽；取不到即缺席 ⇒ code 空串） */
  readonly codeByFinding: Readonly<Record<string, string>>;
}

export interface UnifiedTipsOutcome {
  /** 12 键 tips 文档（零覆盖时为 `[]`——调用方决定是否改走 engine 回落） */
  readonly tips: ReviewTipsDocumentLike;
  /** 未获语义覆盖的 merged findings（`file:line (id)`，stderr 留痕用） */
  readonly uncovered: readonly string[];
}

/** tips 文档里的意见总条数（覆盖面判定：「全灭」= 有 findings 但计数为 0） */
export function countTips(tips: ReviewTipsDocumentLike): number {
  return tips.reduce((total, file) => total + file.reviewTips.length, 0);
}

/**
 * engine 回落路径的 12 键对齐：引擎 tips（10 键）按 `(file, line)` join 回
 * merged findings，注入 `id` / `level`——让 `reviews_tips_zh.json` 在统一路径
 * 与回落路径下**形状一致**（12 键）。join 不上的 tip 保持 10 键（只增不删，
 * 绝不因对齐失败丢字段）。
 */
export function withUnifiedKeys(
  tips: ReviewTipsDocumentLike,
  mergedFindings: readonly Finding[],
): ReviewTipsDocumentLike {
  const findingByLine = new Map<string, Finding>();
  for (const finding of mergedFindings) {
    const key = `${finding.file}\u0000${String(finding.line)}`;
    if (!findingByLine.has(key)) {
      findingByLine.set(key, finding);
    }
  }
  return tips.map((file) => ({
    filePath: file.filePath,
    reviewTips: file.reviewTips.map((tip) => {
      const finding = findingByLine.get(`${file.filePath}\u0000${String(tip.lineNum)}`);
      if (finding === undefined) {
        return tip;
      }
      return { ...tip, id: finding.id, level: LEVEL_BY_SEVERITY[finding.severity] };
    }),
  }));
}

export function assembleUnifiedTips(input: AssembleUnifiedTipsInput): UnifiedTipsOutcome {
  const groups = new Map<string, ReviewTipLike[]>();
  const uncovered: string[] = [];
  // ADR-0023：同文件同 line 去重只留首条（finding 源序——merged 顺序已确定）；
  // 被去重掉的 finding 不算 uncovered（是故意丢弃，不是生成失败）
  const seenLines = new Map<string, Set<number>>();
  for (const finding of input.mergedFindings) {
    let lines = seenLines.get(finding.file);
    if (lines === undefined) {
      lines = new Set<number>();
      seenLines.set(finding.file, lines);
    }
    if (lines.has(finding.line)) {
      continue;
    }
    lines.add(finding.line);
    const entry = input.semanticByMergeKey.get(findingMergeKey(finding));
    if (entry === undefined) {
      uncovered.push(`${finding.file}:${String(finding.line)} (${finding.id})`);
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
  return { tips, uncovered };
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

/** confidence 0–1 → High/Medium/Low（ADR-0017 阈值；不编高置信） */
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
