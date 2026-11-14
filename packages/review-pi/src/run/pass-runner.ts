import path from "node:path";

import type { FetchFunction } from "@earendil-works/pi-ai";

import { buildRunId } from "../audit/audit-writer.js";
import type { Finding } from "../contracts/finding.js";
import {
  type RunProgressSink,
  type ShardLabel,
} from "../contracts/progress.js";
import type {
  ModelFallbackRecord,
  MrFilterRecord,
  ReviewPhase,
  RuleSkillAudit,
} from "../contracts/run.js";
import { runDirPath } from "../experiment/run-record.js";
import { loadRuleSkills, type RuleSkill } from "../knowledge/rule-skill.js";
import { withRequestTimelineAppend } from "../observability/request-timeline.js";
import type { ConfigSnapshot } from "../shared/config.js";
import type { ReviewRuntime } from "../shared/review-runtime.js";
import type { MrBoundaryDecision } from "./mr-boundary-guard.js";
import { splitDiffIntoFileBlocks } from "./mr-input.js";
import { runReviewPass, type ReviewPassInput, type ReviewPassResult } from "./review-pass.js";
import type { ReviewRunInput, ReviewShardFindingsHook } from "./review-run.js";
import { composeShardInput, type Shard } from "./shard-planner.js";

/**
 * pass 装配（ADR-0039 / ADR-0080）：单遍与分片共用同一份 run 级上下文与
 * 每遍描述符。这一层只决定「哪些字段进本遍 `ReviewPassInput`」，不决定
 * 检视语义，也不改任何字节。
 *
 * 装配纪律（两条路径唯一的差异点）：
 * - run 级审计值（`config` / `modelFallback` / `mrFilter` / 真实 `boundary`）
 *   只在单遍或聚合审计出现；分片片内审计不带，`boundary` 传
 *   `{ degraded: false }` 占位。
 * - 单遍 = 目录落在 run 根、无片标签；分片 = `runs/shards/attempt-…/sNN`、
 *   进度事件带片标签。
 */

export interface ReviewRunContext {
  // 身份 / 传输
  readonly caseId: string;
  readonly repoPath: string;
  readonly issueDescription: string;
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetch: FetchFunction;
  readonly rep: number;

  // 已解析的运行档
  readonly runtime: ReviewRuntime;
  readonly modelId: string;

  // 路径与落盘
  readonly runsRoot: string;
  /** `runDirPath(runsRoot)`：单遍产物根，也是分片目录的基准 */
  readonly runsDir: string;
  /** `<runsRoot>/audit`：单遍审计根，也是分片审计的基准 */
  readonly auditRoot: string;
  readonly persistRecord: boolean;

  // run 级审计值（分片时只在聚合审计写一次）
  readonly boundary: MrBoundaryDecision;
  readonly mrFilter?: MrFilterRecord;
  readonly config?: ConfigSnapshot;
  readonly modelFallback?: ModelFallbackRecord;
  readonly tipsConfidenceMin?: number;
  readonly tipsSeverityMin?: Finding["severity"];

  // 规则包（装载一次，各遍共享）
  readonly ruleSkills: readonly RuleSkill[];
  readonly ruleSkillAudit: readonly RuleSkillAudit[];

  // 执行缝
  readonly startedAt: Date;
  readonly emit: RunProgressSink;
  readonly onShardFindings?: ReviewShardFindingsHook;
}

/** `runReview` 已解析的缺省值与入口度量结果 */
export interface ResolvedRunSettings {
  readonly startedAt: Date;
  readonly runtime: ReviewRuntime;
  readonly modelId: string;
  readonly emit: RunProgressSink;
  readonly boundary: MrBoundaryDecision;
  readonly mrFilter?: MrFilterRecord;
}

/**
 * 装配 run 级上下文。**在 `run.start` 之后调用**：规则包装载会写 stderr
 * 降级提示，必须保持既有的输出时序。
 */
export async function buildRunContext(
  input: ReviewRunInput,
  resolved: ResolvedRunSettings,
): Promise<ReviewRunContext> {
  const loaded = await loadRuleSkillSet(input, resolved.runtime);
  return {
    caseId: input.caseId,
    repoPath: input.repoPath,
    issueDescription: input.issueDescription,
    apiKey: input.apiKey,
    ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
    fetch: input.fetch,
    rep: input.rep,
    runtime: resolved.runtime,
    modelId: resolved.modelId,
    runsRoot: input.runsRoot,
    runsDir: runDirPath(input.runsRoot),
    auditRoot: path.join(input.runsRoot, "audit"),
    persistRecord: input.persistRecord !== false,
    boundary: resolved.boundary,
    ...(resolved.mrFilter !== undefined ? { mrFilter: resolved.mrFilter } : {}),
    ...(input.config !== undefined ? { config: input.config } : {}),
    ...(input.modelFallback !== undefined ? { modelFallback: input.modelFallback } : {}),
    ...(input.tipsConfidenceMin !== undefined
      ? { tipsConfidenceMin: input.tipsConfidenceMin }
      : {}),
    ...(input.tipsSeverityMin !== undefined
      ? { tipsSeverityMin: input.tipsSeverityMin }
      : {}),
    ruleSkills: loaded.skills,
    ruleSkillAudit: loaded.audit,
    startedAt: resolved.startedAt,
    emit: resolved.emit,
    ...(input.onShardFindings !== undefined
      ? { onShardFindings: input.onShardFindings }
      : {}),
  };
}

/** 每遍的执行形态：单遍只有 diff，分片带片与总数 */
export type PassDescriptor =
  | { readonly kind: "single"; readonly diff: string }
  | { readonly kind: "shard"; readonly shard: Shard; readonly total: number };

/** 装配结果：执行器直接用 `input`，回调侧用 `label` / `files` / `runDir` */
export interface BuiltPass {
  readonly input: ReviewPassInput;
  readonly label: ShardLabel;
  readonly files: readonly string[];
  /** 本遍产物目录（单遍 = run 根；分片 = `runs/shards/attempt-…/sNN`） */
  readonly runDir: string;
}

/** 一遍的执行结果：descriptor 保留片信息，聚合时据此收窄 */
export interface ExecutedPass {
  readonly descriptor: PassDescriptor;
  readonly pass: ReviewPassResult;
  readonly timing: PassTiming;
}

/** 一遍内一个 phase 的真实起止（绝对毫秒） */
export interface PassPhaseSpan {
  readonly round: number;
  readonly index: number;
  readonly phase: ReviewPhase;
  readonly startedAt: number;
  readonly endedAt: number;
}

/** 一遍的时间事实（ADR-0084）：只进 CLI 账本，不落审计 / 转录 */
export interface PassTiming {
  readonly phaseSpans: readonly PassPhaseSpan[];
  /** 本遍最后一个模型请求结束时刻 */
  readonly lastRequestEndAt: number;
  /** 本遍片级回调耗时（含最后一片之后的那次） */
  readonly reportCallbacksMs: number;
  /** 本遍回调且后面还有下一遍时计入（可从审计窗口扣除） */
  readonly interPassReportMs: number;
}

/** 执行器注入缝（测试注入假 pass / 假时钟；缺省真实现） */
export interface RunPassesOptions {
  readonly runPass?: (input: ReviewPassInput) => Promise<ReviewPassResult>;
  readonly now?: () => number;
}

/**
 * 执行一遍或多遍：串行、每遍结束后执行片级回调（含请求时间线续写），
 * 再推进下一遍的 `startedAt`。单遍 = 单元素 descriptors。
 *
 * 同时采集每遍的真实时间事实：phase 起止由本遍 emit 观察得到，最后一段
 * 以本遍最后一个请求结束为界（fallback = pass.finishedAt），避免把片间
 * 报文时间算进上一片的 P6。
 */
export async function runPasses(
  context: ReviewRunContext,
  descriptors: readonly PassDescriptor[],
  options: RunPassesOptions = {},
): Promise<readonly ExecutedPass[]> {
  const runPass = options.runPass ?? runReviewPass;
  const now = options.now ?? Date.now;
  const executed: ExecutedPass[] = [];
  let startedAt = context.startedAt;
  for (const [index, descriptor] of descriptors.entries()) {
    const built = buildPass(context, descriptor, startedAt);
    const observer = observePassEmit(built.input.emit, now);
    const pass = await runPass({ ...built.input, emit: observer.emit });
    const observed = observer.finish(pass.finishedAt.getTime());

    // 片级上报缝（ADR-0045）：该片 findings 定型、下一片开始前（串行 await）。
    // 报文载荷生成是一次性模型调用，续写本片已关闭的时间线（ADR-0076）。
    const reportStartedAt = now();
    await withRequestTimelineAppend(built.runDir, () =>
      notifyShardFindings(context.onShardFindings, built.label, pass.findings, built.files),
    );
    const callbackMs = Math.max(0, now() - reportStartedAt);
    const hasNext = index < descriptors.length - 1;

    executed.push({
      descriptor,
      pass,
      timing: {
        phaseSpans: observed.phaseSpans,
        lastRequestEndAt: observed.lastRequestEndAt,
        reportCallbacksMs: callbackMs,
        interPassReportMs: hasNext ? callbackMs : 0,
      },
    });
    startedAt = pass.finishedAt;
  }
  return executed;
}

/**
 * 包装一遍的 emit：记录 phase 起止与本遍最后请求结束。
 * 转发给消费者的字节不变；时间只进返回值。
 */
function observePassEmit(
  emit: RunProgressSink,
  now: () => number,
): {
  readonly emit: RunProgressSink;
  finish(fallbackEndedAt: number): {
    readonly phaseSpans: readonly PassPhaseSpan[];
    readonly lastRequestEndAt: number;
  };
} {
  const spans: PassPhaseSpan[] = [];
  let current: Omit<PassPhaseSpan, "endedAt"> | undefined;
  let lastRequestEndAt: number | undefined;
  const close = (endedAt: number): void => {
    if (current !== undefined) {
      spans.push({ ...current, endedAt: Math.max(current.startedAt, endedAt) });
      current = undefined;
    }
  };
  return {
    emit: (event) => {
      if (event.kind === "phase") {
        const at = now();
        close(at);
        current = {
          round: event.round,
          index: event.index,
          phase: event.phase,
          startedAt: at,
        };
      } else if (event.kind === "request" && event.state === "end") {
        lastRequestEndAt = now();
      }
      emit(event);
    },
    finish: (fallbackEndedAt) => {
      const endedAt = lastRequestEndAt ?? fallbackEndedAt;
      close(endedAt);
      return { phaseSpans: spans, lastRequestEndAt: endedAt };
    },
  };
}

async function notifyShardFindings(
  hook: ReviewShardFindingsHook | undefined,
  label: { readonly index: number; readonly total: number },
  findings: readonly Finding[],
  files: readonly string[],
): Promise<void> {
  if (hook === undefined) {
    return;
  }
  try {
    await hook(label, findings, files);
  } catch {
    // 旁路（ADR-0045 决策 3）：hook 自身负责 stderr 可见性；这里只保证不外溢
  }
}

/**
 * context + descriptor → `ReviewPassInput`。两条路径的差异**只在这里**：
 * 目录布局、片标签、emit 包装、以及 run 级审计值是否进入本遍。
 */
export function buildPass(
  context: ReviewRunContext,
  descriptor: PassDescriptor,
  startedAt: Date,
): BuiltPass {
  const common = {
    caseId: context.caseId,
    repoPath: context.repoPath,
    issueDescription: context.issueDescription,
    apiKey: context.apiKey,
    fetch: context.fetch,
    runtime: context.runtime,
    modelId: context.modelId,
    rep: context.rep,
    ...(context.baseUrl !== undefined ? { baseUrl: context.baseUrl } : {}),
    ruleSkills: context.ruleSkills,
    ruleSkillAudit: context.ruleSkillAudit,
    startedAt,
    ...(context.tipsConfidenceMin !== undefined
      ? { tipsConfidenceMin: context.tipsConfidenceMin }
      : {}),
    ...(context.tipsSeverityMin !== undefined
      ? { tipsSeverityMin: context.tipsSeverityMin }
      : {}),
  };

  if (descriptor.kind === "single") {
    const files = splitDiffIntoFileBlocks(descriptor.diff)
      .map((block) => block.path)
      .filter((filePath) => filePath !== "");
    return {
      input: {
        ...common,
        diff: descriptor.diff,
        initialDiff: descriptor.diff,
        runDir: context.runsDir,
        auditDir: context.auditRoot,
        // 单遍：run 级审计值进本遍审计
        boundary: context.boundary,
        ...(context.mrFilter !== undefined ? { mrFilter: context.mrFilter } : {}),
        ...(context.config !== undefined ? { config: context.config } : {}),
        ...(context.modelFallback !== undefined
          ? { modelFallback: context.modelFallback }
          : {}),
        emit: context.emit,
      },
      label: { index: 1, total: 1 },
      files,
      runDir: context.runsDir,
    };
  }

  const label: ShardLabel = {
    index: descriptor.shard.index,
    total: descriptor.total,
  };
  const dirName = shardDirName(descriptor.shard.index);
  const runDir = path.join(
    context.runsDir,
    "shards",
    attemptName(context.startedAt),
    dirName,
  );
  return {
    input: {
      ...common,
      diff: descriptor.shard.diff,
      initialDiff: composeShardInput(descriptor.shard),
      runDir,
      auditDir: path.join(
        context.auditRoot,
        "shards",
        attemptName(context.startedAt),
        dirName,
      ),
      // 全局边界 / 预过滤 / 配置只在聚合审计记一次：片内审计不带这三项
      boundary: { degraded: false },
      shard: label,
      emit: withShardLabel(context.emit, label),
    },
    label,
    files: descriptor.shard.files,
    runDir,
  };
}

/** attempt 目录名 = run 入口 `startedAt`（仅目录名，不是 runId） */
export function attemptName(startedAt: Date): string {
  return `attempt-${buildRunId(startedAt)}`;
}

/** 片号两位化（与分片目录名 sNN 同形） */
export function shardDirName(index: number): string {
  return `s${String(index).padStart(2, "0")}`;
}

/** 片上标签：仅加在非 run 事件上（run.start/end 由外层独占） */
export function withShardLabel(
  emit: RunProgressSink,
  shard: ShardLabel,
): RunProgressSink {
  return (event) => emit(event.kind === "run" ? event : { ...event, shard });
}

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

/** 规则 Skill → 审计轻量项（与既有 AuditLight 形状同源） */
function toRuleSkillAudit(skill: RuleSkill): RuleSkillAudit {
  return {
    source: skill.source.path,
    // zip 形态省略（历史审计字节不变）；目录形态才标出来（ADR-0018）
    ...(skill.source.kind === "dir" ? { kind: skill.source.kind } : {}),
    digest: skill.digest,
    name: skill.name,
    ...(skill.degradedReason !== undefined ? { degradedReason: skill.degradedReason } : {}),
    ...(skill.diagnostics.length > 0
      ? {
          diagnostics: skill.diagnostics.map((diagnostic) => ({
            code: diagnostic.code,
            path: diagnostic.path,
          })),
        }
      : {}),
  };
}
