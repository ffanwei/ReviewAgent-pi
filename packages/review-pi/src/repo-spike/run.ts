import path from "node:path";

import type { FetchFunction } from "@earendil-works/pi-ai";

import type { CoverageLedger } from "../contracts/coverage.js";
import { addUsage, ZERO_USAGE } from "../provider/usage-map.js";
import { emptyCoverageLedger, mergeCoverageLedgers } from "../run/coverage-ledger.js";
import { mergeShardFindings } from "../run/findings-merge.js";
import { runReviewOutcome, type ReviewRunResult } from "../run/review-run.js";
import { enumerateRepoFiles } from "./enumerate.js";
import { groupRepoFiles } from "./group.js";
import {
  ensureDir,
  formatPlanSummary,
  formatResultSummary,
  groupSlug,
  writeJsonFile,
} from "./output.js";
import { buildSpikeRuntime } from "./runtime.js";
import { synthesizeGroupDiff } from "./synthesize-diff.js";
import type {
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
}

const ISSUE_DESCRIPTION =
  "Full-repository scan spike. Every file is presented as a newly added file so the existing MR review pipeline can run without diff input. Findings may include pre-existing issues.";

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
    ...(options.pathPrefix !== undefined ? { pathPrefix: options.pathPrefix } : {}),
    ...(options.files !== undefined ? { files: options.files } : {}),
  });
  const plan = groupRepoFiles(enumerated.files, {
    groupBy: options.groupBy,
    maxFilesPerGroup: options.maxFilesPerGroup,
    maxGroupChars: options.maxGroupChars,
  });
  if (plan.groups.length > options.maxGroups) {
    throw new Error(
      `repo-spike: group count ${String(plan.groups.length)} exceeds --max-groups ${String(
        options.maxGroups,
      )}; narrow --path or raise the guard explicitly`,
    );
  }

  progress(
    `[repo-spike] discovered=${String(enumerated.discovered)} selected=${String(
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
      mode: "repo-spike-plan",
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
      })),
      skippedFiles: mergeSkipped(enumerated.skipped, plan.skipped, syntheticGroups),
    };
    await writeJsonFile(path.join(outDir, "repo-spike-plan.json"), planDoc);
    progress(formatPlanSummary(planDoc));
    return 0;
  }

  const apiKey = deps.apiKey;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw new Error("repo-spike: missing reviewer API key (run `review-pi config init` or pass --config)");
  }
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const runtime = buildSpikeRuntime(options.maxRounds, options.includeTests);

  const groupOutcomes = await mapWithConcurrency(
    syntheticGroups,
    options.groupConcurrency,
    async (synthetic): Promise<RepoSpikeGroupOutcome> => {
      const slug = groupSlug(synthetic.group.index, synthetic.group.key);
      const caseId = `repo-spike-${slug}`;
      const runsRoot = path.join(outDir, "runs", slug);
      const files = synthetic.files;
      if (synthetic.diff === "" || files.length === 0) {
        return {
          index: synthetic.group.index,
          key: synthetic.group.key,
          files,
          diffChars: synthetic.chars,
          status: "skipped",
          findingsCount: 0,
          skipReason: "no-reviewable-files",
        };
      }
      progress(
        `[repo-spike] group ${String(synthetic.group.index)}/${String(
          syntheticGroups.length,
        )} ${synthetic.group.key} files=${String(files.length)} chars=${String(synthetic.chars)}`,
      );
      await ensureDir(runsRoot);
      try {
        const outcome = await runReviewOutcome({
          caseId,
          repoPath,
          diff: synthetic.diff,
          issueDescription: ISSUE_DESCRIPTION,
          apiKey,
          ...(deps.baseUrl !== undefined ? { baseUrl: deps.baseUrl } : {}),
          ...(deps.modelId !== undefined ? { modelId: deps.modelId } : {}),
          runtime,
          fetch: fetchFn,
          runsRoot,
          rep: 1,
          ...(options.ruleSkillZips !== undefined
            ? { ruleSkillZips: options.ruleSkillZips }
            : {}),
          ...(options.ruleSkillDirs !== undefined
            ? { ruleSkillDirs: options.ruleSkillDirs }
            : {}),
          ...(options.strictRuleSkill === true ? { strictRuleSkill: true } : {}),
        });
        if (outcome.kind === "skipped") {
          return {
            index: synthetic.group.index,
            key: synthetic.group.key,
            files,
            diffChars: synthetic.chars,
            status: "skipped",
            findingsCount: 0,
            skipReason: outcome.skip.reason,
          };
        }
        return {
          index: synthetic.group.index,
          key: synthetic.group.key,
          files,
          diffChars: synthetic.chars,
          status: "reviewed",
          findingsCount: outcome.result.record.baseline.findings.length,
          findings: outcome.result.record.baseline.findings,
          runId: outcome.result.runId,
          usage: outcome.result.record.baseline.usage,
          ...(outcome.result.coverage !== undefined
            ? { coverage: outcome.result.coverage }
            : {}),
          recordPath: outcome.result.recordPath,
          auditPath: outcome.result.auditPath,
          reviewsPath: outcome.result.reviewsPath,
          transcriptPath: outcome.result.transcriptPath,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        progress(`[repo-spike] group ${String(synthetic.group.index)} failed: ${message}`);
        return {
          index: synthetic.group.index,
          key: synthetic.group.key,
          files,
          diffChars: synthetic.chars,
          status: "failed",
          findingsCount: 0,
          error: message,
        };
      }
    },
  );

  const reviewed = groupOutcomes.filter(
    (outcome): outcome is RepoSpikeGroupOutcome & { status: "reviewed" } =>
      outcome.status === "reviewed",
  );
  const findings = mergeShardFindings(
    reviewed.map((outcome) => outcome.findings ?? []),
  );
  const usage = reviewed.reduce((total, outcome) => addUsage(total, outcome.usage ?? ZERO_USAGE), ZERO_USAGE);
  const coverage = mergeCoverage(
    groupOutcomes
      .filter((outcome) => outcome.coverage !== undefined)
      .map((outcome) => outcome.coverage as CoverageLedger),
  );
  const skippedFiles = mergeSkipped(enumerated.skipped, plan.skipped, syntheticGroups);
  const errors = groupOutcomes
    .filter((outcome) => outcome.status === "failed" && outcome.error !== undefined)
    .map((outcome) => `${outcome.key}: ${outcome.error ?? ""}`);

  const result: RepoSpikeResult = {
    schemaVersion: 1,
    mode: "repo-spike",
    generatedAt: now().toISOString(),
    repoPath,
    outDir,
    groupBy: options.groupBy,
    files: {
      discovered: enumerated.discovered,
      selected: enumerated.files.length,
      skipped: skippedFiles.length,
    },
    groups: groupOutcomes.map(({ findings: _findings, ...rest }) => rest),
    findings,
    usage,
    ...(coverage !== undefined ? { coverage } : {}),
    skippedFiles,
    errors,
  };
  const resultPath = path.join(outDir, "repo-spike-result.json");
  await writeJsonFile(resultPath, result);
  progress(formatResultSummary(result));

  // 与 review 的退出码口径一致：全部组失败才非 0；全跳过 / 无文件视为完成。
  if (groupOutcomes.length > 0 && reviewed.length === 0 && errors.length > 0) {
    return 1;
  }
  return 0;
}

function mergeCoverage(ledgers: readonly CoverageLedger[]): CoverageLedger | undefined {
  if (ledgers.length === 0) {
    return undefined;
  }
  // 组之间文件不重复（分组保证）；补空账本不会引入文件。
  return mergeCoverageLedgers([...ledgers, emptyCoverageLedger()]);
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

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  requested: number,
  fn: (item: T) => Promise<R>,
): Promise<readonly R[]> {
  const limit = Math.max(1, Math.min(Math.floor(requested), Math.max(items.length, 1)));
  if (limit === 1) {
    const out: R[] = [];
    for (const item of items) {
      out.push(await fn(item));
    }
    return out;
  }
  const results = new Array<R | undefined>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item !== undefined) {
        results[index] = await fn(item);
      }
    }
  };
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results.filter((value): value is R => value !== undefined);
}
