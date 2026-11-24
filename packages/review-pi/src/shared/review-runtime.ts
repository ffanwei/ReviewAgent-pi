import {
  DEFAULT_CODEINTEL,
  DEFAULT_LIMITS,
  type CodeIntelSettings,
  type Limits,
  type ResolvedConfig,
} from "./config.js";

/**
 * 检视运行时值对象（ADR-0025）：CLI 从用户级配置快照取出的**不可变子集**，
 * 经显式参数逐层下传（不做全局单例、不在请求期重读、不回写 `process.env`）。
 *
 * 只装「检视执行需要」的三块：
 * - `limits`：超时 / 并发 / MR 边界 / 分片 / 归档 / 微限（A 档常量不在其中——它们死钉）；
 * - `codeintel`：代码智能启用哪些语言（ADR-0040；只影响符号级工具）；
 * - `maxOutputTokens`：`reviewer.maxOutputTokens`（null = 按接入点自动判档）；
 * - `contextWindow`：`reviewer.contextWindow`（null = 用内核模型目录画像）。
 *
 * 缺省值 `DEFAULT_REVIEW_RUNTIME` = 今天的缺省行为（零漂移），供测试与内核
 * 直调形态使用；CLI 真跑恒传 `reviewRuntimeOf(config)`。
 */
export interface ReviewRuntime {
  readonly limits: Limits;
  readonly codeintel: CodeIntelSettings;
  readonly maxOutputTokens: number | null;
  /** 模型真实上下文窗口；缺省 / null = 用内核模型目录画像（ADR-0102） */
  readonly contextWindow?: number | null;
  /**
   * 单 pass 工具调用硬上界；缺省 = `MAX_TOOL_CALLS`（100）。
   *
   * 只给全仓扫描这类「组内文件多、合成 diff 已含全文」的调用方收紧预算；
   * MR 路径不传，保持 100 不变。
   */
  readonly maxToolCalls?: number;
  /**
   * 单 pass 工具调用**尝试**上界（含被 retrieval 预算跳过的调用）；缺省不限。
   *
   * `maxToolCalls` 只计真正执行的调用；模型可能反复请求已被 retrieval 预算
   * 拒绝的读取，靠 skipped 调用空转。全仓扫描需要这一层封顶。
   */
  readonly maxToolAttempts?: number;
}

export const DEFAULT_REVIEW_RUNTIME: ReviewRuntime = Object.freeze({
  limits: DEFAULT_LIMITS,
  codeintel: DEFAULT_CODEINTEL,
  maxOutputTokens: null,
  contextWindow: null,
});

/** 配置快照 → 检视运行时（main 唯一落点；之后只读） */
export function reviewRuntimeOf(config: ResolvedConfig): ReviewRuntime {
  return {
    limits: config.limits,
    codeintel: config.codeintel,
    maxOutputTokens: config.reviewer.maxOutputTokens,
    contextWindow: config.reviewer.contextWindow,
  };
}
