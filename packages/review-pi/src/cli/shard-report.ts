import type { Finding } from "../contracts/finding.js";
import {
  normalizeReportFilePath,
  type McpReporter,
} from "../mcp/index.js";
import { findingMergeKey } from "../run/findings-merge.js";
import { isSeverityBelow } from "../shared/severity-filter.js";
import { isConfidenceBelow } from "../shared/tips-filter.js";
import { readCodeLines } from "./code-lines.js";
import { buildShardReport, type SemanticTipEntry } from "./report-payload.js";
import { describeReportFailure } from "./report-failure.js";
import { reportFilesWithoutTips } from "./report-files.js";

/**
 * 片级上报编排（ADR-0045 / ADR-0056 / ADR-0061）：该片 findings 定型 → 读源码行 →
 * 统一生成调用 → 逐文件 `mrReviewResult` + 语义登记入 run 级集合（tips 复用）。
 * **绝不抛错**（旁路纪律的最外层闸）：任何失败只落 stderr，检视与退出码不受影响。
 * 覆盖率优先（ADR-0061）：本片 diff 触及的**每个文件**都必须在
 * `saveReviewSummary` 前拿到一条 `mrReviewResult`——无可发 tips 时发
 * `reviewTips: []`；即使该文件有 finding 但片级报文生成失败，也按空列表上报
 * （宁可少报意见，绝不留「未检视」空洞）。
 */
export async function reportShardFindings(input: {
  readonly label: { readonly index: number; readonly total: number };
  readonly findings: readonly Finding[];
  /** 该片 diff 触碰的文件（repo 相对路径）：没有意见的文件也要按文件上报 */
  readonly files: readonly string[];
  readonly taskId: string;
  readonly repoPath: string;
  readonly reporter: McpReporter;
  /** 跨片累积已上报文件（收尾总结的 reportedFiles 输入；按片序追加） */
  readonly reportedFiles: string[];
  /**
   * 跨片累积「平台最终收到的意见」（键 = 合并键；ADR-0057）。只在
   * `reportFileResult` 成功、且该条 tip 确实进入报文时登记——收尾总结按此
   * 裁剪口径，与平台明细一致。
   */
  readonly submittedFindingKeys: Set<string>;
  /** 语义登记的 run 级并集（键 = 合并键；首见优先——tips 复用的数据面） */
  readonly semanticByMergeKey: Map<string, SemanticTipEntry>;
  /** 未覆盖原因的 run 级并集（键 = 合并键；首见优先——stderr 逐条留痕用） */
  readonly uncoveredReasonByMergeKey: Map<string, string>;
  /** 中文 tips 置信度过滤阈值（ADR-0052）：先过滤再组装 */
  readonly confidenceMin: number;
  /** 中文 tips / MCP 上报严重级过滤阈值：先过滤再组装 */
  readonly severityMin: Finding["severity"];
}): Promise<void> {
  const label = input.label.total > 1 ? ` [s${pad2(input.label.index)}/${pad2(input.label.total)}]` : "";
  let keptFindings: readonly Finding[] = [];
  // 本片已经尝试过上报的文件（规范化路径）：广播 tips 与空包都按它去重，保证
  // 每个文件只发一条 mrReviewResult（ADR-0061）。
  const attempted = new Set<string>();
  const markUncovered = (findings: readonly Finding[], reason: string): void => {
    for (const finding of findings) {
      const key = findingMergeKey(finding);
      if (!input.uncoveredReasonByMergeKey.has(key)) {
        input.uncoveredReasonByMergeKey.set(key, reason);
      }
    }
  };
  /** 本片剩余文件补空包（ADR-0061）：`attempted` 里的文件已经有过一次上报尝试。 */
  const reportRemainingFiles = async (): Promise<number> =>
    reportFilesWithoutTips({
      label,
      taskId: input.taskId,
      reportFileResult: (args) => input.reporter.task.reportFileResult(args),
      files: input.files,
      reportedFiles: input.reportedFiles,
      exclude: attempted,
      attempted,
      log: (line) => process.stderr.write(line),
    });
  try {
    // ADR-0052：置信度过滤先于报文组装——被丢弃的意见不进报文。
    // 严重级过滤同口径（只裁中文 tips / MCP 上报，findings 恒全量）。
    keptFindings = input.findings.filter(
      (finding) =>
        !isConfidenceBelow(finding.confidence, input.confidenceMin) &&
        !isSeverityBelow(finding.severity, input.severityMin),
    );
    if (keptFindings.length === 0) {
      // 零 finding（本来就无）或全部被置信度 / 严重级过滤：本片所有文件都没有可发的
      // 中文意见，按文件逐个上报空 tips（ADR-0056 / ADR-0061）。这两类过滤只
      // 决定「产不产中文意见」，不改变「文件已被检视」这一事实——平台需要每个
      // 文件都有一次登记，否则「检视过、没意见」与「从未检视」在远端无法区分。
      const sent = await reportRemainingFiles();
      if (sent > 0) {
        process.stderr.write(
          `review-pi: MCP mrReviewResult${label} 已上报 ${String(sent)} 文件 / 0 条意见\n`,
        );
      } else if (input.files.length === 0) {
        // 零静默：本片拿不到任何文件路径（空 diff / 预过滤后无残留），
        // 没有「已检视」可登记——留一行原因，避免事后误判成调用链断了。
        process.stderr.write(
          `review-pi: MCP mrReviewResult${label} 无可上报文件（本片 diff 未解析出文件路径）\n`,
        );
      }
      return;
    }
    const codeByFinding = await readCodeLines(input.repoPath, keptFindings);
    // ADR-0090：报文为纯确定性组装（语义字段来自 Finding.tips），无模型调用。
    const outcome = buildShardReport({
      findings: keptFindings,
      codeByFinding,
    });
    if (outcome.kind === "failed") {
      // 纯组装不会失败；防御分支保持覆盖率兜底语义。
      markUncovered(keptFindings, `片级报文组装失败：${outcome.reason}`);
      const sent = await reportRemainingFiles();
      if (sent > 0) {
        process.stderr.write(
          `review-pi: MCP mrReviewResult${label} 已上报 ${String(sent)} 文件 / 0 条意见（报文组装失败，全部补空）\n`,
        );
      }
      return;
    }
    // 语义登记并入 run 级集合（首见优先：跨片同合并键 = 同一问题的重复条目）
    for (const [key, entry] of outcome.semanticByKey) {
      if (!input.semanticByMergeKey.has(key)) {
        input.semanticByMergeKey.set(key, entry);
      }
    }
    // 逐条被拒的具体原因（tips 缺失等）——与 uncovered 逐条对齐
    for (const [key, reason] of outcome.uncoveredByKey) {
      if (!input.uncoveredReasonByMergeKey.has(key)) {
        input.uncoveredReasonByMergeKey.set(key, reason);
      }
    }
    for (const problem of outcome.skippedFiles) {
      process.stderr.write(`review-pi: MCP mrReviewResult${label} 跳过文件组（${problem}）\n`);
    }
    for (const problem of outcome.skippedTips) {
      process.stderr.write(`review-pi: MCP mrReviewResult${label} 跳过单条意见（${problem}）\n`);
    }
    for (const problem of outcome.degradedTips) {
      process.stderr.write(`review-pi: MCP mrReviewResult${label} 意见字段降级（${problem}）\n`);
    }
    let sent = 0;
    let tips = 0;
    for (const file of outcome.files) {
      const normalized = normalizeReportFilePath(file.filePath);
      if (normalized !== null) {
        attempted.add(normalized);
      }
      const result = await input.reporter.task.reportFileResult({
        taskId: input.taskId,
        filePath: file.filePath,
        reviewTips: file.reviewTips,
      });
      if (result.ok) {
        sent += 1;
        tips += file.reviewTips.length;
        input.reportedFiles.push(file.filePath);
        // 只有真的发出去的意见才进入「已上报集合」（ADR-0057）：上报失败 /
        // 结构校验跳过的条目不登记，收尾总结不会提及平台没收到的内容。
        for (const finding of file.findings) {
          input.submittedFindingKeys.add(findingMergeKey(finding));
        }
      } else {
        process.stderr.write(
          `review-pi: MCP mrReviewResult${label} ${file.filePath} 失败（${result.reason}）\n`,
        );
      }
    }
    // 本片其余文件补空包（ADR-0061 覆盖率优先）：排除面只剩「已经有过一次上报
    // 尝试」的文件。有 finding 但 tips 全被校验跳过 / 上报失败的文件也在
    // `attempted` 里已有登记，不重复；从未出现在报文里的文件一律补 `[]`。
    sent += await reportRemainingFiles();
    if (sent > 0) {
      process.stderr.write(
        `review-pi: MCP mrReviewResult${label} 已上报 ${String(sent)} 文件 / ${String(tips)} 条意见\n`,
      );
    }
  } catch (error) {
    // 旁路（ADR-0045 决策 3）：绝不把上报失败变成检视失败；具体原因已在上面逐行留痕。
    // 未走完编排的条目补一条兜底原因，避免聚合侧只剩「原因未知」。
    markUncovered(
      keptFindings,
      `上报编排异常：${describeReportFailure(error)}`,
    );
    // 覆盖率兜底（ADR-0061）：编排异常也不能让剩余文件失去「已检视」登记。
    try {
      const sent = await reportRemainingFiles();
      if (sent > 0) {
        process.stderr.write(
          `review-pi: MCP mrReviewResult${label} 已补报 ${String(sent)} 文件 / 0 条意见（编排异常兜底）\n`,
        );
      }
    } catch (fallbackError) {
      process.stderr.write(
        `review-pi: MCP mrReviewResult${label} 兜底补报失败（${describeReportFailure(fallbackError)}）\n`,
      );
    }
  }
}

/** 片号两位化（与分片目录名 sNN 同形） */
function pad2(value: number): string {
  return value < 10 ? `0${String(value)}` : String(value);
}
