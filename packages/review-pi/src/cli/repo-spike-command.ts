import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  createFullRepoLifecycle,
  createMcpReporter,
  resolveReportConfig,
  type FullRepoLifecycle,
  type McpReporter,
} from "../mcp/index.js";
import { resolveTaskToolSettleMs } from "../mcp/task-lifecycle.js";
import { resolveReviewerEndpoint } from "../provider/reviewer-endpoint.js";
import { runRepoSpike } from "../repo-spike/run.js";
import type { RepoReviewedBatch } from "../repo-spike/types.js";
import type { ResolvedConfig } from "../shared/config.js";
import { modelIdForGateway } from "../shared/config-schema.js";
import { resolveTasksRoot, taskDirPath } from "../shared/tasks-dir.js";
import { REVIEW_PI_VERSION } from "../shared/version.js";
import type { RepoSpikeCliArgs } from "./args.js";
import { reportFullRepoBatch } from "./full-repo-report.js";
import { describeReportFailure } from "./report-failure.js";
import { resolveRepoScanSettings } from "./repo-scan-settings.js";

/**
 * `repo-spike` 命令执行缝。
 *
 * - dry-run：不加载配置、不触模型，只做枚举/分组/合成 diff；
 * - 真跑：与 `review` 共用配置解析（reviewer 端点 + model.default），
 *   但运行入口是独立的 `runRepoSpike`，不进入 `prepareReview` 的准入分支；
 * - MCP（ADR-0117）：复用同一 server 配置，按
 *   `fullRepoStartTask → fullRepoReportReviewResult（每批） →
 *   fullRepoFilerCurrentTips → fullRepoEndTask` 上报。
 */
export async function runRepoSpikeCommand(
  args: RepoSpikeCliArgs,
  config?: ResolvedConfig,
): Promise<number> {
  const log = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  const onProgress =
    args.progress === false
      ? undefined
      : (line: string): void => {
          process.stderr.write(`${line}\n`);
        };

  // 落盘根（ADR-0033 同口径）：`--out` 只是显式覆盖；缺省
  // `<tasks 根>/<taskId>`，`--tasks-dir` 只覆盖根。
  const outDir =
    args.outDir !== undefined
      ? resolve(args.outDir)
      : taskDirPath(
          resolveTasksRoot({
            ...(args.tasksDir !== undefined ? { tasksDir: args.tasksDir } : {}),
          }),
          args.taskId,
        );
  // 非法正则已由参数层丢弃，这里逐条可见（零静默）。
  for (const item of args.ignoredPathFilterPatterns ?? []) {
    log(
      `review-pi: ${item.flag} ${JSON.stringify(item.pattern)} 不是合法正则，已忽略（${item.reason}）`,
    );
  }
  // `--model` 与 review 同策略（ADR-0093）：接受但忽略。
  if (args.ignoredModel !== undefined) {
    const passed =
      args.ignoredModel.raw !== undefined
        ? JSON.stringify(args.ignoredModel.raw)
        : "未带值";
    log(
      `review-pi: --model 已废弃并忽略（传入 ${passed}；全仓检视模型取配置文件 model.default）`,
    );
  }
  // 全仓扫描设置：CLI 显式旗标 > 配置 limits.repoScan > 内置缺省。
  const settings = resolveRepoScanSettings(args, config);
  const includeRegexes = settings.includeRegex.map((pattern) => new RegExp(pattern));
  const excludeRegexes = settings.excludeRegex.map((pattern) => new RegExp(pattern));

  const common = {
    repoPath: resolve(args.repo),
    outDir,
    groupBy: settings.groupBy,
    maxFilesPerGroup: settings.maxFilesPerGroup,
    maxGroupChars: settings.maxGroupChars,
    maxGroups: settings.maxGroups,
    maxFiles: settings.maxFiles,
    maxFileChars: settings.maxFileChars,
    maxToolCallsPerFile: settings.maxToolCallsPerFile,
    maxToolCallsPerGroup: settings.maxToolCallsPerGroup,
    maxRounds: settings.maxRounds,
    groupConcurrency: settings.groupConcurrency,
    maxTotalTokens: settings.maxTotalTokens,
    groupAttempts: settings.groupAttempts,
    resume: args.resume,
    includeTests: settings.includeTests,
    trackedOnly: settings.trackedOnly,
    dryRun: args.dryRun,
    ...(args.pathPrefix !== undefined ? { pathPrefix: args.pathPrefix } : {}),
    ...(args.files !== undefined ? { files: args.files } : {}),
    ...(includeRegexes.length > 0 ? { includeRegexes } : {}),
    ...(excludeRegexes.length > 0 ? { excludeRegexes } : {}),
    ...(args.ruleSkillZips !== undefined ? { ruleSkillZips: args.ruleSkillZips } : {}),
    ...(args.ruleSkillDirs !== undefined ? { ruleSkillDirs: args.ruleSkillDirs } : {}),
    ...(args.strictRuleSkill === true ? { strictRuleSkill: true } : {}),
    ...(onProgress !== undefined ? { onProgress } : {}),
  } as const;

  if (args.dryRun) {
    return runRepoSpike(common, { now: () => new Date() });
  }

  if (config === undefined) {
    throw new Error("repo-review: missing user config (run `review-pi config init` or pass --config)");
  }
  const endpoint = resolveReviewerEndpoint(config);
  const rawModel = config.model.default.trim();
  const modelId =
    rawModel.length > 0
      ? modelIdForGateway(rawModel, config.reviewer.stripModelPrefix)
      : undefined;

  // MCP 业务上报（ADR-0117）：与 PR 共用 `mcp.report.server`；建连失败只降级，
  // 不影响检视。事件通道（`mcp.report.tool`）不接——全仓只调四个业务 tool。
  const reportConfig = resolveReportConfig(config);
  const repoTaskId = args.taskId;
  const taskToolsConfigured = reportConfig !== null && reportConfig.task;
  let reporter: McpReporter | null = null;
  if (reportConfig !== null) {
    try {
      reporter = await createMcpReporter({
        config: reportConfig,
        clientVersion: REVIEW_PI_VERSION,
      });
    } catch (error) {
      log(`review-pi: MCP 上报不可用（${describeReportFailure(error)}），继续检视`);
    }
  }
  if (reporter !== null && reporter.handshake === "stateless") {
    log(
      "review-pi: MCP 服务端未接受 initialize，已改为无状态直调（与 Postman 单发同形），继续检视",
    );
  }

  const taskToolsOn = reporter !== null && taskToolsConfigured;
  let lifecycle: FullRepoLifecycle | undefined;
  let onGroupReviewed: ((batch: RepoReviewedBatch) => Promise<void>) | undefined;
  if (taskToolsOn && reporter !== null) {
    lifecycle = createFullRepoLifecycle({
      tasks: reporter.fullRepo,
      taskId: repoTaskId,
      settleMs: resolveTaskToolSettleMs(process.env),
      now: () => Date.now(),
      sleep: (ms) => delay(ms),
      log,
    });
    const repoLifecycle = lifecycle;
    onGroupReviewed = (batch) =>
      reportFullRepoBatch({
        taskId: repoTaskId,
        repoPath: common.repoPath,
        batch,
        lifecycle: repoLifecycle,
        log,
      });
    const started = await lifecycle.start();
    if (!started.ok) {
      log(`review-pi: MCP fullRepoStartTask 失败（${started.reason}），继续检视`);
    }
  }

  try {
    return await runRepoSpike(common, {
      apiKey: endpoint.apiKey,
      baseUrl: endpoint.baseUrl,
      ...(modelId !== undefined ? { modelId } : {}),
      fetch: globalThis.fetch,
      now: () => new Date(),
      languageRules: config.limits.languageRules,
      genericReview: config.limits.genericReview,
      ...(onGroupReviewed !== undefined ? { onGroupReviewed } : {}),
    });
  } finally {
    if (lifecycle !== undefined) {
      const tips = await lifecycle.reportCurrentTips();
      if (!tips.ok) {
        log(`review-pi: MCP fullRepoFilerCurrentTips 失败（${tips.reason}），继续收尾`);
      }
      const done = await lifecycle.finish();
      if (!done.ok) {
        log(`review-pi: MCP fullRepoEndTask 失败（${done.reason}）`);
      }
    }
    await reporter?.close().catch(() => undefined);
  }
}
