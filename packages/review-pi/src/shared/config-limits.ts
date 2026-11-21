// 检视限额配置（ADR-0025）：类型、缺省值与装载期解析。
//
// 从 `shared/config.ts` 拆出：limits 是配置面最大的一块（12 个子块、40+ 个
// 数值），但只依赖通用校验工具与 glob / 正则列表解析。

import {
  asObject,
  assertKnownKeys,
  boolOr,
  ConfigError,
  CONFIG_FILE_NAME,
  intOr,
  numberOr,
  optionalInt,
  optionalObject,
  parseGlobList,
  parseRegexList,
  severityOr,
} from "./config-schema.js";

export interface TimeoutLimits {
  readonly skillPassMs: number;
  readonly skillBashMs: number;
  readonly ruleSkillExtractMs: number;
  readonly ripgrepMs: number;
  readonly probeHealthMs: number;
  readonly probeModelMs: number;
  readonly reviewTurnMs: number;
  readonly oneShotMs: number;
}

/**
 * LLM 调用重试（ADR-0051）：`maxAttempts` 一律是**总尝试次数（含首次）**。
 *
 * 分工：
 * - Agent 内会话（主检视回合 / 规则 Skill 会话）用 `reviewTurnAttempts` +
 *   `maxRetryAfterMs` → pi-ai `maxRetries` / `maxRetryDelayMs`；
 * - 核外一次性调用（片级报文 / 收尾总结）用 `oneShotAttempts`；
 * - smoke 探针缺省**不重试**（`smokeAttempts = 1`），要重试须显式配置；
 * - **流中断重放**（ADR-0077）：`streamAttempts` 是**一次逻辑流请求的总尝试次数**
 *   （含首次），`streamReplayBudgetMs` 是重放总墙钟预算（含退避，0 = 不设上限）。
 *   它叠在 `reviewTurnAttempts` 之上：后者管「请求建立」，前者管「流已开始后断开」。
 *
 * `baseDelayMs` / `maxDelayMs` 只作用于核外一次性调用与流中断重放；Agent 层
 * 建连重试的退避由 pi-ai 自身固定（0.5s→8s），本仓不 fork 上游、只透传次数与超时。
 */
export interface RetryLimits {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly maxRetryAfterMs: number;
  readonly reviewTurnAttempts: number;
  readonly oneShotAttempts: number;
  readonly smokeAttempts: number;
  /** 一次逻辑流请求的总尝试次数（含首次）；1 = 不重放，3 = 1 次首次 + 2 次重放 */
  readonly streamAttempts: number;
  /** 流中断重放的总墙钟预算（毫秒；从首次尝试发出起算、含退避）；0 = 不设上限 */
  readonly streamReplayBudgetMs: number;
}

/** 检视循环上限（ADR-0046） */
export interface LoopLimits {
  /**
   * 最大轮次（一轮 = 六阶段完整一遍）。**最后一轮强制 complete**：
   * 模型说「还要再审」也不再开新轮，本轮产出即最终结果——轮次上限是成本线，
   * 不是失败，不产生 `MAX_ROUNDS_REACHED` 截断。
   */
  readonly maxRounds: number;
  /**
   * Phase 5 六项缺陷镜头二次扫描：开启后，主 Phase 5 候选产出后再发一次
   * 独立补漏请求（空值/边界/类型/错误路径/资源/顺序并发），新增候选与主候选
   * 按 (file, line, category) 合并，主候选永不被丢弃。缺省关闭。
   */
  readonly phase5Sweep: boolean;
}

/**
 * 中文 tips 的置信度过滤（ADR-0052）：`confidence < min` 的检视意见不进入
 * `reviews_tips_zh.json` 与 `mrReviewResult.reviewTips`。英文 findings 不受影响。
 * 取值 0–1，缺省 0.5（= 过滤 Low 档）；`0` = 不过滤，`1` = 只保留满置信。
 */
export interface ConfidenceLimits {
  readonly min: number;
}

/**
 * 中文 tips / MCP 上报的严重级过滤：`severity` 低于 min 的检视意见不进入
 * `reviews_tips_zh.json` 与 `mrReviewResult.reviewTips`。英文 findings / stdout
 * / 审计 findings 不受影响。取值 P0–P3，缺省 P3（= 不过滤）。
 */
export interface SeverityLimits {
  readonly min: "P0" | "P1" | "P2" | "P3";
}

/**
 * 测试文件检视开关：`skip = true`（缺省）时，`run/mr-input.ts` 在检视输入阶段
 * 按文件块整块剔除测试文件；`false` 时原样保留。影响的是**检视输入本身**
 * （findings / tips / MCP 上报同时生效），与 `limits.severity` / `limits.confidence`
 * 的输出侧过滤不同。
 */
export interface TestFileLimits {
  readonly skip: boolean;
}

/**
 * 按 glob 跳过检视（ADR-0069）与按正则限定/排除检视范围（ADR-0078）。
 * 命中的文件块在**检视输入阶段**整块剔除，不进 diff / findings / 中文 tips /
 * MCP 意见；但它们仍是「变更过的文件」，收尾按 ADR-0068 补一条空
 * `reviewTips` 的 `mrReviewResult`。
 *
 * `excludeGlobs` 匹配对象是 diff 里的仓库相对 POSIX 路径，大小写不敏感；
 * 不含 `/` 的 glob 只比文件名（`*.md` 与 `**\/*.md` 等价）。空数组 = 不排除。
 *
 * `includeRegex` / `excludeRegex` 是正则（大小写敏感，匹配前做 git 引号归一化）；
 * `includeRegex` 非空 = 白名单（命中者越过全部启发式过滤），`excludeRegex`
 * 优先于 `includeRegex`。空数组 = 该维度不生效。CLI `--include` / `--exclude`
 * 出现时整体替换对应维度（ADR-0078）。
 */
export interface MrFilterLimits {
  readonly excludeGlobs: readonly string[];
  readonly includeRegex: readonly string[];
  readonly excludeRegex: readonly string[];
}

/**
 * 非 diff 区域过滤：`enabled = true`（缺省）时，候选拦截链只保留落在本遍
 * diff 变更 hunk 内（或距 hunk 边界不超过 `contextLines` 行）的检视意见；
 * 文件不在本遍 diff 的直接拒绝（`OUT_OF_SCOPE`）。影响 findings / tips /
 * MCP / 审计（被拒候选只留 rejectionCounts），关闭 = 保留同文件远处甚至
 * 未改动文件里的意见。
 */
export interface FindingScopeLimits {
  readonly enabled: boolean;
  readonly contextLines: number;
}

export interface BoundaryLimits {
  /** `>` 即降级；null = 该维度不设界 */
  readonly maxFiles: number | null;
  readonly maxDiffLines: number | null;
  /** 过滤后的 diff 字符数上限；超限直接报错，null = 关闭该门禁 */
  readonly maxDiffChars: number | null;
}

export interface SplitLimits {
  /** 是否允许在过滤后 diff 超过 maxShardChars 时自动分片（ADR-0039）；false = 保持单遍旧行为 */
  readonly enabled: boolean;
  /** 单片字符目标（不是硬失败线；单块超过它时按整 hunk 截取，ADR-0070） */
  readonly maxShardChars: number;
  /** 片数上限（成本护栏）：需要更多片直接报错，由使用方拆 MR */
  readonly maxShards: number;
  /** 每片附带的「其他文件变更摘要」字符上限 */
  readonly contextSummaryChars: number;
}

export interface ArchiveLimits {
  readonly maxArchiveBytes: number;
  readonly maxEntries: number;
  readonly maxTotalUncompressed: number;
  readonly maxCompressionRatio: number;
}

export interface MicroLimits {
  readonly skillBashOutputChars: number;
  readonly queryEchoChars: number;
  readonly callChainHops: number;
  readonly toolNameChars: number;
  readonly argumentsSummaryChars: number;
  readonly progressDetailChars: number;
}

/**
 * 覆盖缺口补漏（F-01b）：只对账本里未覆盖的 hunk 发独立请求。
 *
 * - `enabled = false`（缺省）= 不补漏，行为与 F-01a 完全一致；
 * - `maxRequests` 是每个 pass 的请求硬上限，超出保持 `not-reached(budget)`；
 * - `maxChars` 是单个请求的 hunk 正文字符预算（文件头与提示词另计）；
 * - `maxHunksPerRequest` 是单个请求最多携带的 hunk 数。
 */
export interface CoverageRepairLimits {
  readonly enabled: boolean;
  readonly maxRequests: number;
  readonly maxChars: number;
  readonly maxHunksPerRequest: number;
}

export interface CoverageLimits {
  readonly repair: CoverageRepairLimits;
}

export interface Limits {
  readonly loop: LoopLimits;
  readonly timeouts: TimeoutLimits;
  readonly retry: RetryLimits;
  readonly confidence: ConfidenceLimits;
  readonly severity: SeverityLimits;
  readonly testFiles: TestFileLimits;
  readonly mrFilter: MrFilterLimits;
  readonly findingScope: FindingScopeLimits;
  readonly boundary: BoundaryLimits;
  readonly split: SplitLimits;
  readonly archive: ArchiveLimits;
  readonly micro: MicroLimits;
  readonly coverage: CoverageLimits;
}

export const DEFAULT_LIMITS: Limits = {
  loop: { maxRounds: 3, phase5Sweep: false },
  timeouts: {
    skillPassMs: 1_200_000,
    skillBashMs: 120_000,
    ruleSkillExtractMs: 30_000,
    ripgrepMs: 30_000,
    probeHealthMs: 15_000,
    probeModelMs: 120_000,
    reviewTurnMs: 180_000,
    oneShotMs: 300_000,
  },
  retry: {
    maxAttempts: 3,
    baseDelayMs: 500,
    maxDelayMs: 10_000,
    maxRetryAfterMs: 30_000,
    reviewTurnAttempts: 3,
    oneShotAttempts: 3,
    smokeAttempts: 1,
    streamAttempts: 3,
    streamReplayBudgetMs: 600_000,
  },
  confidence: { min: 0.5 },
  severity: { min: "P3" },
  testFiles: { skip: false },
  mrFilter: {
    excludeGlobs: ["**/*.lock", "**/fixtures/**", "**/*.snap"],
    includeRegex: [],
    excludeRegex: [],
  },
  findingScope: { enabled: true, contextLines: 10 },
  boundary: { maxFiles: 10, maxDiffLines: 2_000, maxDiffChars: 1_000_000 },
  split: { enabled: true, maxShardChars: 120_000, maxShards: 12, contextSummaryChars: 8_000 },
  archive: {
    maxArchiveBytes: 8 * 1024 * 1024,
    maxEntries: 2_000,
    maxTotalUncompressed: 64 * 1024 * 1024,
    maxCompressionRatio: 100,
  },
  micro: {
    skillBashOutputChars: 256_000,
    queryEchoChars: 120,
    callChainHops: 2,
    toolNameChars: 60,
    argumentsSummaryChars: 80,
    progressDetailChars: 120,
  },
  coverage: {
    repair: {
      enabled: false,
      maxRequests: 8,
      maxChars: 24_000,
      maxHunksPerRequest: 6,
    },
  },
};


const LIMITS_KEYS = ["loop", "timeouts", "retry", "confidence", "severity", "testFiles", "mrFilter", "findingScope", "boundary", "split", "archive", "micro", "coverage"] as const;
const LOOP_KEYS = ["maxRounds", "phase5Sweep"] as const;
const TIMEOUT_KEYS = [
  "skillPassMs",
  "skillBashMs",
  "ruleSkillExtractMs",
  "ripgrepMs",
  "probeHealthMs",
  "probeModelMs",
  "reviewTurnMs",
  "oneShotMs",
] as const;
const RETRY_KEYS = [
  "maxAttempts",
  "baseDelayMs",
  "maxDelayMs",
  "maxRetryAfterMs",
  "reviewTurnAttempts",
  "oneShotAttempts",
  "smokeAttempts",
  "streamAttempts",
  "streamReplayBudgetMs",
] as const;
const CONFIDENCE_KEYS = ["min"] as const;
const SEVERITY_KEYS = ["min"] as const;
const TEST_FILES_KEYS = ["skip"] as const;
const MR_FILTER_KEYS = ["excludeGlobs", "includeRegex", "excludeRegex"] as const;
const FINDING_SCOPE_KEYS = ["enabled", "contextLines"] as const;
const BOUNDARY_KEYS = ["maxFiles", "maxDiffLines", "maxDiffChars"] as const;
const SPLIT_KEYS = ["enabled", "maxShardChars", "maxShards", "contextSummaryChars"] as const;
const ARCHIVE_KEYS = ["maxArchiveBytes", "maxEntries", "maxTotalUncompressed", "maxCompressionRatio"] as const;
const MICRO_KEYS = [
  "skillBashOutputChars",
  "queryEchoChars",
  "callChainHops",
  "toolNameChars",
  "argumentsSummaryChars",
  "progressDetailChars",
] as const;
const COVERAGE_KEYS = ["repair"] as const;
const COVERAGE_REPAIR_KEYS = ["enabled", "maxRequests", "maxChars", "maxHunksPerRequest"] as const;


export function parseLimits(raw: unknown, warnings: string[]): Limits {
  if (raw === undefined) {
    return DEFAULT_LIMITS;
  }
  const limits = asObject(raw, "limits", warnings);
  assertKnownKeys(limits, LIMITS_KEYS, "limits", warnings);

  const loopObj = optionalObject(limits.loop, "limits.loop", warnings);
  assertKnownKeys(loopObj, LOOP_KEYS, "limits.loop", warnings);
  const loop: LoopLimits = {
    maxRounds: intOr(loopObj.maxRounds, "limits.loop.maxRounds", 1, 20, DEFAULT_LIMITS.loop.maxRounds),
    phase5Sweep: boolOr(
      loopObj.phase5Sweep,
      "limits.loop.phase5Sweep",
      DEFAULT_LIMITS.loop.phase5Sweep,
    ),
  };

  const timeoutsObj = optionalObject(limits.timeouts, "limits.timeouts", warnings);
  assertKnownKeys(timeoutsObj, TIMEOUT_KEYS, "limits.timeouts", warnings);
  const timeouts: TimeoutLimits = {
    skillPassMs: intOr(timeoutsObj.skillPassMs, "limits.timeouts.skillPassMs", 1_000, 3_600_000, DEFAULT_LIMITS.timeouts.skillPassMs),
    skillBashMs: intOr(timeoutsObj.skillBashMs, "limits.timeouts.skillBashMs", 1_000, 600_000, DEFAULT_LIMITS.timeouts.skillBashMs),
    ruleSkillExtractMs: intOr(timeoutsObj.ruleSkillExtractMs, "limits.timeouts.ruleSkillExtractMs", 1_000, 600_000, DEFAULT_LIMITS.timeouts.ruleSkillExtractMs),
    ripgrepMs: intOr(timeoutsObj.ripgrepMs, "limits.timeouts.ripgrepMs", 1_000, 600_000, DEFAULT_LIMITS.timeouts.ripgrepMs),
    probeHealthMs: intOr(timeoutsObj.probeHealthMs, "limits.timeouts.probeHealthMs", 1_000, 120_000, DEFAULT_LIMITS.timeouts.probeHealthMs),
    probeModelMs: intOr(timeoutsObj.probeModelMs, "limits.timeouts.probeModelMs", 10_000, 600_000, DEFAULT_LIMITS.timeouts.probeModelMs),
    reviewTurnMs: intOr(timeoutsObj.reviewTurnMs, "limits.timeouts.reviewTurnMs", 1_000, 3_600_000, DEFAULT_LIMITS.timeouts.reviewTurnMs),
    oneShotMs: intOr(timeoutsObj.oneShotMs, "limits.timeouts.oneShotMs", 1_000, 3_600_000, DEFAULT_LIMITS.timeouts.oneShotMs),
  };

  const retryObj = optionalObject(limits.retry, "limits.retry", warnings);
  assertKnownKeys(retryObj, RETRY_KEYS, "limits.retry", warnings);
  const maxAttempts = intOr(
    retryObj.maxAttempts,
    "limits.retry.maxAttempts",
    1,
    10,
    DEFAULT_LIMITS.retry.maxAttempts,
  );
  // 路径级次数缺省继承 maxAttempts；smoke 例外（缺省 1 = 探针不重试），
  // 只有显式 smokeAttempts 才改变探针行为。
  const inheritedAttempts = (key: keyof RetryLimits, raw: unknown): number =>
    intOr(raw, `limits.retry.${key}`, 1, 10, maxAttempts);
  const retry: RetryLimits = {
    maxAttempts,
    baseDelayMs: intOr(retryObj.baseDelayMs, "limits.retry.baseDelayMs", 0, 60_000, DEFAULT_LIMITS.retry.baseDelayMs),
    maxDelayMs: intOr(retryObj.maxDelayMs, "limits.retry.maxDelayMs", 0, 600_000, DEFAULT_LIMITS.retry.maxDelayMs),
    maxRetryAfterMs: intOr(retryObj.maxRetryAfterMs, "limits.retry.maxRetryAfterMs", 0, 600_000, DEFAULT_LIMITS.retry.maxRetryAfterMs),
    reviewTurnAttempts: inheritedAttempts("reviewTurnAttempts", retryObj.reviewTurnAttempts),
    oneShotAttempts: inheritedAttempts("oneShotAttempts", retryObj.oneShotAttempts),
    smokeAttempts: intOr(
      retryObj.smokeAttempts,
      "limits.retry.smokeAttempts",
      1,
      10,
      DEFAULT_LIMITS.retry.smokeAttempts,
    ),
    // 流中断重放（ADR-0077）：独立于建连次数；13 = 1 次首次 + 12 次重放
    streamAttempts: intOr(
      retryObj.streamAttempts,
      "limits.retry.streamAttempts",
      1,
      100,
      DEFAULT_LIMITS.retry.streamAttempts,
    ),
    streamReplayBudgetMs: intOr(
      retryObj.streamReplayBudgetMs,
      "limits.retry.streamReplayBudgetMs",
      0,
      3_600_000,
      DEFAULT_LIMITS.retry.streamReplayBudgetMs,
    ),
  };


  const confidenceObj = optionalObject(limits.confidence, "limits.confidence", warnings);
  assertKnownKeys(confidenceObj, CONFIDENCE_KEYS, "limits.confidence", warnings);
  const confidence: ConfidenceLimits = {
    min: numberOr(
      confidenceObj.min,
      "limits.confidence.min",
      0,
      1,
      DEFAULT_LIMITS.confidence.min,
    ),
  };

  const severityObj = optionalObject(limits.severity, "limits.severity", warnings);
  assertKnownKeys(severityObj, SEVERITY_KEYS, "limits.severity", warnings);
  const severity: SeverityLimits = {
    min: severityOr(severityObj.min, "limits.severity.min", DEFAULT_LIMITS.severity.min),
  };

  const testFilesObj = optionalObject(limits.testFiles, "limits.testFiles", warnings);
  assertKnownKeys(testFilesObj, TEST_FILES_KEYS, "limits.testFiles", warnings);
  const testFiles: TestFileLimits = {
    skip: boolOr(testFilesObj.skip, "limits.testFiles.skip", DEFAULT_LIMITS.testFiles.skip),
  };

  const mrFilterObj = optionalObject(limits.mrFilter, "limits.mrFilter", warnings);
  assertKnownKeys(mrFilterObj, MR_FILTER_KEYS, "limits.mrFilter", warnings);
  const mrFilter: MrFilterLimits = {
    excludeGlobs: parseGlobList(
      mrFilterObj.excludeGlobs,
      "limits.mrFilter.excludeGlobs",
      DEFAULT_LIMITS.mrFilter.excludeGlobs,
    ),
    includeRegex: parseRegexList(
      mrFilterObj.includeRegex,
      "limits.mrFilter.includeRegex",
      DEFAULT_LIMITS.mrFilter.includeRegex,
    ),
    excludeRegex: parseRegexList(
      mrFilterObj.excludeRegex,
      "limits.mrFilter.excludeRegex",
      DEFAULT_LIMITS.mrFilter.excludeRegex,
    ),
  };

  const findingScopeObj = optionalObject(limits.findingScope, "limits.findingScope", warnings);
  assertKnownKeys(findingScopeObj, FINDING_SCOPE_KEYS, "limits.findingScope", warnings);
  const findingScope: FindingScopeLimits = {
    enabled: boolOr(
      findingScopeObj.enabled,
      "limits.findingScope.enabled",
      DEFAULT_LIMITS.findingScope.enabled,
    ),
    contextLines: intOr(
      findingScopeObj.contextLines,
      "limits.findingScope.contextLines",
      0,
      2_000,
      DEFAULT_LIMITS.findingScope.contextLines,
    ),
  };

  const boundaryObj = optionalObject(limits.boundary, "limits.boundary", warnings);
  assertKnownKeys(boundaryObj, BOUNDARY_KEYS, "limits.boundary", warnings);
  const maxFiles =
    optionalInt(boundaryObj.maxFiles, "limits.boundary.maxFiles", {
      min: 1,
      max: 10_000,
      nullable: true,
    }) ?? DEFAULT_LIMITS.boundary.maxFiles;
  const maxDiffLines =
    optionalInt(boundaryObj.maxDiffLines, "limits.boundary.maxDiffLines", {
      min: 1,
      max: 1_000_000,
      nullable: true,
    }) ?? DEFAULT_LIMITS.boundary.maxDiffLines;
  const boundary: BoundaryLimits = {
    maxFiles: boundaryObj.maxFiles === null ? null : maxFiles,
    maxDiffLines: boundaryObj.maxDiffLines === null ? null : maxDiffLines,
    maxDiffChars:
      boundaryObj.maxDiffChars === null
        ? null
        : (optionalInt(boundaryObj.maxDiffChars, "limits.boundary.maxDiffChars", {
            min: 1_000,
            max: 100_000_000,
            nullable: true,
          }) ?? DEFAULT_LIMITS.boundary.maxDiffChars),
  };

  const splitObj = optionalObject(limits.split, "limits.split", warnings);
  assertKnownKeys(splitObj, SPLIT_KEYS, "limits.split", warnings);
  const split: SplitLimits = {
    enabled: boolOr(splitObj.enabled, "limits.split.enabled", DEFAULT_LIMITS.split.enabled),
    maxShardChars: intOr(
      splitObj.maxShardChars,
      "limits.split.maxShardChars",
      10_000,
      100_000_000,
      DEFAULT_LIMITS.split.maxShardChars,
    ),
    maxShards: intOr(splitObj.maxShards, "limits.split.maxShards", 1, 64, DEFAULT_LIMITS.split.maxShards),
    contextSummaryChars: intOr(
      splitObj.contextSummaryChars,
      "limits.split.contextSummaryChars",
      1_000,
      64_000,
      DEFAULT_LIMITS.split.contextSummaryChars,
    ),
  };

  const archiveObj = optionalObject(limits.archive, "limits.archive", warnings);
  assertKnownKeys(archiveObj, ARCHIVE_KEYS, "limits.archive", warnings);
  const archive: ArchiveLimits = {
    maxArchiveBytes: intOr(archiveObj.maxArchiveBytes, "limits.archive.maxArchiveBytes", 1, 1_000_000_000, DEFAULT_LIMITS.archive.maxArchiveBytes),
    maxEntries: intOr(archiveObj.maxEntries, "limits.archive.maxEntries", 1, 100_000, DEFAULT_LIMITS.archive.maxEntries),
    maxTotalUncompressed: intOr(archiveObj.maxTotalUncompressed, "limits.archive.maxTotalUncompressed", 1, 10_000_000_000, DEFAULT_LIMITS.archive.maxTotalUncompressed),
    maxCompressionRatio: intOr(archiveObj.maxCompressionRatio, "limits.archive.maxCompressionRatio", 1, 10_000, DEFAULT_LIMITS.archive.maxCompressionRatio),
  };

  const microObj = optionalObject(limits.micro, "limits.micro", warnings);
  assertKnownKeys(microObj, MICRO_KEYS, "limits.micro", warnings);
  const micro: MicroLimits = {
    skillBashOutputChars: intOr(microObj.skillBashOutputChars, "limits.micro.skillBashOutputChars", 1, 10_000_000, DEFAULT_LIMITS.micro.skillBashOutputChars),
    queryEchoChars: intOr(microObj.queryEchoChars, "limits.micro.queryEchoChars", 1, 10_000, DEFAULT_LIMITS.micro.queryEchoChars),
    callChainHops: intOr(microObj.callChainHops, "limits.micro.callChainHops", 1, 3, DEFAULT_LIMITS.micro.callChainHops),
    toolNameChars: intOr(microObj.toolNameChars, "limits.micro.toolNameChars", 1, 10_000, DEFAULT_LIMITS.micro.toolNameChars),
    argumentsSummaryChars: intOr(microObj.argumentsSummaryChars, "limits.micro.argumentsSummaryChars", 1, 10_000, DEFAULT_LIMITS.micro.argumentsSummaryChars),
    progressDetailChars: intOr(microObj.progressDetailChars, "limits.micro.progressDetailChars", 1, 10_000, DEFAULT_LIMITS.micro.progressDetailChars),
  };


  const coverageObj = optionalObject(limits.coverage, "limits.coverage", warnings);
  assertKnownKeys(coverageObj, COVERAGE_KEYS, "limits.coverage", warnings);
  const repairObj = optionalObject(coverageObj.repair, "limits.coverage.repair", warnings);
  assertKnownKeys(repairObj, COVERAGE_REPAIR_KEYS, "limits.coverage.repair", warnings);
  const coverage: CoverageLimits = {
    repair: {
      enabled: boolOr(
        repairObj.enabled,
        "limits.coverage.repair.enabled",
        DEFAULT_LIMITS.coverage.repair.enabled,
      ),
      maxRequests: intOr(
        repairObj.maxRequests,
        "limits.coverage.repair.maxRequests",
        0,
        64,
        DEFAULT_LIMITS.coverage.repair.maxRequests,
      ),
      maxChars: intOr(
        repairObj.maxChars,
        "limits.coverage.repair.maxChars",
        1_000,
        500_000,
        DEFAULT_LIMITS.coverage.repair.maxChars,
      ),
      maxHunksPerRequest: intOr(
        repairObj.maxHunksPerRequest,
        "limits.coverage.repair.maxHunksPerRequest",
        1,
        50,
        DEFAULT_LIMITS.coverage.repair.maxHunksPerRequest,
      ),
    },
  };

  return { loop, timeouts, retry, confidence, severity, testFiles, mrFilter, findingScope, boundary, split, archive, micro, coverage };
}
