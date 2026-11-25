import { readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FetchFunction } from "@earendil-works/pi-ai";
import { buildAuditFileContent, buildRunId, writeAuditFile } from "../audit/audit-writer.js";
import type { CoverageLedger, NotReachedCause } from "../contracts/coverage.js";
import type { Finding } from "../contracts/finding.js";
import type { LedgerEntry } from "../contracts/ledger.js";
import type { LlmUsage } from "../contracts/llm.js";
import type { RunProgressSink } from "../contracts/progress.js";
import type {
  ModelFallbackRecord,
  MrFilterRecord,
  RuleSkillAudit,
  RuleSkillPassRecord,
  RunAudit,
  ShardTruncationRecord,
} from "../contracts/run.js";
import { buildReviewsExport, writeReviewsAll } from "../export/reviews.js";
import {
  buildOpenCodeSession,
  writeOpenCodeSession,
  type OpenCodeSubagentRef,
} from "../export/opencode-compat.js";
import { buildTranscript, transcriptStem, writeTranscript } from "../export/transcript.js";
import { buildDiffScope } from "../gate/diff-scope.js";
import { parseUnifiedDiff } from "../diff/parse.js";
import type { RuleSkill } from "../knowledge/rule-skill.js";
import type { SkillPassTranscript } from "../knowledge/skill-pass.js";
import { runAgentReviewLoop } from "../loop/agent-review-loop.js";
import { createCandidateRepair } from "../loop/candidate-repair.js";
import { TRUNCATION_MODEL_LENGTH, TRUNCATION_TOOL_BUDGET } from "../loop/constants.js";
import { buildInitialUserMessage, buildRepoInitialUserMessage, type RepoSnapshotFile } from "../loop/messages.js";
import {
  createRequestTimelineWriter,
  setRequestTimelineSink,
  type TimelineShard,
} from "../observability/request-timeline.js";
import { LOCKED_EFFORT_LABEL, reviewModelOf } from "../provider/pi-client.js";
import type { ConfigSnapshot } from "../shared/config.js";
import { retryPolicyFor } from "../shared/llm-retry.js";
import type { ReviewRuntime } from "../shared/review-runtime.js";
import { summarizeSeverityFilter } from "../shared/severity-filter.js";
import { summarizeTipsFilter } from "../shared/tips-filter.js";
import { buildReviewToolkit } from "../tools/toolkit.js";
import { createContextLedger } from "../tools/ledger.js";
import {
  backfillCandidates,
  buildCoverageLedger,
  closeCoverage,
  truncatedRangesFromShardRecords,
} from "./coverage-ledger.js";
import { SCAN_SYSTEM_PROMPT, SYSTEM_PROMPT } from "../loop/system-prompt.js";
import { repairCoverageGaps } from "./coverage-repair.js";
import type { MrBoundaryDecision } from "./mr-boundary-guard.js";
import { formatRepoSnapshotModelNote, type RepoSnapshotSideRecord } from "./repo-side.js";
import {
  buildSkillPhase5Override,
  buildSkillPhase6VerificationNote,
  buildSkillReviewBrief,
  detectSkillReview,
  type SkillReviewProfile,
} from "./skill-review.js";

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
  /**
   * 输入语义（缺省 `diff`）：repo 模式用 scan 系统提示与文件快照消息。
   * 不改 `diff` 字段——它仍是工具 / 证据门的底稿。
   */
  readonly reviewMode?: "diff" | "repo";
  /** repo 模式的文件快照；在场时初始消息不走 `buildInitialUserMessage`。 */
  readonly fileSnapshot?: readonly RepoSnapshotFile[];
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
  /** 本片的截取明细（ADR-0070；单遍缺席） */
  readonly shardTruncation?: readonly ShardTruncationRecord[];
  /** 规则 Skill（编排层只装载一次，各片共享） */
  readonly ruleSkills: readonly RuleSkill[];
  readonly ruleSkillAudit: readonly RuleSkillAudit[];
  /** 本遍产物目录（转录 / reviews_all.json） */
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
   * 模型替换留痕（ADR-0080）：单遍路径由 CLI 传入并落审计；分片路径不传
   * （键只在聚合审计写一次，片内 `model` 已是生效值）。
   */
  readonly modelFallback?: ModelFallbackRecord;
  /**
   * 中文 tips 置信度过滤阈值（ADR-0052）：只在审计 / run.json 留痕用，不改
   * 检视行为；缺席 = 不写 `tipsFilter` 键。
   */
  readonly tipsConfidenceMin?: number;
  /**
   * 中文 tips / MCP 上报严重级过滤阈值：只在审计 / run.json 留痕用，不改
   * 检视行为；缺席 = 不写 `severityFilter` 键。
   */
  readonly tipsSeverityMin?: Finding["severity"];
  /**
   * 仓库快照侧别（ADR-0109）：base / mixed 时把可执行提示注入初始 user 消息；
   * head / unknown 不注入（正常路径请求字节不变）。
   */
  readonly repoSnapshotSide?: RepoSnapshotSideRecord;
  /** 分片标签（ADR-0076 请求时间线）：多片才在场，单片路径缺席 */
  readonly shard?: TimelineShard;
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
  /** 本遍覆盖账本（F-01a）：审计与分片聚合共用同一份 */
  readonly coverage: CoverageLedger;
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
  // 覆盖分母先于任何模型请求冻结（F-01a）：从本遍 diff 确定性派生；
  // 分片时把 ADR-0070 截取丢弃的 hunk 接回分母，标 not-reached(truncated)。
  const coverage = buildCoverageLedger(
    input.diff,
    input.shardTruncation !== undefined
      ? { truncated: truncatedRangesFromShardRecords(input.shardTruncation) }
      : {},
  );
  // 请求时间线（ADR-0076）：本遍独占一份文件；同步追加，失败现场不受
  // 「产物写盘在 pass 之后」的全有或全无影响。目录必须先建好：直接调用
  // （内核直调 / 单测）时没有 CLI 的预建目录，否则时间线文件打开失败，
  // 失败现场会静默丢失。
  await mkdir(input.runDir, { recursive: true });
  const timeline = createRequestTimelineWriter(input.runDir);
  setRequestTimelineSink(timeline.sink);
  try {
    return await executeReviewPass(input, coverage);
  } catch (error) {
    // 失败路径：审计不会落盘，账本单独留一份失败现场；失败原因统一记为
    // flow-error，未回填的 hunk 不静默成「已审」。
    await persistCoverageSidecar(input.runDir, closeCoverage(coverage, "flow-error"));
    const summary = timeline.summary();
    if (summary !== null) {
      // 旁路：一行失败现场（同时被 review-pi.log 镜像）；不改退出码 / 不吞异常
      process.stderr.write(`review-pi: ${summary}\n`);
    }
    throw error;
  } finally {
    setRequestTimelineSink(null);
    timeline.close();
  }
}

/** 本次 run 的未覆盖原因：输出截断 > 工具预算 > 轮次未完成 > 正常无信号 */
function coverageCauseFor(outcome: {
  readonly audit: RunAudit;
  readonly complete: boolean;
}): NotReachedCause {
  if (outcome.audit.truncationReasons.includes(TRUNCATION_MODEL_LENGTH)) {
    return "output-truncated";
  }
  if (outcome.audit.truncationReasons.includes(TRUNCATION_TOOL_BUDGET)) {
    return "budget";
  }
  return outcome.complete ? "no-signal" : "round-cap";
}

/**
 * 证据接地的 head 侧文件读取器（F-04）：只读本遍 diff 里出现的路径，
 * 拒绝越界路径；单文件上限 2MB；读不到返回 null（调用方 fail-open）。
 */
function buildEvidenceFileReader(
  repoPath: string,
  diff: string,
): (file: string) => string | null {
  const paths = new Set(parseUnifiedDiff(diff).files.map((change) => change.path));
  const root = path.resolve(repoPath);
  const prefix = `${root}${path.sep}`;
  const cache = new Map<string, string | null>();
  return (file: string): string | null => {
    const normalized = file.replace(/\\/g, "/").replace(/^\.\//, "").trim();
    if (!paths.has(normalized)) {
      return null;
    }
    if (cache.has(normalized)) {
      return cache.get(normalized) ?? null;
    }
    const absolute = path.resolve(root, normalized);
    if (absolute !== root && !absolute.startsWith(prefix)) {
      cache.set(normalized, null);
      return null;
    }
    try {
      const stats = statSync(absolute);
      if (!stats.isFile() || stats.size > 2_000_000) {
        cache.set(normalized, null);
        return null;
      }
      const text = readFileSync(absolute, "utf8");
      cache.set(normalized, text);
      return text;
    } catch {
      cache.set(normalized, null);
      return null;
    }
  };
}

/** 失败路径的账本旁路落盘；任何失败都不覆盖原始错误 */
async function persistCoverageSidecar(
  runDir: string,
  coverage: CoverageLedger,
): Promise<void> {
  try {
    await mkdir(runDir, { recursive: true });
    await writeFile(
      path.join(runDir, "coverage.json"),
      `${JSON.stringify(coverage, null, 2)}\n`,
      "utf8",
    );
  } catch {
    // 旁路失败不改变检视失败的原因与退出码
  }
}

/** 审计里的引用核对事实：只记条数与被缺失项，不复制 manifest 正文 */
function skillReviewAuditFacts(profile: SkillReviewProfile): {
  readonly checkedReferences?: number;
  readonly missingReferences?: readonly string[];
} {
  const checks = profile.roots.flatMap((root) =>
    root.referenceCheck !== undefined ? [root.referenceCheck] : [],
  );
  if (checks.length === 0) {
    return {};
  }
  const checkedReferences = checks.reduce(
    (sum, check) => sum + check.verified.length + check.missing.length,
    0,
  );
  const missingReferences = checks.flatMap((check) =>
    check.missing.map((ref) => `${check.manifest}:${String(ref.line)} ${ref.target}`),
  );
  return {
    checkedReferences,
    ...(missingReferences.length > 0 ? { missingReferences } : {}),
  };
}

async function executeReviewPass(
  input: ReviewPassInput,
  coverage: CoverageLedger,
): Promise<ReviewPassResult> {
  // Zone A 按输入语义二选一：MR 缺省仍是 SYSTEM_PROMPT（逐字节不变）；
  // repo 模式用 scan 专用提示，不把既有代码说成「本次新增」。
  const systemPrompt = input.reviewMode === "repo" ? SCAN_SYSTEM_PROMPT : SYSTEM_PROMPT;
  // Skill 包识别（确定性）：只在本次 diff 命中 skill 根时追加清单；
  // 未命中 = undefined，初始消息、阶段消息与位置门都与全代码路径逐字节一致。
  const skillReview = detectSkillReview(input.diff, input.repoPath);
  const ruleSkillLoaded = input.ruleSkills.some(
    (skill) => skill.degradedReason === undefined && skill.name.length > 0,
  );
  const skillBrief =
    skillReview === undefined
      ? undefined
      : buildSkillReviewBrief(skillReview, { ruleSkillLoaded });
  // Phase 5/6 覆盖：放在生成 / 核验前最后一条 user 消息末尾，覆盖编码导向。
  const phaseBrief =
    skillReview === undefined
      ? undefined
      : (index: number): string | undefined => {
          if (index === 4) {
            return buildSkillPhase5Override(skillReview, { ruleSkillLoaded });
          }
          if (index === 5) {
            return buildSkillPhase6VerificationNote();
          }
          return undefined;
        };
  // ADR-0109：只有 --repo 停在 base / mixed 侧时才追加可执行提示；head 是大多数
  // 情况，保持初始消息逐字节不变。提示放在 extra section 末尾，模型最后看到。
  const extraSections = [
    skillBrief,
    formatRepoSnapshotModelNote(input.repoSnapshotSide),
  ].filter(
    (section): section is string => section !== undefined && section.trim().length > 0,
  );
  const initialContextMessages = [
    {
      role: "user" as const,
      content:
        input.fileSnapshot !== undefined
          ? buildRepoInitialUserMessage(
              input.caseId,
              input.issueDescription,
              input.fileSnapshot,
              extraSections.length > 0 ? extraSections.join("\n\n") : undefined,
            )
          : buildInitialUserMessage(
              input.caseId,
              input.issueDescription,
              input.initialDiff,
              extraSections.length > 0 ? extraSections.join("\n\n") : undefined,
            ),
    },
  ];

  const toolkit = buildReviewToolkit({
    repoPath: input.repoPath,
    diff: input.diff,
    runtime: input.runtime,
    ledgerMode: "enabled",
  });

  // skill 会话的八工具 toolkit：每个 skill 按 Phase-5 ledger 快照分叉一次
  // （skill 之间互不可见；skill 读取不污染主账本）。同时注入该 skill 的包根：
  // review.get_file 在仓库缺失时回退到 SKILL.md 所在目录。
  const skillToolkitFor = (seed: readonly LedgerEntry[], skill: RuleSkill) =>
    buildReviewToolkit({
      repoPath: input.repoPath,
      diff: input.diff,
      runtime: input.runtime,
      ledger: createContextLedger(seed),
      ...(skill.filePath.length > 0 ? { skillPackRoot: path.dirname(skill.filePath) } : {}),
    });

  const repairModel = reviewModelOf(input.modelId, input.baseUrl);
  // 非 diff 区域过滤（limits.findingScope，缺省开启）：以**本遍** diff 为准，
  // 分片模式即片内 diff；关闭时不构建 scope（候选链零介入）。
  const findingScope = input.runtime.limits.findingScope;
  const scope = findingScope.enabled
    ? buildDiffScope(input.diff, findingScope.contextLines, skillReview?.wholeFilePaths)
    : undefined;
  const evidenceLimits = input.runtime.limits.evidence;
  const evidenceSide = input.repoSnapshotSide?.side;
  const evidenceReadable =
    evidenceSide !== "base" && evidenceSide !== "mixed" && evidenceSide !== undefined
      ? true
      : evidenceSide === undefined;
  const evidenceGrounding =
    evidenceLimits.mode === "off"
      ? undefined
      : {
          mode: evidenceLimits.mode,
          minMatchChars: evidenceLimits.minMatchChars,
          // base / mixed 侧读到的是改前文本：接地不可判定，统一 fail-open。
          fileText: evidenceReadable
            ? buildEvidenceFileReader(input.repoPath, input.diff)
            : () => null,
        };
  const outcome = await runAgentReviewLoop({
    systemPrompt,
    ...(input.reviewMode !== undefined ? { reviewMode: input.reviewMode } : {}),
    initialContextMessages,
    toolkit,
    apiKey: input.apiKey,
    runtime: input.runtime,
    ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
    modelId: input.modelId,
    fetch: input.fetch,
    includeLedgerAudit: true,
    onProgress: input.emit,
    ...(input.shard !== undefined ? { shard: input.shard } : {}),
    ...(scope !== undefined ? { scope } : {}),
    ...(evidenceGrounding !== undefined ? { evidenceGrounding } : {}),
    ...(phaseBrief !== undefined ? { phaseBrief } : {}),
    // Phase 5 之后追加独立 skill 检视会话（Phase 5 消息不再被修改）
    skillPass: {
      skills: input.ruleSkills,
      toolkitFor: skillToolkitFor,
      ...(skillReview !== undefined ? { docMode: true } : {}),
    },
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

  // 覆盖收口（F-01a）：finding 按新侧行号回填 candidate；F-01b 启用时再对
  // 仍未覆盖的 hunk 发独立补漏请求，补漏候选仍走同一候选门。
  const mainCoverage = backfillCandidates(coverage, outcome.findings, "main");
  const repairLimits = input.runtime.limits.coverage.repair;
  const repair =
    repairLimits.enabled
      ? await repairCoverageGaps({
          diff: input.diff,
          ledger: mainCoverage,
          findings: outcome.findings,
          limits: repairLimits,
          ...(scope !== undefined ? { scope } : {}),
          llm: {
            baseUrl: repairModel.baseUrl,
            apiKey: input.apiKey,
            modelId: input.modelId,
            timeoutMs: input.runtime.limits.timeouts.oneShotMs,
            retry: retryPolicyFor(input.runtime.limits.retry, "oneShot"),
            ...(input.fetch !== undefined ? { fetch: input.fetch } : {}),
          },
        })
      : undefined;
  const findings =
    repair === undefined ? outcome.findings : [...outcome.findings, ...repair.findings];
  // 补漏是一次性调用：成本记在 `coverageRepair.usage` 与 one-shot 账本，
  // 不并入主会话 usage（避免与 one-shot 汇总重复计数）。
  const usage = outcome.usage;
  const closedCoverage = closeCoverage(
    repair?.ledger ?? mainCoverage,
    coverageCauseFor(outcome),
  );

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
    systemPrompt,
    records: outcome.skillPassLog,
    transcripts: outcome.skillTranscripts,
  });
  const tipsFilter = summarizeTipsFilter(findings, input.tipsConfidenceMin);
  const severityFilter = summarizeSeverityFilter(findings, input.tipsSeverityMin);
  const audit: RunAudit = {
    ...outcome.audit,
    coverage: closedCoverage,
    ...(repair !== undefined ? { coverageRepair: repair.audit } : {}),
    ruleSkill: input.ruleSkillAudit,
    ...(outcome.audit.skillPassLog !== undefined ? { skillPassLog: persisted.records } : {}),
    ...(tipsFilter !== undefined ? { tipsFilter } : {}),
    ...(severityFilter !== undefined ? { severityFilter } : {}),
    ...(skillReview !== undefined
      ? {
          skillReview: {
            roots: skillReview.roots.map((root) => root.root),
            docFiles: skillReview.docFiles,
            wholeFilePaths: skillReview.wholeFilePaths,
            ...skillReviewAuditFacts(skillReview),
          },
        }
      : {}),
    ...(input.modelFallback !== undefined ? { modelFallback: input.modelFallback } : {}),
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
    usage,
    findings,
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
  // 检视转录：agent.state.messages 原样 + 合成 system；每 run 独立留档。
  // OpenCode 兼容会话（ADR-0072）与原生转录同 run 落盘：父会话在末尾追加
  // 指向各 skill 子会话的 `subagent` 工具 part。
  const transcriptPath = await persistTranscript({
    caseId: input.caseId,
    repoPath: input.repoPath,
    runId,
    finishedAt,
    runDir: input.runDir,
    systemPrompt,
    capture: outcome.transcript,
    complete: outcome.complete,
    truncated: outcome.audit.truncated,
    subagents: persisted.subagents,
  });
  // 检视意见导出
  const reviewsPath = await persistReviewsEn({
    caseId: input.caseId,
    rep: input.rep,
    source: input.reviewMode === "repo" ? "repo-scan" : "mr",
    runId,
    modelId: input.modelId,
    finishedAt,
    runDir: input.runDir,
    findings,
  });

  return {
    runId,
    startedAt: input.startedAt,
    finishedAt,
    findings,
    usage,
    rounds: outcome.rounds,
    toolCalls: outcome.toolCalls,
    audit,
    coverage: closedCoverage,
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
  readonly systemPrompt: string;
  readonly records: readonly RuleSkillPassRecord[];
  readonly transcripts: readonly SkillPassTranscript[];
}): Promise<{
  readonly records: readonly RuleSkillPassRecord[];
  readonly paths: readonly string[];
  readonly subagents: readonly OpenCodeSubagentRef[];
}> {
  if (args.transcripts.length === 0) {
    return { records: args.records, paths: [], subagents: [] };
  }
  const suffixes = uniqueTranscriptSuffixes(args.records);
  const enriched = [...args.records];
  const paths: string[] = [];
  const subagents: OpenCodeSubagentRef[] = [];
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
      systemPrompt: args.systemPrompt,
      capture: transcript.capture,
      complete: transcript.complete,
      truncated: transcript.truncated,
      finishedAt: args.finishedAt,
      idSuffix: suffixes[index] ?? defaultTranscriptSuffix(transcript),
    });
    const filePath = await writeTranscript(args.runDir, content);
    paths.push(filePath);
    // OpenCode 兼容子会话（ADR-0072）：只写增量（丢弃种子前缀），parentID 指向
    // 同 run 的主会话；sessionId 与原生 `info.id` 同值、稳定且全局唯一。
    const compat = buildOpenCodeSession({
      info: content.info,
      systemPrompt: args.systemPrompt,
      messages: transcript.capture.messages,
      parentID: transcriptStem(args.runId),
      seedCount: transcript.seedCount,
    });
    await writeOpenCodeSession(args.runDir, compat);
    subagents.push({ sessionID: compat.info.id, description: `${transcript.skill} (round ${transcript.round})` });
    const record = enriched[index];
    if (record !== undefined) {
      enriched[index] = { ...record, transcriptFile: path.basename(filePath) };
    }
  }
  return { records: enriched, paths, subagents };
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

/** 检视转录落盘：`<runDir>/session-<runId>[-suffix].json` + OpenCode 兼容版（ADR-0072）；失败抛错 */
async function persistTranscript(args: {
  readonly caseId: string;
  readonly repoPath: string;
  readonly runId: string;
  readonly finishedAt: Date;
  readonly runDir: string;
  readonly systemPrompt: string;
  readonly capture: Parameters<typeof buildTranscript>[0]["capture"];
  readonly complete: boolean;
  readonly truncated: boolean;
  /** 指向本 run 各 skill 子会话的 `subagent` 工具 part（追加到末条 assistant） */
  readonly subagents: readonly OpenCodeSubagentRef[];
}): Promise<string> {
  const content = buildTranscript({
    runId: args.runId,
    caseId: args.caseId,
    repoPath: args.repoPath,
    systemPrompt: args.systemPrompt,
    capture: args.capture,
    complete: args.complete,
    truncated: args.truncated,
    finishedAt: args.finishedAt,
  });
  // OpenCode 兼容主会话（ADR-0072）：原生真源不动，另写 `<runDir>/opencode/`。
  // 父会话无 `seedCount`（全量），`subagents` 让 viewer 能点进各子会话。
  const compat = buildOpenCodeSession({
    info: content.info,
    systemPrompt: args.systemPrompt,
    messages: args.capture.messages,
    ...(args.subagents.length > 0 ? { subagents: args.subagents } : {}),
  });
  await writeOpenCodeSession(args.runDir, compat);
  return writeTranscript(args.runDir, content);
}

/** 检视意见导出落盘：`<runDir>/reviews_all.json`；失败抛错 */
async function persistReviewsEn(args: {
  readonly caseId: string;
  readonly rep: number;
  readonly runId: string;
  readonly modelId: string;
  readonly finishedAt: Date;
  readonly runDir: string;
  readonly source: string;
  readonly findings: readonly Finding[];
}): Promise<string> {
  const envelope = buildReviewsExport({
    generatedAt: args.finishedAt,
    runId: args.runId,
    source: args.source,
    caseId: args.caseId,
    rep: args.rep,
    model: args.modelId,
    findings: args.findings,
  });
  return writeReviewsAll(args.runDir, envelope);
}
