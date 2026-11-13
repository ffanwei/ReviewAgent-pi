/**
 * MCP 业务 tool 调用的纯数据契约（ADR-0037 / ADR-0045）。
 *
 * 放在 `contracts/` 而不是 `mcp/`：核心层（`export/lifecycle.ts` 等）需要消费
 * 「一次业务调用留下了什么」，但**核心不得 import src/mcp/**」是 ADR-0037 的
 * 零耦合验收标准（`mcp/no-core-coupling.test.ts`）。这里只放类型，零运行时依赖。
 */

/** 一次业务 tool 调用的结果：失败带人话原因（调用方打 stderr），绝不抛错 */
export type TaskCallResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * 一次业务调用的完整留痕（`onTaskCall` 回调）：CLI 据此写 `mcp.json`。
 * 与 `TaskCallResult` 的区别：多带输入、时间与服务端原始回包，只用于留痕。
 */
export interface TaskCallTrace {
  /** tool 名：startTask / mrReviewResult / saveReviewSummary / endTask */
  readonly tool: string;
  /** 平铺参数（原样，即 MCP `tools/call.arguments`） */
  readonly arguments: unknown;
  /** 首次尝试开始时刻（epoch ms） */
  readonly startedAt: number;
  /** 含重试的总耗时（毫秒） */
  readonly durationMs: number;
  readonly ok: boolean;
  /** 失败原因（`ok:false`） */
  readonly reason?: string;
  /** 服务端原始返回文本（拿到回包时才有；传输失败缺席） */
  readonly responseText?: string;
}
