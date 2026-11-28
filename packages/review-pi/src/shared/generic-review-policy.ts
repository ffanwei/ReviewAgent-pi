// 通用检视建议类抑制（MR + repo）。
//
// 只作用于**通用检视**的候选 / findings；规则 Skill 的候选在
// `agent-review-loop` 里是在本过滤器之后才追加的，因此天然不走这里。
//
// 判定是纯确定性的：severity 精确命中 + category 命中（categories 空 =
// 不按类别限制）。不按标题关键词猜测“建议 / 可以 / 考虑”，避免误杀真实缺陷。

import type { GenericReviewSuppressionRecord } from "../contracts/run.js";
import type { GenericReviewLimits } from "./config-limits.js";

export interface GenericReviewFilterResult<T> {
  readonly kept: readonly T[];
  /** 策略存在且至少声明了一个 severity 时返回；0 条丢弃也留痕 */
  readonly suppression?: GenericReviewSuppressionRecord;
}

interface CandidateShape {
  readonly severity?: unknown;
  readonly category?: unknown;
}

function readShape(item: unknown): CandidateShape {
  return typeof item === "object" && item !== null ? (item as CandidateShape) : {};
}

/**
 * 过滤通用检视候选。`categories` 为空 = 只按 severity；`severities` 为空 =
 * 不过滤（返回原数组 + undefined audit）。
 */
export function filterGenericSuggestions<T>(
  items: readonly T[],
  policy: GenericReviewLimits | undefined,
): GenericReviewFilterResult<T> {
  if (policy === undefined || policy.suppress.severities.length === 0) {
    return { kept: items };
  }
  const severities = new Set<string>(policy.suppress.severities);
  const categories = new Set<string>(policy.suppress.categories);
  const bySeverity: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const kept: T[] = [];
  let dropped = 0;

  for (const item of items) {
    const shape = readShape(item);
    const severity = typeof shape.severity === "string" ? shape.severity : "";
    const category = typeof shape.category === "string" ? shape.category : "";
    const severityHit = severities.has(severity);
    const categoryHit = categories.size === 0 || categories.has(category);
    if (!severityHit || !categoryHit) {
      kept.push(item);
      continue;
    }
    dropped += 1;
    bySeverity[severity] = (bySeverity[severity] ?? 0) + 1;
    const bucket = category === "" ? "(missing)" : category;
    byCategory[bucket] = (byCategory[bucket] ?? 0) + 1;
  }

  return {
    kept,
    suppression: {
      policy: {
        severities: [...policy.suppress.severities],
        categories: [...policy.suppress.categories],
      },
      dropped,
      bySeverity,
      byCategory,
    },
  };
}

/** 多轮 / 主链 + 补漏的留痕合并；null/undefined 视为无策略 */
export function mergeGenericReviewSuppressions(
  left: GenericReviewSuppressionRecord | undefined,
  right: GenericReviewSuppressionRecord | undefined,
): GenericReviewSuppressionRecord | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  const bySeverity: Record<string, number> = { ...left.bySeverity };
  for (const [key, value] of Object.entries(right.bySeverity)) {
    bySeverity[key] = (bySeverity[key] ?? 0) + value;
  }
  const byCategory: Record<string, number> = { ...left.byCategory };
  for (const [key, value] of Object.entries(right.byCategory)) {
    byCategory[key] = (byCategory[key] ?? 0) + value;
  }
  return {
    policy: left.policy,
    dropped: left.dropped + right.dropped,
    bySeverity,
    byCategory,
  };
}
