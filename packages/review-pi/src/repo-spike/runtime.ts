import type { LanguageRulesLimits } from "../shared/config-limits.js";
import { DEFAULT_REVIEW_RUNTIME, type ReviewRuntime } from "../shared/review-runtime.js";

/**
 * spike 专用运行时：只覆盖与「全仓合成 diff」直接冲突的门槛，
 * **不修改 DEFAULT_LIMITS / DEFAULT_REVIEW_RUNTIME**，因此 MR 路径完全不受影响。
 *
 * - boundary 全开：文件数 / diff 行数 / diff 字符数不设界（组已由 spike 自己限界）；
 * - split 关闭：每个组已经按 maxGroupChars 切好，避免现有字符装箱再切一次；
 * - testFiles 缺省跳过：全仓扫描契约缺省不扫测试；显式 --include-tests 才纳入；
 * - mrFilter 清空：避免用户配置的 MR 正则误伤全仓文件；
 * - findingScope 关闭：合成 diff 里所有行都是 `+`，不应再按 hunk 收窄；
 * - evidence 用 warn：先观察接地率，不直接 drop；
 * - coverage.repair 关闭：避免在合成 diff 上触发补漏；
 * - 工具预算按文件数分配：`min(maxToolCallsPerGroup, maxToolCallsPerFile × 文件数)`；
 *   合成 diff 已含整文件内容，Context Retrieval 的边际收益低，仍保留单组硬上限。
 */
export interface SpikeToolBudget {
  readonly maxToolCalls: number;
  readonly maxToolAttempts: number;
}

/**
 * 按文件数计算单组工具预算。
 *
 * - 每文件预算 `perFile`（缺省 8）；
 * - 单组硬上限 `maxPerGroup`（缺省 40）；
 * - 尝试预算 = 执行预算 + 10，避免被 retrieval 拒绝的重复请求先耗尽尝试次数。
 */
export function computeSpikeToolBudget(
  fileCount: number,
  perFile: number,
  maxPerGroup: number,
): SpikeToolBudget {
  const files = Math.max(1, Math.floor(fileCount));
  const per = Math.max(1, Math.floor(perFile));
  const cap = Math.max(1, Math.floor(maxPerGroup));
  const maxToolCalls = Math.min(cap, per * files);
  return { maxToolCalls, maxToolAttempts: maxToolCalls + 10 };
}

export function buildSpikeRuntime(
  maxRounds: number,
  includeTests: boolean,
  languageRules: LanguageRulesLimits | undefined,
  toolBudget: SpikeToolBudget,
): ReviewRuntime {
  const defaults = DEFAULT_REVIEW_RUNTIME;
  const limits = defaults.limits;
  return {
    ...defaults,
    maxToolCalls: toolBudget.maxToolCalls,
    maxToolAttempts: toolBudget.maxToolAttempts,
    limits: {
      ...limits,
      languageRules: languageRules ?? limits.languageRules,
      loop: {
        ...limits.loop,
        maxRounds: Math.max(1, Math.floor(maxRounds)),
      },
      // 全仓组多，单次请求最坏 180s × 3 次重试会让一个组卡 9 分钟；
      // 探针把单次上界压到 90s、重试压到 1 次，失败组显式记 failed。
      timeouts: {
        ...limits.timeouts,
        reviewTurnMs: 90_000,
        oneShotMs: 120_000,
      },
      retry: {
        ...limits.retry,
        reviewTurnAttempts: 1,
        streamAttempts: 1,
      },
      testFiles: {
        ...limits.testFiles,
        skip: !includeTests,
      },
      mrFilter: {
        excludeGlobs: [],
        includeRegex: [],
        excludeRegex: [],
      },
      findingScope: {
        ...limits.findingScope,
        enabled: false,
      },
      boundary: {
        maxFiles: null,
        maxDiffLines: null,
        maxDiffChars: null,
      },
      split: {
        ...limits.split,
        enabled: false,
        concurrency: 1,
      },
      evidence: {
        ...limits.evidence,
        mode: "warn",
      },
      coverage: {
        repair: {
          ...limits.coverage.repair,
          enabled: false,
        },
      },
      retrieval: {
        maxReadsPerFile: 1,
        maxConsecutiveEmptySearches: 2,
        maxReadCharsPerRun: 120_000,
      },
    },
  };
}
