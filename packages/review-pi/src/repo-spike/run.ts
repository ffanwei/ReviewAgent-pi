import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { FetchFunction } from "@earendil-works/pi-ai";

import type { GenericReviewLimits, LanguageRulesLimits } from "../shared/config-limits.js";

import { addUsage, ZERO_USAGE } from "../provider/usage-map.js";
import {
  createUsageLedger,
  mergeUsageSummaries,
  summarizeUsage,
  type UsageLedgerSummary,
} from "../observability/usage-ledger.js";
import { mergeShardFindings } from "../run/findings-merge.js";
import { runReviewOutcome, type ReviewRunResult } from "../run/review-run.js";
import { buildRepoCoverage, coverageIsConsistent } from "./coverage.js";
import { enumerateRepoFiles } from "./enumerate.js";
import { groupRepoFiles } from "./group.js";
import {
  createJob,
  fingerprintConfig,
  fingerprintGroups,
  fingerprintPlan,
  fingerprintRuleSkills,
  isTransientError,
  jobPath,
  loadJob,
  readDoneGroup,
  usageTotal,
  validateJob,
  writeJob,
} from "./job.js";
import {
  ensureDir,
  formatDuration,
  formatPlanSummary,
  formatProgressLine,
  formatResultSummary,
  groupSlug,
  writeJsonFile,
} from "./output.js";
import { buildSpikeRuntime, computeSpikeToolBudget } from "./runtime.js";
import { synthesizeGroupDiff } from "./synthesize-diff.js";
import type {
  RepoReviewedBatch,
  RepoSpikeGroupOutcome,
  RepoSpikeOptions,
  RepoSpikePlan,
  RepoSpikeResult,
  SkippedFile,
  SyntheticGroup,
} from "./types.js";

export interface RepoSpikeDeps {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly modelId?: string;
  readonly fetch?: FetchFunction;
  readonly now?: () => Date;
  /**
   * 语言缺陷清单开关（ADR-0118）：来自配置 `limits.languageRules`。
   * 缺席 = 内置缺省（repo 关闭）。
   */
  readonly languageRules?: LanguageRulesLimits;
  /**
   * 通用检视建议类抑制：来自配置 `limits.genericReview`。
   * 缺席 = 内置缺省（P3 + 可维护 / 可读性 / 可测试性）。
   */
  readonly genericReview?: GenericReviewLimits;
  /**
   * 每批（组）检视完成后的上报缝（ADR-0117）：只在 `status=reviewed` 时、组结果
   * 已落 job 之后触发。回调抛错只留一行进度，绝不影响检视结果与退出码。
   * 续跑跳过的 done 组不会触发。
   */
  readonly onGroupReviewed?: (batch: RepoReviewedBatch) => Promise<void>;
}

const ISSUE_DESCRIPTION =
  "Full-repository review. The snapshot contains existing production source files. Find real, evidence-backed defects in the provided files; do not describe them as newly introduced changes.";

/** 一个组的结果（内部用） */
interface ReviewedGroup {
  readonly synthetic: SyntheticGroup;
  readonly result: ReviewRunResult;
}

/**
 * 执行一次 repo-spike：
 * 枚举 → 分组 → 每组合成「全新增」diff → 每组一次 `runReviewOutcome` → 合并产物。
 *
 * `dryRun = true` 时只做枚举/分组/合成 diff 并写 plan，不触模型、不需要配置。
 */
export async function runRepoSpike(
  options: RepoSpikeOptions,
  deps: RepoSpikeDeps = {},
): Promise<number> {
  const now = deps.now ?? (() => new Date());
  const progress = options.onProgress ?? (() => {});
  const outDir = path.resolve(options.outDir);
  const repoPath = path.resolve(options.repoPath);

  const enumerated = await enumerateRepoFiles({
    repoPath,
    maxFiles: options.maxFiles,
    maxFileChars: options.maxFileChars,
    trackedOnly: options.trackedOnly ?? true,
    ...(options.pathPrefix !== undefined ? { pathPrefix: options.pathPrefix } : {}),
    ...(options.files !== undefined ? { files: options.files } : {}),
    ...(options.includeRegexes !== undefined ? { includeRegexes: options.includeRegexes } : {}),
    ...(options.excludeRegexes !== undefined ? { excludeRegexes: options.excludeRegexes } : {}),
  });
  const plan = groupRepoFiles(enumerated.files, {
    groupBy: options.groupBy,
    maxFilesPerGroup: options.maxFilesPerGroup,
    maxGroupChars: options.maxGroupChars,
  });
  if (plan.groups.length > options.maxGroups) {
    throw new Error(
      `repo-review: group count ${String(plan.groups.length)} exceeds --max-groups ${String(
        options.maxGroups,
      )}; narrow --path or raise the guard explicitly`,
    );
  }

  progress(
    `[repo-review] discovered=${String(enumerated.discovered)} selected=${String(
      enumerated.files.length,
    )} groups=${String(plan.groups.length)} skipped=${String(
      enumerated.skipped.length + plan.skipped.length,
    )}`,
  );

  const syntheticGroups: SyntheticGroup[] = [];
  for (const group of plan.groups) {
    syntheticGroups.push(await synthesizeGroupDiff(group, { repoPath }));
  }

  if (options.dryRun) {
    const planDoc: RepoSpikePlan = {
      schemaVersion: 1,
      mode: "repo-review-plan",
      generatedAt: now().toISOString(),
      repoPath,
      outDir,
      groupBy: options.groupBy,
      files: {
        discovered: enumerated.discovered,
        selected: enumerated.files.length,
        skipped: countSkipped(enumerated.skipped, plan.skipped, syntheticGroups),
      },
      groups: syntheticGroups.map((synthetic) => ({
        index: synthetic.group.index,
        key: synthetic.group.key,
        files: synthetic.files,
        diffChars: synthetic.chars,
        ...(synthetic.group.soloLarge === true ? { soloLarge: true } : {}),
      })),
      skippedFiles: mergeSkipped(enumerated.skipped, plan.skipped, syntheticGroups),
    };
    await writeJsonFile(path.join(outDir, "repo-review-plan.json"), planDoc);
    // 兼容旧脚本：过渡期保留 repo-spike 文件名，内容与新产品名一致。
    await writeJsonFile(path.join(outDir, "repo-spike-plan.json"), planDoc);
    progress(formatPlanSummary(planDoc));
    return 0;
  }

  const apiKey = deps.apiKey;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw new Error("repo-review: missing reviewer API key (run `review-pi config init` or pass --config)");
  }
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const maxTotalTokens = Math.max(0, Math.floor(options.maxTotalTokens ?? 0));
  const groupAttempts = Math.max(1, Math.floor(options.groupAttempts ?? 2));
  const toolCallsPerFile = Math.max(1, Math.floor(options.maxToolCallsPerFile ?? 8));
  const maxToolCallsPerGroup = Math.max(1, Math.floor(options.maxToolCallsPerGroup ?? 40));

  const hashes = {
    snapshotHash: fingerprintGroups(syntheticGroups),
    planHash: fingerprintPlan(syntheticGroups),
    configHash: fingerprintConfig({
      ...(deps.modelId !== undefined ? { modelId: deps.modelId } : {}),
      ...(deps.baseUrl !== undefined ? { baseUrl: deps.baseUrl } : {}),
      maxRounds: options.maxRounds,
      includeTests: options.includeTests,
      groupBy: options.groupBy,
      maxToolCallsPerFile: toolCallsPerFile,
      maxToolCallsPerGroup: maxToolCallsPerGroup,
      ruleSkillsHash: await fingerprintRuleSkills(options.ruleSkillZips, options.ruleSkillDirs),
      strictRuleSkill: options.strictRuleSkill === true,
    }),
  };

  let job = options.resume === true ? await loadJob(outDir) : undefined;
  if (options.resume === true) {
    if (job === undefined) {
      throw new Error(`repo-review: cannot resume: ${jobPath(outDir)} not found`);
    }
    validateJob(job, hashes);
    job = { ...job, maxTotalTokens, status: "running", updatedAt: now().toISOString() };
  } else {
    job = createJob({
      outDir,
      repoPath,
      now: now(),
      ...(deps.modelId !== undefined ? { modelId: deps.modelId } : {}),
      maxTotalTokens,
      hashes,
      groups: syntheticGroups,
    });
  }
  if (job.groups.length !== syntheticGroups.length) {
    throw new Error("repo-review: job group count does not match the current plan");
  }

  const outcomes = new Array<RepoSpikeGroupOutcome | undefined>(syntheticGroups.length);
  let spentTokens = 0;
  for (let index = 0; index < syntheticGroups.length; index += 1) {
    const group = job.groups[index];
    const synthetic = syntheticGroups[index];
    if (group === undefined || synthetic === undefined) {
      throw new Error("repo-review: internal job/plan mismatch");
    }
    if (options.resume === true && group.status === "done") {
      const done = await readDoneGroup(outDir, group);
      if (done !== undefined) {
        outcomes[index] = done;
        spentTokens += usageTotal(done.usage);
        continue;
      }
      // run.json 缺失或损坏：退回 pending，重新检视。
      group.attempts = 0;
      delete group.startedAt;
      delete group.finishedAt;
      delete group.runId;
      delete group.findingsCount;
      delete group.usage;
      delete group.error;
      delete group.skipReason;
    }
    if (
      options.resume === true &&
      group.status === "skipped" &&
      group.skipReason !== "budget-exhausted"
    ) {
      outcomes[index] = skippedOutcome(synthetic, group.skipReason ?? "no-reviewable-files");
      continue;
    }
    // pending / running / failed / budget-skipped：本次重新派发。
    group.status = "pending";
    group.attempts = group.attempts ?? 0;
    delete group.startedAt;
    delete group.finishedAt;
    delete group.runId;
    delete group.findingsCount;
    delete group.usage;
    delete group.error;
    delete group.skipReason;
  }
  job.spentTokens = spentTokens;

  let persistChain: Promise<void> = Promise.resolve();
  const persistJob = (): Promise<void> => {
    job.updatedAt = now().toISOString();
    const snapshot = job;
    persistChain = persistChain.then(() => writeJob(snapshot));
    return persistChain;
  };
  await persistJob();

  const runStartedAt = Date.now();
  const initialCompleted = outcomes.filter((outcome) => outcome !== undefined).length;
  const totalGroups = syntheticGroups.length;
  let finishedThisRun = 0;
  let activeCount = 0;
  const elapsedMs = (): number => Date.now() - runStartedAt;
  const etaMs = (): number | undefined => {
    const remaining = Math.max(0, syntheticGroups.length - initialCompleted - finishedThisRun);
    if (remaining === 0) {
      return 0;
    }
    if (finishedThisRun === 0) {
      return undefined;
    }
    return Math.round((elapsedMs() / finishedThisRun) * remaining);
  };
  const etaText = (): string =>
    etaMs() === undefined ? "eta=calculating" : `eta=${formatDuration(etaMs() ?? 0)}`;
  const tokenText = (): string =>
    maxTotalTokens > 0
      ? ` tokens=${String(job.spentTokens)}/${String(maxTotalTokens)}`
      : ` tokens=${String(job.spentTokens)}`;
  const progressSnapshot = () => ({
    completed: initialCompleted + finishedThisRun,
    total: totalGroups,
    active: activeCount,
    elapsedMs: elapsedMs(),
    etaMs: etaMs(),
    spentTokens: job.spentTokens,
    maxTotalTokens,
  });

  const executeGroup = async (index: number): Promise<RepoSpikeGroupOutcome> => {
    const synthetic = syntheticGroups[index];
    const jobGroup = job.groups[index];
    if (synthetic === undefined || jobGroup === undefined) {
      throw new Error("repo-review: internal job/plan mismatch");
    }
    if (synthetic.diff === "" || synthetic.files.length === 0) {
      const skipped = skippedOutcome(synthetic, "no-reviewable-files");
      jobGroup.status = "skipped";
      jobGroup.skipReason = skipped.skipReason;
      jobGroup.finishedAt = now().toISOString();
      return skipped;
    }

    const slug = groupSlug(synthetic.group.index, synthetic.group.key);
    const caseId = `repo-review-${slug}`;
    const runsRoot = path.join(outDir, "runs", slug);
    progress(
      `[repo-review] [${String(synthetic.group.index)}/${String(totalGroups)}] start ${synthetic.group.key} files=${String(synthetic.files.length)} chars=${String(synthetic.chars)} elapsed=${formatDuration(elapsedMs())} ${etaText()}`,
    );
    await ensureDir(runsRoot);
    // 组级账本：同一组的所有重试 attempt 共用；失败 attempt 已产生的用量也
    // 留在账里（不能因为最后一次成功就把前几次的钱抹掉）。
    const groupLedger = createUsageLedger();
    const groupRuntime = buildSpikeRuntime(
      options.maxRounds,
      options.includeTests,
      deps.languageRules,
      computeSpikeToolBudget(
        synthetic.files.length,
        toolCallsPerFile,
        maxToolCallsPerGroup,
      ),
      deps.genericReview,
    );

    for (let attempt = 0; attempt < groupAttempts; attempt += 1) {
      jobGroup.status = "running";
      jobGroup.attempts = (jobGroup.attempts ?? 0) + 1;
      jobGroup.startedAt = jobGroup.startedAt ?? now().toISOString();
      delete jobGroup.finishedAt;
      delete jobGroup.error;
      await persistJob();
      try {
        const outcome = await runReviewOutcome({
          caseId,
          repoPath,
          diff: synthetic.diff,
          reviewMode: "repo",
          fileSnapshot: synthetic.snapshot,
          issueDescription: ISSUE_DESCRIPTION,
          apiKey,
          ...(deps.baseUrl !== undefined ? { baseUrl: deps.baseUrl } : {}),
          ...(deps.modelId !== undefined ? { modelId: deps.modelId } : {}),
          runtime: groupRuntime,
          fetch: fetchFn,
          runsRoot,
          rep: 1,
          usageLedger: groupLedger,
          ...(options.ruleSkillZips !== undefined
            ? { ruleSkillZips: options.ruleSkillZips }
            : {}),
          ...(options.ruleSkillDirs !== undefined
            ? { ruleSkillDirs: options.ruleSkillDirs }
            : {}),
          ...(options.strictRuleSkill === true ? { strictRuleSkill: true } : {}),
        });
        if (outcome.kind === "skipped") {
          const skipped = withGroupUsage(
            skippedOutcome(synthetic, outcome.skip.reason),
            groupLedger,
          );
          jobGroup.status = "skipped";
          jobGroup.skipReason = skipped.skipReason;
          jobGroup.usage = skipped.usage;
          jobGroup.usageLedger = skipped.usageLedger;
          jobGroup.finishedAt = now().toISOString();
          return skipped;
        }
        const reviewed = withGroupUsage(reviewedOutcome(synthetic, outcome.result), groupLedger);
        // 路径修复留痕（ADR-0120）：group 级一行，CLI 与 review-pi.log 都可见。
        for (const repair of outcome.result.record.baseline.audit.pathRepairs ?? []) {
          progress(
            `[repo-review] group ${String(synthetic.group.index)} path repaired: ${repair.from} -> ${repair.to} (distance=${String(repair.distance)})`,
          );
        }
        jobGroup.status = "done";
        jobGroup.runId = reviewed.runId;
        jobGroup.findingsCount = reviewed.findingsCount;
        jobGroup.usage = reviewed.usage;
        jobGroup.usageLedger = reviewed.usageLedger;
        jobGroup.finishedAt = now().toISOString();
        return reviewed;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const canRetry = attempt + 1 < groupAttempts && isTransientError(error);
        if (canRetry) {
          progress(`[repo-review] group ${String(synthetic.group.index)} transient failure, retrying: ${message}`);
          await delay(500 * (attempt + 1));
          continue;
        }
        progress(`[repo-review] group ${String(synthetic.group.index)} failed: ${message}`);
        jobGroup.status = "failed";
        jobGroup.error = message;
        jobGroup.finishedAt = now().toISOString();
        const failed = withGroupUsage(
          {
            index: synthetic.group.index,
            key: synthetic.group.key,
            files: synthetic.files,
            diffChars: synthetic.chars,
            status: "failed",
            findingsCount: 0,
            error: message,
          },
          groupLedger,
        );
        jobGroup.usage = failed.usage;
        jobGroup.usageLedger = failed.usageLedger;
        return failed;
      }
    }
    throw new Error("repo-review: internal retry loop exhausted without a result");
  };

  const pending = syntheticGroups
    .map((_, index) => index)
    .filter((index) => outcomes[index] === undefined);
  let cursor = 0;
  let budgetStopped = false;
  const concurrency = Math.max(
    1,
    Math.min(Math.floor(options.groupConcurrency), Math.max(pending.length, 1)),
  );
  const worker = async (): Promise<void> => {
    while (true) {
      if (budgetStopped) {
        return;
      }
      if (maxTotalTokens > 0 && job.spentTokens >= maxTotalTokens) {
        budgetStopped = true;
        return;
      }
      const position = cursor;
      cursor += 1;
      const index = pending[position];
      if (index === undefined) {
        return;
      }
      activeCount += 1;
      const groupStartedAt = Date.now();
      let outcome: RepoSpikeGroupOutcome;
      try {
        outcome = await executeGroup(index);
      } finally {
        activeCount -= 1;
        finishedThisRun += 1;
      }
      outcomes[index] = outcome;
      job.spentTokens += usageTotal(outcome.usage);
      await persistJob();
      progress(
        `[repo-review] [${String(initialCompleted + finishedThisRun)}/${String(totalGroups)}] ${outcome.status} ${outcome.key} findings=${String(outcome.findingsCount)} group=${formatDuration(Date.now() - groupStartedAt)} elapsed=${formatDuration(elapsedMs())} ${etaText()}${tokenText()}`,
      );
      // 上报缝（ADR-0117）：只在本次进程真正检视完成的组触发；续跑 done 组已在
      // 上面跳过，不会重报。失败只留一行，不改变组状态与退出码。
      if (outcome.status === "reviewed" && deps.onGroupReviewed !== undefined) {
        try {
          await deps.onGroupReviewed({
            index: outcome.index,
            key: outcome.key,
            files: outcome.files,
            findings: outcome.presentationFindings ?? outcome.findings ?? [],
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          progress(
            `[repo-review] group ${String(outcome.index)} report callback failed: ${message}`,
          );
        }
      }
      if (maxTotalTokens > 0 && job.spentTokens >= maxTotalTokens) {
        budgetStopped = true;
      }
    }
  };
  const heartbeat =
    pending.length > 0
      ? setInterval(() => {
          progress(formatProgressLine(progressSnapshot()));
        }, 30_000)
      : undefined;
  heartbeat?.unref?.();
  try {
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  } finally {
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
    }
  }

  for (let index = 0; index < syntheticGroups.length; index += 1) {
    if (outcomes[index] !== undefined) {
      continue;
    }
    const synthetic = syntheticGroups[index];
    const jobGroup = job.groups[index];
    if (synthetic === undefined || jobGroup === undefined) {
      throw new Error("repo-review: internal job/plan mismatch");
    }
    outcomes[index] = skippedOutcome(synthetic, "budget-exhausted");
    jobGroup.status = "skipped";
    jobGroup.skipReason = "budget-exhausted";
    jobGroup.finishedAt = now().toISOString();
  }

  const groupOutcomes = outcomes.filter(
    (outcome): outcome is RepoSpikeGroupOutcome => outcome !== undefined,
  );
  const reviewedCount = groupOutcomes.filter((outcome) => outcome.status === "reviewed").length;
  const failedCount = groupOutcomes.filter((outcome) => outcome.status === "failed").length;
  const budgetSkippedCount = job.groups.filter(
    (group) => group.status === "skipped" && group.skipReason === "budget-exhausted",
  ).length;
  const partial = failedCount > 0 || budgetSkippedCount > 0;
  job.status =
    failedCount > 0 && reviewedCount === 0 && budgetSkippedCount === 0
      ? "failed"
      : partial
        ? "partial"
        : "completed";
  await persistJob();

  const reviewed = groupOutcomes.filter(
    (outcome): outcome is RepoSpikeGroupOutcome & { status: "reviewed" } =>
      outcome.status === "reviewed",
  );
  const findings = mergeShardFindings(
    reviewed.map((outcome) => outcome.findings ?? []),
  );
  // 全组用量：reviewed / failed / skipped 都算（失败 attempt 的账不能丢）。
  const usage = groupOutcomes.reduce(
    (total, outcome) => addUsage(total, outcome.usage ?? ZERO_USAGE),
    ZERO_USAGE,
  );
  let usageLedger: UsageLedgerSummary | undefined;
  for (const outcome of groupOutcomes) {
    usageLedger = mergeUsageSummaries(usageLedger, outcome.usageLedger);
  }
  const coverage = buildRepoCoverage({
    selected: enumerated.files,
    groupedSkipped: plan.skipped,
    groups: syntheticGroups,
    outcomes: groupOutcomes,
  });
  if (!coverageIsConsistent(coverage)) {
    throw new Error("repo-review: coverage summary is inconsistent with selected files");
  }
  const skippedFiles = mergeSkipped(enumerated.skipped, plan.skipped, syntheticGroups);
  const errors = groupOutcomes
    .filter((outcome) => outcome.status === "failed" && outcome.error !== undefined)
    .map((outcome) => `${outcome.key}: ${outcome.error ?? ""}`);

  const result: RepoSpikeResult = {
    schemaVersion: 1,
    mode: "repo",
    generatedAt: now().toISOString(),
    repoPath,
    outDir,
    groupBy: options.groupBy,
    files: {
      discovered: enumerated.discovered,
      selected: enumerated.files.length,
      skipped: skippedFiles.length,
    },
    groups: groupOutcomes.map(
      ({ findings: _findings, presentationFindings: _presentationFindings, ...rest }) => rest,
    ),
    findings,
    usage,
    ...(usageLedger !== undefined ? { usageLedger } : {}),
    coverage,
    skippedFiles,
    errors,
  };
  const resultPath = path.join(outDir, "repo-review-result.json");
  await writeJsonFile(resultPath, result);
  // 兼容旧脚本：过渡期保留 repo-spike 文件名，内容与新产品名一致。
  await writeJsonFile(path.join(outDir, "repo-spike-result.json"), result);
  progress(formatResultSummary(result));
  progress(`[repo-review] job: status=${job.status} path=${jobPath(outDir)}`);

  // 0 = 完成；2 = 部分完成（失败组 / 预算停止）；1 = 全部失败。
  if (job.status === "failed") {
    return 1;
  }
  if (job.status === "partial") {
    return 2;
  }
  return 0;
}

function skippedOutcome(
  synthetic: SyntheticGroup,
  reason: string,
): RepoSpikeGroupOutcome {
  return {
    index: synthetic.group.index,
    key: synthetic.group.key,
    files: synthetic.files,
    diffChars: synthetic.chars,
    status: "skipped",
    findingsCount: 0,
    skipReason: reason,
  };
}

/** 把组账本投影回 outcome：usage 含 Agent + 一次性 + 覆盖补漏 + 失败 attempt */
function withGroupUsage(
  outcome: RepoSpikeGroupOutcome,
  ledger: ReturnType<typeof createUsageLedger>,
): RepoSpikeGroupOutcome {
  const summary = summarizeUsage(ledger);
  if (summary.calls === 0) {
    return outcome;
  }
  return {
    ...outcome,
    usage: summary.usage,
    usageLedger: summary,
  };
}

function reviewedOutcome(
  synthetic: SyntheticGroup,
  result: ReviewRunResult,
): RepoSpikeGroupOutcome {
  return {
    index: synthetic.group.index,
    key: synthetic.group.key,
    files: synthetic.files,
    diffChars: synthetic.chars,
    status: "reviewed",
    findingsCount: result.record.baseline.findings.length,
    findings: result.record.baseline.findings,
    ...(result.presentationFindings !== undefined
      ? { presentationFindings: result.presentationFindings }
      : {}),
    runId: result.runId,
    usage: result.record.baseline.usage,
    ...(result.coverage !== undefined ? { coverage: result.coverage } : {}),
    recordPath: result.recordPath,
    auditPath: result.auditPath,
    reviewsPath: result.reviewsPath,
    transcriptPath: result.transcriptPath,
  };
}

function countSkipped(
  enumerated: readonly SkippedFile[],
  grouping: readonly SkippedFile[],
  syntheticGroups: readonly SyntheticGroup[],
): number {
  return mergeSkipped(enumerated, grouping, syntheticGroups).length;
}

function mergeSkipped(
  enumerated: readonly SkippedFile[],
  grouping: readonly SkippedFile[],
  syntheticGroups: readonly SyntheticGroup[],
): readonly SkippedFile[] {
  const seen = new Set<string>();
  const out: SkippedFile[] = [];
  for (const item of [
    ...enumerated,
    ...grouping,
    ...syntheticGroups.flatMap((group) => group.skipped),
  ]) {
    const key = `${item.path}\u0000${item.reason}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}
