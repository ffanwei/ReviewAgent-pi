import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path, { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { InvalidatedTip } from "../mcp/task-tools.js";
import type { Finding } from "../contracts/finding.js";
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
import {
  createHistoryInvalidationRunner,
  loadHistoryTips,
  type HistoryInvalidationRunner,
  type InvalidationSummary,
} from "../repo-spike/history-invalidation.js";
import type { RepoReviewedBatch } from "../repo-spike/types.js";
import type { ResolvedConfig } from "../shared/config.js";
import { modelIdForGateway } from "../shared/config-schema.js";
import { retryPolicyFor } from "../shared/llm-retry.js";
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
  // 历史意见失效检查（R-21）：只在 MCP task 上报可用时启用——判定结果的唯一
  // 消费者是 currentTips 那次上报，没有目的地不烧裁决 token。建连层判定：
  // reporter null（未配置 / 建连失败）→ 跳过；无状态降级不算无效。
  let invalidation: HistoryInvalidationRunner | undefined;
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
    invalidation = await prepareHistoryInvalidation({
      config,
      repoPath: common.repoPath,
      outDir,
      modelId,
      baseUrl: endpoint.baseUrl,
      apiKey: endpoint.apiKey,
      log,
    });
    const runner = invalidation;
    onGroupReviewed = async (batch) => {
      // 先上报（平台可见优先），再随组入队判定：矩阵同步定案、LLM 候选进
      // 队列异步跑（不阻塞该 worker 取下一组）。
      await reportFullRepoBatch({
        taskId: repoTaskId,
        repoPath: common.repoPath,
        batch,
        lifecycle: repoLifecycle,
        log,
      });
      if (runner !== undefined) {
        await runner.enqueueBatch(batch);
      }
    };
    const started = await lifecycle.start();
    if (!started.ok) {
      log(`review-pi: MCP fullRepoStartTask 失败（${started.reason}），继续检视`);
    }
  } else {
    await noteSkippedInvalidation(common.repoPath, log);
  }

  let invalidatedTips: readonly InvalidatedTip[] = [];
  try {
    const exitCode = await runRepoSpike(common, {
      apiKey: endpoint.apiKey,
      baseUrl: endpoint.baseUrl,
      ...(modelId !== undefined ? { modelId } : {}),
      fetch: globalThis.fetch,
      now: () => new Date(),
      languageRules: config.limits.languageRules,
      genericReview: config.limits.genericReview,
      ...(onGroupReviewed !== undefined ? { onGroupReviewed } : {}),
    });
    if (invalidation !== undefined) {
      // 判定结果映射成 InvalidatedTip（repo-spike 层不知道 MCP，CLI 单点映射）；
      // 摘要写进 repo-review-result.json（读改写原子覆盖）。
      const outcome = await invalidation.finalize(await readRepoReviewResult(outDir));
      invalidatedTips = outcome.report.map((item) => ({
        tipsId: item.tipsId,
        reason: item.reason,
      }));
      await writeHistoryTipsSummary(outDir, outcome.summary, log);
    }
    return exitCode;
  } finally {
    if (lifecycle !== undefined) {
      const tips = await lifecycle.reportCurrentTips(
        invalidatedTips.length > 0 ? { invalidatedTips } : undefined,
      );
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

/**
 * MCP 未启用时的留痕：历史文件存在才打一行（不存在 = 功能静默关闭，零噪声）。
 * 判定结果的唯一消费者是 currentTips 上报——没有目的地不烧裁决 token。
 */
async function noteSkippedInvalidation(
  repoPath: string,
  log: (line: string) => void,
): Promise<void> {
  try {
    await stat(path.join(repoPath, ".aireview", "history_review_tips.json"));
    log("review-pi: MCP 未启用，跳过历史意见失效检查\n");
  } catch {
    // 文件不存在：功能静默关闭
  }
}

/** 历史意见失效检查装配：文件在 + 条目非空才建 runner；坏文件一行留痕 */
async function prepareHistoryInvalidation(input: {
  readonly config: ResolvedConfig;
  readonly repoPath: string;
  readonly outDir: string;
  readonly modelId: string | undefined;
  readonly baseUrl: string;
  readonly apiKey: string | null;
  readonly log: (line: string) => void;
}): Promise<HistoryInvalidationRunner | undefined> {
  const limits = input.config.limits.repoScan.historyTips;
  const load = await loadHistoryTips({ repoPath: input.repoPath, limits, log: input.log });
  if (load === null || load.entries.length === 0) {
    return undefined;
  }
  if (input.apiKey === null || input.modelId === undefined) {
    input.log("review-pi: 历史意见失效检查跳过（模型端点不可用）\n");
    return undefined;
  }
  return createHistoryInvalidationRunner({
    repoPath: input.repoPath,
    outDir: input.outDir,
    limits,
    load,
    genericReview: input.config.limits.genericReview,
    llm: {
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      modelId: input.modelId,
      timeoutMs: input.config.limits.timeouts.oneShotMs,
      retry: retryPolicyFor(input.config.limits.retry, "oneShot"),
      fetch: globalThis.fetch,
    },
    log: input.log,
  });
}

/** 读 run 层写好的 repo-review-result.json（收尾 sweep 的覆盖门 + findings） */
async function readRepoReviewResult(outDir: string): Promise<{
  readonly coverage: { readonly files: readonly { path: string; state: string }[] };
  readonly findings: readonly Finding[];
}> {
  try {
    const raw = await readFile(path.join(outDir, "repo-review-result.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      coverage?: { files?: { path?: unknown; state?: unknown }[] };
      findings?: unknown;
    };
    const files = Array.isArray(parsed.coverage?.files)
      ? parsed.coverage.files.flatMap((file) =>
          typeof file?.path === "string" && typeof file?.state === "string"
            ? [{ path: file.path, state: file.state }]
            : [],
        )
      : [];
    const findings = Array.isArray(parsed.findings) ? (parsed.findings as readonly Finding[]) : [];
    return { coverage: { files }, findings };
  } catch {
    // 结果文件缺失 / 损坏：覆盖门全闭（保守保留），不阻断收尾
    return { coverage: { files: [] }, findings: [] };
  }
}

/** 把失效检查摘要写进 repo-review-result.json（读改写 + 原子覆盖） */
async function writeHistoryTipsSummary(
  outDir: string,
  summary: InvalidationSummary,
  log: (line: string) => void,
): Promise<void> {
  const target = path.join(outDir, "repo-review-result.json");
  try {
    const raw = await readFile(target, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    parsed.historyTips = summary;
    const dir = path.dirname(target);
    const tmp = path.join(dir, `.repo-review-result.${process.pid}.${Date.now()}.tmp`);
    await writeFile(tmp, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    try {
      await rename(tmp, target);
    } catch {
      await rm(target, { force: true });
      await rename(tmp, target);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`review-pi: 历史意见摘要写入 repo-review-result.json 失败（${message}）\n`);
  }
}
