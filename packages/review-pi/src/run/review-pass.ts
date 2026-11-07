import path from "node:path";
import type { FetchFunction } from "@earendil-works/pi-ai";
import { buildAuditFileContent, buildRunId, writeAuditFile } from "../audit/audit-writer.js";
import type { Finding } from "../contracts/finding.js";
import type { LedgerEntry } from "../contracts/ledger.js";
import type { LlmUsage } from "../contracts/llm.js";
import type { RunProgressSink } from "../contracts/progress.js";
import type {
  MrFilterRecord,
  RuleSkillAudit,
  RuleSkillPassRecord,
  RunAudit,
} from "../contracts/run.js";
import { buildReviewsExport, writeReviewsEn } from "../export/reviews.js";
import { buildTranscript, writeTranscript } from "../export/transcript.js";
import type { RuleSkill } from "../knowledge/rule-skill.js";
import type { SkillPassTranscript } from "../knowledge/skill-pass.js";
import { runAgentReviewLoop } from "../loop/agent-review-loop.js";
import { createCandidateRepair } from "../loop/candidate-repair.js";
import { buildInitialUserMessage } from "../loop/messages.js";
import { LOCKED_EFFORT_LABEL, reviewModelOf } from "../provider/pi-client.js";
import type { ConfigSnapshot } from "../shared/config.js";
import { retryPolicyFor } from "../shared/llm-retry.js";
import type { ReviewRuntime } from "../shared/review-runtime.js";
import { summarizeTipsFilter } from "../shared/tips-filter.js";
import { buildReviewToolkit } from "../tools/toolkit.js";
import { createContextLedger } from "../tools/ledger.js";
import { SYSTEM_PROMPT } from "../zonea/system-prompt.js";
import type { MrBoundaryDecision } from "./mr-boundary-guard.js";

/**
 * 单遍检视执行（ADR-0039 实施拆分第 2 步）。
 *
 * 一次「完整六阶段 + 规则 Skill 会话 + 产物落盘」的执行单元：
 * - 单片路径：`runDir` / `auditDir` 就是 ADR-0032 原布局，逐字节同旧实现；
 * - 分片路径：调用方把 `runDir` / `auditDir` 指到 `shards/attempt-<…>/sNN`，
 *   每片独立 toolkit / ledger / 初始消息，规则 Skill 会话各跑一次；
 * - 本函数**不发** `run.start` / `run.end`（外层编排独占，ADR-0039 决策 9）。
 */

export interface ReviewPassInput {
  readonly caseId: string;
  readonly repoPath: string;
  readonly issueDescription: string;
  readonly apiKey: string;
  readonly fetch: FetchFunction;
  readonly runtime: ReviewRuntime;
  readonly modelId: string;
  readonly rep: number;
  readonly baseUrl?: string;
  /** 本遍用于工具与初始消息的 diff（分片 = 片内 diff） */
  readonly diff: string;
  /** 初始用户消息里的 diff 文本（分片 = 片内 diff + 其他文件摘要） */
  readonly initialDiff: string;
  /** 规则 Skill（编排层只装载一次，各片共享） */
  readonly ruleSkills: readonly RuleSkill[];
  readonly ruleSkillAudit: readonly RuleSkillAudit[];
  /** 本遍产物目录（转录 / reviews_en.json） */
  readonly runDir: string;
  /** 本遍审计目录（<auditDir>/<runId>.json） */
  readonly auditDir: string;
  readonly startedAt: Date;
  /** 边界护栏决策（分片时为全量 diff 的度量结果） */
  readonly boundary: MrBoundaryDecision;
  /** 输入预过滤留痕：只在单遍 / 聚合审计写一次（ADR-0039 验收 9） */
  readonly mrFilter?: MrFilterRecord;
  /** 生效配置快照：只在单遍 / 聚合审计写一次 */
  readonly config?: ConfigSnapshot;
  /**
   * 中文 tips 置信度过滤阈值（ADR-0052）：只在审计 / run.json 留痕用，不改
   * 检视行为；缺席 = 不写 `tipsFilter` 键。
   */
  readonly tipsConfidenceMin?: number;
  readonly emit: RunProgressSink;
}

export interface ReviewPassResult {
  readonly runId: string;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly findings: readonly Finding[];
  readonly usage: LlmUsage;
  readonly rounds: number;
  readonly toolCalls: number;
  readonly audit: RunAudit;
  readonly complete: boolean;
  readonly transcriptPath: string;
  readonly reviewsPath: string;
  readonly auditPath: string;
  /** 收尾摘要观测值（不进审计字节） */
  readonly ledgerHitCount: number;
  readonly modelCalls: number;
  readonly skillBashCalls: number;
  /** 本遍 skill 会话转录的绝对路径（按 skillPassLog 顺序） */
  readonly skillTranscriptPaths: readonly string[];
}

export async function runReviewPass(input: ReviewPassInput): Promise<ReviewPassResult> {
  const initialContextMessages = [
    {
      role: "user" as const,
      content: buildInitialUserMessage(input.caseId, input.issueDescription, input.initialDiff),
    },
  ];

  const toolkit = buildReviewToolkit({
    repoPath: input.repoPath,
    diff: input.diff,
    runtime: input.runtime,
    ledgerMode: "enabled",
  });

  // skill 会话的七工具 toolkit：每个 skill 按 Phase-5 ledger 快照分叉一次
  // （skill 之间互不可见；skill 读取不污染主账本）
  const skillToolkitFor = (seed: readonly LedgerEntry[]) =>
    buildReviewToolkit({
      repoPath: input.repoPath,
      diff: input.diff,
      runtime: input.runtime,
      ledger: createContextLedger(seed),
    });

  const repairModel = reviewModelOf(input.modelId, input.baseUrl);
  const outcome = await runAgentReviewLoop({
    systemPrompt: SYSTEM_PROMPT,
    initialContextMessages,
    toolkit,
    apiKey: input.apiKey,
    runtime: input.runtime,
    ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
    modelId: input.modelId,
    fetch: input.fetch,
    includeLedgerAudit: true,
    onProgress: input.emit,
    // Phase 5 之后追加独立 skill 检视会话（Phase 5 消息不再被修改）
    skillPass: { skills: input.ruleSkills, toolkitFor: skillToolkitFor },
    // 有界候选修复（P1）：schema 仍非法的少数候选在 Phase 6 前至多修一次。
    // 复用核外一次性调用层（与报文同源重试 / 超时），不碰检视会话 wire 字节。
    candidateRepair: createCandidateRepair({
      baseUrl: repairModel.baseUrl,
      apiKey: input.apiKey,
      modelId: input.modelId,
      timeoutMs: input.runtime.limits.timeouts.oneShotMs,
      retry: retryPolicyFor(input.runtime.limits.retry, "oneShot"),
      ...(input.fetch !== undefined ? { fetch: input.fetch } : {}),
    }),
  });

  // 审计投影
  const finishedAt = new Date();
  // runId = 首次模型请求时刻（ADR-0032）：审计文件名、转录文件名与
  // `info.runId` 共用同一值，caseId 不再进入任何路径/文件名。
  const runId = buildRunId(outcome.transcript.firstRequestAt);
  // skill 会话独立转录（ADR-0014 决策 13）：先落盘，再把 basename 回填到
  // skillPassLog（主转录/审计据此引用）
  const persisted = await persistSkillTranscripts({
    caseId: input.caseId,
    repoPath: input.repoPath,
    runId,
    finishedAt,
    runDir: input.runDir,
    records: outcome.skillPassLog,
    transcripts: outcome.skillTranscripts,
  });
  const tipsFilter = summarizeTipsFilter(outcome.findings, input.tipsConfidenceMin);
  const audit: RunAudit = {
    ...outcome.audit,
    ruleSkill: input.ruleSkillAudit,
    ...(outcome.audit.skillPassLog !== undefined ? { skillPassLog: persisted.records } : {}),
    ...(tipsFilter !== undefined ? { tipsFilter } : {}),
  };
  const auditContent = buildAuditFileContent({
    runId,
    caseId: input.caseId,
    model: input.modelId,
    effort: LOCKED_EFFORT_LABEL,
    startedAt: input.startedAt,
    finishedAt,
    rounds: outcome.rounds,
    toolCalls: outcome.toolCalls,
    usage: outcome.usage,
    findings: outcome.findings,
    audit,
    // Ledger 快照经 outcome.audit 透传（恒投影——含空数组形态）
    ...(outcome.audit.ledger !== undefined ? { ledger: outcome.audit.ledger } : {}),
    // 护栏降级留痕（#12）：界内省键（缺席省键纪律——审计键序只在尾部扩展）
    ...(input.boundary.degraded ? { mrBoundary: input.boundary.mrBoundary } : {}),
    // 输入预过滤留痕（大 diff 第一期）：无剔除省键
    ...(input.mrFilter !== undefined ? { mrFilter: input.mrFilter } : {}),
    // 生效配置快照（ADR-0025）：只进审计文件，stdout 键集不变
    ...(input.config !== undefined ? { config: input.config } : {}),
  });
  const auditPath = await writeAuditFile(input.auditDir, auditContent);
  // 检视转录：agent.state.messages 原样 + 合成 system；每 run 独立留档
  const transcriptPath = await persistTranscript({
    caseId: input.caseId,
    repoPath: input.repoPath,
    runId,
    finishedAt,
    runDir: input.runDir,
    capture: outcome.transcript,
    complete: outcome.complete,
    truncated: outcome.audit.truncated,
  });
  // 检视意见导出
  const reviewsPath = await persistReviewsEn({
    caseId: input.caseId,
    rep: input.rep,
    runId,
    modelId: input.modelId,
    finishedAt,
    runDir: input.runDir,
    findings: outcome.findings,
  });

  return {
    runId,
    startedAt: input.startedAt,
    finishedAt,
    findings: outcome.findings,
    usage: outcome.usage,
    rounds: outcome.rounds,
    toolCalls: outcome.toolCalls,
    audit,
    complete: outcome.complete,
    transcriptPath,
    reviewsPath,
    auditPath,
    ledgerHitCount: outcome.ledgerHitCount,
    modelCalls:
      outcome.audit.requests.length +
      outcome.skillPassLog.reduce((sum, entry) => sum + entry.requestCount, 0),
    skillBashCalls: outcome.skillBashCalls,
    skillTranscriptPaths: persisted.paths,
  };
}

/**
 * skill 会话转录落盘（ADR-0014 决策 13）：每个会话一份，文件名后缀
 * `-skill-<name>-r<round>`（同名 skill 重复时追加序号），返回已回填
 * `transcriptFile`（basename）的 skillPassLog 与绝对路径。
 */
async function persistSkillTranscripts(args: {
  readonly caseId: string;
  readonly repoPath: string;
  readonly runId: string;
  readonly finishedAt: Date;
  readonly runDir: string;
  readonly records: readonly RuleSkillPassRecord[];
  readonly transcripts: readonly SkillPassTranscript[];
}): Promise<{
  readonly records: readonly RuleSkillPassRecord[];
  readonly paths: readonly string[];
}> {
  if (args.transcripts.length === 0) {
    return { records: args.records, paths: [] };
  }
  const suffixes = uniqueTranscriptSuffixes(args.records);
  const enriched = [...args.records];
  const paths: string[] = [];
  // 转录是记录的按序子集（没发出过请求的失败会话没有转录）：从上次命中之后
  // 继续找 (round, skill) 相同的记录，命中即回填 basename。
  let searchFrom = 0;
  for (const transcript of args.transcripts) {
    const index = enriched.findIndex(
      (record, position) =>
        position >= searchFrom &&
        record.round === transcript.round &&
        record.skill === transcript.skill,
    );
    if (index < 0) {
      continue;
    }
    searchFrom = index + 1;
    const content = buildTranscript({
      runId: args.runId,
      caseId: args.caseId,
      repoPath: args.repoPath,
      systemPrompt: SYSTEM_PROMPT,
      capture: transcript.capture,
      complete: transcript.complete,
      truncated: transcript.truncated,
      finishedAt: args.finishedAt,
      idSuffix: suffixes[index] ?? defaultTranscriptSuffix(transcript),
    });
    const filePath = await writeTranscript(args.runDir, content);
    paths.push(filePath);
    const record = enriched[index];
    if (record !== undefined) {
      enriched[index] = { ...record, transcriptFile: path.basename(filePath) };
    }
  }
  return { records: enriched, paths };
}

/** 每个 skill pass 的稳定文件名后缀（同名 skill 重复时追加 -2、-3…） */
function uniqueTranscriptSuffixes(records: readonly RuleSkillPassRecord[]): readonly string[] {
  const seen = new Map<string, number>();
  return records.map((record) => {
    const base = defaultTranscriptSuffix({ round: record.round, skill: record.skill });
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}-${count}`;
  });
}

function defaultTranscriptSuffix(target: { readonly round: number; readonly skill: string }): string {
  const safe = target.skill.replace(/[^A-Za-z0-9_-]/g, "_");
  return `-skill-${safe}-r${target.round}`;
}

/** 检视转录落盘：`<runDir>/session-<runId>[-suffix].json`；失败抛错 */
async function persistTranscript(args: {
  readonly caseId: string;
  readonly repoPath: string;
  readonly runId: string;
  readonly finishedAt: Date;
  readonly runDir: string;
  readonly capture: Parameters<typeof buildTranscript>[0]["capture"];
  readonly complete: boolean;
  readonly truncated: boolean;
}): Promise<string> {
  const content = buildTranscript({
    runId: args.runId,
    caseId: args.caseId,
    repoPath: args.repoPath,
    systemPrompt: SYSTEM_PROMPT,
    capture: args.capture,
    complete: args.complete,
    truncated: args.truncated,
    finishedAt: args.finishedAt,
  });
  return writeTranscript(args.runDir, content);
}

/** 检视意见导出落盘：`<runDir>/reviews_en.json`；失败抛错 */
async function persistReviewsEn(args: {
  readonly caseId: string;
  readonly rep: number;
  readonly runId: string;
  readonly modelId: string;
  readonly finishedAt: Date;
  readonly runDir: string;
  readonly findings: readonly Finding[];
}): Promise<string> {
  const envelope = buildReviewsExport({
    generatedAt: args.finishedAt,
    runId: args.runId,
    source: "mr",
    caseId: args.caseId,
    rep: args.rep,
    model: args.modelId,
    findings: args.findings,
  });
  return writeReviewsEn(args.runDir, envelope);
}
