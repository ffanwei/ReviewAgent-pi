// run 级留痕契约（测量常量面：审计投影的形状与 DSH 线一致，
// 冻结 analyze 脚本据此消费 pi RunRecord）。随模块落地逐步补齐。

import type { CoverageLedger, DroppedHunkRange } from "./coverage.js";
import type { Finding } from "./finding.js";
import type { LedgerEntry } from "./ledger.js";
import type { LlmUsage, ToolSchema, WireMessage } from "./llm.js";
import type { UsageLedgerSummary } from "../observability/usage-ledger.js";

/** 六阶段名（固定顺序；phaseLog 留痕用） */
export type ReviewPhase =
  | "Change Understanding"
  | "Code Understanding"
  | "Risk Classification"
  | "Context Decision"
  | "Context Retrieval"
  | "Deep Reasoning"
  | "Evidence Verification";

/** 模型 JSON 回复失败的分级原因（P0 宽松提取器；写进 phaseLog.parseFailure） */
export type ModelJsonFailureKind =
  | "empty"
  | "truncated"
  | "not-json"
  | "missing-key"
  | "duplicate-key";

/**
 * 阶段回复解析失败留痕（P1）：**仅在失败时在场**——成功 run 的 phaseLog
 * 形状逐字节不变。`expected` 是调用方期望的目标键类别，`kind` 是分级原因。
 */
export interface PhaseParseFailure {
  readonly expected: "candidates" | "verdicts";
  readonly kind: ModelJsonFailureKind;
}

/** 一个阶段的执行留痕 */
export interface PhaseRecord {
  readonly round: number;
  readonly phase: ReviewPhase;
  readonly requestCount: number;
  readonly note?: string;
  /** 解析失败的可机读留痕（只在失败时出现；CLI 据此在 stderr 报一行） */
  readonly parseFailure?: PhaseParseFailure;
  /** 同一阶段因解析失败追加的模型请求次数（缺省 = 未重试） */
  readonly parseRetries?: number;
  /** 经历恢复后是否解析成功（仅在发生过恢复/失败时出现） */
  readonly parseRecovered?: boolean;
  /** 解析恢复来源：同会话重试 / 离线 salvage / 短窗口 LLM 修复 */
  readonly parseRecovery?: "retry" | "offline" | "short-llm";
}

/** 一次工具调用的留痕 */
export interface ToolCallRecord {
  readonly name: string;
  readonly argumentsJson: string;
  readonly resultSummary: string;
}

/** 候选结论被拦截的留痕（候选拦截链每候选至多一条，首个失败阶段） */
export interface CandidateRejection {
  readonly candidateId: string;
  readonly stage: RejectionStage;
  /** 英文的拦截原因 */
  readonly reason: string;
}

/**
 * 拦截阶段顺序：Schema 校验 → 证据检查 → 验证裁决 → 位置范围 → 重复 id。
 * `OUT_OF_SCOPE` 由 `limits.findingScope` 控制（缺省开启）：意见必须落在本遍
 * diff 的变更 hunk（含前后 `contextLines` 行）内。
 * ADR-0090：`NON_ENGLISH` 已随中文原生检视退役。
 */
export type RejectionStage =
  | "SCHEMA_INVALID"
  | "NO_EVIDENCE"
  | "EVIDENCE_UNGROUNDED"
  | "VERIFICATION_FAILED"
  | "OUT_OF_SCOPE"
  | "DUPLICATE_ID";

/** Cache Break 原因分类（相邻请求字节前缀分歧定位） */
export type CacheBreakReason =
  | "MODEL_CHANGED"
  | "SYSTEM_PROMPT_CHANGED"
  | "TOOL_SCHEMA_CHANGED"
  | "CONTEXT_REORDERED";

/** 分歧落点分区（报告归因口径：model 段 / Zone A 稳定前缀 / Zone B/C 上下文） */
export type CacheBreakZone = "MODEL" | "A" | "B/C";

export interface CacheBreakRecord {
  /** 相邻对中后一请求的序号（1-based） */
  readonly requestIndex: number;
  readonly reason: CacheBreakReason;
  readonly zone: CacheBreakZone;
  /** 规范字节布局（model 段 → messages 段 → tools 段）内的首个分歧偏移 */
  readonly divergeByteOffset: number;
}

/** 一次 review 的请求面（onPayload 序列化点捕获；审计 requests[] 即此形状） */
export interface WireRequest {
  readonly model: string;
  readonly effort: string;
  readonly messages: readonly WireMessage[];
  readonly tools: readonly ToolSchema[];
  /** JSON.stringify(payload) 原文（可原样重放） */
  readonly wireBody: string;
}

/** MR 边界护栏的降级原因（#12：前两类 = 度量完成但超界；末类 = 结构不可度量） */
export type MrBoundaryReason = "too-many-files" | "diff-too-large" | "boundary-unmeasurable";

/** MR 边界护栏降级留痕（#12：审计文件尾键 mrBoundary 的形状；界内缺省省键） */
export interface MrBoundaryRecord {
  /** 度量到的文件数（boundary-unmeasurable 时为 null——度量未完成） */
  readonly files: number | null;
  /** 度量到的变更行数 = 新增 + 删除（boundary-unmeasurable 时为 null） */
  readonly changedLines: number | null;
  /** 降级决策恒 true：该记录只在降级时在场（零静默纪律——界内无此键） */
  readonly degraded: true;
  readonly reason: MrBoundaryReason;
}

/**
 * 输入预过滤的剔除原因（大 diff 第一期：只剔噪声，不改检视语义）；
 * `test` = 配置驱动的测试文件跳过；`exclude` = 配置驱动的 glob 跳过（ADR-0069）；
 * `not-included` = 不在检视范围白名单内；`regex-exclude` = 命中范围正则排除
 * （CLI 或配置，ADR-0078）。
 */
export type MrFilterReason =
  | "lockfile"
  | "generated"
  | "minified"
  | "binary"
  | "test"
  | "exclude"
  | "not-included"
  | "regex-exclude";

/** 检视范围正则的来源（ADR-0078：CLI 覆盖配置，每个维度至多一条） */
export type MrFilterSource = "cli" | "config";

/** 生效的一条范围规则名单（原文进审计，保证 run 可复现） */
export interface MrFilterPatternSet {
  readonly source: MrFilterSource;
  readonly patterns: readonly string[];
}

/** 被剔除的单个文件（审计窄投影，最多保留前 20 条） */
export interface MrFilteredPath {
  readonly path: string;
  readonly reason: MrFilterReason;
}

/**
 * 输入预过滤留痕（审计文件尾键 mrFilter 的形状；无剔除且未配置范围规则时省键）。
 * `reasons` 恒含八类键（未命中为 0），便于下游按固定形状读数。
 * `filters` 只在本次 run 配置了 include/exclude 正则时在场——规则原文是
 * 「这次到底按什么范围筛的」的唯一证据。
 */
export interface MrFilterRecord {
  readonly droppedFiles: number;
  readonly droppedChars: number;
  readonly reasons: Readonly<Record<MrFilterReason, number>>;
  readonly paths: readonly MrFilteredPath[];
  readonly filters?: {
    readonly include?: MrFilterPatternSet;
    readonly exclude?: MrFilterPatternSet;
  };
}

/** 规则 Skill 审计留痕的诊断项（内核装载 warning 的窄投影） */
export interface RuleSkillAuditDiagnostic {
  readonly code: string;
  readonly path: string;
}

/**
 * 规则 Skill 装载留痕（ADR-0014 / ADR-0018：审计文件尾键）。
 * 每装载一个 zip 一条，顺序 = CLI 传入顺序（或约定目录的文件名序）。
 * `source` = 归档来源（仓库相对 POSIX）；`digest` = zip 内容 sha256；
 * `name` = 装载的 skill 名（降级时为空串）；`degradedReason` 在场即降级；
 * `diagnostics` = 内核装载 warning（path 已净化为缓存目录相对形态）。
 * 恒为数组（N=0 ⇒ 空数组）。
 */
export interface RuleSkillAudit {
  readonly source: string;
  /** 输入形态（ADR-0018）：仅目录形态在场；zip 形态省略以保持历史审计字节不变 */
  readonly kind?: "dir";
  readonly digest: string;
  readonly name: string;
  readonly degradedReason?: string;
  readonly diagnostics?: readonly RuleSkillAuditDiagnostic[];
}

/** skill pass 状态三态（ADR-0014：跑通 0 候选是合法 empty，不是降级） */
export type RuleSkillPassStatus = "ok" | "empty" | "failed";

/** 失败发生的环节（把「执行失败」进一步可诊断化；装载降级只进 `ruleSkill[]`，bash 命令被拒绝不算失败） */
export type RuleSkillFailureStage = "parse" | "session";

/**
 * 一次 skill 会话的执行留痕（ADR-0014：粒度 = round × skill）。
 * `phaseLog` 不承载 skill 回合——两者并列，各自单纯。
 *
 * - `candidateCount` = 该会话原始产出的候选条数（未去重）；
 * - `mergedCount` = 被去重合并掉的条数（含「与主候选重复」被合并的；账目闭合：
 *   `candidateCount - mergedCount` = 实际并入候选流的条数）；
 * - `ruleIds` = 该会话候选引用的规则 id（首见序、去重）；
 * - `transcriptFile` = 独立转录文件名（run 输出目录内，basename）；
 * - `degradedReason` / `failureStage` = 失败或降级的可诊断留痕。
 */
export interface RuleSkillPassRecord {
  readonly round: number;
  readonly skill: string;
  readonly status: RuleSkillPassStatus;
  readonly requestCount: number;
  readonly toolCallCount: number;
  readonly candidateCount: number;
  readonly mergedCount: number;
  readonly ruleIds?: readonly string[];
  readonly transcriptFile?: string;
  readonly degradedReason?: string;
  readonly failureStage?: RuleSkillFailureStage;
}

/**
 * 单片审计留痕（ADR-0039 决策 7）：分片模式下聚合审计尾键 `shards[]` 的条目。
 * 片内完整审计（requests 等正文）落在 `audit/shards/attempt-<…>/sNN/<runId>.json`。
 */
export interface ShardAuditRecord {
  /** 1-based 片号 */
  readonly index: number;
  /** 本片文件块数 */
  readonly files: number;
  /** 本片 diff 字符数 */
  readonly chars: number;
  /** 本片包含的仓库相对路径（排障用；diff 顺序） */
  readonly filePaths: readonly string[];
  /** 该片首次模型请求时刻派生的 runId */
  readonly runId: string;
  readonly status: "ok" | "failed";
  /** 六阶段循环是否完整走完 */
  readonly complete: boolean;
  readonly truncated: boolean;
  /** 该片命中的边界降级文案（全局边界护栏派生；未降级省键） */
  readonly domainWarning?: string;
  readonly usage: LlmUsage;
  readonly rounds: number;
  readonly toolCalls: number;
}

/**
 * 单文件块超预算的截取留痕（ADR-0070）。
 *
 * 纪律：只丢弃**整 hunk**（保留文件头 + 前缀若干个完整 hunk），绝不切 hunk
 * 字节——行号与 evidence 链仍然自洽。`keptHunks >= 1` 是硬约束（首个 hunk 单独
 * 超预算时保持原样，宁可超目标也不留一个只有文件头的空块）。
 */
export interface ShardTruncationRecord {
  /** 仓库相对路径（diff 前置块为空串） */
  readonly path: string;
  /** 原块字符数 */
  readonly originalChars: number;
  /** 截取后字符数 */
  readonly keptChars: number;
  /** 原块 hunk 总数 */
  readonly hunks: number;
  /** 保留的完整 hunk 数 */
  readonly keptHunks: number;
  /** 丢弃的完整 hunk 数（= hunks - keptHunks） */
  readonly droppedHunks: number;
  /**
   * 被丢弃 hunk 的区间与文件内 1-based 序号（ADR-0070）。
   * 覆盖账本据此把丢弃区间接回分母并标 `not-reached(truncated)`；
   * diff 前置块（path = ""）不产生区间。
   */
  readonly dropped: readonly DroppedHunkRange[];
  /** 被丢弃 hunk 里的新增行数 */
  readonly droppedAdded: number;
  /** 被丢弃 hunk 里的删除行数 */
  readonly droppedRemoved: number;
}

/**
 * 中文 tips 置信度过滤留痕（ADR-0052）：审计 / run.json 尾键。
 * `droppedTips` = 低于 `minConfidence` 而被丢弃的 merged findings 条数。
 */
export interface TipsFilterRecord {
  readonly minConfidence: number;
  readonly droppedTips: number;
}

/**
 * 中文 tips / MCP 上报严重级过滤留痕：审计 / run.json 尾键。
 * `droppedTips` = 低于 `minSeverity` 而被丢弃的 merged findings 条数。
 */
export interface SeverityFilterRecord {
  readonly minSeverity: Finding["severity"];
  readonly droppedTips: number;
}

/**
 * 通用检视建议类抑制留痕（MR + repo）：只统计被过滤的通用候选；
 * 规则 Skill 候选不走这个过滤器。
 */
export interface GenericReviewSuppressionRecord {
  readonly policy: {
    readonly severities: readonly string[];
    readonly categories: readonly string[];
  };
  readonly dropped: number;
  readonly bySeverity: Readonly<Record<string, number>>;
  readonly byCategory: Readonly<Record<string, number>>;
}

/**
 * 候选字段归一化的逐条留痕（字段修复；只在真有修复时进审计尾键）。
 * `source` 区分本地确定性修复与有界一次性模型修复；`fields` 是被修复的
 * 字段名（不记录值，避免把模型原文复制进审计）。
 */
export interface CandidateNormalizationRecord {
  readonly round: number;
  readonly candidateId: string;
  readonly fields: readonly string[];
  readonly source: "deterministic" | "one-shot";
}

/** 候选拦截链各阶段的计数（只在有拦截时进审计尾键；固定形状便于下游读数） */
export type CandidateRejectionCounts = Readonly<Record<RejectionStage, number>>;

/**
 * 模型替换留痕（ADR-0080）：只在 `--model` 因 model-not-found 降级到
 * `config.model.default` 时在场；无替换整键缺席（零字节漂移）。
 *
 * `requested` 是用户传的 wire id（已剥前缀），`used` 是本 run 实际生效的 id。
 * 一个 run 只有一个生效模型——替换在开跑前定死，不随分片漂移。
 */
export interface ModelFallbackRecord {
  readonly requested: string;
  readonly used: string;
  readonly reason: "model-not-found";
}

/**
 * Skill 包检视留痕：本次 diff 命中的 skill 根、命中的文档文件，以及按
 * 「整文件放行」处理的位置门集合。无命中时整键缺席（零漂移）。
 *
 * 识别是确定性的：从变更文件向上找最近的 `SKILL.md` / `skill.md`；
 * `roots` / `docFiles` / `wholeFilePaths` 均按 diff 首见序去重。
 */
export interface SkillReviewRecord {
  readonly roots: readonly string[];
  readonly docFiles: readonly string[];
  readonly wholeFilePaths: readonly string[];
  /** 确定性引用核对：扫描到的相对引用总数（存在 + 缺失） */
  readonly checkedReferences?: number;
  /** 缺失引用（`manifest:line target` 形态）；无缺失时省键 */
  readonly missingReferences?: readonly string[];
}

/** 循环运行期的审计累积面（AuditFileContent 与 AuditLight 的共同来源） */
/**
 * 证据接地审计（F-04）：只记计数，不复制 evidence 正文。
 * - `checked` = 进入核对的候选数；
 * - `grounded` / `unverified` / `unverifiable` 为三态计数；
 * - `dropped` = drop 模式下因 unverified 被拒绝的候选数。
 */
export interface EvidenceGroundingAudit {
  readonly mode: "warn" | "drop";
  readonly checked: number;
  readonly grounded: number;
  readonly unverified: number;
  readonly unverifiable: number;
  readonly dropped: number;
}

/**
 * 检索预算留痕（F-08b）：只在 `limits.retrieval` 任一上限 > 0 时出现。
 * 计数器覆盖整个 pass（分片路径按片独立）。
 */
export interface RetrievalBudgetAudit {
  readonly maxReadsPerFile: number;
  readonly maxConsecutiveEmptySearches: number;
  readonly maxReadCharsPerRun: number;
  readonly reads: number;
  readonly readSkips: number;
  readonly searchSkips: number;
  readonly emptySearches: number;
  readonly readChars: number;
}

/**
 * Finding 路径修复留痕：模型把 `file` 写错几个字符时，按已知文件全集修正为
 * 真实路径（ADR-0120）。`distance` = 宽松匹配 0 / 编辑距离 1..N。
 */
export interface PathRepairRecord {
  readonly from: string;
  readonly to: string;
  readonly distance: number;
}

export interface RunAudit {
  readonly requests: readonly WireRequest[];
  readonly toolCallLog: readonly ToolCallRecord[];
  readonly phaseLog: readonly PhaseRecord[];
  readonly rejections: readonly CandidateRejection[];
  readonly cacheBreaks: readonly CacheBreakRecord[];
  readonly truncated: boolean;
  readonly truncationReasons: readonly string[];
  /** Context Ledger 快照（恒投影；零工具调用为空数组） */
  readonly ledger?: readonly LedgerEntry[];
  /** 规则 Skill 装载留痕（恒为数组：N=0 ⇒ 空数组） */
  readonly ruleSkill?: readonly RuleSkillAudit[];
  /** skill 会话执行留痕（粒度 round × skill；恒为数组：N=0 ⇒ 空数组） */
  readonly skillPassLog?: readonly RuleSkillPassRecord[];
  /**
   * 分片留痕（ADR-0039）：只在分片模式出现；单片路径整键缺席（零漂移）。
   * 聚合审计里 `requests` 等正文为空数组，正文在各片审计文件里。
   */
  readonly shards?: readonly ShardAuditRecord[];
  /**
   * 单文件块超预算截取留痕（ADR-0070）：只在真有截取时在场（零漂移）。
   * 与 `shards` 并列；CLI 据此在 stderr 报一行。
   */
  readonly shardTruncation?: readonly ShardTruncationRecord[];
  /** 中文 tips 置信度过滤留痕（ADR-0052）：配置缺席时省键 */
  readonly tipsFilter?: TipsFilterRecord;
  /** 中文 tips / MCP 上报严重级过滤留痕：配置缺席时省键 */
  readonly severityFilter?: SeverityFilterRecord;
  /** 通用检视建议类抑制留痕：未配置 / 未丢弃时省键 */
  readonly genericReview?: GenericReviewSuppressionRecord;
  /** 候选字段归一化留痕（只在真有修复时在场；零漂移纪律） */
  readonly candidateNormalizations?: readonly CandidateNormalizationRecord[];
  /** Finding 路径修复留痕（ADR-0120）：只在真有修复时在场 */
  readonly pathRepairs?: readonly PathRepairRecord[];
  /** 候选拦截链阶段计数（只在有拦截时在场） */
  readonly rejectionCounts?: CandidateRejectionCounts;
  /** 证据接地计数（F-04；只在 mode 非 off 且检查过候选时在场） */
  readonly evidenceGrounding?: EvidenceGroundingAudit;
  /** 检索预算计数（F-08b）：只在配置了上限时出现 */
  readonly retrievalBudget?: RetrievalBudgetAudit;
  /** Skill 包检视留痕：本次 diff 未命中任何 skill 根时省键 */
  readonly skillReview?: SkillReviewRecord;
  /**
   * 模型替换留痕（ADR-0080）：只在真发生降级时在场；无替换整键缺席。
   * 聚合审计记一次；分片审计不重复该键（`model` 已是生效值）。
   */
  readonly modelFallback?: ModelFallbackRecord;
  /**
   * 覆盖账本（F-01a）：本遍 / 聚合的文件 × hunk 三态。
   * 只在 pass 审计携带；聚合审计由各片合并。
   */
  readonly coverage?: CoverageLedger;
  /**
   * 覆盖缺口补漏（F-01b）：只在启用 `limits.coverage.repair.enabled` 时在场；
   * 关闭时整键缺席（零漂移）。
   */
  readonly coverageRepair?: CoverageRepairAudit;
  /**
   * 本遍用量账本摘要（ADR-0066 收敛）：按 source / model 聚合，含 Agent / Skill
   * / 解析修复 / 候选修复 / 覆盖补漏；落审计可供基准与复盘直接读取，不再
   * 手工相加 `usage + coverageRepair.usage`。
   */
  readonly usageLedger?: UsageLedgerSummary;
}

/**
 * 补漏候选的独立验证（v3）：在候选门之前再做一次证伪判断。
 * - `accepted` / `rejected` 是验证器给出 pass / reject 的候选数；
 * - 验证请求失败时 fail-open，候选保留并计入 `unverified`，`failedRequests` 留痕；
 * - `usage` 是验证器自身的 one-shot 用量。
 */
export interface CoverageRepairVerificationAudit {
  readonly requests: number;
  readonly failedRequests: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly unverified: number;
  readonly usage: LlmUsage;
}

/**
 * 覆盖缺口补漏的审计投影（F-01b）。
 *
 * - `requests` 是实际发出的补漏请求数；`failedRequests` 是调用 / 解析失败数；
 * - `hunksSent` 是请求里携带的未覆盖 hunk 数；`hunksCovered` 是收到有效回执
 *   （candidate 或 no-issue）的 hunk 数；
 * - `candidates` 是回执里的候选条数；`acceptedFindings` 是通过候选门后的条数；
 * - `rejectedCandidates` 是候选门拒绝 + 回执结构非法的条数；
 * - `skippedByBudget` 是因 `maxRequests` / `maxChars` 未发出的缺口 hunk 数；
 * - `usage` 是补漏相关 one-shot 的总用量（生成 + 验证）。审计根 `usage`
 *   只含 Agent 内调用（ADR-0066），任何“本次运行 token 总量”的汇总都必须
 *   把两者相加；验证器用量同时记在 `verification.usage` 作为分项。
 */
export interface CoverageRepairAudit {
  readonly enabled: boolean;
  readonly requests: number;
  readonly failedRequests: number;
  readonly hunksSent: number;
  readonly hunksCovered: number;
  readonly noIssue: number;
  readonly candidates: number;
  readonly acceptedFindings: number;
  readonly rejectedCandidates: number;
  readonly skippedByBudget: number;
  readonly usage: LlmUsage;
  /** v3 独立证伪门；只在真有补漏候选并执行验证时在场 */
  readonly verification?: CoverageRepairVerificationAudit;
}

/** 六阶段循环一次完整运行的结果（审计投影的输入） */
export interface RunResult {
  readonly caseId: string;
  readonly model: string;
  readonly findings: readonly Finding[];
  readonly usage: LlmUsage;
  readonly rounds: number;
  readonly toolCalls: number;
  readonly audit: RunAudit;
  readonly auditPath?: string;
  /**
   * 单遍主转录路径（绝对路径；ADR-0088）。分片路径缺席——每片路径在
   * `record.shards[].transcriptFile`；旧记录缺席（export 走 legacy shim）。
   */
  readonly transcriptPath?: string;
  /**
   * 域外显式降级标注（#12 MR 边界护栏）：超界 / 不可度量时在场
   * （生产化方案 §3.1 原文案或 boundary-unmeasurable 语义文案），
   * 边界内缺席省键——护栏零介入的可观测证明。
   */
  readonly domainWarning?: string;
}
