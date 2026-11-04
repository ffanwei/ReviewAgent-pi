import { optionalPositiveIntArg } from "./args.js";
import { readThroughLedger } from "./ledger.js";
import { applyLineBudget } from "./result-budget.js";
import type { ReviewToolHandler } from "./toolkit-types.js";

/**
 * review.get_diff（#6 P3a）：返回本次 MR 的 unified diff（检视对象本体）。
 *
 * 输出确定性：同一 MR → 同一字节；超预算在行边界截断并留痕。
 * 分页（大 diff 第一期）：`offset`（1-based 起始行）/ `limit`（行数）按行翻页，
 * 默认页仍是原行为（无入参 = 全量 + 8K 字符截断，历史字节不变）。翻页后
 * 同一请求的 ledger 描述含区间，不同页不互相命中。
 * Context Ledger：diff 登记为 evidence（Evidence Policy：diff 即首要证据源），
 * 重复读取返回 "Already loaded: ctx#NNN" 引用而非原文（Ledger 功能态）。
 */

/** Ledger 登记标识：无入参 = 请求本身；分页 = 规范化区间 */
function diffLedgerDescription(offset: number | undefined, limit: number | undefined): string {
  if (offset === undefined && limit === undefined) {
    return "review.get_diff";
  }
  const start = offset ?? 1;
  const end = limit === undefined ? "end" : start + limit - 1;
  return `review.get_diff:${start}-${end}`;
}

export const getDiffTool: ReviewToolHandler = async (args, context): Promise<string> => {
  const offset = optionalPositiveIntArg("review.get_diff", args, "offset");
  const limit = optionalPositiveIntArg("review.get_diff", args, "limit");
  return readThroughLedger(
    context.ledger,
    "evidence",
    diffLedgerDescription(offset, limit),
    async () => {
      const allLines = context.diff.split("\n");
      if (offset === undefined && limit === undefined) {
        // 历史形态（逐字节不变）：无分页 = 原 header + 全量 + 8K 截断
        const lines = ["MR unified diff:", ...allLines];
        const budget = applyLineBudget(
          lines,
          context.resultBudgetChars,
          (shown, total) =>
            `Tool result truncated: showing ${shown} of ${total} diff lines (tool result budget ${context.resultBudgetChars} chars exceeded).`,
        );
        return budget.lines.join("\n");
      }

      const totalLines = allLines.length;
      const start = offset ?? 1;
      if (start > totalLines) {
        throw new Error(
          `review.get_diff: requested offset ${String(start)} is beyond the end of the diff (${String(totalLines)} lines)`,
        );
      }
      const end = limit === undefined ? totalLines : Math.min(start + limit - 1, totalLines);
      const lines = [
        `MR unified diff: lines ${String(start)}-${String(end)} of ${String(totalLines)}`,
        ...allLines.slice(start - 1, end),
      ];
      const budget = applyLineBudget(
        lines,
        context.resultBudgetChars,
        (shown, total) =>
          `Tool result truncated: showing ${shown} of ${total} result lines (tool result budget ${context.resultBudgetChars} chars exceeded); request a narrower range with offset/limit.`,
      );
      return budget.lines.join("\n");
    },
  );
};
