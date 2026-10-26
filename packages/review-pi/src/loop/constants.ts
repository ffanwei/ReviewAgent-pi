// 循环常量（测量常量面：与 DSH 线 loop/constants.ts 一致）。

/** 最大轮次（一轮 = 六阶段完整一遍）；超出即截断留痕 */
export const MAX_ROUNDS = 5;

/** 轮次上限截断原因（审计 truncationReasons 留痕文案） */
export const TRUNCATION_MAX_ROUNDS = "MAX_ROUNDS_REACHED";

/** 单 run 工具调用硬上界（C/D/E；成功执行计数，跨轮不重置，失败也计入） */
export const MAX_TOOL_CALLS = 100;

/** 工具预算耗尽截断原因（审计 truncationReasons 留痕文案；不翻转 truncated） */
export const TRUNCATION_TOOL_BUDGET = "TOOL_BUDGET_EXHAUSTED";

/**
 * 预算耗尽时的工具应答内容（= 审计 resultSummary = wire tool 消息 content）。
 * 字节真源：t-series C/D/E 审计 toolCallLog（"Error: tool call budget exhausted"）；
 * 根仓现行源码的 "SKIPPED: " 前缀是 t-series 之后的演进，不采纳。
 */ 
export const TOOL_BUDGET_EXHAUSTED_SUMMARY = "Error: tool call budget exhausted";
