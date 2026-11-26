import type { CoverageLedger } from "../contracts/coverage.js";
import type { Finding } from "../contracts/finding.js";
import type { LlmUsage } from "../contracts/llm.js";
import type { RepoSnapshotFile } from "../loop/messages.js";

/**
 * repo-spike：全仓检视的**一次性探针**。
 *
 * 目标不是产品化 scan，而是用最小改动验证：
 * - 仓库文件枚举 / 分组能否确定性工作；
 * - 把每个文件合成为「新文件」unified diff 后，现有 MR 流水线能否跑通；
 * - 按目录/文件数分组、每组一次 `runReviewOutcome` 是否可控；
 * - 规则 Skill 能否透传。
 *
 * 明确不承诺：行锚点语义、覆盖账本、scan 专用提示词、评测口径。
 */
export type RepoSpikeGroupBy = "directory" | "files" | "language" | "none";

export interface RepoSpikeOptions {
  readonly repoPath: string;
  readonly outDir: string;
  readonly groupBy: RepoSpikeGroupBy;
  readonly maxFilesPerGroup: number;
  readonly maxGroupChars: number;
  readonly maxGroups: number;
  readonly maxFiles: number;
  readonly maxFileChars: number;
  readonly maxRounds: number;
  readonly groupConcurrency: number;
  /** 是否把测试文件纳入检视（缺省 false，与全仓扫描契约一致） */
  readonly includeTests: boolean;
  readonly dryRun: boolean;
  /** 从 `<out>/job.json` 续跑：校验快照 / 配置 / 计划 hash 后跳过已完成组 */
  readonly resume?: boolean;
  /** 总 token 预算（含缓存）；0 / 缺省 = 不限；达到后停止派发新组 */
  readonly maxTotalTokens?: number;
  /** 单组最多尝试次数（仅临时错误重试；缺省 2） */
  readonly groupAttempts?: number;
  /** 只检视该仓库相对路径前缀（POSIX，空 = 全仓） */
  readonly pathPrefix?: string;
  /** 只检视这些仓库相对路径（POSIX，精确匹配；用于补跑指定组/文件） */
  readonly files?: readonly string[];
  /** 路径白名单正则（`--include`）：命中任一才保留；空 = 不过滤 */
  readonly includeRegexes?: readonly RegExp[];
  /** 路径黑名单正则（`--exclude`）：命中即剔除，优先于白名单 */
  readonly excludeRegexes?: readonly RegExp[];
  readonly ruleSkillZips?: readonly string[];
  readonly ruleSkillDirs?: readonly string[];
  readonly strictRuleSkill?: boolean;
  readonly onProgress?: (line: string) => void;
}

export interface RepoFile {
  /** 仓库相对 POSIX 路径 */
  readonly path: string;
  readonly size: number;
}

export interface SkippedFile {
  readonly path: string;
  readonly reason: string;
}

export interface EnumeratedRepo {
  readonly files: readonly RepoFile[];
  readonly skipped: readonly SkippedFile[];
  /** 发现的总数（含被过滤的） */
  readonly discovered: number;
}

export interface RepoGroup {
  /** 1-based 组号 */
  readonly index: number;
  readonly key: string;
  readonly files: readonly RepoFile[];
  /** 估算字符数（文件大小 + diff 头开销） */
  readonly estimatedChars: number;
  /** 单文件估算超过 maxGroupChars、按大文件例外单独成组 */
  readonly soloLarge?: boolean;
}

export interface GroupPlan {
  readonly groups: readonly RepoGroup[];
  readonly skipped: readonly SkippedFile[];
}

export interface SyntheticGroup {
  readonly group: RepoGroup;
  readonly diff: string;
  readonly files: readonly string[];
  /** 模型可见的文件快照（repo 模式初始消息用；无 diff 头） */
  readonly snapshot: readonly RepoSnapshotFile[];
  readonly chars: number;
  readonly skipped: readonly SkippedFile[];
}

export type RepoSpikeGroupStatus = "reviewed" | "skipped" | "failed";

/**
 * 一批（组）检视完成后的上报材料（ADR-0117）：组内实际送检文件 + 已合并
 * findings。CLI 用它组装 `fullRepoReportReviewResult`；repo-spike 不认识 MCP。
 */
export interface RepoReviewedBatch {
  readonly index: number;
  readonly key: string;
  /** 该组实际送检的文件（仓库相对 POSIX 路径；不含组内跳过） */
  readonly files: readonly string[];
  readonly findings: readonly Finding[];
}

export interface RepoSpikeGroupOutcome {
  readonly index: number;
  readonly key: string;
  readonly files: readonly string[];
  readonly diffChars: number;
  readonly status: RepoSpikeGroupStatus;
  readonly findingsCount: number;
  /** 内部合并用；写结果文件时会剥掉，避免 groups[] 重复存整份 findings */
  readonly findings?: readonly Finding[];
  readonly runId?: string;
  readonly usage?: LlmUsage;
  readonly coverage?: CoverageLedger;
  readonly recordPath?: string;
  readonly auditPath?: string;
  readonly reviewsPath?: string;
  readonly transcriptPath?: string;
  readonly error?: string;
  readonly skipReason?: string;
}

export interface RepoSpikeResult {
  readonly schemaVersion: 1;
  readonly mode: "repo";
  readonly generatedAt: string;
  readonly repoPath: string;
  readonly outDir: string;
  readonly groupBy: RepoSpikeGroupBy;
  readonly files: {
    readonly discovered: number;
    readonly selected: number;
    readonly skipped: number;
  };
  readonly groups: readonly RepoSpikeGroupOutcome[];
  readonly findings: readonly Finding[];
  readonly usage: LlmUsage;
  /** 文件级三态覆盖账本（repo 模式专用；不写 MR 的 hunk 账本） */
  readonly coverage: RepoCoverage;
  readonly skippedFiles: readonly SkippedFile[];
  readonly errors: readonly string[];
}

/** 文件级覆盖状态：已检视且有 finding / 已检视无 finding / 未触达 */
export type RepoCoverageState = "candidate" | "no-issue" | "not-reached";

/** 未触达的稳定原因（枚举阶段 / 分组 / 执行 / 预算） */
export type RepoCoverageReason =
  | "failed-group"
  | "group-too-large"
  | "too-large"
  | "binary"
  | "unsupported-extension"
  | "excluded-path"
  | "not-a-regular-file"
  | "empty"
  | "read-failed"
  | "no-reviewable-files"
  | "budget-exhausted"
  | "over-max-files"
  | "unknown";

export interface RepoCoverageFile {
  /** 仓库相对 POSIX 路径 */
  readonly path: string;
  readonly state: RepoCoverageState;
  /** 仅 `not-reached` 在场 */
  readonly reason?: RepoCoverageReason;
  /** 仅 `candidate` 在场；组内 finding id，保持组内顺序 */
  readonly findingIds?: readonly string[];
}

export interface RepoCoverageSummary {
  readonly selected: number;
  readonly candidate: number;
  readonly noIssue: number;
  readonly notReached: number;
}

export interface RepoCoverage {
  readonly summary: RepoCoverageSummary;
  /** 按枚举顺序（路径字典序）排列；每个 selected 文件恰好一条 */
  readonly files: readonly RepoCoverageFile[];
}

export interface RepoSpikePlan {
  readonly schemaVersion: 1;
  readonly mode: "repo-review-plan";
  readonly generatedAt: string;
  readonly repoPath: string;
  readonly outDir: string;
  readonly groupBy: RepoSpikeGroupBy;
  readonly files: {
    readonly discovered: number;
    readonly selected: number;
    readonly skipped: number;
  };
  readonly groups: readonly {
    readonly index: number;
    readonly key: string;
    readonly files: readonly string[];
    readonly diffChars: number;
    /** 单文件超过 maxGroupChars、按大文件例外单独成组 */
    readonly soloLarge?: boolean;
  }[];
  readonly skippedFiles: readonly SkippedFile[];
}
