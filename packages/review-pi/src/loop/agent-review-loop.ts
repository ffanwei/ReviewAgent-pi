import { Agent } from "@review-agent-pi/pi-agent-core";
import type { AgentMessage, AgentTool, StreamFn } from "@review-agent-pi/pi-agent-core";
import type { AssistantMessage, FetchFunction } from "@review-agent-pi/pi-ai";
import type { Finding } from "../contracts/finding.js";
import type { LedgerEntry } from "../contracts/ledger.js";
import type { LlmMessage, LlmUsage } from "../contracts/llm.js";
import { NO_OP_PROGRESS_SINK, type RunProgressSink } from "../contracts/progress.js";
import type {
  CandidateRejection,
  PhaseRecord,
  RuleSkillPassRecord,
  RunAudit,
  ToolCallRecord,
  WireRequest,
} from "../contracts/run.js";
import type { AgentTranscriptCapture } from "../export/transcript.js";
import { applyCandidateGate } from "../gate/candidate-gate.js";
import { mergeSkillCandidates, type SkillCandidateBatch } from "../gate/candidate-merge.js";
import { assistantText, captureWire, reviewModelOf, reviewStreamFn } from "../provider/pi-client.js";
import { addUsage, piUsageToLlmUsage, ZERO_USAGE } from "../provider/usage-map.js";
import { DEFAULT_REVIEW_RUNTIME, type ReviewRuntime } from "../shared/review-runtime.js";
import { classifyCacheBreaks } from "./cache-break.js";
import {
  MAX_ROUNDS,
  MAX_TOOL_CALLS,
  TOOL_BUDGET_EXHAUSTED_SUMMARY,
  TRUNCATION_MAX_ROUNDS,
  TRUNCATION_MODEL_LENGTH,
  TRUNCATION_TOOL_BUDGET,
} from "./constants.js";
import { parseCandidatesReply, parseVerificationReply, type VerificationVerdict } from "./parse.js";
import { PHASE_COUNT, PHASE_INSTRUCTIONS, PHASE_ORDER } from "./phases.js";
import { createRequestProgress } from "./request-progress.js";
import { fromWireToolName, toWireToolName } from "../tools/registry.js";
import { knownArgumentKeys, stripUnknownArguments } from "../tools/tool-arguments.js";
import { summarizeDetailLine, withToolProgress } from "../tools/tool-progress.js";
import type { ReviewToolkit } from "../tools/toolkit.js";
import type { RuleSkill } from "../knowledge/rule-skill.js";
import { runSkillPass, type SkillPassTranscript } from "../knowledge/skill-pass.js";
import { buildSkillCandidatesBrief } from "../knowledge/skill-pass-brief.js";

// agentLoop 钩子驱动循环（#6 P3a）：六阶段 + 工具子循环跑在
// pi-agent-core Agent 上，三个预定缝承载 review 语义——
//
// - shouldStopAfterTurn = review 状态机：工具轮恒继续（t-series 真源：预算
//   耗尽也 recall，相位只在文本回复时完结，无 force-complete）；文本轮完结
//   当前阶段（解析 + PhaseRecord 留痕），经 agent.followUp 注入下一阶段指令
//   或下一轮 phase-1 指令；complete / 轮次上界即停；
// - transformContext 不设（恒等透传）：消息前缀 append-only，Zone A/B/C
//   稳定前缀由内核时序直接保证；
// - state.tools = 七工具 AgentTool（name = wire 下划线名直达 wire function.name；
//   prepareArguments 剥未知键对齐 DSH 容忍语义——pi-ai 严格校验缝的方言对冲）。
//
// 工具预算与审计在 execute 包装层：成功执行计数跨轮不重置（失败也计入），
// 超出即返回 "Error: tool call budget exhausted"（= 审计 resultSummary =
// wire tool 消息 content，t-series 真源字节）；truncationReasons 单列
// TOOL_BUDGET_EXHAUSTED 但不翻转 truncated（截断语义只归 MAX_ROUNDS）。
//
// 规则 Skill（ADR-0014）：Phase 5 文本回合收尾后、Phase 6 指令注入前，顺序跑
// 各 skill 的独立检视会话（`knowledge/skill-pass.ts`）。skill 回合不进
// `phaseLog`（两者并列），候选在候选门之前跨 skill 去重，Phase 6 一次裁定。

export interface AgentReviewLoopInputs {
  readonly systemPrompt: string;
  /** 初始上下文消息（MR 消息等 run 级组装，由调用方决定） */
  readonly initialContextMessages: readonly LlmMessage[];
  /** 七工具执行面（含 Ledger；唯一形态恒传 ledgerMode "enabled" 的 toolkit） */
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
   * 运行进度投影（ADR-0016）：缺省不注入 = 零输出、零行为变化。事件只投影既有
   * 留痕（阶段推进 / 请求首尾 / 工具首尾 / skill 会话首尾），不改 wire 字节、
   * 不进审计、不影响退出码。
   */
  readonly onProgress?: RunProgressSink;
}

/** skill 会话接线（由 run 层提供 pack 与 toolkit 工厂） */
export interface SkillPassRequest {
  /** 已装载的规则 Skill（CLI 顺序；降级包不跑会话） */
  readonly skills: readonly RuleSkill[];
  /**
   * 按 Phase-5 ledger 快照分叉七工具 toolkit。每个 skill 调用一次：skill 之间
   * 互不可见，且 skill 会话的读取不会污染主账本。
   */
  readonly toolkitFor: (seedLedgerSnapshot: readonly LedgerEntry[]) => ReviewToolkit;
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
const CANDIDATES_PHASE_INDEX = 4;
const VERIFICATION_PHASE_INDEX = 5;

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
  let roundCandidates: readonly unknown[] = [];
  let roundVerdicts: ReadonlyMap<string, VerificationVerdict> = new Map();
  let roundComplete = false;
  let emittedIds: ReadonlySet<string> = new Set();
  let truncated = false;
  let complete = false;
  // 规则 Skill 会话留痕（与 phaseLog 并列，不混入相位记录）
  const skillPassLog: RuleSkillPassRecord[] = [];
  const skillTranscripts: SkillPassTranscript[] = [];
  let skillToolCalls = 0;
  let roundSkillBatches: readonly SkillCandidateBatch[] = [];
  // 首次模型请求时刻（唯一新增内核仪器；不是逐请求/逐工具耗时）
  let firstRequestAt: Date | undefined;
  // 进度投影（ADR-0016）：只读既有留痕，缺省 sink = 空函数（零行为变化）
  const emitProgress = inputs.onProgress ?? NO_OP_PROGRESS_SINK;
  const requestProgress = createRequestProgress(emitProgress);
  const runtime = inputs.runtime ?? DEFAULT_REVIEW_RUNTIME;
  // DISP 微限（ADR-0025）：进度行只在开进度时有意义；缺省值与历史行为一致
  const progressLimits = {
    argumentsSummaryChars: runtime.limits.micro.argumentsSummaryChars,
    progressDetailChars: runtime.limits.micro.progressDetailChars,
  };

  const agentTools: AgentTool[] = inputs.toolkit.schemas.map((schema) => {
    const parameters = JSON.parse(schema.parametersJson) as Record<string, unknown>;
    const knownKeys = knownArgumentKeys(parameters);
    const tool: AgentTool = {
      name: toWireToolName(schema.name),
      label: schema.name,
      description: schema.description,
      parameters,
      prepareArguments: (args) => stripUnknownArguments(args, knownKeys),
      execute: async (_toolCallId, params) => {
        const args = params as Record<string, unknown>;
        const argumentsJson = JSON.stringify(args);
        if (executedToolCalls >= MAX_TOOL_CALLS) {
          phaseSkippedToolCalls += 1;
          appendReason(truncationReasons, TRUNCATION_TOOL_BUDGET);
          toolCallLog.push({
            name: schema.name,
            argumentsJson,
            resultSummary: TOOL_BUDGET_EXHAUSTED_SUMMARY,
          });
          return { content: [{ type: "text", text: TOOL_BUDGET_EXHAUSTED_SUMMARY }], details: {} };
        }
        // 预算预约同步于检查（批内调用序即预约序）；失败不退还（防失败死循环）
        executedToolCalls += 1;
        try {
          const result = await inputs.toolkit.executeTool(schema.name, args);
          toolCallLog.push({ name: schema.name, argumentsJson, resultSummary: result });
          return { content: [{ type: "text", text: result }], details: {} };
        } catch (error) {
          // t-series 真源字节：失败前缀 "Error: "（VUL4J-16/E/rep-3 实证：
          // "Error: review.get_file: file …"——工具错误消息自带工具名前缀）
          const summary = `Error: ${errorMessage(error)}`;
          toolCallLog.push({ name: schema.name, argumentsJson, resultSummary: summary });
          return { content: [{ type: "text", text: summary }], details: {} };
        }
      },
    };
    // 进度包装（ADR-0016）：名用点分审计名；成功/失败判据与 skill 会话同源
    return withToolProgress(tool, schema.name, emitProgress, progressLimits);
  });

  const streamFn: StreamFn = reviewStreamFn({
    apiKey: inputs.apiKey,
    ...(inputs.fetch !== undefined ? { fetch: inputs.fetch } : {}),
    maxOutputTokens: runtime.maxOutputTokens,
  });

  // followUp 注入缝：shouldStopAfterTurn 闭包引用 agent，先落占位再绑定
  // （只在 agent.prompt 运行期被调用，绑定必然先于首调）
  let enqueueFollowUp: (message: AgentMessage) => void = () => {
    throw new Error("internal error: follow-up enqueue invoked before agent construction");
  };

  const model = reviewModelOf(inputs.modelId, inputs.baseUrl, runtime.models);
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
      `review turn failed: ${failed.errorMessage ?? "provider returned an error stop reason"}`,
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
    const parsed = parsePhaseReply(replyText);
    const notes: string[] = [];
    if (phaseSkippedToolCalls > 0) {
      notes.push(`${phaseSkippedToolCalls} tool call(s) skipped: budget exhausted`);
    }
    if (parsed.note !== undefined) {
      notes.push(parsed.note);
    }
    phaseLog.push({
      round,
      phase: phaseNameOf(phaseIndex),
      requestCount: phaseRequestCount,
      ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
    });

    // Phase 5 之后、Phase 6 指令之前：顺序跑 skill 检视会话（ADR-0014）。
    // 种子 = 主会话此刻的 messages 快照；每个 skill 分叉自己的 history 与 ledger。
    if (phaseIndex === CANDIDATES_PHASE_INDEX) {
      await runRoundSkillPasses(seedMessages);
    }

    if (phaseIndex < PHASE_COUNT - 1) {
      phaseIndex += 1;
      resetPhaseCounters();
      emitPhase(phaseIndex);
      followUp(phaseMessage(phaseIndex));
      return false;
    }

    // Evidence Verification 收尾：候选拦截链 + 轮次决策
    const gate = applyCandidateGate({
      candidates: roundCandidates,
      verdicts: roundVerdicts,
      emittedIds,
      round,
    });
    findings.push(...gate.findings);
    rejections.push(...gate.rejections);
    emittedIds = gate.emittedIds;
    complete = roundComplete;
    if (complete) {
      return true;
    }
    if (round >= MAX_ROUNDS) {
      truncated = true;
      appendReason(truncationReasons, TRUNCATION_MAX_ROUNDS);
      return true;
    }
    round += 1;
    phaseIndex = 0;
    resetPhaseCounters();
    roundCandidates = [];
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

    const merged = mergeSkillCandidates({
      primary: roundCandidates,
      batches: outcomes.map((outcome) => ({
        skill: outcome.record.skill,
        candidates: outcome.candidates,
      })),
    });
    roundCandidates = merged.candidates;
    roundSkillBatches = merged.survivingBatches;
    outcomes.forEach((outcome, index) => {
      usage = addUsage(usage, outcome.usage);
      skillToolCalls += outcome.record.toolCallCount;
      skillPassLog.push({ ...outcome.record, mergedCount: merged.mergedCounts[index] ?? 0 });
      if (outcome.transcript !== undefined) {
        skillTranscripts.push(outcome.transcript);
      }
    });
  }

  function parsePhaseReply(replyText: string): { readonly note?: string } {
    if (phaseIndex === CANDIDATES_PHASE_INDEX) {
      const parsed = parseCandidatesReply(replyText);
      roundCandidates = parsed.candidates;
      return parsed.note !== undefined ? { note: parsed.note } : {};
    }
    if (phaseIndex === VERIFICATION_PHASE_INDEX) {
      const parsed = parseVerificationReply(replyText);
      roundVerdicts = parsed.verdicts;
      roundComplete = parsed.complete;
      return parsed.note !== undefined ? { note: parsed.note } : {};
    }
    return {};
  }

  function resetPhaseCounters(): void {
    phaseRequestCount = 0;
    phaseSkippedToolCalls = 0;
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
    const instruction = PHASE_INSTRUCTIONS[index];
    if (instruction === undefined) {
      throw new Error(`missing phase instruction at index ${index}`);
    }
    const skillBrief =
      index === VERIFICATION_PHASE_INDEX ? buildSkillCandidatesBrief(roundSkillBatches) : undefined;
    return {
      role: "user",
      content: skillBrief === undefined ? instruction : `${instruction}\n\n${skillBrief}`,
      // 相位推进时刻（ADR-0015：不再写 0——转录与 view 的消息时间以此为准；
      // timestamp 不进 wire，字节门不受影响）
      timestamp: Date.now(),
    };
  }
}

/** LlmMessage → pi-ai UserMessage（`timestamp` 取构造时刻；不进 wire 序列化） */
function toUserMessage(message: LlmMessage): AgentMessage {
  if (message.role !== "user") {
    throw new Error(`initial context message must have role "user", got "${message.role}"`);
  }
  return { role: "user", content: message.content, timestamp: Date.now() };
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
