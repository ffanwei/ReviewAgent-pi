import type { AuditFileContent } from "../audit/audit-writer.js";

/**
 * #7 review-pi CLI 结果呈现（进程内主缝）：stdout 形状契约。
 *
 * 整个 stdout = 单个 JSON 文档（机器可读、进程烟测锁形状）：ok 标志 +
 * 运行标识 + 计数摘要 + 结构化 Finding 集 + 审计文件路径。错误走 stderr，
 * stdout 保持干净。形状对齐 DSH 线 render.ts 的域内呈现面（review-pi 无
 * 切分编排——超界 MR 处理是 DSH 线后分家决策，pi 线自立 ADR 前不实装）。
 *
 * 恒英文（ADR-0065）：stdout 呈现档就是英文真源本身，不做任何翻译，也没有
 * `presentation` 留痕键——审计、run 记录与 stdout 的 findings 逐字节同源。
 *
 * 截断契约（票面）：诚实截断 = 完成的一种——退出码 0，truncated=true 在
 * JSON 中携带信号；呈现层不区分对待。
 */

/** 一次检视的呈现面：导出审计的顶层摘要经 Pick 锚定（审计字段漂移即编译错） */
export type ReviewOutcome = Pick<
  AuditFileContent,
  "caseId" | "runId" | "truncated" | "rounds" | "toolCalls" | "findings"
> & {
  readonly auditPath: string;
};

/** ok 包络 + 两空格缩进 JSON 整写 + 尾随换行（stdout 单文档纪律的公共面） */
export function renderJsonDocument(document: Record<string, unknown>): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** ok 包络 + 两空格缩进 JSON 整写 + 尾随换行 */
export function renderReviewOutcome(outcome: ReviewOutcome): string {
  return renderJsonDocument({ ok: true, ...outcome });
}
