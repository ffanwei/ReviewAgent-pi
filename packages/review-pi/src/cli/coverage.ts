import { normalizeReportFilePath } from "../mcp/task-tools.js";

/**
 * 覆盖补报计划（ADR-0061 / ADR-0068）：变更文件全集 − 已上报文件。
 *
 * 纯计算，不调用 MCP：`files` 保持变更文件的原始顺序；`reported` 是规范化后的
 * 已上报集合，调用方把它作为 `exclude` 传给补报循环（`reportFilesWithoutTips`）。
 * 非法路径（绝对路径 / `.` / `..` / 空段）不登记——与 `normalizeReportFilePath`
 * 的「本地绝对路径不出进程」纪律同源。
 */
export interface CoverageReportPlan {
  /** 仍需补报空 tips 的文件（保持变更文件原顺序） */
  readonly files: readonly string[];
  /** 已上报文件（规范化；非法路径不登记） */
  readonly reported: ReadonlySet<string>;
}

export function planCoverageReport(
  changedFiles: readonly string[],
  reportedFiles: readonly string[],
): CoverageReportPlan {
  const reported = new Set<string>();
  for (const file of reportedFiles) {
    const normalized = normalizeReportFilePath(file);
    if (normalized !== null) {
      reported.add(normalized);
    }
  }
  return {
    files: changedFiles.filter((file) => !reported.has(file)),
    reported,
  };
}
