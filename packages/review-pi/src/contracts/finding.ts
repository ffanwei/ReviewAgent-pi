// Finding 契约（ADR-0090：中文原生检视）。
// 只有通过候选拦截链（No Evidence, No Finding）的候选才允许产出。
//
// 语言口径：
// - 自然语言字段（title / description / tips.review / tips.suggestion /
//   tips.subcategory）为中文；
// - 结构化字段（id / severity / file / line / evidence 代码摘录 / rule /
//   confidence）保持原样；专有名词、代码标识符在中文叙述中保留英文。

/** 平台检视意见类别（中文七类；`category` 与 tips 报文同源单源） */
export const REVIEW_CATEGORIES = [
  "可维护",
  "安全",
  "可靠性",
  "可测试性",
  "性能",
  "可移植",
  "可读性",
] as const;

export type ReviewCategory = (typeof REVIEW_CATEGORIES)[number];

/** 中文检视意见块（ADR-0090：候选阶段直接产出，替代片级语义生成） */
export interface FindingTips {
  /** 意见正文：Markdown，含「[缺陷类型]」「影响评估」 */
  readonly review: string;
  /** 修改建议：Markdown，含「[重构思路]」「代码示例」 */
  readonly suggestion: string;
  /** 细分类型（收窄 category 的中文短语） */
  readonly subcategory: string;
}

export interface Finding {
  readonly id: string;
  readonly severity: "P0" | "P1" | "P2" | "P3";
  readonly category: string;
  readonly file: string;
  readonly line: number;
  readonly title: string;
  readonly description: string;
  /** 支撑本条结论的可验证材料：具体符号、行号与代码摘录 */
  readonly evidence: readonly string[];
  readonly rule: string;
  readonly confidence: number;
  /** 中文意见块（候选阶段产出；归一化兜底后恒在场） */
  readonly tips?: FindingTips;
}

/** category 是否属于中文七类 */
export function isReviewCategory(value: string): value is ReviewCategory {
  return (REVIEW_CATEGORIES as readonly string[]).includes(value);
}
