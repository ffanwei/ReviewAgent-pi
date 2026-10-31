import { DEFAULT_LIMITS, type Limits, type ModelOverride, type ResolvedConfig } from "./config.js";

/**
 * 检视运行时值对象（ADR-0025）：CLI 从用户级配置快照取出的**不可变子集**，
 * 经显式参数逐层下传（不做全局单例、不在请求期重读、不回写 `process.env`）。
 *
 * 只装「检视执行需要」的三块：
 * - `limits`：超时 / 并发 / MR 边界 / 归档 / 微限（A 档常量不在其中——它们死钉）；
 * - `maxOutputTokens`：`reviewer.maxOutputTokens`（null = 按接入点自动判档）；
 * - `models`：`models{}` 元数据覆盖（按 id 深合并到内置目录）。
 *
 * 缺省值 `DEFAULT_REVIEW_RUNTIME` = 今天的缺省行为（零漂移），供测试与内核
 * 直调形态使用；CLI 真跑恒传 `reviewRuntimeOf(config)`。
 */
export interface ReviewRuntime {
  readonly limits: Limits;
  readonly maxOutputTokens: number | null;
  readonly models: Readonly<Record<string, ModelOverride>>;
}

export const DEFAULT_REVIEW_RUNTIME: ReviewRuntime = Object.freeze({
  limits: DEFAULT_LIMITS,
  maxOutputTokens: null,
  models: {},
});

/** 配置快照 → 检视运行时（main 唯一落点；之后只读） */
export function reviewRuntimeOf(config: ResolvedConfig): ReviewRuntime {
  return {
    limits: config.limits,
    maxOutputTokens: config.reviewer.maxOutputTokens,
    models: config.models,
  };
}
