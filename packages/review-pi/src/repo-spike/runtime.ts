import { DEFAULT_REVIEW_RUNTIME, type ReviewRuntime } from "../shared/review-runtime.js";

/**
 * spike 专用运行时：只覆盖与「全仓合成 diff」直接冲突的门槛，
 * **不修改 DEFAULT_LIMITS / DEFAULT_REVIEW_RUNTIME**，因此 MR 路径完全不受影响。
 *
 * - boundary 全开：文件数 / diff 行数 / diff 字符数不设界（组已由 spike 自己限界）；
 * - split 关闭：每个组已经按 maxGroupChars 切好，避免现有字符装箱再切一次；
 * - testFiles 保留：spike 先把测试文件交给流水线，是否保留由产品决定；
 * - mrFilter 清空：避免用户配置的 MR 正则误伤全仓文件；
 * - findingScope 关闭：合成 diff 里所有行都是 `+`，不应再按 hunk 收窄；
 * - evidence 用 warn：先观察接地率，不直接 drop；
 * - coverage.repair 关闭：避免在合成 diff 上触发补漏。
 */
export function buildSpikeRuntime(maxRounds: number): ReviewRuntime {
  const defaults = DEFAULT_REVIEW_RUNTIME;
  const limits = defaults.limits;
  return {
    ...defaults,
    limits: {
      ...limits,
      loop: {
        ...limits.loop,
        maxRounds: Math.max(1, Math.floor(maxRounds)),
      },
      testFiles: {
        ...limits.testFiles,
        skip: false,
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
    },
  };
}
