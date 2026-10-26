import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentMessage, AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, FetchFunction, Model } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import type { Finding } from "../contracts/finding.js";
import type { LlmMessage, LlmUsage } from "../contracts/llm.js";
import type {
  CandidateRejection,
  PhaseRecord,
  RunAudit,
  ToolCallRecord,
  WireRequest,
} from "../contracts/run.js";
import { applyCandidateGate } from "../gate/candidate-gate.js";
import {
  assistantText,
  captureWire,
  LOCKED_REASONING_EFFORT,
  reviewModelOf,
} from "../provider/pi-client.js";
import { addUsage, piUsageToLlmUsage, ZERO_USAGE } from "../provider/usage-map.js";
import { classifyCacheBreaks } from "./cache-break.js";
import {
  MAX_ROUNDS,
  MAX_TOOL_CALLS,
  TOOL_BUDGET_EXHAUSTED_SUMMARY,
  TRUNCATION_MAX_ROUNDS,
  TRUNCATION_TOOL_BUDGET,
} from "./constants.js";
import { parseCandidatesReply, parseVerificationReply, type VerificationVerdict } from "./parse.js";
import { PHASE_COUNT, PHASE_INSTRUCTIONS, PHASE_ORDER } from "./phases.js";
import { fromWireToolName, toWireToolName } from "../tools/registry.js";
import type { ReviewToolkit } from "../tools/toolkit.js";

// agentLoop 钩子驱动循环（#6 P3a，config C/D/E）：六阶段 + 工具子循环跑在
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

export interface AgentReviewLoopInputs {
  readonly systemPrompt: string;
  /** 初始上下文消息（MR / fullRepo 等 run 级组装，由调用方按配置决定） */
  readonly initialContextMessages: readonly LlmMessage[];
  /** 七工具执行面（含 Ledger；config E 传 ledgerMode "enabled" 的 toolkit） */
  readonly toolkit: ReviewToolkit;
  readonly apiKey: string;
  /** 网关 base URL 覆盖（REVIEWER_URL；缺省官方接入点） */
  readonly baseUrl?: string;
  /** 模型 id 覆盖（缺省钉住的评审模型） */
  readonly modelId?: string;
  /** 传输层注入；离线测试恒注入 fake 适配器 */
  readonly fetch?: FetchFunction;
  /** 审计投影 ledger 键（config E）；缺省不投影 */
  readonly includeLedgerAudit?: boolean;
  /**
   * 阶段附加简报（0-based 阶段下标）：某阶段消息尾部的追加内容。
   * 缺省（undefined）= 逐字节不变（A–E 冻结面）。config F 用它在候选阶段
   * （RULE_CHECK_PHASE_INDEX）注入规则 Skill 简报。简报并进同一条 user
   * 消息——followUpMode 缺省 one-at-a-time，连发两条会变成两个 run。
   */
  readonly phaseBrief?: (phaseIndex: number) => string | undefined;
}

export interface AgentReviewLoopOutcome {
  readonly findings: readonly Finding[];
  readonly usage: LlmUsage;
  readonly rounds: number;
  readonly toolCalls: number;
  /** 验证 complete 信号（= !truncated） */
  readonly complete: boolean;
  readonly audit: RunAudit;
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
    return tool;
  });

  const streamFn: StreamFn = (model, context, options) =>
    deepseekProvider().stream(model as Model<"openai-completions">, context, {
      ...options,
      apiKey: inputs.apiKey,
      ...(inputs.fetch !== undefined ? { fetch: inputs.fetch } : {}),
      reasoningEffort: LOCKED_REASONING_EFFORT,
    });

  // followUp 注入缝：shouldStopAfterTurn 闭包引用 agent，先落占位再绑定
  // （只在 agent.prompt 运行期被调用，绑定必然先于首调）
  let enqueueFollowUp: (message: AgentMessage) => void = () => {
    throw new Error("internal error: follow-up enqueue invoked before agent construction");
  };

  const agent = new Agent({
    initialState: {
      systemPrompt: inputs.systemPrompt,
      model: reviewModelOf(inputs.modelId, inputs.baseUrl),
      messages: inputs.initialContextMessages.map(toUserMessage),
      tools: agentTools,
    },
    streamFn,
    // DSH 工具批为严格批序执行（审计记录顺序 = 批内顺序）；parallel 模式按完成序落账
    toolExecution: "sequential",
    onPayload: (payload) => {
      requests.push(auditWireCapture(payload));
      phaseRequestCount += 1;
    },
    shouldStopAfterTurn: (context): boolean => {
      const message = context.message;
      usage = addUsage(usage, piUsageToLlmUsage(message.usage));
      if (message.content.some((block) => block.type === "toolCall")) {
        return false;
      }
      return advancePhase(assistantText(message), enqueueFollowUp);
    },
  });
  enqueueFollowUp = (message) => {
    agent.followUp(message);
  };

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
  };
  return { findings, usage, rounds: round, toolCalls: executedToolCalls, complete, audit };

  /** 文本轮收尾当前阶段并推进；返回值即 shouldStopAfterTurn 的停止判定 */
  function advancePhase(replyText: string, followUp: (message: AgentMessage) => void): boolean {
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

    if (phaseIndex < PHASE_COUNT - 1) {
      phaseIndex += 1;
      resetPhaseCounters();
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
    followUp(phaseMessage(0));
    return false;
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

  /**
   * 阶段消息 = PHASE_INSTRUCTIONS[i]（字节冻结）+ 可选简报。
   * 缺省简报（inputs.phaseBrief 缺席 / 该下标返回 undefined）逐字节不变；
   * 有简报时尾部拼 `\n\n<brief>`——config F 的字节差唯一定位点。
   */
  function phaseMessage(index: number): AgentMessage {
    const instruction = PHASE_INSTRUCTIONS[index];
    if (instruction === undefined) {
      throw new Error(`missing phase instruction at index ${index}`);
    }
    const brief = inputs.phaseBrief?.(index);
    return {
      role: "user",
      content: brief === undefined ? instruction : `${instruction}\n\n${brief}`,
      timestamp: 0,
    };
  }
}

/** LlmMessage → pi-ai UserMessage（timestamp 为内核内部字段，不参与序列化） */
function toUserMessage(message: LlmMessage): AgentMessage {
  if (message.role !== "user") {
    throw new Error(`initial context message must have role "user", got "${message.role}"`);
  }
  return { role: "user", content: message.content, timestamp: 0 };
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

/** schema 已知入参键（prepareArguments 剥未知键的保留集） */
function knownArgumentKeys(parameters: Record<string, unknown>): ReadonlySet<string> {
  const properties = parameters.properties;
  if (typeof properties !== "object" || properties === null) {
    return new Set();
  }
  return new Set(Object.keys(properties));
}

function stripUnknownArguments(args: unknown, knownKeys: ReadonlySet<string>): Record<string, unknown> {
  if (typeof args !== "object" || args === null) {
    return {};
  }
  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (knownKeys.has(key)) {
      stripped[key] = value;
    }
  }
  return stripped;
}

function appendReason(reasons: string[], reason: string): void {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
