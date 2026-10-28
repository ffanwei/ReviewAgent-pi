// run 级留痕契约（测量常量面：审计投影的形状与 DSH 线一致，
// 冻结 analyze 脚本据此消费 pi RunRecord）。随模块落地逐步补齐。

import type { Finding } from "./finding.js";
import type { LedgerEntry } from "./ledger.js";
import type { LlmUsage, ToolSchema, WireMessage } from "./llm.js";
import type { PrefetchLayerRecord } from "./prefetch.js";

/** 六阶段名（固定顺序；phaseLog 留痕用） */
export type ReviewPhase =
  | "Change Understanding"
  | "Risk Classification"
  | "Context Decision"
  | "Context Retrieval"
  | "Deep Reasoning"
  | "Evidence Verification";

/** 一个阶段的执行留痕 */
export interface PhaseRecord {
  readonly round: number;
  readonly phase: ReviewPhase;
  readonly requestCount: number;
  readonly note?: string;
}

/** 一次工具调用的留痕（config B 零工具，恒空数组；契约先行） */
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

/** 拦截阶段顺序：Schema 校验 → 语言检查 → 证据检查 → 验证裁决 → 重复 id */
export type RejectionStage =
  | "SCHEMA_INVALID"
  | "NON_ENGLISH"
  | "NO_EVIDENCE"
  | "VERIFICATION_FAILED"
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

/** config C 全仓注入的留痕（预算守卫：截断必留痕） */
export interface FullRepoRecord {
  readonly budgetChars: number;
  readonly contentChars: number;
  readonly truncated: boolean;
  readonly totalFiles: number;
  readonly shownFiles: number;
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

/** 规则 Skill 审计留痕的诊断项（内核装载 warning 的窄投影） */
export interface RuleSkillAuditDiagnostic {
  readonly code: string;
  readonly path: string;
}

/**
 * 规则 Skill 装载留痕（ADR-0014 / config F：审计文件尾键）。
 * 每装载一个 zip 一条，顺序 = CLI 传入顺序（或约定目录的文件名序）。
 * `source` = 归档来源（仓库相对 POSIX）；`digest` = zip 内容 sha256；
 * `name` = 装载的 skill 名（降级时为空串）；`degradedReason` 在场即降级；
 * `diagnostics` = 内核装载 warning（path 已净化为缓存目录相对形态）。
 * 非 F 配置时省键（缺席纪律）；F 恒为数组（N=0 ⇒ 空数组）。
 */
export interface RuleSkillAudit {
  readonly source: string;
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

/** 循环运行期的审计累积面（AuditFileContent 与 AuditLight 的共同来源） */
export interface RunAudit {
  readonly requests: readonly WireRequest[];
  readonly toolCallLog: readonly ToolCallRecord[];
  readonly phaseLog: readonly PhaseRecord[];
  readonly rejections: readonly CandidateRejection[];
  readonly cacheBreaks: readonly CacheBreakRecord[];
  readonly truncated: boolean;
  readonly truncationReasons: readonly string[];
  readonly prefetch?: readonly PrefetchLayerRecord[];
  /** config C 全仓注入记账（非 C 配置缺省） */
  readonly fullRepo?: FullRepoRecord;
  /** config E Context Ledger 快照（非 E 配置缺省） */
  readonly ledger?: readonly LedgerEntry[];
  /**
   * config F 规则 Skill 装载留痕（ADR-0014：每 zip 一条、CLI 序）。
   * 非 F 配置缺省省键；F 恒为数组（N=0 ⇒ 空数组）。
   */
  readonly ruleSkill?: readonly RuleSkillAudit[];
  /** config F skill 会话执行留痕（粒度 round × skill；非 F 缺省省键，F 恒为数组：N=0 ⇒ 空数组） */
  readonly skillPassLog?: readonly RuleSkillPassRecord[];
}

/** 六阶段循环一次完整运行的结果（审计投影的输入） */
export interface RunResult {
  readonly caseId: string;
  readonly configId: string;
  readonly model: string;
  readonly findings: readonly Finding[];
  readonly usage: LlmUsage;
  readonly rounds: number;
  readonly toolCalls: number;
  readonly audit: RunAudit;
  readonly auditPath?: string;
  /**
   * 域外显式降级标注（#12 MR 边界护栏）：超界 / 不可度量时在场
   * （生产化方案 §3.1 原文案或 boundary-unmeasurable 语义文案），
   * 边界内缺席省键——护栏零介入的可观测证明。
   */
  readonly domainWarning?: string;
}
