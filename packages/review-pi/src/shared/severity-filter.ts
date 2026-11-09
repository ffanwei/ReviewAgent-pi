import type { Finding } from "../contracts/finding.js";
import type { SeverityFilterRecord } from "../contracts/run.js";

/**
 * 中文 tips / MCP 上报的严重级过滤：单一判定 / 留痕口径。
 *
 * 纪律：
 * - 判定恒为「本条 severity 低于 `limits.severity.min`」⇒ 丢弃（等于阈值保留）；
 * - **只服务中文 tips 与 MCP 上报**（`reviews_tips_zh.json`、`mrReviewResult.reviewTips`），
 *   `reviews_en.json` / stdout / 审计 findings 永远保留全量；
 * - 过滤阈值来自配置 `limits.severity.min`（P0–P3，缺省 P3 = 不过滤）；
 *   缺席 = 不过滤（内核直调 / 单测形态）；CLI 真跑恒传配置值。
 */

/** 严重级排序：数字越小越严重（P0 最高） */
export const SEVERITY_RANK: Readonly<Record<Finding["severity"], number>> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

/** 严重级 → 排序序号（未知值按最低级处理，不误删） */
export function severityRankOf(severity: Finding["severity"]): number {
  return SEVERITY_RANK[severity] ?? SEVERITY_RANK.P3;
}

/** 低于阈值即丢弃（阈值缺席 = 不过滤；等于阈值保留） */
export function isSeverityBelow(
  severity: Finding["severity"],
  minSeverity: Finding["severity"] | undefined,
): boolean {
  return minSeverity !== undefined && severityRankOf(severity) > severityRankOf(minSeverity);
}

/**
 * 过滤留痕：阈值在场就产记录（即使丢弃 0 条，也要让审计看见生效阈值）；
 * 阈值缺席返回 undefined（审计 / run.json 整键省略——零漂移）。
 */
export function summarizeSeverityFilter(
  findings: readonly Finding[],
  minSeverity: Finding["severity"] | undefined,
): SeverityFilterRecord | undefined {
  if (minSeverity === undefined) {
    return undefined;
  }
  let droppedTips = 0;
  for (const finding of findings) {
    if (isSeverityBelow(finding.severity, minSeverity)) {
      droppedTips += 1;
    }
  }
  return { minSeverity, droppedTips };
}
