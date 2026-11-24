import { resolve } from "node:path";

import { resolveReviewerEndpoint } from "../provider/reviewer-endpoint.js";
import { runRepoSpike } from "../repo-spike/run.js";
import type { ResolvedConfig } from "../shared/config.js";
import { modelIdForGateway } from "../shared/config-schema.js";
import type { RepoSpikeCliArgs } from "./args.js";

/**
 * `repo-spike` 命令执行缝。
 *
 * - dry-run：不加载配置、不触模型，只做枚举/分组/合成 diff；
 * - 真跑：与 `review` 共用配置解析（reviewer 端点 + model.default），
 *   但运行入口是独立的 `runRepoSpike`，不进入 `prepareReview` 的准入分支。
 */
export async function runRepoSpikeCommand(
  args: RepoSpikeCliArgs,
  config?: ResolvedConfig,
): Promise<number> {
  const onProgress =
    args.progress === false
      ? undefined
      : (line: string): void => {
          process.stderr.write(`${line}\n`);
        };

  const common = {
    repoPath: resolve(args.repo),
    outDir: resolve(args.outDir),
    groupBy: args.groupBy,
    maxFilesPerGroup: args.maxFilesPerGroup,
    maxGroupChars: args.maxGroupChars,
    maxFiles: args.maxFiles,
    maxFileChars: args.maxFileChars,
    maxRounds: args.maxRounds,
    groupConcurrency: args.groupConcurrency,
    dryRun: args.dryRun,
    ...(args.pathPrefix !== undefined ? { pathPrefix: args.pathPrefix } : {}),
    ...(args.ruleSkillZips !== undefined ? { ruleSkillZips: args.ruleSkillZips } : {}),
    ...(args.ruleSkillDirs !== undefined ? { ruleSkillDirs: args.ruleSkillDirs } : {}),
    ...(args.strictRuleSkill === true ? { strictRuleSkill: true } : {}),
    ...(onProgress !== undefined ? { onProgress } : {}),
  } as const;

  if (args.dryRun) {
    return runRepoSpike(common, { now: () => new Date() });
  }

  if (config === undefined) {
    throw new Error("repo-spike: missing user config (run `review-pi config init` or pass --config)");
  }
  const endpoint = resolveReviewerEndpoint(config);
  const rawModel = config.model.default.trim();
  const modelId =
    rawModel.length > 0
      ? modelIdForGateway(rawModel, config.reviewer.stripModelPrefix)
      : undefined;
  return runRepoSpike(common, {
    apiKey: endpoint.apiKey,
    baseUrl: endpoint.baseUrl,
    ...(modelId !== undefined ? { modelId } : {}),
    fetch: globalThis.fetch,
    now: () => new Date(),
  });
}
