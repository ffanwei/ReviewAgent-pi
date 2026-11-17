import type { Finding } from "../contracts/finding.js";

/**
 * 分组检视的输出预算：每个检视组、整个样本各保留多少条 findings。
 *
 * 只做确定性排序与截断，不改变 finding 内容；`limit <= 0` = 不限制。
 * 排序口径：严重级优先（P0 > P1 > P2 > P3），同级按 confidence 降序，
 * 再按文件/行号稳定排序。截断后重编号，避免出现 F001、F004 空洞。
 */

const SEVERITY_RANK: Readonly<Record<Finding["severity"], number>> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

export interface FindingBudgetResult {
  readonly findings: readonly Finding[];
  /** 被预算丢弃的条数 */
  readonly dropped: number;
}

export function capFindings(
  findings: readonly Finding[],
  limit: number,
): FindingBudgetResult {
  if (limit <= 0 || findings.length <= limit) {
    return { findings, dropped: 0 };
  }
  return {
    findings: rankFindings(findings).slice(0, limit),
    dropped: findings.length - limit,
  };
}

export function rankFindings(findings: readonly Finding[]): readonly Finding[] {
  return [...findings].sort((left, right) => {
    const bySeverity = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
    if (bySeverity !== 0) {
      return bySeverity;
    }
    if (left.confidence !== right.confidence) {
      return right.confidence - left.confidence;
    }
    if (left.file !== right.file) {
      return left.file < right.file ? -1 : 1;
    }
    if (left.line !== right.line) {
      return left.line - right.line;
    }
    if (left.title === right.title) {
      return 0;
    }
    return left.title < right.title ? -1 : 1;
  });
}

/** 截断/排序后按输出顺序重编号 F001…；不改变其它字段。 */
export function renumberFindings(findings: readonly Finding[]): readonly Finding[] {
  return findings.map((finding, index) => ({
    ...finding,
    id: `F${String(index + 1).padStart(3, "0")}`,
  }));
}
