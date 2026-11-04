import path from "node:path";
import type { FetchFunction } from "@earendil-works/pi-ai";
import { buildAuditFileContent, buildRunId, writeAuditFile } from "../audit/audit-writer.js";
import type { Finding } from "../contracts/finding.js";
import type { LedgerEntry } from "../contracts/ledger.js";
import { NO_OP_PROGRESS_SINK, type RunProgressSink } from "../contracts/progress.js";
import type { RuleSkillAudit, RuleSkillPassRecord, RunAudit, RunResult, MrFilterRecord } from "../contracts/run.js";
import { buildRunRecord, runDirPath, writeRunRecord, type RunRecord } from "../experiment/run-record.js";
import { buildReviewsExport, writeReviewsEn } from "../export/reviews.js";
import { buildTranscript, writeTranscript, type AgentTranscriptCapture } from "../export/transcript.js";
import { loadRuleSkills, type RuleSkill } from "../knowledge/rule-skill.js";
import type { SkillPassTranscript } from "../knowledge/skill-pass.js";
import { runAgentReviewLoop } from "../loop/agent-review-loop.js";
import { buildInitialUserMessage } from "../loop/messages.js";
import { LOCKED_EFFORT_LABEL, REVIEW_MODEL_ID } from "../provider/pi-client.js";
import type { ConfigSnapshot } from "../shared/config.js";
import { DEFAULT_REVIEW_RUNTIME, type ReviewRuntime } from "../shared/review-runtime.js";
import { buildReviewToolkit, type ReviewToolkit } from "../tools/toolkit.js";
import { createContextLedger } from "../tools/ledger.js";
import { SYSTEM_PROMPT } from "../zonea/system-prompt.js";
import { guardMrBoundary, type MrBoundaryDecision } from "./mr-boundary-guard.js";
import { assertDiffWithinCharLimit, filterDiffForReview, toMrFilterRecord } from "./mr-input.js";

// 单案全链入口（ADR-0024：配置矩阵删除后只剩唯一形态）：
// MR 初始上下文 → pi-agent-core Agent 三钩子循环（七工具 + 轮次上界 + Ledger
// + 规则 Skill 会话）→ 审计投影落盘。
//
// 规则 Skill 是唯一形态（原 config F）：装载成功则用于候选阶段的规则检视；
// 装不到则照常检视（`ruleSkill: []`），由 CLI 在 stderr 提示一行。
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
}

export interface ReviewRunResult {
  /** run 标识（毫秒时间戳 + 用例；审计文件名同源；#7 CLI stdout 契约） */
  readonly runId: string;
  readonly record: RunRecord;
  readonly recordPath: string;
  readonly auditPath: string;
  /** 检视转录路径（ADR-0013）：走 pi Agent，每 run 独立留档 */
  readonly transcriptPath: string;
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

/**
 * 单案全链入口：**先发 run 起点，再跑主体，成败都补 run 终点**（ADR-0037）。
 *
 * run 起止也是进度事件的投影（ADR-0016 三条纪律原样继承）：消费方（CLI 渲染 /
 * 上报）只看见既有留痕里已有的事实。`run.end` 的 `runId` 只在成功路径出现——
 * 它由首次模型请求时刻决定（ADR-0032），在首次请求之前失败时从未存在过。
 */
export async function runReview(input: ReviewRunInput): Promise<ReviewRunResult> {
  const startedAt = input.startedAt ?? new Date();
  const emit = input.onProgress ?? NO_OP_PROGRESS_SINK;
  emit({
    kind: "run",
    state: "start",
    caseId: input.caseId,
    model: input.modelId ?? REVIEW_MODEL_ID,
    startedAt: startedAt.toISOString(),
  });
  try {
    return await runReviewInner(input, startedAt, emit);
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

async function runReviewInner(
  input: ReviewRunInput,
  startedAt: Date,
  emit: RunProgressSink,
): Promise<ReviewRunResult> {
  const modelId = input.modelId ?? REVIEW_MODEL_ID;
  const runtime = input.runtime ?? DEFAULT_REVIEW_RUNTIME;
  // 大 diff 第一期（内核入口唯一咽喉）：
  // 1) 预过滤噪声文件（lockfile / 生成物 / minified / 二进制），整块剔除、
  //    绝不切 hunk；2) 过滤后再过体积门（超限直接抛错，不把注定失败的请求
  //    发给模型）。过滤清单经审计尾键 `mrFilter` 与 stderr 一行留痕。
  const filtered = filterDiffForReview(input.diff);
  assertDiffWithinCharLimit(filtered.diff, runtime.limits.boundary.maxDiffChars);
  const diff = filtered.diff;
  const mrFilter = toMrFilterRecord(filtered);
  // MR 边界护栏（#12）：纯度量，不触碰请求字节面：界内 degraded=false 全程零介入
  // （缺席省键），超界/不可度量只追加结果尾键（domainWarning + 审计 mrBoundary）。
  // ADR-0025：界值来自 `limits.boundary`；两维皆 null = 护栏停用（不度量不告警）。
  // 度量对象是**过滤后**的 diff：过滤剔掉的噪声不应把 MR 推过边界。
  const boundary = guardMrBoundary(diff, runtime.limits.boundary);

  const initialContextMessages = [
    { role: "user" as const, content: buildInitialUserMessage(input.caseId, input.issueDescription, diff) },
  ];

  const toolkit = buildReviewToolkit({
    repoPath: input.repoPath,
    diff,
    runtime,
    ledgerMode: "enabled",
  });

  // 规则 Skill（ADR-0012 / ADR-0014 / ADR-0018）：**在 new Agent 之前**完成
  // 定位 → 解压前审计 → 解压 → 复核 → 装载。多 zip 按 CLI 顺序；降级包不跑
  // 会话（装载事实进 `ruleSkill[]`）。cacheRoot 落在 run 输出根（绝不写回仓库）。
  const loadRuleSkillsFn = input.ruleSkillLoader ?? loadRuleSkills;
  const explicitZips =
    input.ruleSkillZips ?? (input.ruleSkillZip !== undefined ? [input.ruleSkillZip] : undefined);
  const ruleSkills: readonly RuleSkill[] = await loadRuleSkillsFn({
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
  const ruleSkillAudit = ruleSkills.map(toRuleSkillAudit);
  // skill 会话的七工具 toolkit：每个 skill 按 Phase-5 ledger 快照分叉一次
  // （skill 之间互不可见；skill 读取不污染主账本）
  const skillToolkitFor = (seed: readonly LedgerEntry[]): ReviewToolkit =>
    buildReviewToolkit({
      repoPath: input.repoPath,
      diff,
      runtime,
      ledger: createContextLedger(seed),
    });

  const outcome = await runAgentReviewLoop({
    systemPrompt: SYSTEM_PROMPT,
    initialContextMessages,
    toolkit,
    apiKey: input.apiKey,
    runtime,
    ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
    ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
    fetch: input.fetch,
    includeLedgerAudit: true,
    ...(input.onProgress !== undefined ? { onProgress: input.onProgress } : {}),
    // Phase 5 之后追加独立 skill 检视会话（Phase 5 消息不再被修改）
    skillPass: { skills: ruleSkills, toolkitFor: skillToolkitFor },
  });

  // 审计投影
  const finishedAt = new Date();
  // runId = 首次模型请求时刻（ADR-0032）：审计文件名、转录文件名与
  // `info.runId` 共用同一值，caseId 不再进入任何路径/文件名。
  const runId = buildRunId(outcome.transcript.firstRequestAt);
  const auditDir = buildAuditDir(input);
  // skill 会话独立转录（ADR-0014 决策 13）：先落盘，再把 basename 回填到
  // skillPassLog（主转录/审计据此引用）
  const skillPassLog = await persistSkillTranscripts({
    input,
    runId,
    finishedAt,
    records: outcome.skillPassLog,
    transcripts: outcome.skillTranscripts,
  });
  const audit: RunAudit = {
    ...outcome.audit,
    ruleSkill: ruleSkillAudit,
    ...(outcome.audit.skillPassLog !== undefined ? { skillPassLog } : {}),
  };
  const auditContent = buildAuditFileContent({
    runId,
    caseId: input.caseId,
    model: modelId,
    effort: LOCKED_EFFORT_LABEL,
    startedAt,
    finishedAt,
    rounds: outcome.rounds,
    toolCalls: outcome.toolCalls,
    usage: outcome.usage,
    findings: outcome.findings,
    audit,
    // Ledger 快照经 outcome.audit 透传（恒投影——含空数组形态）
    ...(outcome.audit.ledger !== undefined ? { ledger: outcome.audit.ledger } : {}),
    // 护栏降级留痕（#12）：界内省键（缺席省键纪律——审计键序只在尾部扩展）
    ...(boundary.degraded ? { mrBoundary: boundary.mrBoundary } : {}),
    // 输入预过滤留痕（大 diff 第一期）：无剔除省键
    ...(mrFilter !== undefined ? { mrFilter } : {}),
    // 生效配置快照（ADR-0025）：只进审计文件，stdout 键集不变
    ...(input.config !== undefined ? { config: input.config } : {}),
  });
  const auditPath = await writeAuditFile(auditDir, auditContent);
  // 检视转录：agent.state.messages 原样 + 合成 system；每 run 独立留档
  const transcriptPath = await persistTranscript({
    input,
    runId,
    finishedAt,
    capture: outcome.transcript,
    complete: outcome.complete,
    truncated: outcome.audit.truncated,
  });
  // 检视意见导出
  const reviewsPath = await persistReviewsEn({
    input,
    runId,
    modelId,
    finishedAt,
    findings: outcome.findings,
  });

  const result: RunResult = {
    caseId: input.caseId,
    model: modelId,
    findings: outcome.findings,
    usage: outcome.usage,
    rounds: outcome.rounds,
    toolCalls: outcome.toolCalls,
    audit,
    auditPath,
    // 域外显式降级标注（#12）：界内省键（边界内与无护栏时逐字节一致）
    ...(boundary.degraded ? { domainWarning: boundary.domainWarning } : {}),
  };
  const record = buildRunRecord({
    source: "mr",
    caseId: input.caseId,
    rep: input.rep,
    model: modelId,
    completedAt: finishedAt,
    result,
  });
  const recordPath = await persistRunRecord(input, record);
  emit({
    kind: "run",
    state: "end",
    status: "ok",
    runId,
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    usage: outcome.usage,
    truncated: outcome.audit.truncated,
    findings: summarizeFindings(outcome.findings),
  });
  return {
    runId,
    record,
    recordPath,
    auditPath,
    transcriptPath,
    reviewsPath,
    // 收尾摘要用的观测值（不进审计/RunRecord 字节）：Ledger 命中 + 模型调用总数
    ledgerHitCount: outcome.ledgerHitCount,
    modelCalls:
      outcome.audit.requests.length +
      outcome.skillPassLog.reduce((sum, entry) => sum + entry.requestCount, 0),
    skillBashCalls: outcome.skillBashCalls,
    ...(mrFilter !== undefined ? { mrFilter } : {}),
  };
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

/** 审计文件目录：`<runsRoot>/audit`（ADR-0032：无 case / rep / audit 中间层） */
function buildAuditDir(input: ReviewRunInput): string {
  return path.join(input.runsRoot, "audit");
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

/**
 * runs 树目录单点（转录 / 意见导出共用；与运行记录 `run.json` 同目录）：
 * `<runsRoot>/runs`（ADR-0032）。
 * 布局逻辑单源在 `run-record.runDirPath`（防记录与产物布局漂移）。
 */
function runOutputDir(input: ReviewRunInput): string {
  return runDirPath(input.runsRoot);
}

/**
 * skill 会话转录落盘（ADR-0014 决策 13）：每个会话一份，文件名后缀
 * `-skill-<name>-r<round>`（同名 skill 重复时追加序号），返回已回填
 * `transcriptFile`（basename）的 skillPassLog。
 */
async function persistSkillTranscripts(args: {
  readonly input: ReviewRunInput;
  readonly runId: string;
  readonly finishedAt: Date;
  readonly records: readonly RuleSkillPassRecord[];
  readonly transcripts: readonly SkillPassTranscript[];
}): Promise<readonly RuleSkillPassRecord[]> {
  if (args.transcripts.length === 0) {
    return args.records;
  }
  const suffixes = uniqueTranscriptSuffixes(args.records);
  const enriched = [...args.records];
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
      caseId: args.input.caseId,
      repoPath: args.input.repoPath,
      systemPrompt: SYSTEM_PROMPT,
      capture: transcript.capture,
      complete: transcript.complete,
      truncated: transcript.truncated,
      finishedAt: args.finishedAt,
      idSuffix: suffixes[index] ?? defaultTranscriptSuffix(transcript),
    });
    const filePath = await writeTranscript(runOutputDir(args.input), content);
    const record = enriched[index];
    if (record !== undefined) {
      enriched[index] = { ...record, transcriptFile: path.basename(filePath) };
    }
  }
  return enriched;
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

/** 检视转录落盘：`<runOutputDir>/session-<runId>[-suffix].json`；失败抛错 */
async function persistTranscript(args: {
  readonly input: ReviewRunInput;
  readonly runId: string;
  readonly finishedAt: Date;
  readonly capture: AgentTranscriptCapture;
  readonly complete: boolean;
  readonly truncated: boolean;
}): Promise<string> {
  const content = buildTranscript({
    runId: args.runId,
    caseId: args.input.caseId,
    repoPath: args.input.repoPath,
    systemPrompt: SYSTEM_PROMPT,
    capture: args.capture,
    complete: args.complete,
    truncated: args.truncated,
    finishedAt: args.finishedAt,
  });
  return writeTranscript(runOutputDir(args.input), content);
}

/** 检视意见导出落盘：`<runOutputDir>/reviews_en.json`；失败抛错 */
async function persistReviewsEn(args: {
  readonly input: ReviewRunInput;
  readonly runId: string;
  readonly modelId: string;
  readonly finishedAt: Date;
  readonly findings: readonly Finding[];
}): Promise<string> {
  const envelope = buildReviewsExport({
    generatedAt: args.finishedAt,
    runId: args.runId,
    source: "mr",
    caseId: args.input.caseId,
    rep: args.input.rep,
    model: args.modelId,
    findings: args.findings,
  });
  return writeReviewsEn(runOutputDir(args.input), envelope);
}
