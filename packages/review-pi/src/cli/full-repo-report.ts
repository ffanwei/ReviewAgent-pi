import type { FullRepoLifecycle } from "../mcp/full-repo-lifecycle.js";
import { normalizeReportFilePath } from "../mcp/task-tools.js";
import type { RepoReviewedBatch } from "../repo-spike/types.js";
import { readCodeLines } from "./code-lines.js";
import { describeReportFailure } from "./report-failure.js";
import { reportFilesWithoutTips } from "./report-files.js";
import { buildShardReport } from "./report-payload.js";
import { formatTipReview, formatTipSuggestion } from "./tip-format.js";

/**
 * 一个全仓检视批次（组）的上报编排（ADR-0117）。
 *
 * 口径与 PR 的 `mrReviewResult` 一致：
 * - 有意见的文件：`Finding.tips` → 8 字段 tip（`buildShardReport` 纯组装），
 *   源码行按 `--repo` + 真实行号读取，读不到就跳过该条（绝不编）；
 * - 组内其余送检文件：补一条 `reviewTips: []`（平台据此知道「已看过、无问题」）；
 * - 任何失败只留 stderr 一行，绝不影响检视结果与退出码。
 *
 * 只上报本组实际送检的文件（`batch.files`）；组内被跳过的文件（超大 / 不可读）
 * 不在这里冒充「已检视」。
 */
export async function reportFullRepoBatch(input: {
  readonly taskId: string;
  readonly repoPath: string;
  readonly batch: RepoReviewedBatch;
  readonly lifecycle: FullRepoLifecycle;
  readonly log: (line: string) => void;
}): Promise<void> {
  const { batch, lifecycle, log } = input;
  const batchLabel = `（批次 ${String(batch.index)} ${batch.key}）`;
  try {
    const codeByFinding = await readCodeLines(input.repoPath, batch.findings);
    const outcome = buildShardReport({
      findings: batch.findings,
      codeByFinding,
    });

    const attempted = new Set<string>();
    let sent = 0;
    let tips = 0;

    if (outcome.kind === "ok") {
      for (const problem of outcome.skippedFiles) {
        log(`review-pi: MCP fullRepoReportReviewResult${batchLabel} 跳过文件组（${problem}）\n`);
      }
      for (const problem of outcome.skippedTips) {
        log(`review-pi: MCP fullRepoReportReviewResult${batchLabel} 跳过单条意见（${problem}）\n`);
      }
      for (const problem of outcome.degradedTips) {
        log(`review-pi: MCP fullRepoReportReviewResult${batchLabel} 意见字段降级（${problem}）\n`);
      }
      for (const file of outcome.files) {
        const normalized = normalizeReportFilePath(file.filePath);
        if (normalized !== null) {
          attempted.add(normalized);
        }
        // 与 PR 输出面同一套 Markdown 断段（只改展示，不改语义）。
        const reviewTips = file.reviewTips.map((tip) => ({
          ...tip,
          review: formatTipReview(tip.review),
          suggestion: formatTipSuggestion(tip.suggestion),
        }));
        const result = await input.lifecycle.reportFile({
          filePath: file.filePath,
          reviewTips,
        });
        if (!result.ok) {
          log(
            `review-pi: MCP fullRepoReportReviewResult ${file.filePath} 失败（${result.reason}）\n`,
          );
        } else {
          sent += 1;
          tips += reviewTips.length;
        }
      }
    }

    // 覆盖率优先：本组其余送检文件补空包（已尝试过的文件不重复）。
    const emptySent = await reportFilesWithoutTips({
      label: batchLabel,
      toolLabel: "fullRepoReportReviewResult",
      taskId: input.taskId,
      files: batch.files,
      reportedFiles: [],
      exclude: attempted,
      attempted,
      log,
      reportFileResult: (args) =>
        lifecycle.reportFile({ filePath: args.filePath, reviewTips: args.reviewTips }),
    });

    if (sent + emptySent > 0 || tips > 0) {
      log(
        `review-pi: MCP fullRepoReportReviewResult${batchLabel} 已上报 ${String(
          sent + emptySent,
        )} 文件 / ${String(tips)} 条意见${emptySent > 0 ? `（补空 ${String(emptySent)}）` : ""}\n`,
      );
    }
  } catch (error) {
    log(
      `review-pi: MCP fullRepoReportReviewResult${batchLabel} 上报异常（${describeReportFailure(
        error,
      )}），继续检视\n`,
    );
  }
}
