import type { Finding } from "../contracts/finding.js";
import type { TipsFilterRecord } from "../contracts/run.js";

/**
 * 中文 tips 的置信度过滤（ADR-0052）：单一判定 / 留痕口径。
 *
 * 纪律：
 * - 判定恒为 `confidence < min` ⇒ 丢弃（`>= min` 保留，边界值保留）；
 * - 只服务**中文 tips** 的取数（`reviews_tips_zh.json` 与 mrReviewResult），
 *   英文 findings / stdout 永远保留全量；
 * - 过滤阈值来自配置 `limits.confidence.min`（0–1，缺省 0.5）；缺席 = 不过滤
 *   （内核直调 / 单测形态）；CLI 真跑恒传配置值。
 */

/** 低于阈值即丢弃（阈值缺席 = 不过滤） */
export function isConfidenceBelow(confidence: number, minConfidence: number | undefined): boolean {
  return minConfidence !== undefined && confidence < minConfidence;
}

/**
 * 过滤留痕：阈值在场就产记录（即使丢弃 0 条，也要让审计看见生效阈值）；
 * 阈值缺席返回 undefined（审计 / run.json 整键省略——零漂移）。
 */
export function summarizeTipsFilter(
  findings: readonly Finding[],
  minConfidence: number | undefined,
): TipsFilterRecord | undefined {
  if (minConfidence === undefined) {
    return undefined;
  }
  let droppedTips = 0;
  for (const finding of findings) {
    if (finding.confidence < minConfidence) {
      droppedTips += 1;
    }
  }
  return { minConfidence, droppedTips };
}
