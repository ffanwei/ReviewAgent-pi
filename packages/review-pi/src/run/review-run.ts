import path from "node:path";
import type { FetchFunction } from "@earendil-works/pi-ai";
import { buildAuditFileContent, writeAuditFile } from "../audit/audit-writer.js";
import type { Finding } from "../contracts/finding.js";
import type { LlmUsage } from "../contracts/llm.js";
import {
  NO_OP_PROGRESS_SINK,
  type RunProgressSink,
} from "../contracts/progress.js";
import type {
  CandidateNormalizationRecord,
  ModelFallbackRecord,
  MrFilterPatternSet,
  MrFilterRecord,
  PhaseRecord,
  RejectionStage,
  ReviewPhase,
  RuleSkillPassRecord,
  RunAudit,
  RunResult,
  ShardAuditRecord,
  ShardTruncationRecord,
} from "../contracts/run.js";
import {
  buildRunRecord,
  writeRunRecord,
  type RunRecord,
  type ShardRecord,
} from "../experiment/run-record.js";
import { buildReviewsExport, writeReviewsEn } from "../export/reviews.js";
import { loadRuleSkills } from "../knowledge/rule-skill.js";
import { LOCKED_EFFORT_LABEL, REVIEW_MODEL_ID } from "../provider/pi-client.js";
import { addUsage, ZERO_USAGE } from "../provider/usage-map.js";
import type { ConfigSnapshot, SplitLimits } from "../shared/config.js";
import { DEFAULT_REVIEW_RUNTIME, type ReviewRuntime } from "../shared/review-runtime.js";
import { summarizeSeverityFilter } from "../shared/severity-filter.js";
import { summarizeTipsFilter } from "../shared/tips-filter.js";
import { guardMrBoundary, type MrBoundaryDecision } from "./mr-boundary-guard.js";
import { diffTooLargeError, filterDiffForReview, listChangedFilePaths, MrDiffTooLargeError, NoReviewableFilesError, toMrFilterRecord } from "./mr-input.js";
import { mergeShardFindings } from "./findings-merge.js";
import {
  buildRunContext,
  runPasses,
  type ExecutedPass,
  type ReviewRunContext,
} from "./pass-runner.js";
import {
  planShards,
  type Shard,
  type ShardPlan,
} from "./shard-planner.js";

// 单案全链入口（ADR-0024：配置矩阵删除后只剩唯一形态）：
// MR 初始上下文 → pi-agent-core Agent 三钩子循环（七工具 + 轮次上界 + Ledger
// + 规则 Skill 会话）→ 审计投影落盘。
//
// 规则 Skill 是唯一形态（原 config F）：装载成功则用于候选阶段的规则检视；
// 装不到则照常检视（`ruleSkill: []`），由 CLI 在 stderr 提示一行。
//
// 大 diff 第二期（ADR-0039）：入口先做一次全局预过滤 / 体积门 / 边界度量，
// 再按 `diff --git` 文件块规划分片。≤ 单片预算或 `limits.split.enabled=false`
// 时走**与旧实现逐字节相同**的单遍路径；多片时串行跑每片完整六阶段，最后
// 合并 findings 并落聚合产物（全部片成功后才写）。
//
// fake 适配器与真适配器同缝：传输层经注入的 FetchFunction——离线开发/测试
// 注入 fakeFetch（canned SSE），真跑注入真 fetch + baseUrl（配置 reviewer.baseUrl），
// 其余链路完全一致。
// 审计留痕口径（#4 密钥纪律）：审计与 RunRecord 只含 model（实际请求的
// 模型 id）与接入行为产物，绝不含 API key。

export interface ReviewRunInput {
  readonly caseId: string;
  /** 本地 git 仓库快照路径（base = MR 前版本） */
  readonly repoPath: string;
  readonly diff: string;
  readonly issueDescription: string;
  readonly apiKey: string;
  /** 网关 base URL（配置 `reviewer.baseUrl`；缺省官方 api.deepseek.com） */
  readonly baseUrl?: string;
  /** 模型 id（#45 自由 id；缺省钉住的评审模型） */
  readonly modelId?: string;
  /**
   * 检视运行时（ADR-0025）：limits / maxOutputTokens 的不可变子集。
   * 缺省 = `DEFAULT_REVIEW_RUNTIME`（今天的缺省行为；测试与内核直调形态）。
   */
  readonly runtime?: ReviewRuntime;
  /**
   * 生效配置快照（ADR-0025）：只写审计文件顶层 `config` 键（全量生效值 +
   * 来源 + digest；秘密只记 set/missing）。缺省 = 不写（直调内核/测试形态）。
   */
  readonly config?: ConfigSnapshot;
  /**
   * 模型替换留痕（ADR-0080）：CLI 在前置探测判定降级后传入；只写审计顶层
   * `modelFallback` 与 run.json 同名字段。缺省 = 无替换（整键缺席）。
   */
  readonly modelFallback?: ModelFallbackRecord;
  /** 传输层注入（离线 = fakeFetch；线上 = 真 fetch） */
  readonly fetch: FetchFunction;
  /** 运行留痕根目录（fixture 或真实 runs/）；布局 `<runsRoot>/{runs,audit}/` */
  readonly runsRoot: string;
  readonly rep: number;
  /**
   * 记录落盘开关（#8 runner 执行缝）：缺省 true（内核自写 RunRecord——
   * CLI / e2e 直跑形态）；false = 执行缝模式——runner 是记录唯一写者，
   * 内核不落盘（recordPath 返回空串），审计照常落盘。
   */
  readonly persistRecord?: boolean;
  /** 起始时间戳（测试确定性钩子；缺省当前时间） */
  readonly startedAt?: Date;
  /** 规则 Skill 显式 zip 路径（--rule-skill-zip；单数兼容入口） */
  readonly ruleSkillZip?: string;
  /** 规则 Skill 显式 zip 列表（--rule-skill-zip 可重复；顺序 = 执行顺序） */
  readonly ruleSkillZips?: readonly string[];
  /** 规则 Skill 显式**已解压目录**列表（--rule-skill / --skill；排在全部 zip 之后） */
  readonly ruleSkillDirs?: readonly string[];
  /** 规则 Skill 严格模式（--strict-rule-skill）：装载失败抛错而非降级 */
  readonly strictRuleSkill?: boolean;
  /**
   * 检视范围正则（ADR-0078）：CLI 与配置在 main 侧已合并成「每个维度一条」。
   * 缺省 = 不筛（逐字节保持旧行为）。
   */
  readonly diffPathFilters?: {
    readonly include?: MrFilterPatternSet;
    readonly exclude?: MrFilterPatternSet;
  };
  /** 规则 Skill 装载器注入缝（测试注入假实现；缺省真装载器） */
  readonly ruleSkillLoader?: typeof loadRuleSkills;
  /**
   * 运行进度投影（ADR-0016）：CLI 注入；缺省不注入 = 零输出、零行为变化。
   * 事件只读既有留痕（阶段/请求/工具/skill 会话），不进审计、不改 wire 字节。
   */
  readonly onProgress?: RunProgressSink;
  /**
   * 片级检视结果回调（ADR-0045）：每片 pass 完成、该片 findings 定型后调用
   * 并 **await**（串行：上一片的回调完成才开始下一片）。单片路径 = 一次调用
   * （`{index:1, total:1}`）。第三个参数是该片 diff 触碰的文件清单（repo 相对
   * 路径）——让「没有问题」也能按文件上报。缺省不注入 = 零行为变化
   * （不进审计、不改 wire 字节）。
   *
   * 旁路纪律：这是上报缝，不是检视链的一环——实现方保证**绝不抛错**（自身
   * 负责 stderr 可见性）；本层仍防御性吞错，hook 失败绝不影响检视与退出码。
   */
  readonly onShardFindings?: ReviewShardFindingsHook;
  /**
   * 中文 tips 置信度过滤阈值（ADR-0052）：只用于在审计 / run.json 留痕
   * `tipsFilter`（阈值 + 被丢弃条数）；不改变检视结果与英文 findings。
   * 缺席 = 不留痕（内核直调 / 单测形态）；CLI 真跑恒传 `limits.confidence.min`。
   */
  readonly tipsConfidenceMin?: number;
  /**
   * 中文 tips / MCP 上报严重级过滤阈值：只用于在审计 / run.json 留痕
   * `severityFilter`（阈值 + 被丢弃条数）；不改变检视结果与英文 findings。
   * 缺席 = 不留痕（内核直调 / 单测形态）；CLI 真跑恒传 `limits.severity.min`。
   */
  readonly tipsSeverityMin?: Finding["severity"];
}

/**
 * 片级回调形状（ADR-0045）：label 与进度事件的分片标签同构（1-based）。
 * `files` = 该片 diff 触碰的文件（repo 相对路径，按 diff 出现顺序；单片路径
 * = 整份 diff 的文件）——供上报方对「没有意见的文件」也按文件调用。
 */
export type ReviewShardFindingsHook = (
  label: { readonly index: number; readonly total: number },
  findings: readonly Finding[],
  files: readonly string[],
) => Promise<void>;

export interface ReviewRunResult {
  /** run 标识（毫秒时间戳 + 用例；审计文件名同源；#7 CLI stdout 契约） */
  readonly runId: string;
  readonly record: RunRecord;
  readonly recordPath: string;
  readonly auditPath: string;
  /** 检视转录路径（ADR-0013）：走 pi Agent，每 run 独立留档 */
  readonly transcriptPath: string;
  /**
   * 全部分片的主转录（ADR-0039）：单遍路径恒为 1 条，与 `transcriptPath` 同值；
   * 分片路径按 `s01 → s02 → …` 顺序。
   */
  readonly transcriptPaths: readonly string[];
  /** 检视意见导出路径（ADR-0013）：`reviews_en.json` */
  readonly reviewsPath: string;
  /**
   * 收尾摘要用的观测值（**不进审计 / RunRecord 字节**）：
   * Context Ledger 命中次数（重复读取返回 "Already loaded" 引用的次数，
   * 主会话 + 规则 Skill 会话合计）。
   */
  readonly ledgerHitCount: number;
  /**
   * 模型调用总次数（主会话请求 + 规则 Skill 会话请求）。`requests` 只在审计
   * 文件里，轻量快照不带，所以这个数只能从返回值上取。
   */
  readonly modelCalls: number;
  /** 规则 Skill 会话里的 `bash` 调用数（指标 `toolCalls` 不含它，摘要行单列） */
  readonly skillBashCalls: number;
  /**
   * 输入预过滤留痕（大 diff 第一期）：无剔除时缺席；CLI 据此在 stderr 报一行。
   * 与审计尾键 `mrFilter` 同源（同一投影，不另算）。
   */
  readonly mrFilter?: MrFilterRecord;
  /**
   * 单文件块超预算截取留痕（ADR-0070）：无截取时缺席；CLI 据此在 stderr 报一行。
   * 与审计尾键 `shardTruncation` 同源（同一投影，不另算）。
   */
  readonly shardTruncation?: readonly ShardTruncationRecord[];
  /**
   * 阶段时间事实（ADR-0084）：只进 CLI 账本，不进审计 / run.json / 转录。
   * 单遍也返回；当前 CLI 仅在分片 run 使用。
   */
  readonly timings?: ReviewTimings;
}

/** 一个 phase 的真实起止（绝对毫秒；分片时带片号） */
export interface ReviewTimingPhaseSpan {
  readonly round: number;
  readonly index: number;
  readonly phase: ReviewPhase;
  readonly shardIndex?: number;
  readonly startedAt: number;
  readonly endedAt: number;
}

export interface ReviewTimings {
  /** run 起点（审计窗口起点） */
  readonly auditStartedAt: number;
  /** 最后一个模型请求结束（审计窗口终点） */
  readonly auditEndedAt: number;
  /** 两遍之间的片级回调耗时（单遍 = 0） */
  readonly interPassReportMs: number;
  /** 全部片级回调耗时（含最后一片之后的那次） */
  readonly reportCallbacksMs: number;
  readonly phaseSpans: readonly ReviewTimingPhaseSpan[];
}

/** 一次 run 的聚合结果（emit run.end 需要 usage / truncated / findings 摘要） */
interface ReviewOutcome {
  readonly result: ReviewRunResult;
  readonly runId: string;
  readonly usage: LlmUsage;
  readonly truncated: boolean;
  readonly findings: readonly Finding[];
}

/** 预期内的跳过结果（ADR-0075 / ADR-0078）：数据，不是异常 */
export type ReviewSkip =
  | {
      readonly reason: "diff-too-large";
      readonly message: string;
      readonly diffLength: number;
      readonly maxChars: number;
    }
  | {
      readonly reason: "no-reviewable-files";
      readonly message: string;
      readonly droppedFiles: number;
      readonly droppedChars: number;
    };

/** 一次入口调用的结果：完成检视，或预期内跳过 */
export type ReviewRunOutcome =
  | { readonly kind: "reviewed"; readonly result: ReviewRunResult }
  | { readonly kind: "skipped"; readonly skip: ReviewSkip };

/** 准入通过后的执行上下文（过滤 / 体积门 / 边界 / 分片计划都只算一次） */
interface PreparedReview {
  readonly kind: "ready";
  readonly startedAt: Date;
  readonly emit: RunProgressSink;
  readonly runtime: ReviewRuntime;
  readonly modelId: string;
  readonly diff: string;
  readonly boundary: MrBoundaryDecision;
  readonly mrFilter?: MrFilterRecord;
  readonly shards: readonly Shard[] | null;
  readonly shardTotal: number;
}

type PrepareReviewOutcome =
  | PreparedReview
  | { readonly kind: "skipped"; readonly skip: ReviewSkip };

/**
 * 入口准入（ADR-0075 / ADR-0078）：过滤、体积门、边界与分片计划。
 * 预期内的跳过**返回数据**；只有真正的异常才向外抛。
 */
function prepareReview(input: ReviewRunInput): PrepareReviewOutcome {
  const startedAt = input.startedAt ?? new Date();
  const emit = input.onProgress ?? NO_OP_PROGRESS_SINK;
  const runtime = input.runtime ?? DEFAULT_REVIEW_RUNTIME;
  const modelId = input.modelId ?? REVIEW_MODEL_ID;

  // 大 diff 第一期（内核入口唯一咽喉）：
  // 1) 预过滤噪声文件（lockfile / 生成物 / minified / 二进制），整块剔除、
  //    绝不切 hunk；2) 过滤后再过体积门（超限返回 skipped，不把注定失败的
  //    请求发给模型）。过滤清单经审计尾键 `mrFilter` 与 stderr 一行留痕。
  const filtered = filterDiffForReview(input.diff, {
    skipTestFiles: runtime.limits.testFiles.skip,
    excludeGlobs: runtime.limits.mrFilter.excludeGlobs,
    ...(input.diffPathFilters?.include !== undefined
      ? { includeFilter: input.diffPathFilters.include }
      : {}),
    ...(input.diffPathFilters?.exclude !== undefined
      ? { excludeFilter: input.diffPathFilters.exclude }
      : {}),
  });
  // ADR-0078：输入本来有文件块、但被范围规则全部剔除 → 跳过检视（CLI 上报空意见 +
  // 固定总结）。输入本身解析不出文件块时保持既有边界护栏行为，不在此拦截。
  const hadFileBlocks = listChangedFilePaths(input.diff).length > 0;
  if (hadFileBlocks && listChangedFilePaths(filtered.diff).length === 0) {
    const error = new NoReviewableFilesError(filtered.dropped.length, filtered.droppedChars);
    return {
      kind: "skipped",
      skip: {
        reason: "no-reviewable-files",
        message: error.message,
        droppedFiles: filtered.dropped.length,
        droppedChars: filtered.droppedChars,
      },
    };
  }
  const maxChars = runtime.limits.boundary.maxDiffChars;
  const tooLarge = diffTooLargeError(filtered.diff, maxChars);
  if (tooLarge !== undefined) {
    return {
      kind: "skipped",
      skip: {
        reason: "diff-too-large",
        message: tooLarge.message,
        diffLength: tooLarge.diffLength,
        maxChars: tooLarge.maxChars,
      },
    };
  }

  const diff = filtered.diff;
  const mrFilter = toMrFilterRecord(filtered);
  // MR 边界护栏（#12）：度量对象是**过滤后**的 diff。分片模式下它是整份 MR
  // 的属性，只度量 / 记账一次（每片审计不重复记）。
  const boundary = guardMrBoundary(diff, runtime.limits.boundary);
  const shards = planReviewShards(diff, runtime.limits.split);
  return {
    kind: "ready",
    startedAt,
    emit,
    runtime,
    modelId,
    diff,
    boundary,
    ...(mrFilter !== undefined ? { mrFilter } : {}),
    shards,
    shardTotal: shards === null ? 1 : shards.length,
  };
}

/** 执行已准入的 run：`run.start` / `run.end` 只在这里发 */
async function executeReview(
  input: ReviewRunInput,
  prepared: PreparedReview,
): Promise<ReviewRunResult> {
  const { startedAt, emit, runtime, modelId, diff, boundary, mrFilter, shards, shardTotal } =
    prepared;
  emit({
    kind: "run",
    state: "start",
    caseId: input.caseId,
    model: modelId,
    startedAt: startedAt.toISOString(),
    ...(shards !== null ? { shards: { total: shardTotal } } : {}),
  });

  try {
    // 规则包装载在 `run.start` 之后、首遍之前：保持既有 stderr 时序。
    const context = await buildRunContext(input, {
      startedAt,
      runtime,
      modelId,
      emit,
      boundary,
      ...(mrFilter !== undefined ? { mrFilter } : {}),
    });
    const outcome =
      shards === null
        ? await executeSinglePass(context, diff)
        : await executeShardedPasses(context, shards);
    emit({
      kind: "run",
      state: "end",
      status: "ok",
      runId: outcome.runId,
      durationMs: Math.max(0, Date.now() - startedAt.getTime()),
      usage: outcome.usage,
      truncated: outcome.truncated,
      findings: summarizeFindings(outcome.findings),
      ...(shards !== null
        ? { shards: { total: shardTotal, ok: shardTotal, failed: 0 } }
        : {}),
    });
    return outcome.result;
  } catch (error) {
    emit({
      kind: "run",
      state: "end",
      status: "failed",
      durationMs: Math.max(0, Date.now() - startedAt.getTime()),
    });
    throw error;
  }
}

/**
 * 新入口（ADR-0083）：预期内的跳过以数据返回，CLI 不再靠 `catch` 分支。
 * 公开的 `runReview` 保持「跳过即抛错」的旧契约，作为兼容适配器。
 */
export async function runReviewOutcome(input: ReviewRunInput): Promise<ReviewRunOutcome> {
  const prepared = prepareReview(input);
  if (prepared.kind === "skipped") {
    return prepared;
  }
  return { kind: "reviewed", result: await executeReview(input, prepared) };
}

function errorFromSkip(skip: ReviewSkip): Error {
  return skip.reason === "diff-too-large"
    ? new MrDiffTooLargeError(skip.diffLength, skip.maxChars)
    : new NoReviewableFilesError(skip.droppedFiles, skip.droppedChars);
}

/**
 * 单案全链入口：**先发 run 起点，再跑主体，成败都补 run 终点**（ADR-0037）。
 *
 * run 起止也是进度事件的投影（ADR-0016 三条纪律原样继承）：消费方（CLI 渲染 /
 * 上报）只看见既有留痕里已有的事实。`run.end` 的 `runId` 只在成功路径出现——
 * 它由首次模型请求时刻决定（ADR-0032），在首次请求之前失败时从未存在过。
 *
 * 分片模式（ADR-0039）：外层独占一次 `run.start` / `run.end`，并带 `shards`
 * 计数；片内事件带 `shard` 标签。单片路径整组事件不带分片字段（零字节漂移）。
 *
 * 本入口保持「预期内跳过即抛错」的公开契约（ADR-0075 / ADR-0078 的既有消费方）；
 * 需要把跳过当数据处理的调用方用 `runReviewOutcome`。
 */
export async function runReview(input: ReviewRunInput): Promise<ReviewRunResult> {
  const outcome = await runReviewOutcome(input);
  if (outcome.kind === "skipped") {
    throw errorFromSkip(outcome.skip);
  }
  return outcome.result;
}

/** 规划分片：关闭 / 未超预算时返回 null（单遍路径，零变更） */
function planReviewShards(diff: string, split: SplitLimits): readonly Shard[] | null {
  if (!split.enabled || diff.length <= split.maxShardChars) {
    return null;
  }
  const plan: ShardPlan = planShards(diff, {
    maxShardChars: split.maxShardChars,
    maxShards: split.maxShards,
    contextSummaryChars: split.contextSummaryChars,
  });
  if (plan.shards.length > 1) {
    return plan.shards;
  }
  // 单块超预算（整份 diff 就是一个文件块）：唯一一片也是**截取片**，必须走
  // 分片路径，否则截取结果被丢弃、原始超预算 diff 会被整份发给模型（ADR-0070）。
  return plan.shards.some((shard) => shard.truncated.length > 0) ? plan.shards : null;
}

// ---------------------------------------------------------------------------
// 单遍路径（与 ADR-0039 之前的实现逐字节一致）
// ---------------------------------------------------------------------------

/**
 * 片级回调调度（ADR-0045）：旁路纪律的最后一道闸——实现方应自吞错误，这里
 * 仍防御性捕获（hook 抛错 = 实现方 bug），绝不把上报失败变成检视失败。
 */
/**
 * 单遍路径：pass 装配与执行。
 * 与分片路径共享 `runPasses`；结果构造（RunRecord / RunResult）仍由本函数独占。
 */
async function executeSinglePass(
  context: ReviewRunContext,
  diff: string,
): Promise<ReviewOutcome> {
  const executed = await runPasses(context, [{ kind: "single", diff }]);
  const first = executed[0];
  if (first === undefined) {
    throw new Error("internal: single pass produced no result");
  }
  const { pass, timing } = first;

  const result: RunResult = {
    caseId: context.caseId,
    model: context.modelId,
    findings: pass.findings,
    usage: pass.usage,
    rounds: pass.rounds,
    toolCalls: pass.toolCalls,
    audit: pass.audit,
    auditPath: pass.auditPath,
    // 域外显式降级标注（#12）：界内省键（边界内与无护栏时逐字节一致）
    ...(context.boundary.degraded ? { domainWarning: context.boundary.domainWarning } : {}),
  };
  const record = buildRunRecord({
    source: "mr",
    caseId: context.caseId,
    rep: context.rep,
    model: context.modelId,
    completedAt: pass.finishedAt,
    result,
    ...(context.modelFallback !== undefined
      ? { modelFallback: context.modelFallback }
      : {}),
  });
  const recordPath = await persistRunRecord(context, record);
  return {
    result: {
      runId: pass.runId,
      record,
      recordPath,
      auditPath: pass.auditPath,
      transcriptPath: pass.transcriptPath,
      transcriptPaths: [pass.transcriptPath],
      reviewsPath: pass.reviewsPath,
      ledgerHitCount: pass.ledgerHitCount,
      modelCalls: pass.modelCalls,
      skillBashCalls: pass.skillBashCalls,
      ...(context.mrFilter !== undefined ? { mrFilter: context.mrFilter } : {}),
      timings: {
        auditStartedAt: context.startedAt.getTime(),
        auditEndedAt: timing.lastRequestEndAt,
        interPassReportMs: timing.interPassReportMs,
        reportCallbacksMs: timing.reportCallbacksMs,
        phaseSpans: timing.phaseSpans,
      },
    },
    runId: pass.runId,
    usage: pass.usage,
    truncated: pass.audit.truncated,
    findings: pass.findings,
  };
}

/**
 * 分片路径（ADR-0039）：串行跑每片，片间执行上报回调，最后聚合。
 * 目录布局、片标签与 `startedAt` 递进由 `buildPass` 与这里共同保证。
 */
async function executeShardedPasses(
  context: ReviewRunContext,
  shards: readonly Shard[],
): Promise<ReviewOutcome> {
  const total = shards.length;
  const descriptors = shards.map((shard) => ({ kind: "shard" as const, shard, total }));
  const executed = await runPasses(context, descriptors);
  return aggregateShards(context, executed);
}

async function aggregateShards(
  context: ReviewRunContext,
  executed: readonly ExecutedPass[],
): Promise<ReviewOutcome> {
  const findings = mergeShardFindings(executed.map((entry) => entry.pass.findings));
  // 单文件超预算截取留痕（ADR-0070）：片序 → 块序，无截取时为空数组
  const shardTruncation = executed.flatMap((entry) =>
    entry.descriptor.kind === "shard" ? entry.descriptor.shard.truncated : [],
  );

  let usage = ZERO_USAGE;
  let toolCalls = 0;
  let rounds = 0;
  let truncated = false;
  let ledgerHitCount = 0;
  let modelCalls = 0;
  let skillBashCalls = 0;
  const truncationReasons: string[] = [];
  const seenReasons = new Set<string>();
  const skillPassLog: RuleSkillPassRecord[] = [];
  // 解析失败留痕（P1）：聚合审计不重复承载正文，但失败诊断要留下——
  // 否则分片路径的 stderr 提示无从取数（成功 run 仍为空数组，零漂移）。
  const phaseParseFailures: PhaseRecord[] = [];
  const candidateNormalizations: CandidateNormalizationRecord[] = [];
  const rejectionCounts: Record<RejectionStage, number> = {
    SCHEMA_INVALID: 0,
    NON_ENGLISH: 0,
    NO_EVIDENCE: 0,
    VERIFICATION_FAILED: 0,
    OUT_OF_SCOPE: 0,
    DUPLICATE_ID: 0,
  };

  for (const { pass } of executed) {
    usage = addUsage(usage, pass.usage);
    toolCalls += pass.toolCalls;
    rounds = Math.max(rounds, pass.rounds);
    truncated = truncated || pass.audit.truncated;
    ledgerHitCount += pass.ledgerHitCount;
    modelCalls += pass.modelCalls;
    skillBashCalls += pass.skillBashCalls;
    for (const reason of pass.audit.truncationReasons) {
      if (!seenReasons.has(reason)) {
        seenReasons.add(reason);
        truncationReasons.push(reason);
      }
    }
    // 只聚合带解析失败的相位记录（诊断，不是正文）
    for (const phaseRecord of pass.audit.phaseLog) {
      if (phaseRecord.parseFailure !== undefined) {
        phaseParseFailures.push(phaseRecord);
      }
    }
    // 候选字段修复 / 拦截计数：片级诊断，聚合层保留（账目闭合）
    candidateNormalizations.push(...(pass.audit.candidateNormalizations ?? []));
    for (const [stage, count] of Object.entries(pass.audit.rejectionCounts ?? {})) {
      rejectionCounts[stage as RejectionStage] += count;
    }
    // 聚合 skillPassLog：把片内 basename 重写成 runs 目录相对路径，
    // 这样 export / session 索引能直接寻址到 shards/attempt-…/sNN 下的转录
    const passRunDir = path.dirname(pass.transcriptPath);
    for (const entry of pass.audit.skillPassLog ?? []) {
      skillPassLog.push({
        ...entry,
        ...(entry.transcriptFile !== undefined
          ? {
              transcriptFile: relativePosix(
                context.runsDir,
                path.join(passRunDir, entry.transcriptFile),
              ),
            }
          : {}),
      });
    }
  }

  const finishedAt = executed.at(-1)?.pass.finishedAt ?? new Date();
  const aggRunId = executed[0]?.pass.runId;
  if (aggRunId === undefined) {
    // 防御：分片路径至少一片（planReviewShards 保证非空）
    throw new Error("internal: sharded review produced no shard results");
  }

  const timings: ReviewTimings = {
    auditStartedAt: context.startedAt.getTime(),
    auditEndedAt: Math.max(...executed.map((entry) => entry.timing.lastRequestEndAt)),
    interPassReportMs: executed.reduce(
      (sum, entry) => sum + entry.timing.interPassReportMs,
      0,
    ),
    reportCallbacksMs: executed.reduce(
      (sum, entry) => sum + entry.timing.reportCallbacksMs,
      0,
    ),
    phaseSpans: executed.flatMap((entry) => {
      if (entry.descriptor.kind !== "shard") {
        return entry.timing.phaseSpans;
      }
      const shardIndex = entry.descriptor.shard.index;
      return entry.timing.phaseSpans.map((span) => ({ ...span, shardIndex }));
    }),
  };

  const shardAudits: ShardAuditRecord[] = executed.map(({ descriptor, pass }) => {
    if (descriptor.kind !== "shard") {
      throw new Error("internal: aggregate saw a single-pass descriptor");
    }
    const shard = descriptor.shard;
    return {
      index: shard.index,
      files: shard.files.length,
      chars: shard.chars,
      filePaths: shard.files,
      runId: pass.runId,
      status: "ok",
      complete: pass.complete,
      truncated: pass.audit.truncated,
      ...(context.boundary.degraded ? { domainWarning: context.boundary.domainWarning } : {}),
      usage: pass.usage,
      rounds: pass.rounds,
      toolCalls: pass.toolCalls,
    };
  });

  const tipsFilter = summarizeTipsFilter(findings, context.tipsConfidenceMin);
  const severityFilter = summarizeSeverityFilter(findings, context.tipsSeverityMin);
  const audit: RunAudit = {
    // 聚合审计不重复承载正文（正文在各片审计里），只做账目；
    // 解析失败记录是诊断，聚合进来让单份审计也能解释「候选为什么丢了」。
    requests: [],
    toolCallLog: [],
    phaseLog: phaseParseFailures,
    rejections: [],
    cacheBreaks: [],
    truncated,
    truncationReasons,
    // 规则 Skill 装载审计在聚合层记一次（ADR-0039 决策 4 / 7）
    ruleSkill: context.ruleSkillAudit,
    shards: shardAudits,
    ...(shardTruncation.length > 0 ? { shardTruncation } : {}),
    ...(skillPassLog.length > 0 ? { skillPassLog } : {}),
    ...(tipsFilter !== undefined ? { tipsFilter } : {}),
    ...(severityFilter !== undefined ? { severityFilter } : {}),
    ...(candidateNormalizations.length > 0 ? { candidateNormalizations } : {}),
    ...(Object.values(rejectionCounts).some((count) => count > 0) ? { rejectionCounts } : {}),
    // 模型替换留痕（ADR-0080）：聚合审计只记一次；无替换整键缺席
    ...(context.modelFallback !== undefined
      ? { modelFallback: context.modelFallback }
      : {}),
  };

  const auditContent = buildAuditFileContent({
    runId: aggRunId,
    caseId: context.caseId,
    model: context.modelId,
    effort: LOCKED_EFFORT_LABEL,
    startedAt: context.startedAt,
    finishedAt,
    rounds,
    toolCalls,
    usage,
    findings,
    audit,
    ...(context.boundary.degraded ? { mrBoundary: context.boundary.mrBoundary } : {}),
    ...(context.mrFilter !== undefined ? { mrFilter: context.mrFilter } : {}),
    ...(context.config !== undefined ? { config: context.config } : {}),
  });
  const auditPath = await writeAuditFile(context.auditRoot, auditContent);

  // 聚合 reviews_en.json（唯一对外真源）
  const reviewsPath = await writeReviewsEn(
    context.runsDir,
    buildReviewsExport({
      generatedAt: finishedAt,
      runId: aggRunId,
      source: "mr",
      caseId: context.caseId,
      rep: context.rep,
      model: context.modelId,
      findings,
    }),
  );

  const result: RunResult = {
    caseId: context.caseId,
    model: context.modelId,
    findings,
    usage,
    rounds,
    toolCalls,
    audit,
    auditPath,
    ...(context.boundary.degraded ? { domainWarning: context.boundary.domainWarning } : {}),
  };
  const shardRecords: ShardRecord[] = executed.map(({ descriptor, pass }) => {
    if (descriptor.kind !== "shard") {
      throw new Error("internal: aggregate saw a single-pass descriptor");
    }
    const shard = descriptor.shard;
    return {
      index: shard.index,
      runId: pass.runId,
      files: shard.files.length,
      chars: shard.chars,
      complete: pass.complete,
      truncated: pass.audit.truncated,
      usage: pass.usage,
      rounds: pass.rounds,
      toolCalls: pass.toolCalls,
      transcriptFile: relativePosix(context.runsDir, pass.transcriptPath),
      auditFile: relativePosix(context.auditRoot, pass.auditPath),
      ...(context.boundary.degraded ? { domainWarning: context.boundary.domainWarning } : {}),
    };
  });
  const record = buildRunRecord({
    source: "mr",
    caseId: context.caseId,
    rep: context.rep,
    model: context.modelId,
    completedAt: finishedAt,
    result,
    shards: shardRecords,
    ...(context.modelFallback !== undefined
      ? { modelFallback: context.modelFallback }
      : {}),
  });
  const recordPath = await persistRunRecord(context, record);

  return {
    result: {
      runId: aggRunId,
      record,
      recordPath,
      auditPath,
      transcriptPath: executed[0]?.pass.transcriptPath ?? "",
      transcriptPaths: executed.map((entry) => entry.pass.transcriptPath),
      reviewsPath,
      ledgerHitCount,
      modelCalls,
      skillBashCalls,
      ...(context.mrFilter !== undefined ? { mrFilter: context.mrFilter } : {}),
      ...(shardTruncation.length > 0 ? { shardTruncation } : {}),
      timings,
    },
    runId: aggRunId,
    usage,
    truncated,
    findings,
  };
}

/** 绝对路径 → 相对基准目录的 POSIX 路径（产物可搬迁） */
function relativePosix(baseDir: string, filePath: string): string {
  return path.relative(path.resolve(baseDir), path.resolve(filePath)).split(path.sep).join("/");
}

/**
 * 记录落盘单点：persistRecord=false（执行缝模式）时内核不落盘、返回空串——
 * runner 是记录唯一写者，防双写与孤儿文件。
 */
function persistRunRecord(context: ReviewRunContext, record: RunRecord): Promise<string> {
  if (!context.persistRecord) {
    return Promise.resolve("");
  }
  return writeRunRecord(context.runsRoot, record);
}

/**
 * findings 摘要（进度投影用）：只有条数与严重度分布。
 * 正文（title / description / evidence / 落点）**不进**进度事件——上报侧
 * 默认也只允许这一档，正文的出口永远只有 `reviews_en.json`（ADR-0037 决策 3）。
 */
function summarizeFindings(findings: readonly Finding[]): {
  readonly count: number;
  readonly bySeverity: Readonly<Record<"P0" | "P1" | "P2" | "P3", number>>;
} {
  const bySeverity: Record<"P0" | "P1" | "P2" | "P3", number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const finding of findings) {
    bySeverity[finding.severity] += 1;
  }
  return { count: findings.length, bySeverity };
}
