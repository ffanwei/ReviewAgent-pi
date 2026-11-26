import { DEFAULT_LIMITS, type RepoScanLimits } from "../shared/config-limits.js";
import type { ResolvedConfig } from "../shared/config.js";
import type { RepoSpikeCliArgs } from "./args.js";

/**
 * 全仓扫描设置的合并口径（ADR-0117 后续修订）：
 *
 * **CLI 显式旗标 > 配置 `limits.repoScan` > 内置缺省**
 *
 * 参数层只在旗标真的出现时才填字段；这里再落配置缺省。`--include/--exclude`
 * 出现时整体替换对应维度（空数组 = 本次清空），与 review 的 `--include/--exclude`
 * 覆盖 `limits.mrFilter` 同语义。
 */
export function resolveRepoScanSettings(
  args: RepoSpikeCliArgs,
  config: ResolvedConfig | undefined,
): RepoScanLimits {
  const base = config?.limits.repoScan ?? DEFAULT_LIMITS.repoScan;
  return {
    groupBy: args.groupBy ?? base.groupBy,
    maxFilesPerGroup: args.maxFilesPerGroup ?? base.maxFilesPerGroup,
    maxGroupChars: args.maxGroupChars ?? base.maxGroupChars,
    maxGroups: args.maxGroups ?? base.maxGroups,
    maxFiles: args.maxFiles ?? base.maxFiles,
    maxFileChars: args.maxFileChars ?? base.maxFileChars,
    maxToolCallsPerFile: base.maxToolCallsPerFile,
    maxToolCallsPerGroup: base.maxToolCallsPerGroup,
    maxRounds: args.maxRounds ?? base.maxRounds,
    groupConcurrency: args.groupConcurrency ?? base.groupConcurrency,
    maxTotalTokens: args.maxTotalTokens ?? base.maxTotalTokens,
    groupAttempts: args.groupAttempts ?? base.groupAttempts,
    includeTests: args.includeTests ?? base.includeTests,
    includeRegex: args.includePatterns ?? base.includeRegex,
    excludeRegex: args.excludePatterns ?? base.excludeRegex,
  };
}
