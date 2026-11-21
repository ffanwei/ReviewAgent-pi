// 覆盖账本契约（F-01a）：文件 × hunk 三态。
//
// 纯数据形状，不含运行时逻辑。账本从本遍 diff 确定性派生，用于回答
// 「哪些文件 / hunk 被真正审视过」，而不是只统计 findings。
// 纪律：
// - `candidate` 由 finding 按新侧行号确定性回填；
// - `no-issue` 只由结构化回执产生（F-01b 补漏），不靠提示词自称；
// - 未被回填的 hunk 一律 `not-reached`，不得静默成「已审」。

/** 单个 hunk 的覆盖状态 */
export type CoverageStatus = "candidate" | "no-issue" | "not-reached";

/** `not-reached` 的机读原因（封闭枚举；顺序 = 报告顺序） */
export const NOT_REACHED_CAUSES = [
  "no-signal",
  "truncated",
  "budget",
  "output-truncated",
  "flow-error",
  "round-cap",
] as const;

export type NotReachedCause = (typeof NOT_REACHED_CAUSES)[number];

/** 候选来源（同一 hunk 可被主会话 / sweep / skill / 补漏分别命中） */
export type CandidateSource = "main" | "sweep" | "skill" | "repair";

/** 账本内单个 hunk 的定位（file + 文件内 1-based 序号） */
export interface CoverageHunkRef {
  readonly file: string;
  readonly hunkIndex: number;
}

/** diff 行区间（与 `diff/hunk.ts` 的 HunkHeader 同口径） */
export interface CoverageLineRange {
  /** 起始行（1-based；0 仅用于新增/删除文件的一侧空区间） */
  readonly start: number;
  /** 行数（0 = 该侧无行） */
  readonly count: number;
}

/** 一个 hunk 的覆盖记录 */
export interface HunkCoverage {
  /** 文件内 1-based hunk 序号（含被截取丢弃的 hunk） */
  readonly index: number;
  readonly old: CoverageLineRange;
  readonly new: CoverageLineRange;
  readonly status: CoverageStatus;
  /** candidate：支撑该 hunk 的 finding id（至少一条） */
  readonly findingIds?: readonly string[];
  /** candidate：候选来源（去重、首见序） */
  readonly sources?: readonly CandidateSource[];
  /** no-issue 的理由；not-reached 时可带原因说明 */
  readonly reason?: string;
  /** 仅 not-reached：机读原因 */
  readonly cause?: NotReachedCause;
}

/** 被排除、不进入覆盖分母的文件原因 */
export type CoverageExclusionReason = "deleted" | "binary" | "no-hunks";

export interface ExcludedFileCoverage {
  readonly path: string;
  readonly reason: CoverageExclusionReason;
}

export interface FileCoverage {
  readonly file: string;
  readonly hunks: readonly HunkCoverage[];
}

export interface CoverageCounts {
  readonly hunks: number;
  readonly candidate: number;
  readonly noIssue: number;
  readonly notReached: number;
  /** finding 找不到对应 hunk 的次数（文件不在账本 / 行号落在 hunk 外） */
  readonly outOfHunk: number;
  /** not-reached 的原因分布；恒含全部键（未命中为 0） */
  readonly byCause: Readonly<Record<NotReachedCause, number>>;
}

export interface CoverageLedger {
  /** 按文件路径排序，保证分片聚合与并行顺序无关 */
  readonly files: readonly FileCoverage[];
  readonly excluded: readonly ExcludedFileCoverage[];
  /** 无法归属到任何文件的 hunk 数（宽松解析保留；不参与分区恒等式） */
  readonly unattributedHunks: number;
  readonly counts: CoverageCounts;
}

/**
 * 被丢弃的完整 hunk（ADR-0070）。
 * `index` = 该文件原始 hunk 序（1-based），用于把丢弃区间接回 kept hunk 之后。
 */
export interface DroppedHunkRange {
  readonly index: number;
  readonly old: CoverageLineRange;
  readonly new: CoverageLineRange;
}

export interface TruncatedHunkRange extends DroppedHunkRange {
  readonly file: string;
}

export interface BuildCoverageOptions {
  readonly truncated?: readonly TruncatedHunkRange[];
}

/** 回填所需的最小 finding 形状（避免账本模块依赖完整 Finding） */
export interface CoverageFindingRef {
  readonly id: string;
  readonly file: string;
  readonly line: number;
}

/** 补漏回执：显式声明某个 hunk 审过且没有问题 */
export interface NoIssueClaim {
  readonly file: string;
  readonly hunkIndex: number;
  readonly reason: string;
}
