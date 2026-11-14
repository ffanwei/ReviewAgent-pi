import type { TaskCallResult } from "../contracts/mcp-task.js";
import type { AgentReviewTip, MrReviewResultArgs } from "../mcp/task-tools.js";
import { normalizeReportFilePath } from "../mcp/task-tools.js";

/**
 * 对「没有检视意见」的文件逐个调用 `mrReviewResult(filePath, reviewTips: [])`。
 *
 * 路径按报文同一规范处理（反斜杠→正斜杠、拒绝对路径/`..`），非法路径跳过
 * 并留痕；`exclude` = 已经有过一次上报尝试的文件（ADR-0061：每文件只发
 * 一条，避免与报文重复）。`attempted` 是调用方的尝试集合，本函数把处理过的
 * 规范化路径都登记进去，供后续兜底去重。返回成功发送的文件数。
 *
 * 片级上报（run 期）与收尾交付（ADR-0081）共用同一实现；调用方只注入
 * `reportFileResult` 与日志口，不耦合 `McpReporter` 的具体类型。
 */
export async function reportFilesWithoutTips(input: {
  readonly label: string;
  readonly taskId: string;
  readonly files: readonly string[];
  readonly reportedFiles: string[];
  readonly exclude?: ReadonlySet<string>;
  /** 出参：本函数处理过（含跳过）的文件路径，供调用方后续兜底去重 */
  readonly attempted?: Set<string>;
  readonly log: (line: string) => void;
  readonly reportFileResult: (args: MrReviewResultArgs) => Promise<TaskCallResult>;
}): Promise<number> {
  const seen = new Set<string>();
  let sent = 0;
  for (const raw of input.files) {
    const filePath = normalizeReportFilePath(raw);
    if (filePath === null) {
      input.log(
        `review-pi: MCP mrReviewResult${input.label} 跳过文件（filePath 非法：${JSON.stringify(raw)}）\n`,
      );
      continue;
    }
    if (seen.has(filePath) || input.exclude?.has(filePath) === true) {
      continue;
    }
    // 注意：`exclude` 与 `attempted` 在调用方常是同一个 Set（本片尝试集合），
    // 因此必须先过排除判断再登记，否则刚加入的路径会把自己排除掉。
    seen.add(filePath);
    input.attempted?.add(filePath);
    const result = await input.reportFileResult({
      taskId: input.taskId,
      filePath,
      reviewTips: [] as readonly AgentReviewTip[],
    });
    if (result.ok) {
      sent += 1;
      input.reportedFiles.push(filePath);
    } else {
      input.log(
        `review-pi: MCP mrReviewResult${input.label} ${filePath} 失败（${result.reason}）\n`,
      );
    }
  }
  return sent;
}
