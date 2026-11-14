// 12 键中文分组意见的形状契约（ADR-0017 / ADR-0045 / ADR-0090）。
//
// 原「呈现投影注入缝」（ADR-0010 英文产出 + 核外翻译投影的消费端接线）已随
// ADR-0090 中文原生检视整体退役：候选直接产出中文与 `Finding.tips`，无翻译、
// 无外部引擎、无 `presentation.engine` 配置键。本文件只保留 tips / tips 文档
// 的类型定义（delivery / unified-tips / reviews-tips-zh / review-summary 共用）。

/** 分组式检视意见：单条 tip 的结构（统一路径 = 12 键，只增不删） */
export interface ReviewTipLike {
  /** 聚合 finding id（`F001…`；tips ↔ reviews_all ↔ 平台报文可 join） */
  readonly id?: string;
  readonly code: string;
  readonly review: string;
  readonly suggestion: string;
  readonly category: string;
  readonly subcategory: string;
  readonly severity: string;
  /** 平台四档（Suggestion/Minor/Major/Fatal；与 `mrReviewResult` 同口径） */
  readonly level?: string;
  readonly ruleId: string;
  readonly lineNum: number;
  readonly source: string;
  readonly confidence: string;
}

/** 一个文件下的意见分组（空组不落盘——ADR-0017：只含有意见的文件） */
export interface ReviewTipsFileLike {
  readonly filePath: string;
  readonly reviewTips: readonly ReviewTipLike[];
}

/** `reviews_tips_zh.json` 的文档形状（顶层数组） */
export type ReviewTipsDocumentLike = readonly ReviewTipsFileLike[];
