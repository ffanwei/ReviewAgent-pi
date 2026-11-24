import type { CoverageLedger } from "../contracts/coverage.js";
import type { Finding } from "../contracts/finding.js";
import type { LlmUsage } from "../contracts/llm.js";

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
  /** 只检视该仓库相对路径前缀（POSIX，空 = 全仓） */
  readonly pathPrefix?: string;
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
}

export interface GroupPlan {
  readonly groups: readonly RepoGroup[];
  readonly skipped: readonly SkippedFile[];
}

export interface SyntheticGroup {
  readonly group: RepoGroup;
  readonly diff: string;
  readonly files: readonly string[];
  readonly chars: number;
  readonly skipped: readonly SkippedFile[];
}

export type RepoSpikeGroupStatus = "reviewed" | "skipped" | "failed";

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
  readonly mode: "repo-spike";
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
  readonly coverage?: CoverageLedger;
  readonly skippedFiles: readonly SkippedFile[];
  readonly errors: readonly string[];
}

export interface RepoSpikePlan {
  readonly schemaVersion: 1;
  readonly mode: "repo-spike-plan";
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
  }[];
  readonly skippedFiles: readonly SkippedFile[];
}
