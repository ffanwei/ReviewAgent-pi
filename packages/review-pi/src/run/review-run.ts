import path from "node:path";
import type { FetchFunction } from "@earendil-works/pi-ai";
import { buildAuditFileContent, buildRunId, writeAuditFile } from "../audit/audit-writer.js";
import type { Finding } from "../contracts/finding.js";
import type { LlmUsage } from "../contracts/llm.js";
import {
  NO_OP_PROGRESS_SINK,
  type RunProgressSink,
  type ShardLabel,
} from "../contracts/progress.js";
import type {
  CandidateNormalizationRecord,
  MrFilterRecord,
  PhaseRecord,
  RejectionStage,
  RuleSkillAudit,
  RuleSkillPassRecord,
  RunAudit,
  RunResult,
  ShardAuditRecord,
} from "../contracts/run.js";
import {
  buildRunRecord,
  runDirPath,
  writeRunRecord,
  type RunRecord,
  type ShardRecord,
} from "../experiment/run-record.js";
import { buildReviewsExport, writeReviewsEn } from "../export/reviews.js";
import { loadRuleSkills, type RuleSkill } from "../knowledge/rule-skill.js";
import { LOCKED_EFFORT_LABEL, REVIEW_MODEL_ID } from "../provider/pi-client.js";
import { addUsage, ZERO_USAGE } from "../provider/usage-map.js";
import type { ConfigSnapshot, SplitLimits } from "../shared/config.js";
import { DEFAULT_REVIEW_RUNTIME, type ReviewRuntime } from "../shared/review-runtime.js";
import { summarizeSeverityFilter } from "../shared/severity-filter.js";
import { summarizeTipsFilter } from "../shared/tips-filter.js";
import { guardMrBoundary, type MrBoundaryDecision } from "./mr-boundary-guard.js";
import { assertDiffWithinCharLimit, filterDiffForReview, splitDiffIntoFileBlocks, toMrFilterRecord } from "./mr-input.js";
import { mergeShardFindings } from "./findings-merge.js";
import { runReviewPass, type ReviewPassResult } from "./review-pass.js";
import {
  composeShardInput,
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
  /** 规则 Skill 显式**已解压目录**列表（--rule-skill 可重复；排在全部 zip 之后） */
  readonly ruleSkillDirs?: readonly string[];
  /** 规则 Skill 严格模式（--strict-rule-skill）：装载失败抛错而非降级 */
  readonly strictRuleSkill?: boolean;
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
}

/** 一次 run 的聚合结果（emit run.end 需要 usage / truncated / findings 摘要） */
interface ReviewOutcome {
  readonly result: ReviewRunResult;
  readonly runId: string;
  readonly usage: LlmUsage;
  readonly truncated: boolean;
  readonly findings: readonly Finding[];
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
 */
export async function runReview(input: ReviewRunInput): Promise<ReviewRunResult> {
  const startedAt = input.startedAt ?? new Date();
  const emit = input.onProgress ?? NO_OP_PROGRESS_SINK;
  const runtime = input.runtime ?? DEFAULT_REVIEW_RUNTIME;
  const modelId = input.modelId ?? REVIEW_MODEL_ID;

  // 大 diff 第一期（内核入口唯一咽喉）：
  // 1) 预过滤噪声文件（lockfile / 生成物 / minified / 二进制），整块剔除、
  //    绝不切 hunk；2) 过滤后再过体积门（超限直接抛错，不把注定失败的请求
  //    发给模型）。过滤清单经审计尾键 `mrFilter` 与 stderr 一行留痕。
  // 第二期：同一份过滤结果只算一次，分片不改写任何字节。
  const filtered = filterDiffForReview(input.diff);
  assertDiffWithinCharLimit(filtered.diff, runtime.limits.boundary.maxDiffChars);
  const diff = filtered.diff;
  const mrFilter = toMrFilterRecord(filtered);
  // MR 边界护栏（#12）：度量对象是**过滤后**的 diff。分片模式下它是整份 MR
  // 的属性，只度量 / 记账一次（每片审计不重复记）。
  const boundary = guardMrBoundary(diff, runtime.limits.boundary);

  const shards = planReviewShards(diff, runtime.limits.split);
  const shardTotal = shards === null ? 1 : shards.length;
  emit({
    kind: "run",
    state: "start",
    caseId: input.caseId,
    model: modelId,
    startedAt: startedAt.toISOString(),
    ...(shards !== null ? { shards: { total: shardTotal } } : {}),
  });

  try {
    const outcome =
      shards === null
        ? await executeSinglePass({
            input,
            runtime,
            modelId,
            diff,
            startedAt,
            boundary,
            ...(mrFilter !== undefined ? { mrFilter } : {}),
            emit,
          })
        : await executeShardedPasses({
            input,
            runtime,
            modelId,
            shards,
            startedAt,
            boundary,
            ...(mrFilter !== undefined ? { mrFilter } : {}),
            emit,
          });
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

/** 规划分片：关闭 / 未超预算 / 只装出一片时返回 null（单遍路径，零变更） */
function planReviewShards(diff: string, split: SplitLimits): readonly Shard[] | null {
  if (!split.enabled || diff.length <= split.maxShardChars) {
    return null;
  }
  const plan: ShardPlan = planShards(diff, {
    maxShardChars: split.maxShardChars,
    maxShards: split.maxShards,
    contextSummaryChars: split.contextSummaryChars,
  });
  return plan.shards.length > 1 ? plan.shards : null;
}

// ---------------------------------------------------------------------------
// 单遍路径（与 ADR-0039 之前的实现逐字节一致）
// ---------------------------------------------------------------------------

/**
 * 片级回调调度（ADR-0045）：旁路纪律的最后一道闸——实现方应自吞错误，这里
 * 仍防御性捕获（hook 抛错 = 实现方 bug），绝不把上报失败变成检视失败。
 */
async function notifyShardFindings(
  input: ReviewRunInput,
  label: { readonly index: number; readonly total: number },
  findings: readonly Finding[],
  files: readonly string[],
): Promise<void> {
  if (input.onShardFindings === undefined) {
    return;
  }
  try {
    await input.onShardFindings(label, findings, files);
  } catch {
    // 旁路（ADR-0045 决策 3）：hook 自身负责 stderr 可见性；这里只保证不外溢
  }
}

async function executeSinglePass(args: {
  readonly input: ReviewRunInput;
  readonly runtime: ReviewRuntime;
  readonly modelId: string;
  readonly diff: string;
  readonly startedAt: Date;
  readonly boundary: MrBoundaryDecision;
  readonly mrFilter?: MrFilterRecord;
  readonly emit: RunProgressSink;
}): Promise<ReviewOutcome> {
  const loaded = await loadRuleSkillSet(args.input, args.runtime);
  const pass = await runReviewPass({
    caseId: args.input.caseId,
    repoPath: args.input.repoPath,
    issueDescription: args.input.issueDescription,
    apiKey: args.input.apiKey,
    fetch: args.input.fetch,
    runtime: args.runtime,
    modelId: args.modelId,
    rep: args.input.rep,
    ...(args.input.baseUrl !== undefined ? { baseUrl: args.input.baseUrl } : {}),
    diff: args.diff,
    initialDiff: args.diff,
    ruleSkills: loaded.skills,
    ruleSkillAudit: loaded.audit,
    runDir: runDirPath(args.input.runsRoot),
    auditDir: path.join(args.input.runsRoot, "audit"),
    startedAt: args.startedAt,
    boundary: args.boundary,
    ...(args.mrFilter !== undefined ? { mrFilter: args.mrFilter } : {}),
    ...(args.input.config !== undefined ? { config: args.input.config } : {}),
    ...(args.input.tipsConfidenceMin !== undefined
      ? { tipsConfidenceMin: args.input.tipsConfidenceMin }
      : {}),
    ...(args.input.tipsSeverityMin !== undefined
      ? { tipsSeverityMin: args.input.tipsSeverityMin }
      : {}),
    emit: args.emit,
  });
  // 片级上报缝（ADR-0045）：单片路径 = 一次调用，findings 已定型；文件清单
  // 取整份 diff（让「没有问题」也按文件上报，与分片路径同契约）。
  await notifyShardFindings(
    args.input,
    { index: 1, total: 1 },
    pass.findings,
    splitDiffIntoFileBlocks(args.diff)
      .map((block) => block.path)
      .filter((filePath) => filePath !== ""),
  );

  const result: RunResult = {
    caseId: args.input.caseId,
    model: args.modelId,
    findings: pass.findings,
    usage: pass.usage,
    rounds: pass.rounds,
    toolCalls: pass.toolCalls,
    audit: pass.audit,
    auditPath: pass.auditPath,
    // 域外显式降级标注（#12）：界内省键（边界内与无护栏时逐字节一致）
    ...(args.boundary.degraded ? { domainWarning: args.boundary.domainWarning } : {}),
  };
  const record = buildRunRecord({
    source: "mr",
    caseId: args.input.caseId,
    rep: args.input.rep,
    model: args.modelId,
    completedAt: pass.finishedAt,
    result,
  });
  const recordPath = await persistRunRecord(args.input, record);
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
      ...(args.mrFilter !== undefined ? { mrFilter: args.mrFilter } : {}),
    },
    runId: pass.runId,
    usage: pass.usage,
    truncated: pass.audit.truncated,
    findings: pass.findings,
  };
}

// ---------------------------------------------------------------------------
// 分片路径（ADR-0039 决策 2 / 4 / 5 / 6 / 7 / 10）
// ---------------------------------------------------------------------------

async function executeShardedPasses(args: {
  readonly input: ReviewRunInput;
  readonly runtime: ReviewRuntime;
  readonly modelId: string;
  readonly shards: readonly Shard[];
  readonly startedAt: Date;
  readonly boundary: MrBoundaryDecision;
  readonly mrFilter?: MrFilterRecord;
  readonly emit: RunProgressSink;
}): Promise<ReviewOutcome> {
  const total = args.shards.length;
  // attempt 目录名 = run 入口 startedAt（仅目录名，不是 runId）；每次尝试独占
  // 一组片产物，重跑不覆盖历史转录（ADR-0039 决策 6）。
  const attempt = `attempt-${buildRunId(args.startedAt)}`;
  const runsDir = runDirPath(args.input.runsRoot);
  const auditRoot = path.join(args.input.runsRoot, "audit");
  // 规则 Skill 装载与装载审计只做一次（ADR-0039 决策 4）
  const loaded = await loadRuleSkillSet(args.input, args.runtime);

  const executed: Array<{ readonly shard: Shard; readonly pass: ReviewPassResult }> = [];
  let shardStartedAt = args.startedAt;
  for (const shard of args.shards) {
    const dirName = shardDirName(shard.index);
    const pass = await runReviewPass({
      caseId: args.input.caseId,
      repoPath: args.input.repoPath,
      issueDescription: args.input.issueDescription,
      apiKey: args.input.apiKey,
      fetch: args.input.fetch,
      runtime: args.runtime,
      modelId: args.modelId,
      rep: args.input.rep,
      ...(args.input.baseUrl !== undefined ? { baseUrl: args.input.baseUrl } : {}),
      diff: shard.diff,
      initialDiff: composeShardInput(shard),
      ruleSkills: loaded.skills,
      ruleSkillAudit: loaded.audit,
      runDir: path.join(runsDir, "shards", attempt, dirName),
      auditDir: path.join(auditRoot, "shards", attempt, dirName),
      startedAt: shardStartedAt,
      // 全局边界 / 预过滤 / 配置只在聚合审计记一次：片内审计不带这三项
      boundary: { degraded: false },
      ...(args.input.tipsConfidenceMin !== undefined
        ? { tipsConfidenceMin: args.input.tipsConfidenceMin }
        : {}),
      ...(args.input.tipsSeverityMin !== undefined
        ? { tipsSeverityMin: args.input.tipsSeverityMin }
        : {}),
      emit: withShardLabel(args.emit, { index: shard.index, total }),
    });
    executed.push({ shard, pass });
    // 片级上报缝（ADR-0045）：该片 findings 定型、下一片开始前（串行 await）。
    await notifyShardFindings(args.input, { index: shard.index, total }, pass.findings, shard.files);
    shardStartedAt = pass.finishedAt;
  }

  return aggregateShards({
    input: args.input,
    modelId: args.modelId,
    startedAt: args.startedAt,
    boundary: args.boundary,
    ruleSkillAudit: loaded.audit,
    ...(args.mrFilter !== undefined ? { mrFilter: args.mrFilter } : {}),
    runsDir,
    auditRoot,
    executed,
  });
}

async function aggregateShards(args: {
  readonly input: ReviewRunInput;
  readonly modelId: string;
  readonly startedAt: Date;
  readonly boundary: MrBoundaryDecision;
  readonly ruleSkillAudit: readonly RuleSkillAudit[];
  readonly mrFilter?: MrFilterRecord;
  readonly runsDir: string;
  readonly auditRoot: string;
  readonly executed: readonly { readonly shard: Shard; readonly pass: ReviewPassResult }[];
}): Promise<ReviewOutcome> {
  const findings = mergeShardFindings(args.executed.map((entry) => entry.pass.findings));

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

  for (const { pass } of args.executed) {
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
                args.runsDir,
                path.join(passRunDir, entry.transcriptFile),
              ),
            }
          : {}),
      });
    }
  }

  const finishedAt = args.executed.at(-1)?.pass.finishedAt ?? new Date();
  const aggRunId = args.executed[0]?.pass.runId;
  if (aggRunId === undefined) {
    // 防御：分片路径至少一片（planReviewShards 保证 length > 1）
    throw new Error("internal: sharded review produced no shard results");
  }

  const shardAudits: ShardAuditRecord[] = args.executed.map(({ shard, pass }) => ({
    index: shard.index,
    files: shard.files.length,
    chars: shard.chars,
    filePaths: shard.files,
    runId: pass.runId,
    status: "ok",
    complete: pass.complete,
    truncated: pass.audit.truncated,
    ...(args.boundary.degraded ? { domainWarning: args.boundary.domainWarning } : {}),
    usage: pass.usage,
    rounds: pass.rounds,
    toolCalls: pass.toolCalls,
  }));

  const tipsFilter = summarizeTipsFilter(findings, args.input.tipsConfidenceMin);
  const severityFilter = summarizeSeverityFilter(findings, args.input.tipsSeverityMin);
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
    ruleSkill: args.ruleSkillAudit,
    shards: shardAudits,
    ...(skillPassLog.length > 0 ? { skillPassLog } : {}),
    ...(tipsFilter !== undefined ? { tipsFilter } : {}),
    ...(severityFilter !== undefined ? { severityFilter } : {}),
    ...(candidateNormalizations.length > 0 ? { candidateNormalizations } : {}),
    ...(Object.values(rejectionCounts).some((count) => count > 0) ? { rejectionCounts } : {}),
  };

  const auditContent = buildAuditFileContent({
    runId: aggRunId,
    caseId: args.input.caseId,
    model: args.modelId,
    effort: LOCKED_EFFORT_LABEL,
    startedAt: args.startedAt,
    finishedAt,
    rounds,
    toolCalls,
    usage,
    findings,
    audit,
    ...(args.boundary.degraded ? { mrBoundary: args.boundary.mrBoundary } : {}),
    ...(args.mrFilter !== undefined ? { mrFilter: args.mrFilter } : {}),
    ...(args.input.config !== undefined ? { config: args.input.config } : {}),
  });
  const auditPath = await writeAuditFile(args.auditRoot, auditContent);

  // 聚合 reviews_en.json（唯一对外真源）
  const reviewsPath = await writeReviewsEn(
    args.runsDir,
    buildReviewsExport({
      generatedAt: finishedAt,
      runId: aggRunId,
      source: "mr",
      caseId: args.input.caseId,
      rep: args.input.rep,
      model: args.modelId,
      findings,
    }),
  );

  const result: RunResult = {
    caseId: args.input.caseId,
    model: args.modelId,
    findings,
    usage,
    rounds,
    toolCalls,
    audit,
    auditPath,
    ...(args.boundary.degraded ? { domainWarning: args.boundary.domainWarning } : {}),
  };
  const shardRecords: ShardRecord[] = args.executed.map(({ shard, pass }) => ({
    index: shard.index,
    runId: pass.runId,
    files: shard.files.length,
    chars: shard.chars,
    complete: pass.complete,
    truncated: pass.audit.truncated,
    usage: pass.usage,
    rounds: pass.rounds,
    toolCalls: pass.toolCalls,
    transcriptFile: relativePosix(args.runsDir, pass.transcriptPath),
    auditFile: relativePosix(args.auditRoot, pass.auditPath),
    ...(args.boundary.degraded ? { domainWarning: args.boundary.domainWarning } : {}),
  }));
  const record = buildRunRecord({
    source: "mr",
    caseId: args.input.caseId,
    rep: args.input.rep,
    model: args.modelId,
    completedAt: finishedAt,
    result,
    shards: shardRecords,
  });
  const recordPath = await persistRunRecord(args.input, record);

  return {
    result: {
      runId: aggRunId,
      record,
      recordPath,
      auditPath,
      transcriptPath: args.executed[0]?.pass.transcriptPath ?? "",
      transcriptPaths: args.executed.map((entry) => entry.pass.transcriptPath),
      reviewsPath,
      ledgerHitCount,
      modelCalls,
      skillBashCalls,
      ...(args.mrFilter !== undefined ? { mrFilter: args.mrFilter } : {}),
    },
    runId: aggRunId,
    usage,
    truncated,
    findings,
  };
}

/** 规则 Skill 装载（ADR-0012 / ADR-0014 / ADR-0018）：编排层只做一次 */
async function loadRuleSkillSet(
  input: ReviewRunInput,
  runtime: ReviewRuntime,
): Promise<{ readonly skills: readonly RuleSkill[]; readonly audit: readonly RuleSkillAudit[] }> {
  const skills = await ruleSkillsOf(input, runtime);
  return { skills, audit: skills.map(toRuleSkillAudit) };
}

async function ruleSkillsOf(
  input: ReviewRunInput,
  runtime: ReviewRuntime,
): Promise<readonly RuleSkill[]> {
  const loadRuleSkillsFn = input.ruleSkillLoader ?? loadRuleSkills;
  const explicitZips =
    input.ruleSkillZips ?? (input.ruleSkillZip !== undefined ? [input.ruleSkillZip] : undefined);
  return loadRuleSkillsFn({
    repoPath: input.repoPath,
    cacheRoot: path.join(input.runsRoot, ".cache", "rule-skills"),
    ...(explicitZips !== undefined ? { explicitZipPaths: explicitZips } : {}),
    ...(input.ruleSkillDirs !== undefined ? { ruleSkillDirs: input.ruleSkillDirs } : {}),
    ...(input.strictRuleSkill !== undefined ? { strict: input.strictRuleSkill } : {}),
    // ADR-0025：归档上限与解压超时来自配置快照（缺省 = 历史常量）
    limits: {
      ...runtime.limits.archive,
      timeoutMs: runtime.limits.timeouts.ruleSkillExtractMs,
    },
  });
}

/** 片上标签：仅加在非 run 事件上（run.start/end 由外层独占） */
function withShardLabel(emit: RunProgressSink, shard: ShardLabel): RunProgressSink {
  return (event) => emit(event.kind === "run" ? event : { ...event, shard });
}

function shardDirName(index: number): string {
  return `s${String(index).padStart(2, "0")}`;
}

/** 绝对路径 → 相对基准目录的 POSIX 路径（产物可搬迁） */
function relativePosix(baseDir: string, filePath: string): string {
  return path.relative(path.resolve(baseDir), path.resolve(filePath)).split(path.sep).join("/");
}

/**
 * 记录落盘单点：persistRecord=false（执行缝模式）时内核不落盘、返回空串——
 * runner 是记录唯一写者，防双写与孤儿文件。
 */
function persistRunRecord(input: ReviewRunInput, record: RunRecord): Promise<string> {
  if (input.persistRecord === false) {
    return Promise.resolve("");
  }
  return writeRunRecord(input.runsRoot, record);
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

/**
 * RuleSkill → 审计留痕投影：source/digest/name + 降级原因 + 装载诊断
 * （code/path 窄投影；path 已净化为缓存目录相对 POSIX）。
 * 缺席省键纪律：diagnostics 空 / 无降级时省键。
 */
function toRuleSkillAudit(skill: RuleSkill): RuleSkillAudit {
  return {
    source: skill.source.path,
    // zip 形态省略（历史审计字节不变）；目录形态才标出来（ADR-0018）
    ...(skill.source.kind === "dir" ? { kind: skill.source.kind } : {}),
    digest: skill.digest,
    name: skill.name,
    ...(skill.degradedReason !== undefined ? { degradedReason: skill.degradedReason } : {}),
    ...(skill.diagnostics.length > 0
      ? { diagnostics: skill.diagnostics.map((diagnostic) => ({ code: diagnostic.code, path: diagnostic.path })) }
      : {}),
  };
}
