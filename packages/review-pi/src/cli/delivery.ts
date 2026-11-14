import { dirname, resolve } from "node:path";

import { calculateCost } from "@earendil-works/pi-ai";

import type { Finding } from "../contracts/finding.js";
import type { McpReportStats } from "../contracts/mcp-report.js";
import type { TaskCallResult } from "../contracts/mcp-task.js";
import type { ModelFallbackRecord, PhaseRecord } from "../contracts/run.js";
import { runDirPath } from "../experiment/run-record.js";
import { SESSION_INDEX_VERSION, writeSessionIndex } from "../export/session-index.js";
import {
  writeLifecycleSessions,
  type LifecycleEvent,
} from "../export/lifecycle.js";
import { writeRunTrace } from "../export/trace-export.js";
import { PHASE_ORDER } from "../loop/phases.js";
import type {
  MrReviewResultArgs,
  SaveReviewSummaryArgs,
} from "../mcp/task-tools.js";
import { reviewModelOf } from "../provider/pi-client.js";
import { llmUsageToPiUsage } from "../provider/usage-map.js";
import { findingMergeKey } from "../run/findings-merge.js";
import { formatMrFilterNotice } from "../run/mr-input.js";
import type { SettledTaskResult } from "../mcp/task-lifecycle.js";
import type { ReviewRunResult, ReviewSkip } from "../run/review-run.js";
import { formatShardTruncationNotice } from "../run/shard-planner.js";
import { readCodeLines } from "./code-lines.js";
import { planCoverageReport } from "./coverage.js";
import { writeMcpCallLog, type McpCallLogDocument } from "./mcp-call-log.js";
import { reportFilesWithoutTips } from "./report-files.js";
import { doneLine, type ProgressSummary } from "./progress-render.js";
import { renderJsonDocument, renderReviewOutcome } from "./render.js";
import type { ShardReportRun, SemanticTipEntry } from "./report-payload.js";
import { describeReportFailure } from "./report-failure.js";
import {
  DIFF_TOO_LARGE_SUMMARY_MARKDOWN,
  NO_REVIEWABLE_FILES_SUMMARY_MARKDOWN,
  type ReviewSummaryInput,
  type ReviewSummaryResult,
} from "./review-summary.js";
import {
  removeExecDirTipsCopies,
  removeStaleReviewsTipsZh,
  writeExecDirTipsCopies,
  writeReviewsTipsZh,
  type ExecDirTipsOutcome,
} from "./reviews-tips-zh.js";
import { removeStaleReviewsZh } from "./reviews-zh.js";
import type { ReviewTipsDocumentLike } from "./presentation-projection.js";
import { assembleUnifiedTips, countTips, filterFindingsForTips } from "./unified-tips.js";

/**
 * CLI 交付 module（ADR-0081）：`runReview` 返回之后的唯一收尾链。
 *
 * 顺序不变量（接口的一部分，调用方与测试共享）：
 *
 * 1. 覆盖补报（变更文件全集 − 已上报）先于总结；
 * 2. 收尾摘要行先于 tips 组装；
 * 3. tips 组装/落盘先于总结；
 * 4. tips 落盘失败只记录（`deferredFailure`），总结照常；
 * 5. 总结前固定沉降，`saveReviewSummary` 在沉降之后；
 * 6. stdout 文档只返回，不写；session 索引与 finalize 由 `main` 负责。
 *
 * 纯结构迁移（ADR-0081）：CLI 参数、stdout 字节、退出码、stderr 行序与文案、
 * 产物格式、MCP 调用序列均不变。
 */

/** 业务 tool 调用结果（契约来源 `contracts/mcp-task.ts`） */
export type DeliveryTaskResult = TaskCallResult;

/** 生命周期 facade 的结构子集（ADR-0086）：交付只依赖这四项 */
export interface DeliveryTaskPort {
  readonly started: boolean;
  reportFile(args: Omit<MrReviewResultArgs, "taskId">): Promise<DeliveryTaskResult>;
  saveSummary(
    args: Omit<SaveReviewSummaryArgs, "taskId">,
    options?: { readonly settleBefore?: boolean },
  ): Promise<SettledTaskResult>;
  finish(): Promise<SettledTaskResult>;
}

/** 事件通道：flush / close 与业务生命周期分开 */
export interface DeliveryEventsPort {
  flush(timeoutMs: number): Promise<McpReportStats>;
  close(): Promise<void>;
}

/** 一次性模型调用的两处用途（报文生成 / 收尾总结）；生产侧闭合 runtime */
export interface DeliveryOneShotPort {
  generateTips(input: {
    readonly findings: readonly Finding[];
    readonly codeByFinding: Readonly<Record<string, string>>;
  }): Promise<ShardReportRun>;
  generateSummary(
    input: Omit<ReviewSummaryInput, "runtime" | "fetch">,
  ): Promise<ReviewSummaryResult>;
}

/** 时钟缝：`sleep` 让沉降在 module 测试里可断言且不真等 5 秒 */
export interface DeliveryClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** 进度渲染器的收尾口（`main` 持有渲染器，交付只调用 finish） */
export interface DeliveryProgressPort {
  finish(summary: ProgressSummary): void;
}

export interface DeliveryInput {
  /** run 半边：现有域契约（record / runId / auditPath / reviewsPath / transcriptPaths / mrFilter …） */
  readonly run: ReviewRunResult;
  readonly identity: {
    readonly caseId: string;
    readonly taskId: string;
    /** 进程 cwd（`reviews_tips_zh.json` 执行目录副本与 session 索引的落点） */
    readonly cwd: string;
  };
  readonly paths: {
    /** 任务目录根（session 索引的 tasksDir） */
    readonly tasksRoot: string;
    /** 本次 run 的输出根（`<runs>`，索引与留痕寻址） */
    readonly runsRoot: string;
  };
  /** `--repo` 工作树：按 finding 位置抽源码行 */
  readonly repoPath: string;
  /** 过滤前变更文件全集（ADR-0068：被预过滤剔除的文件也要补报空 tips） */
  readonly coverageFiles: readonly string[];
  readonly model: {
    readonly modelId: string;
    readonly baseUrl: string;
  };
  readonly limits: {
    readonly confidenceMin: number;
    readonly severityMin: Finding["severity"];
  };
  readonly mcp: {
    /** `undefined` = 业务上报关闭（覆盖补报 / 总结都不调用） */
    readonly task?: DeliveryTaskPort;
    /** 事件通道（flush / close）；与业务开关独立 */
    readonly events?: DeliveryEventsPort;
    /** 平台最终收到的 finding（键 = 合并键；ADR-0057 总结裁剪口径） */
    readonly submittedFindingKeys: ReadonlySet<string>;
    /** 跨片累积已上报文件（可变：覆盖补报会把新文件追加进来） */
    readonly reportedFiles: string[];
    readonly flushTimeoutMs: number;
  };
  readonly tips: {
    /** 片级语义登记（业务关闭时由本 module 补写） */
    readonly semanticByMergeKey: Map<string, SemanticTipEntry>;
    /** 未覆盖原因（同上） */
    readonly uncoveredReasonByMergeKey: Map<string, string>;
  };
  readonly timing: {
    /** run 开始时刻（收尾摘要的 durationMs 基准） */
    readonly startedAt: number;
  };
  readonly modelFallback?: ModelFallbackRecord;
  readonly ports: {
    readonly oneShot: DeliveryOneShotPort;
    readonly clock: DeliveryClock;
    /** stderr 行（含换行；生产 = `process.stderr.write`） */
    readonly log: (line: string) => void;
    /** 未注入 = 进度关闭，交付走 `doneLine` 的 stderr 分支 */
    readonly progress?: DeliveryProgressPort;
  };
}

export interface DeliveryTimings {
  readonly coverageMs: number;
  readonly tipsMs: number;
  readonly summaryMs: number;
  readonly settleMs: number;
  readonly totalMs: number;
}

export interface DeliveryOutcome {
  /** 由 `main` 写到 stdout（交付不碰进程出口） */
  readonly stdoutDocument: string;
  readonly timings: DeliveryTimings;
  /** tips 落盘失败：`main` 跳过 session 索引与 stdout，随后以该错误退出 */
  readonly deferredFailure?: unknown;
}

export interface SkipDeliveryInput {
  readonly identity: { readonly caseId: string; readonly taskId: string };
  readonly skip: ReviewSkip;
  /** 原始变更文件的首个（与既有跳过上报口径一致） */
  readonly firstFile?: string;
  readonly task?: DeliveryTaskPort;
  /** 已上报文件账本（补报会追加；跳过后进程结束，不再读取） */
  readonly reportedFiles: string[];
  readonly log: (line: string) => void;
}

export interface SkipDeliveryOutcome {
  readonly stdoutDocument: string;
}

/**
 * 跳过交付（ADR-0075 / ADR-0078 / ADR-0081）：固定总结 + 首个文件空 tips +
 * 单 JSON stdout 文档。不写 audit / run.json，不发进度事件。
 */
export async function deliverSkip(input: SkipDeliveryInput): Promise<SkipDeliveryOutcome> {
  const { log } = input;
  const task = input.task;
  if (task !== undefined && task.started) {
    if (input.firstFile !== undefined) {
      await reportFilesWithoutTips({
        label: "",
        taskId: input.identity.taskId,
        reportFileResult: (args) =>
          task.reportFile({ filePath: args.filePath, reviewTips: args.reviewTips }),
        files: [input.firstFile],
        reportedFiles: input.reportedFiles,
        log,
      });
    }
    const markdownContent =
      input.skip.reason === "diff-too-large"
        ? DIFF_TOO_LARGE_SUMMARY_MARKDOWN
        : NO_REVIEWABLE_FILES_SUMMARY_MARKDOWN;
    const outcome = await task.saveSummary(
      { markdownContent },
      { settleBefore: false },
    );
    if (!outcome.ok) {
      log(`review-pi: MCP saveReviewSummary 失败（${outcome.reason}）\n`);
    }
  }
  return {
    stdoutDocument: renderJsonDocument({
      ok: true,
      caseId: input.identity.caseId,
      skipped: input.skip.reason,
      findings: [],
    }),
  };
}

export async function deliverReviewRun(input: DeliveryInput): Promise<DeliveryOutcome> {
  const { clock } = input.ports;
  const startedAt = clock.now();
  const timings = { coverageMs: 0, tipsMs: 0, summaryMs: 0, settleMs: 0, totalMs: 0 };

  announceInput(input);

  const coverageStartedAt = clock.now();
  await reportMissingFiles(input);
  timings.coverageMs = clock.now() - coverageStartedAt;

  finishRunLine(input);

  const assemblyStartedAt = clock.now();
  const assembly = await assembleTips(input);
  timings.tipsMs += clock.now() - assemblyStartedAt;
  logFilterDrops(input, assembly);

  const persistStartedAt = clock.now();
  const deferredFailure = await persistTips(input, assembly.tipsDoc);
  timings.tipsMs += clock.now() - persistStartedAt;

  const summaryTiming = await publishSummary(input, assembly.tipsDoc);
  timings.summaryMs = summaryTiming.summaryMs;
  timings.settleMs = summaryTiming.settleMs;

  // tips 落盘失败 = 本次运行失败：跳过索引与 stdout（ADR-0045 决策 2 修订）。
  if (deferredFailure === undefined) {
    await persistSessionIndex(input);
  }

  const stdoutDocument = buildStdoutDocument(input);
  timings.totalMs = clock.now() - startedAt;

  return {
    stdoutDocument,
    timings,
    ...(deferredFailure !== undefined ? { deferredFailure } : {}),
  };
}

/** run 结束后的三行输入留痕（规则包为空 / 预过滤 / 单文件截取） */
function announceInput(input: DeliveryInput): void {
  const { log } = input.ports;
  const audit = input.run.record.baseline.audit;
  if ((audit.ruleSkill ?? []).length === 0) {
    log(
      "review-pi: 未装载任何规则包（--rule-skill-zip / --rule-skill / --skill 未传或缺值；ADR-0027 后不再扫描仓库内 .review-rules/），照常检视\n",
    );
  }
  if (input.run.mrFilter !== undefined && input.run.mrFilter.droppedFiles > 0) {
    log(`review-pi: ${formatMrFilterNotice(input.run.mrFilter)}\n`);
  }
  if (input.run.shardTruncation !== undefined) {
    log(`review-pi: ${formatShardTruncationNotice(input.run.shardTruncation)}\n`);
  }
}

/** 覆盖补报：变更文件全集 − 已上报（ADR-0061 / ADR-0068）；失败只留痕 */
async function reportMissingFiles(input: DeliveryInput): Promise<void> {
  const task = input.mcp.task;
  if (task === undefined || input.coverageFiles.length === 0) {
    return;
  }
  const { log } = input.ports;
  try {
    const coverage = planCoverageReport(input.coverageFiles, input.mcp.reportedFiles);
    const sent = await reportFilesWithoutTips({
      label: "",
      taskId: input.identity.taskId,
      reportFileResult: (args) =>
        task.reportFile({ filePath: args.filePath, reviewTips: args.reviewTips }),
      files: coverage.files,
      reportedFiles: input.mcp.reportedFiles,
      exclude: coverage.reported,
      log,
    });
    if (sent > 0) {
      log(
        `review-pi: MCP mrReviewResult 已补报 ${String(sent)} 个变更文件 / 0 条意见` +
          "（预过滤剔除或未进入检视）\n",
      );
    }
  } catch (error) {
    log(`review-pi: MCP mrReviewResult 补报变更文件失败（${describeReportFailure(error)}）\n`);
  }
}

/** 收尾摘要 + 解析失败行（进度关闭时 `doneLine` 仍恒打一行） */
function finishRunLine(input: DeliveryInput): void {
  const summary = buildRunSummary(input);
  if (input.ports.progress !== undefined) {
    input.ports.progress.finish(summary);
  } else {
    input.ports.log(`${doneLine(summary)}\n`);
  }
  reportPhaseParseFailures(input.run.record.baseline.audit.phaseLog, input.ports.log);
}

interface TipsAssembly {
  readonly tipsDoc: ReviewTipsDocumentLike | undefined;
  readonly droppedByConfidence: number;
  readonly droppedBySeverity: number;
  readonly minConfidence: number;
  readonly minSeverity: Finding["severity"];
}

/**
 * 中文 tips 的取数与组装（ADR-0045 / ADR-0052 / ADR-0065）：
 * 过滤 → （业务关闭时）补一次语义生成 → 统一组装 → 选源。
 */
async function assembleTips(input: DeliveryInput): Promise<TipsAssembly> {
  const { log } = input.ports;
  const { record } = input.run;
  const minConfidence = input.limits.confidenceMin;
  const minSeverity = input.limits.severityMin;
  const eligible = filterFindingsForTips(record.baseline.findings, {
    minConfidence,
    minSeverity,
  });
  const keptFindings = eligible.kept;
  const allFindingsFiltered =
    record.baseline.findings.length > 0 && keptFindings.length === 0;
  const codeByFinding = await readCodeLines(input.repoPath, record.baseline.findings);

  // 业务关闭（无 MCP 上报）时中文 tips 也必须产出：收尾补一次片级语义生成，
  // 只登记语义（不发报文）。业务开启时各片已在回调里跑过，这里零额外调用。
  if (input.mcp.task === undefined && keptFindings.length > 0) {
    const { outcome, split } = await input.ports.oneShot.generateTips({
      findings: keptFindings,
      codeByFinding,
    });
    if (split !== undefined) {
      log(
        `review-pi: 中文 tips 语义生成失败，已拆分为 ${String(split.batches)} 批重试` +
          `（${String(split.succeeded)} 批成功）\n`,
      );
    }
    if (outcome.kind === "failed") {
      log(`review-pi: 中文 tips 语义生成失败（${outcome.reason}），本次不产分组意见\n`);
      for (const finding of keptFindings) {
        const key = findingMergeKey(finding);
        if (!input.tips.uncoveredReasonByMergeKey.has(key)) {
          input.tips.uncoveredReasonByMergeKey.set(key, `片级语义生成失败：${outcome.reason}`);
        }
      }
    } else {
      for (const [key, entry] of outcome.semanticByKey) {
        if (!input.tips.semanticByMergeKey.has(key)) {
          input.tips.semanticByMergeKey.set(key, entry);
        }
      }
      for (const [key, reason] of outcome.uncoveredByKey) {
        if (!input.tips.uncoveredReasonByMergeKey.has(key)) {
          input.tips.uncoveredReasonByMergeKey.set(key, reason);
        }
      }
    }
  }

  const unifiedTips = assembleUnifiedTips({
    mergedFindings: record.baseline.findings,
    semanticByMergeKey: input.tips.semanticByMergeKey,
    codeByFinding,
    minConfidence,
    minSeverity,
    uncoveredReasonByMergeKey: input.tips.uncoveredReasonByMergeKey,
  });
  for (const missed of unifiedTips.uncovered) {
    log(
      `review-pi: 检视意见未获统一生成覆盖（${missed.label}），tips 缺席该条：${missed.reason}\n`,
    );
  }

  // tips 选源（ADR-0065）：统一生成为唯一真源。
  // - 有产出 ⇒ 落盘；- 零 findings / 全部被过滤 ⇒ 产 `[]`；
  // - 有 finding 但零覆盖 ⇒ 不产文件并清陈旧。
  let tipsDoc: ReviewTipsDocumentLike | undefined;
  if (countTips(unifiedTips.tips) > 0) {
    tipsDoc = unifiedTips.tips;
  } else if (record.baseline.findings.length === 0 || allFindingsFiltered) {
    tipsDoc = [];
  } else {
    log("review-pi: 统一生成未覆盖任何意见，本次不产分组意见（不回落英文引擎）\n");
  }

  return {
    tipsDoc,
    droppedByConfidence: eligible.droppedByConfidence,
    droppedBySeverity: eligible.droppedBySeverity,
    minConfidence,
    minSeverity,
  };
}

/** 过滤留痕（零静默）：只在真的丢了条数时打一行汇总 */
function logFilterDrops(input: DeliveryInput, assembly: TipsAssembly): void {
  const { log } = input.ports;
  if (assembly.droppedByConfidence > 0) {
    log(
      `review-pi: 置信度过滤丢弃 ${String(assembly.droppedByConfidence)} 条检视意见` +
        `（阈值 ${String(assembly.minConfidence)}），仅影响中文 tips\n`,
    );
  }
  if (assembly.droppedBySeverity > 0) {
    log(
      `review-pi: 严重级过滤丢弃 ${String(assembly.droppedBySeverity)} 条检视意见` +
        `（阈值 ${String(assembly.minSeverity)}），仅影响中文 tips 与 MCP 上报\n`,
    );
  }
}

/**
 * 中文产物落盘：`reviews_tips_zh.json` + cwd 副本；失败只记下（deferred），
 * 不阻断后续总结与 finalize。
 */
async function persistTips(
  input: DeliveryInput,
  tipsDoc: ReviewTipsDocumentLike | undefined,
): Promise<unknown> {
  const { log } = input.ports;
  let failure: unknown;
  try {
    const reviewsPath = input.run.reviewsPath;
    if (reviewsPath !== undefined) {
      const removed = await removeStaleReviewsZh(dirname(reviewsPath));
      if (removed !== undefined) {
        log(
          `review-pi: 本次不产 reviews_zh.json（中文产物 = reviews_tips_zh.json），` +
            `已清除陈旧 ${removed}\n`,
        );
      }
    }
    if (reviewsPath !== undefined) {
      const tipsDir = dirname(reviewsPath);
      if (tipsDoc !== undefined) {
        await writeReviewsTipsZh(tipsDir, tipsDoc);
        reportExecDirTips(await writeExecDirTipsCopies(tipsDoc, input.identity.cwd), "写入", log);
      } else {
        const removed = await removeStaleReviewsTipsZh(tipsDir);
        if (removed !== undefined) {
          log(`review-pi: 已清除陈旧 ${removed}\n`);
        }
        reportExecDirTips(await removeExecDirTipsCopies(input.identity.cwd), "清除", log);
      }
    }
  } catch (error) {
    failure = error;
    const message = error instanceof Error ? error.message : String(error);
    log(
      `review-pi: 中文产物落盘失败（${message}）；仍上报检视总结与 endTask，随后以失败退出\n`,
    );
  }
  return failure;
}

/** 收尾总结：按「平台实际收到」口径裁剪 → 生成 → 沉降 → `saveReviewSummary` */
async function publishSummary(
  input: DeliveryInput,
  tipsDoc: ReviewTipsDocumentLike | undefined,
): Promise<{ readonly summaryMs: number; readonly settleMs: number }> {
  const task = input.mcp.task;
  if (task === undefined) {
    return { summaryMs: 0, settleMs: 0 };
  }
  const { log, clock } = input.ports;
  const { record } = input.run;
  const submittedSourceIds = new Set(
    record.baseline.findings
      .filter((finding) => input.mcp.submittedFindingKeys.has(findingMergeKey(finding)))
      .map((finding) => finding.id),
  );
  const summaryFindings = record.baseline.findings.filter((finding) =>
    submittedSourceIds.has(finding.id),
  );
  const summaryTips =
    tipsDoc === undefined
      ? undefined
      : tipsDoc
          .map((file) => ({
            ...file,
            reviewTips: file.reviewTips.filter(
              (tip) => tip.id !== undefined && submittedSourceIds.has(tip.id),
            ),
          }))
          .filter((file) => file.reviewTips.length > 0);
  const unreported = record.baseline.findings.length - summaryFindings.length;
  if (unreported > 0) {
    log(
      `review-pi: 检视总结只覆盖已上报的 ${String(summaryFindings.length)} 条意见` +
        `（${String(unreported)} 条未上报，未计入）\n`,
    );
  }
  log(
    record.baseline.findings.length === 0
      ? "review-pi: MCP saveReviewSummary 未发现检视意见，发送固定总结（不调用模型）\n"
      : summaryFindings.length === 0
        ? "review-pi: MCP saveReviewSummary 无已上报的检视意见，发送固定总结（不调用模型）\n"
        : "review-pi: MCP saveReviewSummary 生成中（检视总结）……\n",
  );

  const summaryStartedAt = clock.now();
  const summaryReport = await input.ports.oneShot.generateSummary({
    ...(summaryTips !== undefined && summaryTips.length > 0 ? { tips: summaryTips } : {}),
    findings: summaryFindings,
    ...(summaryFindings.length === 0 && unreported > 0
      ? { unreportedFindings: unreported }
      : {}),
    ...(input.mcp.reportedFiles.length > 0 ? { reportedFiles: [...input.mcp.reportedFiles] } : {}),
  });
  const summaryMs = clock.now() - summaryStartedAt;
  if (summaryReport.degradedReason !== undefined) {
    log(`review-pi: 检视总结降级为模板（${summaryReport.degradedReason}）\n`);
  }

  // 模型替换留痕（ADR-0080）：只在真发生降级时追加一行；固定模板总结不追加。
  const summaryMarkdown =
    input.modelFallback === undefined
      ? summaryReport.markdown
      : `${summaryReport.markdown}\n\n${modelFallbackMarkdownLine(input.modelFallback)}`;
  // 第一段沉降由 facade 拥有（ADR-0086）：正常路径先等，跳过路径不经过这里。
  const outcome = await task.saveSummary(
    { markdownContent: summaryMarkdown },
    { settleBefore: true },
  );
  if (!outcome.ok) {
    log(`review-pi: MCP saveReviewSummary 失败（${outcome.reason}），检视结果不受影响\n`);
  }
  return { summaryMs, settleMs: outcome.waitedMs };
}

/** cwd session 索引（ADR-0036 / ADR-0039 v2）：寻址信息，写失败只警告 */
async function persistSessionIndex(input: DeliveryInput): Promise<void> {
  const { log } = input.ports;
  const { record } = input.run;
  const sessionRunsDir = runDirPath(input.paths.runsRoot);
  const sessionSkills = (record.baseline.audit.skillPassLog ?? [])
    .map((entry) => entry.transcriptFile)
    .filter((file): file is string => typeof file === "string" && file.trim().length > 0)
    // 聚合 skillPassLog 的文件名可能是 runs 目录相对路径（分片：shards/attempt…/sNN/），
    // 旧形态是 basename——resolve 对两者都成立。
    .map((file) => resolve(sessionRunsDir, file));
  try {
    await writeSessionIndex(input.identity.cwd, {
      version: SESSION_INDEX_VERSION,
      taskId: input.identity.taskId,
      tasksDir: input.paths.tasksRoot,
      runId: input.run.runId,
      repo: input.repoPath,
      updatedAt: record.completedAt,
      mains: input.run.transcriptPaths,
      skills: sessionSkills,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(
      `review-pi: session 索引写入失败（${message}）；review-pi export 将读不到本次结果\n`,
    );
  }
}

/** stdout 文档（恒英文、单 JSON；由 main 写，交付只返回） */
function buildStdoutDocument(input: DeliveryInput): string {
  const { record } = input.run;
  return renderReviewOutcome({
    caseId: record.caseId,
    runId: input.run.runId,
    truncated: record.baseline.audit.truncated,
    rounds: record.baseline.rounds,
    toolCalls: record.baseline.toolCalls,
    findings: record.baseline.findings,
    auditPath: input.run.auditPath,
  });
}

/** 收尾摘要的数值面（与审计同源；成本用与转录同一份模型画像） */
function buildRunSummary(input: DeliveryInput): ProgressSummary {
  const { record } = input.run;
  const skillPassLog = record.baseline.audit.skillPassLog ?? [];
  const skillToolCalls = skillPassLog.reduce((sum, entry) => sum + entry.toolCallCount, 0);
  const usage = record.baseline.usage;
  const costUsd = calculateCost(
    reviewModelOf(input.model.modelId, input.model.baseUrl),
    llmUsageToPiUsage(usage),
  ).total;
  return {
    durationMs: input.ports.clock.now() - input.timing.startedAt,
    usage,
    costUsd,
    modelCalls: input.run.modelCalls,
    toolCalls: record.baseline.toolCalls,
    mainToolCalls: record.baseline.toolCalls - skillToolCalls,
    skillToolCalls,
    skillBashCalls: input.run.skillBashCalls,
    ledgerHits: input.run.ledgerHitCount,
  };
}

/** 阶段回复解析失败的 stderr 一行（成功 run 零输出） */
function reportPhaseParseFailures(
  phaseLog: readonly PhaseRecord[],
  log: (line: string) => void,
): void {
  for (const entry of phaseLog) {
    const failure = entry.parseFailure;
    if (failure === undefined) {
      continue;
    }
    const expected = failure.expected === "candidates" ? "候选" : "裁决";
    log(
      `review-pi: [r${String(entry.round)} ${phaseLabelOf(entry.phase)}] ` +
        `${expected}解析失败（${failure.kind}），本轮 0 ${expected}；详见审计 phaseLog\n`,
    );
  }
}

/** PhaseRecord.phase → `phaseN`（1-based）；未知名称回退为原名 */
function phaseLabelOf(phase: PhaseRecord["phase"]): string {
  const index = PHASE_ORDER.indexOf(phase);
  return index >= 0 ? `phase${String(index + 1)}` : phase;
}

/** 平台可见的替换说明（ADR-0080）：只在真发生降级时追加到模型生成的总结末尾 */
function modelFallbackMarkdownLine(record: ModelFallbackRecord): string {
  return (
    `> 模型降级说明：请求模型 \`${record.requested}\` 不可用（model not found），` +
    `本次检视实际使用 \`${record.used}\`。`
  );
}

/** 执行目录副本的失败留痕：cwd 可能只读，写/清失败只警告不改退出码 */
function reportExecDirTips(
  outcome: ExecDirTipsOutcome,
  action: string,
  log: (line: string) => void,
): void {
  for (const problem of outcome.problems) {
    log(`review-pi: 执行目录副本${action}失败（${problem}）\n`);
  }
}

export interface DeliveryFinalizeInput {
  readonly taskId: string;
  /** 本次 run 的输出根（mcp.json / lifecycle / trace 的落点） */
  readonly runsRoot: string;
  /** 生命周期 facade（started / finish 由它自己记） */
  readonly task?: DeliveryTaskPort;
  /** 事件通道（flush / close）；与业务 tool 开关独立 */
  readonly events?: DeliveryEventsPort;
  /** 事件通道是否配置（与业务 tool 开关独立） */
  readonly flushEnabled: boolean;
  readonly flushTimeoutMs: number;
  /** 业务调用留痕（`taskToolsOn && size > 0` 时由 main 传入；**惰性**取文档，
   * 保证 endTask 也被写进去——与既有「endTask 之后写」的顺序一致） */
  readonly mcpLog?: { readonly document: () => McpCallLogDocument };
  /** 会话生命周期 + trace 留痕（run 成功后才由 main 传入） */
  readonly lifecycle?: {
    readonly runId: string;
    readonly transcriptPaths: readonly string[];
    readonly events: readonly LifecycleEvent[];
    readonly title: string;
  };
  readonly log: (line: string) => void;
  readonly clock: DeliveryClock;
}

/**
 * 收尾 finalize（ADR-0081 第 9 步）：第二段沉降 → endTask → mcp.json →
 * lifecycle → trace → flush → close。**在所有路径上调用**（含 run 前失败），
 * 因此与 `deliverReviewRun` 分开：交付只覆盖 run 之后的阶段。
 *
 * 返回第二段沉降耗时，供 `main` 合并进阶段账本；账本打印与 sink 重置仍归 `main`。
 */
export async function finalizeDelivery(
  input: DeliveryFinalizeInput,
): Promise<{ readonly settleMs: number }> {
  const { log, clock } = input;
  let settleMs = 0;
  if (input.task !== undefined) {
    // 第二段沉降与 endTask 由 facade 拥有（ADR-0086）；幂等。
    const done = await input.task.finish();
    settleMs = done.waitedMs;
    if (!done.ok) {
      log(`review-pi: MCP endTask 失败（${done.reason}）\n`);
    }
  }
  // 业务调用留痕落盘（mcp.json）：endTask 之后写，四个调用的最终结果都在内存里。
  if (input.mcpLog !== undefined) {
    try {
      await writeMcpCallLog(runDirPath(input.runsRoot), input.mcpLog.document());
    } catch (error) {
      log(`review-pi: mcp.json 写入失败（${describeReportFailure(error)}），不影响检视结果\n`);
    }
  }
  // 会话生命周期留痕（ADR-0073）：startTask → 检视对话 → 外部步骤 → endTask。
  if (input.lifecycle !== undefined) {
    try {
      await writeLifecycleSessions({
        runsDir: runDirPath(input.runsRoot),
        runId: input.lifecycle.runId,
        transcriptPaths: input.lifecycle.transcriptPaths,
        events: input.lifecycle.events,
        title: input.lifecycle.title,
        finishedAt: clock.now(),
      });
    } catch (error) {
      log(
        `review-pi: 会话生命周期留痕写入失败（${describeReportFailure(error)}），不影响检视结果\n`,
      );
    }
    // opencode-trace 留痕（ADR-0074）：写失败只警告。
    try {
      await writeRunTrace(runDirPath(input.runsRoot), input.lifecycle.transcriptPaths);
    } catch (error) {
      log(`review-pi: trace 留痕写入失败（${describeReportFailure(error)}），不影响检视结果\n`);
    }
  }
  if (input.events !== undefined && input.flushEnabled) {
    // 收尾尽力发完；失败 / 超时都只落一行 stderr，不影响已产出的结果与退出码
    try {
      const stats = await input.events.flush(input.flushTimeoutMs);
      log(
        `review-pi: MCP 上报 sent ${String(stats.sent)} / failed ${String(stats.failed)} / dropped ${String(stats.dropped)}\n`,
      );
    } catch {
      // 旁路：连统计都拿不到也不改变任何结果
    }
  }
  await input.events?.close().catch(() => undefined);
  return { settleMs };
}
