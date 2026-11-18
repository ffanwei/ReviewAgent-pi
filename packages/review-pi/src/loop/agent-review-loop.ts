import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, FetchFunction } from "@earendil-works/pi-ai";
import type { Finding } from "../contracts/finding.js";
import type { LedgerEntry } from "../contracts/ledger.js";
import type { LlmMessage, LlmUsage } from "../contracts/llm.js";
import { NO_OP_PROGRESS_SINK, type RunProgressSink } from "../contracts/progress.js";
import type {
  CandidateNormalizationRecord,
  CandidateRejection,
  CandidateRejectionCounts,
  PhaseParseFailure,
  PhaseRecord,
  RejectionStage,
  RuleSkillPassRecord,
  RunAudit,
  ToolCallRecord,
  WireRequest,
} from "../contracts/run.js";
import type { AgentTranscriptCapture } from "../export/transcript.js";
import { applyCandidateGate } from "../gate/candidate-gate.js";
import type { TimelineShard } from "../observability/request-timeline.js";
import { normalizeCandidates } from "../gate/candidate-normalize.js";
import { mergeSkillCandidates, type SkillCandidateBatch } from "../gate/candidate-merge.js";
import type { DiffScope } from "../gate/diff-scope.js";
import { validateFinding } from "../finding/finding-schema.js";
import { assistantText, captureWire, reviewModelOf, reviewStreamFn } from "../provider/pi-client.js";
import { reviewTurnStreamOptions } from "../provider/review-turn-policy.js";
import { addUsage, piUsageToLlmUsage, ZERO_USAGE } from "../provider/usage-map.js";
import { DEFAULT_REVIEW_RUNTIME, type ReviewRuntime } from "../shared/review-runtime.js";
import { classifyCacheBreaks } from "./cache-break.js";
import {
  MAX_TOOL_CALLS,
  TOOL_BUDGET_EXHAUSTED_SUMMARY,
  TRUNCATION_MODEL_LENGTH,
  TRUNCATION_TOOL_BUDGET,
} from "./constants.js";
import { parseCandidatesReply, parseVerificationReply, type VerificationVerdict } from "../shared/parse.js";
import { MAX_SALVAGE_INPUT_CHARS, salvageCandidatesReply, salvageVerificationReply } from "./json-salvage.js";
import {
  CANDIDATES_PHASE_INDEX,
  PHASE_COUNT,
  PHASE_ORDER,
  buildPhaseInstruction,
} from "./phases.js";
import { createRequestProgress } from "../shared/request-progress.js";
import type { CandidateRepairFn } from "./candidate-repair.js";
import { fromWireToolName } from "../tools/registry.js";
import { buildAgentTools } from "../tools/tool-adapter.js";
import { summarizeDetailLine } from "../tools/tool-progress.js";
import type { ReviewToolkit } from "../tools/toolkit.js";
import type { RuleSkill } from "../knowledge/rule-skill.js";
import { runSkillPass, type SkillPassTranscript } from "../knowledge/skill-pass.js";
import { buildSkillCandidatesBrief } from "../knowledge/skill-pass-brief.js";
import { completeOneShot } from "../provider/one-shot-llm.js";

// agentLoop 钩子驱动循环（#6 P3a）：六阶段 + 工具子循环跑在
// pi-agent-core Agent 上，三个预定缝承载 review 语义——
//
// - shouldStopAfterTurn = review 状态机：工具轮恒继续（t-series 真源：预算
//   耗尽也 recall，相位只在文本回复时完结，无 force-complete）；文本轮完结
//   当前阶段（解析 + PhaseRecord 留痕），经 agent.followUp 注入下一阶段指令
//   或下一轮 phase-1 指令；complete / 轮次上界即停；
// - transformContext 不设（恒等透传）：消息前缀 append-only，Zone A/B/C
//   稳定前缀由内核时序直接保证；
// - state.tools = 八工具 AgentTool（name = wire 下划线名直达 wire function.name；
//   prepareArguments 剥未知键对齐 DSH 容忍语义——pi-ai 严格校验缝的方言对冲）。
//
// 工具预算与审计在 execute 包装层：成功执行计数跨轮不重置（失败也计入），
// 超出即返回 "Error: tool call budget exhausted"（= 审计 resultSummary =
// wire tool 消息 content，t-series 真源字节）；truncationReasons 单列
// TOOL_BUDGET_EXHAUSTED 但不翻转 truncated（截断语义只归模型输出上界）。
//
// 轮次上限（ADR-0046）：来自 `limits.loop.maxRounds`（缺省 3）。到最后一轮时
// **强制 complete**——模型说还要再审也不开新轮，本轮产出即最终结果；不产生
// `MAX_ROUNDS_REACHED` 截断（轮次上限是成本线，不是失败）。
//
// 规则 Skill（ADR-0014）：Phase 5 文本回合收尾后、Phase 6 指令注入前，顺序跑
// 各 skill 的独立检视会话（`knowledge/skill-pass.ts`）。skill 回合不进
// `phaseLog`（两者并列），候选在候选门之前跨 skill 去重，Phase 6 一次裁定。

/** 短窗口阶段回复修复注入缝（测试确定性；缺省走 completeOneShot）。 */
export type PhaseReplyRepairFn = (input: {
  readonly raw: string;
  readonly phase: string;
}) => Promise<string | undefined>;

export interface AgentReviewLoopInputs {
  readonly systemPrompt: string;
  /** 初始上下文消息（MR 消息等 run 级组装，由调用方决定） */
  readonly initialContextMessages: readonly LlmMessage[];
  /** 八工具执行面（含 Ledger；唯一形态恒传 ledgerMode "enabled" 的 toolkit） */
  readonly toolkit: ReviewToolkit;
  readonly apiKey: string;
  /** 网关 base URL 覆盖（配置 `reviewer.baseUrl`；缺省官方接入点） */
  readonly baseUrl?: string;
  /** 模型 id 覆盖（缺省钉住的评审模型） */
  readonly modelId?: string;
  /** 传输层注入；离线测试恒注入 fake 适配器 */
  readonly fetch?: FetchFunction;
  /**
   * 检视运行时（ADR-0025）：输出预算 / 模型元数据 / 微限（进度与入参摘要）
   * / skill 会话超时。缺省 = 今天的缺省行为（测试与直调形态）。
   */
  readonly runtime?: ReviewRuntime;
  /** 审计投影 ledger 键（唯一形态恒投影）；缺省不投影（测试夹具用） */
  readonly includeLedgerAudit?: boolean;
  /**
   * skill 检视会话（ADR-0014）：Phase 5 文本回合结束后、Phase 6
   * 指令注入之前顺序执行。缺省 = 无 skill 会话（N=0 时主链逐字节不变）。
   */
  readonly skillPass?: SkillPassRequest;
  /**
   * 有界一次性候选修复（P1）：确定性归一化后仍 schema 非法的候选，在 Phase 6
   * 裁决前发起至多一次模型修复。缺省 = 不修复（现有测试 / 直调零漂移）。
   */
  readonly candidateRepair?: CandidateRepairFn;
  /** 短窗口 Phase 5/6 回复修复；缺省使用真实 one-shot 调用。 */
  readonly phaseReplyRepair?: PhaseReplyRepairFn;
  /**
   * 非 diff 区域过滤（`limits.findingScope`）：由 run 层按本遍 diff 构建。
   * 缺省 undefined = 不过滤（内核直调 / 单测零漂移）。
   */
  readonly scope?: DiffScope;
  /**
   * 运行进度投影（ADR-0016）：缺省不注入 = 零输出、零行为变化。事件只投影既有
   * 留痕（阶段推进 / 请求首尾 / 工具首尾 / skill 会话首尾），不改 wire 字节、
   * 不进审计、不影响退出码。
   */
  readonly onProgress?: RunProgressSink;
  /**
   * 阶段附加段（Phase 5/6 等）：返回 undefined / 纯空白 = 不追加。
   * 只改阶段 user 消息文本，不改阶段语义、wire 工具面或 Finding schema；
   * 与测试文件提示、skill 候选清单同序追加在基础指令之后。
   */
  readonly phaseBrief?: (index: number) => string | undefined;
  /**
   * 分片标签（ADR-0076 请求时间线）：多片路径由 run 层传入，单片路径缺席。
   * 只进时间线行，不进审计 / wire 字节。
   */
  readonly shard?: TimelineShard;
}

/** skill 会话接线（由 run 层提供 pack 与 toolkit 工厂） */
export interface SkillPassRequest {
  /** 已装载的规则 Skill（CLI 顺序；降级包不跑会话） */
  readonly skills: readonly RuleSkill[];
  /**
   * 按 Phase-5 ledger 快照分叉八工具 toolkit。每个 skill 调用一次：skill 之间
   * 互不可见，且 skill 会话的读取不会污染主账本。
   */
  readonly toolkitFor: (seedLedgerSnapshot: readonly LedgerEntry[]) => ReviewToolkit;
  /**
   * 本次 diff 命中 skill / 文档：skill 会话的通用输出契约改用模态中性证据口径。
   * 缺省 = 代码口径（既有 trace 逐字节不变）。
   */
  readonly docMode?: boolean;
}

export interface AgentReviewLoopOutcome {
  readonly findings: readonly Finding[];
  /** 累计 usage：主会话 + skill 会话（skill 的真实成本不隐藏，ADR-0014 负后果一节已明示） */
  readonly usage: LlmUsage;
  readonly rounds: number;
  /**
   * 工具调用总数：主会话 + skill 会话。`audit.toolCallLog` 只记主会话的逐项
   * 记录（skill 会话属非测量档），skill 的调用数按会话计在
   * `skillPassLog[].toolCallCount`——两个口径不互斥，各自单一。
   */
  readonly toolCalls: number;
  /**
   * 规则 Skill 会话里的 `bash` 调用数（合计）。指标口径 `toolCalls` 不含 bash
   * （ADR-0014），收尾总结行单独报它；不进审计。
   */
  readonly skillBashCalls: number;
  /**
   * Context Ledger 命中总数（主会话 + skill 会话）：重复读取返回
   * "Already loaded: ctx#NNN" 引用的次数。收尾摘要用的观测值，不进审计。
   */
  readonly ledgerHitCount: number;
  /** 验证 complete 信号（= !truncated） */
  readonly complete: boolean;
  readonly audit: RunAudit;
  /** Agent 侧现场（检视转录原料，ADR-0013）：messages 快照 + 首次模型请求时刻 + 模型身份 */
  readonly transcript: AgentTranscriptCapture;
  /** 每轮 × 每 skill 的执行留痕（无 skill 会话时为空数组） */
  readonly skillPassLog: readonly RuleSkillPassRecord[];
  /** 每个 skill 会话的独立转录原料（写盘在 run 层） */
  readonly skillTranscripts: readonly SkillPassTranscript[];
}

/** 深解析阶段（0-based 指令下标）：候选与裁决的解析点 */
const VERIFICATION_PHASE_INDEX = 5;
/** Phase 5/6 解析失败时，同一会话内最多追加一次请求 */
const MAX_PHASE_PARSE_RETRIES = 1;
/** 离线 salvage 后仍失败时，短窗口 LLM 修复的 run 级上限 */
const MAX_SHORT_REPAIRS_PER_RUN = 2;

/** 有界候选修复（P1 步骤 3）：整个 run 最多 2 次调用，单次最多 8 条候选 */
const MAX_REPAIR_CALLS_PER_RUN = 2;
const MAX_REPAIR_CANDIDATES_PER_CALL = 8;

export async function runAgentReviewLoop(
  inputs: AgentReviewLoopInputs,
): Promise<AgentReviewLoopOutcome> {
  // 审计累积面（run 内顺序单写；产出时整体冻结为 readonly 投影）
  const requests: WireRequest[] = [];
  const toolCallLog: ToolCallRecord[] = [];
  const phaseLog: PhaseRecord[] = [];
  const rejections: CandidateRejection[] = [];
  const findings: Finding[] = [];
  const truncationReasons: string[] = [];
  let usage: LlmUsage = ZERO_USAGE;
  let executedToolCalls = 0;
  let round = 1;
  let phaseIndex = 0;
  let phaseRequestCount = 0;
  let phaseSkippedToolCalls = 0;
  let phaseParseRetries = 0;
  let shortRepairCalls = 0;
  let roundCandidates: readonly unknown[] = [];
  let roundVerdicts: ReadonlyMap<string, VerificationVerdict> = new Map();
  let roundComplete = false;
  // Phase 5 六项镜头二次扫描（limits.loop.phase5Sweep）：主候选产出后再发一次
  // 补漏请求，新增候选按 (file, line, category) 与主候选合并，主候选永不被丢弃。
  let phase5SweepState: "idle" | "requested" | "completed" = "idle";
  let phase5SweepCandidates: readonly unknown[] = [];
  let emittedIds: ReadonlySet<string> = new Set();
  let emittedContentKeys: ReadonlySet<string> = new Set();
  let emittedRootKeys: ReadonlySet<string> = new Set();
  const candidateNormalizations: CandidateNormalizationRecord[] = [];
  const rejectionCounts: Record<RejectionStage, number> = {
    SCHEMA_INVALID: 0,
    NO_EVIDENCE: 0,
    VERIFICATION_FAILED: 0,
    OUT_OF_SCOPE: 0,
    DUPLICATE_ID: 0,
  };
  let repairCalls = 0;
  let truncated = false;
  let complete = false;
  // 规则 Skill 会话留痕（与 phaseLog 并列，不混入相位记录）
  const skillPassLog: RuleSkillPassRecord[] = [];
  const skillTranscripts: SkillPassTranscript[] = [];
  let skillToolCalls = 0;
  let skillBashCalls = 0;
  let skillLedgerHits = 0;
  let roundSkillBatches: readonly SkillCandidateBatch[] = [];
  // 首次模型请求时刻（唯一新增内核仪器；不是逐请求/逐工具耗时）
  let firstRequestAt: Date | undefined;
  // 进度投影（ADR-0016）：只读既有留痕，缺省 sink = 空函数（零行为变化）
  const emitProgress = inputs.onProgress ?? NO_OP_PROGRESS_SINK;
  const requestProgress = createRequestProgress(emitProgress);
  const runtime = inputs.runtime ?? DEFAULT_REVIEW_RUNTIME;
  // 轮次上限（ADR-0046）：配置驱动；最后一轮强制 complete（见 advancePhase）
  const maxRounds = runtime.limits.loop.maxRounds;
  // DISP 微限（ADR-0025）：进度行只在开进度时有意义；缺省值与历史行为一致
  const progressLimits = {
    argumentsSummaryChars: runtime.limits.micro.argumentsSummaryChars,
    progressDetailChars: runtime.limits.micro.progressDetailChars,
  };

  const agentTools = buildAgentTools(inputs.toolkit, {
    beforeExecute: (call) => {
      if (executedToolCalls >= MAX_TOOL_CALLS) {
        phaseSkippedToolCalls += 1;
        appendReason(truncationReasons, TRUNCATION_TOOL_BUDGET);
        toolCallLog.push({
          name: call.name,
          argumentsJson: call.argumentsJson,
          resultSummary: TOOL_BUDGET_EXHAUSTED_SUMMARY,
        });
        return { kind: "skip", text: TOOL_BUDGET_EXHAUSTED_SUMMARY };
      }
      // 预算预约同步于检查（批内调用序即预约序）；失败不退还（防失败死循环）
      executedToolCalls += 1;
      return { kind: "run" };
    },
    onResult: (call, result) => {
      toolCallLog.push({
        name: call.name,
        argumentsJson: call.argumentsJson,
        resultSummary: result,
      });
    },
    onError: (call, text) => {
      // t-series 真源字节：失败前缀 "Error: " 由适配器统一产出。
      toolCallLog.push({
        name: call.name,
        argumentsJson: call.argumentsJson,
        resultSummary: text,
      });
    },
    // 进度包装（ADR-0016）：名用点分审计名；成功/失败判据与 skill 会话同源
    progress: { emit: emitProgress, limits: progressLimits },
  });

  const streamFn: StreamFn = reviewStreamFn({
    apiKey: inputs.apiKey,
    ...(inputs.fetch !== undefined ? { fetch: inputs.fetch } : {}),
    maxOutputTokens: runtime.maxOutputTokens,
    ...(runtime.contextWindow !== undefined ? { contextWindow: runtime.contextWindow } : {}),
    ...reviewTurnStreamOptions(runtime),
    // ADR-0076：请求时间线作用域（阶段 / 轮次在请求发出时求值）
    timeline: {
      scope: () => ({
        site: "main",
        ...(inputs.shard !== undefined ? { shard: inputs.shard } : {}),
        round,
        phase: phaseNameOf(phaseIndex),
        phaseIndex: phaseIndex + 1,
      }),
    },
  });

  // followUp 注入缝：shouldStopAfterTurn 闭包引用 agent，先落占位再绑定
  // （只在 agent.prompt 运行期被调用，绑定必然先于首调）
  let enqueueFollowUp: (message: AgentMessage) => void = () => {
    throw new Error("internal error: follow-up enqueue invoked before agent construction");
  };

  const model = reviewModelOf(inputs.modelId, inputs.baseUrl);
  const agent = new Agent({
    initialState: {
      systemPrompt: inputs.systemPrompt,
      model,
      messages: inputs.initialContextMessages.map(toUserMessage),
      tools: agentTools,
    },
    streamFn,
    // DSH 工具批为严格批序执行（审计记录顺序 = 批内顺序）；parallel 模式按完成序落账
    toolExecution: "sequential",
    onPayload: (payload) => {
      if (firstRequestAt === undefined) {
        firstRequestAt = new Date();
      }
      requests.push(auditWireCapture(payload));
      phaseRequestCount += 1;
      requestProgress.start();
    },
    shouldStopAfterTurn: (context): boolean | Promise<boolean> => {
      const message = context.message;
      const turnUsage = piUsageToLlmUsage(message.usage);
      usage = addUsage(usage, turnUsage);
      requestProgress.end(turnUsage);
      // 输出撞上 max_tokens 上界（思维链含在预算内时尤易发生）：不翻转控制流
      // （相位推进与 DSH 一致），但必须留痕——否则截断静默成"审 0 条"。
      if (message.stopReason === "length") {
        truncated = true;
        appendReason(truncationReasons, TRUNCATION_MODEL_LENGTH);
      }
      if (message.content.some((block) => block.type === "toolCall")) {
        return false;
      }
      return advancePhase(assistantText(message), enqueueFollowUp, context.context.messages);
    },
  });
  enqueueFollowUp = (message) => {
    agent.followUp(message);
  };

  emitPhase(0);
  await agent.prompt(phaseMessage(0));

  // pi-ai 对 provider 错误不 reject（resolve 出 stopReason "error" 的消息后
  // agent 即止）：缝必须显式拦截，错误永不静默成一次"成功" run。
  const failed = agent.state.messages.find(
    (message: AgentMessage): message is AssistantMessage =>
      message.role === "assistant" && message.stopReason === "error",
  );
  if (failed !== undefined) {
    throw new Error(
      `检视回合失败：${failed.errorMessage ?? "provider 返回 error 停因"}`,
    );
  }

  const audit: RunAudit = {
    requests,
    toolCallLog,
    phaseLog,
    rejections,
    cacheBreaks: classifyCacheBreaks(requests),
    truncated,
    truncationReasons,
    ...(inputs.includeLedgerAudit ? { ledger: inputs.toolkit.ledger.snapshot() } : {}),
    ...(inputs.skillPass !== undefined ? { skillPassLog } : {}),
    ...(candidateNormalizations.length > 0 ? { candidateNormalizations } : {}),
    ...(totalRejections(rejectionCounts) > 0 ? { rejectionCounts } : {}),
  };
  if (firstRequestAt === undefined) {
    throw new Error("internal error: agent review loop finished without a model request");
  }
  const transcript: AgentTranscriptCapture = {
    messages: [...agent.state.messages],
    firstRequestAt,
    model: { id: model.id, baseUrl: model.baseUrl },
  };
  return {
    findings,
    usage,
    rounds: round,
    toolCalls: executedToolCalls + skillToolCalls,
    skillBashCalls,
    ledgerHitCount: inputs.toolkit.ledger.hitCount() + skillLedgerHits,
    // 截断优先：输出撞上界（MODEL_MAX_TOKENS_REACHED）时即使裁决 complete 也不可宣称完整
    complete: complete && !truncated,
    audit,
    transcript,
    skillPassLog,
    skillTranscripts,
  };

  /** 文本轮收尾当前阶段并推进；返回值即 shouldStopAfterTurn 的停止判定 */
  async function advancePhase(
    replyText: string,
    followUp: (message: AgentMessage) => void,
    seedMessages: readonly AgentMessage[],
  ): Promise<boolean> {
    let parsed = parsePhaseReply(replyText);
    let recovery: PhaseRecord["parseRecovery"];
    // 第 1 层：离线 salvage（0 token）。只修 JSON 语法，严格验收；有损恢复直接拒绝。
    if (parsed.parseFailure !== undefined && parsed.parseFailure.kind !== "truncated") {
      const salvaged = salvagePhaseReply(replyText);
      if (salvaged !== undefined) {
        parsed = parsePhaseReply(salvaged);
        if (parsed.parseFailure === undefined) {
          recovery = "offline";
        }
      }
    }
    // 第 2 层：同会话短提示重试一次；不重发阶段指令、不重跑工具检索。
    if (
      parsed.parseFailure !== undefined &&
      parsed.parseFailure.kind !== "truncated" &&
      phaseParseRetries < MAX_PHASE_PARSE_RETRIES
    ) {
      phaseParseRetries += 1;
      followUp(parseRetryMessage(phaseIndex, parsed.note));
      return false;
    }
    // 第 3 层：短窗口 LLM 修复（只发畸形回复 + schema，不带会话/diff）。
    if (
      parsed.parseFailure !== undefined &&
      parsed.parseFailure.kind !== "truncated" &&
      shortRepairCalls < MAX_SHORT_REPAIRS_PER_RUN &&
      replyText.length <= MAX_SALVAGE_INPUT_CHARS
    ) {
      shortRepairCalls += 1;
      const repaired = await shortRepairReply(replyText);
      if (repaired !== undefined) {
        parsed = parsePhaseReply(repaired);
        if (parsed.parseFailure === undefined) {
          recovery = "short-llm";
        }
      }
    }
    const recoverySource =
      recovery ??
      (phaseParseRetries > 0 && parsed.parseFailure === undefined ? "retry" : undefined);
    const notes: string[] = [];
    if (phaseSkippedToolCalls > 0) {
      notes.push(`跳过 ${String(phaseSkippedToolCalls)} 次工具调用：预算耗尽`);
    }
    if (parsed.note !== undefined) {
      notes.push(parsed.note);
    }
    const isSweepReply =
      phaseIndex === CANDIDATES_PHASE_INDEX && phase5SweepState === "requested";
    if (isSweepReply) {
      // 二次扫描不新增 PhaseRecord：请求数与备注并入本轮的 Deep Reasoning 记录。
      const previous = phaseLog.at(-1);
      if (previous !== undefined) {
        phaseLog[phaseLog.length - 1] = {
          ...previous,
          requestCount: phaseRequestCount,
          ...(parsed.parseFailure !== undefined ? { parseFailure: parsed.parseFailure } : {}),
          ...(notes.length > 0
            ? {
                note: [previous.note, ...notes]
                  .filter((part): part is string => part !== undefined && part.length > 0)
                  .join("; "),
              }
            : {}),
        };
      }
    } else {
      phaseLog.push({
        round,
        phase: phaseNameOf(phaseIndex),
        requestCount: phaseRequestCount,
        ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
        ...(parsed.parseFailure !== undefined ? { parseFailure: parsed.parseFailure } : {}),
        ...(recoverySource !== undefined || parsed.parseFailure !== undefined
          ? {
              ...(phaseParseRetries > 0 ? { parseRetries: phaseParseRetries } : {}),
              parseRecovered: parsed.parseFailure === undefined,
              ...(recoverySource !== undefined ? { parseRecovery: recoverySource } : {}),
            }
          : {}),
      });
    }

    if (isSweepReply) {
      if (parsed.parseFailure === undefined) {
        const merged = mergeSkillCandidates({
          primary: roundCandidates,
          batches: [{ skill: "phase5-sweep", candidates: phase5SweepCandidates }],
        });
        const mergedCount = merged.mergedCounts[0] ?? 0;
        const added = phase5SweepCandidates.length - mergedCount;
        roundCandidates = merged.candidates;
        phase5SweepCandidates = [];
        phase5SweepState = "completed";
        const previous = phaseLog.at(-1);
        if (previous !== undefined) {
          phaseLog[phaseLog.length - 1] = {
            ...previous,
            note: [
              previous.note,
              `六项镜头二次扫描新增 ${String(added)} 条（合并重复 ${String(mergedCount)} 条）`,
            ]
              .filter((part): part is string => part !== undefined && part.length > 0)
              .join("; "),
          };
        }
      } else {
        // 扫描回复最终仍不可解析：不再卡住阶段机，按无新增继续。
        phase5SweepCandidates = [];
        phase5SweepState = "completed";
      }
    }

    // Phase 5 之后、Phase 6 指令之前：顺序跑 skill 检视会话（ADR-0014）。
    // 种子 = 主会话此刻的 messages 快照；每个 skill 分叉自己的 history 与 ledger。
    if (phaseIndex === CANDIDATES_PHASE_INDEX) {
      if (runtime.limits.loop.phase5Sweep && phase5SweepState === "idle") {
        phase5SweepState = "requested";
        followUp(phase5SweepMessage());
        return false;
      }
      await runRoundSkillPasses(seedMessages);
    }

    if (phaseIndex < PHASE_COUNT - 1) {
      phaseIndex += 1;
      resetPhaseCounters();
      emitPhase(phaseIndex);
      followUp(phaseMessage(phaseIndex));
      return false;
    }

    // Evidence Verification 收尾：有界修复 → 候选拦截链 → 轮次决策
    await maybeRepairInvalidCandidates();
    const gate = applyCandidateGate({
      candidates: roundCandidates,
      verdicts: roundVerdicts,
      emittedIds,
      emittedContentKeys,
      emittedRootKeys,
      round,
      ...(inputs.scope !== undefined ? { scope: inputs.scope } : {}),
    });
    findings.push(...gate.findings);
    rejections.push(...gate.rejections);
    for (const rejection of gate.rejections) {
      rejectionCounts[rejection.stage] += 1;
    }
    emittedIds = gate.emittedIds;
    emittedContentKeys = gate.emittedContentKeys;
    emittedRootKeys = gate.emittedRootKeys;
    complete = roundComplete;
    if (complete) {
      return true;
    }
    // 最后一轮强制 complete（ADR-0046）：不再开新轮，本轮产出即最终结果。
    // 这是成本线而不是失败，不置 truncated、不写 MAX_ROUNDS_REACHED。
    if (round >= maxRounds) {
      complete = true;
      return true;
    }
    round += 1;
    phaseIndex = 0;
    resetPhaseCounters();
    roundCandidates = [];
    phase5SweepState = "idle";
    phase5SweepCandidates = [];
    roundVerdicts = new Map();
    roundComplete = false;
    roundSkillBatches = [];
    emitPhase(0);
    followUp(phaseMessage(0));
    return false;
  }

  /**
   * 本轮 skill 检视会话（ADR-0014）：
   * 1. 每个 skill 一个独立 `Agent`，种子 = 主会话 Phase-5 末 messages 快照；
   * 2. 会话候选在候选门之前按 (file,line,category) 跨 skill 去重；
   * 3. 存活候选并入本轮候选流，Phase 6 一次裁定两批；
   * 4. 装载降级的包不跑会话（装载事实已在 `ruleSkill[]`，不重复记失败）。
   */
  async function runRoundSkillPasses(seedMessages: readonly AgentMessage[]): Promise<void> {
    const request = inputs.skillPass;
    if (request === undefined) {
      return;
    }
    const ledgerSnapshot = inputs.toolkit.ledger.snapshot();
    const outcomes: Awaited<ReturnType<typeof runSkillPass>>[] = [];
    for (const skill of request.skills) {
      if (skill.degradedReason !== undefined || skill.name.length === 0) {
        continue;
      }
      const startedAt = Date.now();
      emitProgress({ kind: "skill", state: "start", round, skill: skill.name });
      const outcome = await runSkillPass({
        round,
        skill,
        systemPrompt: inputs.systemPrompt,
        seedMessages,
        toolkit: request.toolkitFor(ledgerSnapshot),
        apiKey: inputs.apiKey,
        ...(inputs.baseUrl !== undefined ? { baseUrl: inputs.baseUrl } : {}),
        ...(inputs.modelId !== undefined ? { modelId: inputs.modelId } : {}),
        ...(inputs.fetch !== undefined ? { fetch: inputs.fetch } : {}),
        runtime,
        onProgress: emitProgress,
        ...(request.docMode !== undefined ? { docMode: request.docMode } : {}),
        ...(inputs.shard !== undefined ? { shard: inputs.shard } : {}),
      });
      emitProgress({
        kind: "skill",
        state: "end",
        round,
        skill: skill.name,
        durationMs: Date.now() - startedAt,
        status: outcome.record.status,
        requestCount: outcome.record.requestCount,
        toolCallCount: outcome.record.toolCallCount,
        ...(outcome.record.degradedReason !== undefined
          ? {
              detail: summarizeDetailLine(
                outcome.record.degradedReason,
                runtime.limits.micro.progressDetailChars,
              ),
            }
          : {}),
      });
      outcomes.push(outcome);
    }
    if (outcomes.length === 0) {
      return;
    }

    const normalizedBatches = outcomes.map((outcome, index) => {
      const normalized = normalizeCandidates({
        candidates: outcome.candidates,
        round,
        idPrefix: `round-${String(round)}-skill-${String(index)}-candidate-`,
      });
      candidateNormalizations.push(...normalized.records);
      return { skill: outcome.record.skill, candidates: normalized.candidates };
    });

    const merged = mergeSkillCandidates({
      primary: roundCandidates,
      batches: normalizedBatches,
    });
    roundCandidates = merged.candidates;
    roundSkillBatches = merged.survivingBatches;
    outcomes.forEach((outcome, index) => {
      usage = addUsage(usage, outcome.usage);
      skillToolCalls += outcome.record.toolCallCount;
      skillBashCalls += outcome.bashCallCount;
      skillLedgerHits += outcome.ledgerHitCount;
      skillPassLog.push({ ...outcome.record, mergedCount: merged.mergedCounts[index] ?? 0 });
      if (outcome.transcript !== undefined) {
        skillTranscripts.push(outcome.transcript);
      }
    });
  }

  /**
   * 有界候选修复（P1 步骤 3）：只挑确定性归一化后仍 schema 非法的候选，
   * Phase 6 裁决前至多发起一次模型调用（整个 run 有调用上限）。
   * 修复结果重新过确定性归一化，并强制保留原 id（裁决对齐键）。
   */
  async function maybeRepairInvalidCandidates(): Promise<void> {
    const repair = inputs.candidateRepair;
    if (repair === undefined || repairCalls >= MAX_REPAIR_CALLS_PER_RUN) {
      return;
    }
    const invalidIndices: number[] = [];
    roundCandidates.forEach((candidate, index) => {
      if (validateFinding(candidate).length > 0) {
        invalidIndices.push(index);
      }
    });
    if (invalidIndices.length === 0) {
      return;
    }
    const selected = invalidIndices.slice(0, MAX_REPAIR_CANDIDATES_PER_CALL);
    repairCalls += 1;
    let repaired: readonly unknown[];
    try {
      repaired = await repair({
        round,
        candidates: selected.map((index) => roundCandidates[index]),
      });
    } catch {
      return;
    }
    if (repaired.length === 0) {
      return;
    }
    const next = [...roundCandidates];
    selected.forEach((slotValue, slot) => {
      const candidate = repaired[slot];
      if (candidate === undefined) {
        return;
      }
      const original = roundCandidates[slotValue];
      const originalId = readCandidateId(original, round, slotValue);
      const normalized = normalizeCandidates({
        candidates: [candidate],
        round,
        idPrefix: `round-${String(round)}-repaired-${String(slotValue)}-`,
      });
      let fixed = normalized.candidates[0];
      if (isRecord(fixed) && originalId !== "") {
        fixed = { ...fixed, id: originalId };
      }
      // 一次调用即一条 one-shot 记录：字段名 = 确定性修复字段 ∪ 与原候选的差异键。
      // 即使修复后的对象已完全合法（无需再归一化），调用本身也必须留痕。
      const fields = new Set(normalized.records.flatMap((record) => record.fields));
      if (isRecord(fixed)) {
        for (const key of changedFields(original, fixed)) {
          fields.add(key);
        }
      }
      candidateNormalizations.push({
        round,
        candidateId: originalId,
        fields: [...fields],
        source: "one-shot",
      });
      next[slotValue] = fixed;
    });
    roundCandidates = next;
  }

  function parsePhaseReply(replyText: string): {
    readonly note?: string;
    readonly parseFailure?: PhaseParseFailure;
  } {
    if (phaseIndex === CANDIDATES_PHASE_INDEX) {
      const parsed = parseCandidatesReply(replyText);
      const normalized = normalizeCandidates({ candidates: parsed.candidates, round });
      candidateNormalizations.push(...normalized.records);
      if (phase5SweepState === "requested") {
        phase5SweepCandidates = normalized.candidates;
      } else {
        roundCandidates = normalized.candidates;
      }
      return {
        ...(parsed.note !== undefined ? { note: parsed.note } : {}),
        ...(parsed.failure !== undefined
          ? { parseFailure: { expected: "candidates", kind: parsed.failure } }
          : {}),
      };
    }
    if (phaseIndex === VERIFICATION_PHASE_INDEX) {
      const parsed = parseVerificationReply(replyText);
      roundVerdicts = parsed.verdicts;
      roundComplete = parsed.complete;
      return {
        ...(parsed.note !== undefined ? { note: parsed.note } : {}),
        ...(parsed.failure !== undefined
          ? { parseFailure: { expected: "verdicts", kind: parsed.failure } }
          : {}),
      };
    }
    return {};
  }

  function resetPhaseCounters(): void {
    phaseRequestCount = 0;
    phaseSkippedToolCalls = 0;
    phaseParseRetries = 0;
  }

  /** 解析失败回灌：只补一条短提示，阶段指令与已检索证据仍在会话里。 */
  function parseRetryMessage(index: number, note: string | undefined): AgentMessage {
    const format =
      index === CANDIDATES_PHASE_INDEX
        ? '{"candidates":[<候选对象>]}'
        : '{"verdicts":[{"id":"…","pass":true,"reason":"…"}],"complete":true}';
    return {
      role: "user",
      content: [
        `上一次回复无法解析为本阶段要求的 JSON（${note ?? "解析失败"}）。`,
        "请只重新输出完整 JSON，不要解释，不要 Markdown 围栏。",
        `格式：${format}`,
      ].join("\n"),
      timestamp: Date.now(),
    };
  }

  /** 离线 salvage：把修复后的候选/裁决重新拼成阶段 JSON，走同一解析链。 */
  function salvagePhaseReply(text: string): string | undefined {
    if (phaseIndex === CANDIDATES_PHASE_INDEX) {
      const candidates = salvageCandidatesReply(text);
      return candidates === undefined ? undefined : JSON.stringify({ candidates });
    }
    if (phaseIndex === VERIFICATION_PHASE_INDEX) {
      const verdicts = salvageVerificationReply(text);
      return verdicts === undefined
        ? undefined
        : JSON.stringify({ verdicts: verdicts.entries, complete: verdicts.complete });
    }
    return undefined;
  }

  /** 短窗口 LLM 修复：只带畸形回复与 schema，不带会话/diff/工具证据。 */
  async function shortRepairReply(raw: string): Promise<string | undefined> {
    if (inputs.phaseReplyRepair !== undefined) {
      return inputs.phaseReplyRepair({ raw, phase: phaseNameOf(phaseIndex) });
    }
    const format =
      phaseIndex === CANDIDATES_PHASE_INDEX
        ? '{"candidates":[<候选对象>]}'
        : '{"verdicts":[{"id":"…","pass":true,"reason":"…"}],"complete":true}';
    const result = await completeOneShot({
      baseUrl: model.baseUrl,
      apiKey: inputs.apiKey,
      modelId: model.id,
      system:
        "你是 JSON 语法修复器。只修复 JSON 语法错误，不改变字段值、不增删候选。" +
        "只输出修复后的 JSON 对象，不要解释，不要 Markdown 围栏。",
      user: `阶段：${phaseNameOf(phaseIndex)}。
目标格式：${format}

待修复回复：
${raw}`,
      timeoutMs: runtime.limits.timeouts.oneShotMs,
      maxTokens: Math.min(runtime.maxOutputTokens ?? 16_000, 16_000),
      responseFormat: "json_object",
      purpose: "reply-repair",
      ...(inputs.fetch !== undefined ? { fetch: inputs.fetch } : {}),
    });
    if (!result.ok) {
      return undefined;
    }
    if (result.usage !== undefined) {
      usage = addUsage(usage, result.usage);
    }
    return result.text;
  }

  /** 阶段推进投影（ADR-0016）：入参 0-based，事件里给 1-based 序号（含轮次） */
  function emitPhase(index: number): void {
    emitProgress({
      kind: "phase",
      round,
      phase: phaseNameOf(index),
      index: index + 1,
      total: PHASE_COUNT,
    });
  }

  /**
   * 阶段消息 = `PHASE_INSTRUCTIONS[i]`（字节冻结）+ 可选附加段。
   *
   * 唯一的附加者是 Phase 6 的 skill 候选清单（ADR-0014：两批候选一次裁定），
   * 数据在 loop 侧，故由本模块直接拼装——ADR-0012 的 `phaseBrief` 注入缝已
   * 随该决策退役。无附加时逐字节不变（N=0 的形态）。
   */
  function phaseMessage(index: number): AgentMessage {
    const skillBrief =
      index === VERIFICATION_PHASE_INDEX ? buildSkillCandidatesBrief(roundSkillBatches) : undefined;
    const instruction = buildPhaseInstruction(index, runtime.limits.testFiles.skip);
    const strategyBrief = inputs.phaseBrief?.(index);
    const content = [instruction, strategyBrief, skillBrief]
      .filter((part): part is string => part !== undefined && part.trim().length > 0)
      .join("\n\n");
    return {
      role: "user",
      content,
      // 相位推进时刻（ADR-0015：不再写 0——转录与 view 的消息时间以此为准；
      // timestamp 不进 wire，字节门不受影响）
      timestamp: Date.now(),
    };
  }

  /**
   * Phase 5 六项镜头补漏扫描（`limits.loop.phase5Sweep`）。
   *
   * 独立请求而不是并入主 Phase 5 指令：实测把检查项塞进同一次生成会挤掉
   * 主候选（注意力置换）。这里只要求「新增」，已有候选原样保留。
   */
  function phase5SweepMessage(): AgentMessage {
    const existing = roundCandidates
      .map((candidate) => {
        if (!isRecord(candidate)) {
          return undefined;
        }
        const file = typeof candidate.file === "string" ? candidate.file : "";
        const line = typeof candidate.line === "number" ? candidate.line : 0;
        const title = typeof candidate.title === "string" ? candidate.title : "";
        return `${file}:${String(line)} ${title}`.trim();
      })
      .filter((line): line is string => line !== undefined && line.length > 0)
      .join("\n");
    const content = [
      "Phase 5 补漏扫描（六项缺陷镜头）。不要重复已有候选，只输出你新发现、且尚未列出的候选。",
      existing.length > 0 ? `已有候选：\n${existing}` : "已有候选：无",
      [
        "对每个新增/修改 hunk 依次检查：",
        "1. 空值/缺失键：新解引用、下标、字段访问是否可能为空或不存在；",
        "2. 边界/off-by-one：新增的分页、循环、切片、长度计算在 0、1、整除、超限时的行为；",
        "3. 类型/字节序/精度：新增的 cast、跨语言边界、格式化参数是否匹配；",
        "4. 错误路径：新增的异常/返回 null/日志分支是否丢失错误信息；",
        "5. 资源与生命周期：新增的句柄、内存、锁、连接是否所有分支都释放；",
        "6. 顺序/并发/幂等：新增的去重、集合遍历、异步改写是否破坏顺序或幂等。",
        "本次变更新写或重写的代码路径，即使旧代码已有 TODO 或已知缺口，也要把新实现中缺失的校验/分支视为本次引入的问题。",
      ].join("\n"),
      '只回一个 JSON 对象：{"candidates":[...]}；没有新增就回 {"candidates":[]}。',
    ].join("\n\n");
    return { role: "user", content, timestamp: Date.now() };
  }
}

/** LlmMessage → pi-ai UserMessage（`timestamp` 取构造时刻；不进 wire 序列化） */
function toUserMessage(message: LlmMessage): AgentMessage {
  if (message.role !== "user") {
    throw new Error(`initial context message must have role "user", got "${message.role}"`);
  }
  return { role: "user", content: message.content, timestamp: Date.now() };
}

function readCandidateId(candidate: unknown, round: number, index: number): string {
  if (isRecord(candidate)) {
    const id = candidate.id;
    if (typeof id === "string" && id.length > 0) {
      return id;
    }
  }
  return `round-${String(round)}-candidate-${String(index)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 两个候选对象之间值有差异的顶层键（修复留痕用；不记录值本身） */
function changedFields(before: unknown, after: Record<string, unknown>): readonly string[] {
  const source = isRecord(before) ? before : {};
  const keys = new Set([...Object.keys(source), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (JSON.stringify(source[key]) !== JSON.stringify(after[key])) {
      changed.push(key);
    }
  }
  return changed;
}

function totalRejections(counts: CandidateRejectionCounts): number {
  return Object.values(counts).reduce((total, value) => total + value, 0);
}

function phaseNameOf(phaseIndex: number): PhaseRecord["phase"] {
  const name = PHASE_ORDER[phaseIndex];
  if (name === undefined) {
    throw new Error(`missing phase name at index ${phaseIndex}`);
  }
  return name as PhaseRecord["phase"];
}

/**
 * 审计投影：wire 捕获（tools = wire 下划线名）→ DSH 审计口径（tools = 点分名，
 * 与 requests[].tools 真源同形态；wireBody 原文保持下划线形态不变）。
 */
function auditWireCapture(payload: unknown): WireRequest {
  const wire = captureWire(payload);
  return {
    ...wire,
    tools: wire.tools.map((tool) => ({ ...tool, name: fromWireToolName(tool.name) })),
  };
}

function appendReason(reasons: string[], reason: string): void {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
}
