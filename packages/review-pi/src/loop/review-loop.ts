import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type { Finding } from "../contracts/finding.js";
import type { LlmMessage, LlmUsage } from "../contracts/llm.js";
import type { PrefetchLayerRecord } from "../contracts/prefetch.js";
import { NO_OP_PROGRESS_SINK, type RunProgressSink } from "../contracts/progress.js";
import type { CandidateRejection, PhaseRecord, RunAudit, WireRequest } from "../contracts/run.js";
import { applyCandidateGate } from "../gate/candidate-gate.js";
import { assistantText } from "../provider/pi-client.js";
import { addUsage, ZERO_USAGE } from "../provider/usage-map.js";
import { classifyCacheBreaks } from "./cache-break.js";
import { MAX_ROUNDS, TRUNCATION_MAX_ROUNDS } from "./constants.js";
import { parseCandidatesReply, parseVerificationReply, type VerificationVerdict } from "./parse.js";
import { PHASE_COUNT, PHASE_INSTRUCTIONS, PHASE_ORDER } from "./phases.js";
import { createRequestProgress } from "./request-progress.js";

// 六阶段控制器（内核变量面，config B 直驱）：pi 原语上的从 0 重写。
// 每轮 = 六阶段完整一遍，每阶段恰好一次请求（零工具，无子循环）；
// 回复回填上下文 append-only——compaction 显式禁用，任何请求的前缀
// 与上一请求逐字节一致（Zone A/B/C 稳定前缀是缓存命中与对照实验的根基）；
// 解析失败不抛异常（note 留痕进 PhaseRecord，有界推进）；
// Evidence Verification 的 complete 信号决定轮次终止；
// MAX_ROUNDS 上限外即截断留痕（truncationReasons）。

/** 一次回合的缝产出：回复消息 + wire 捕获 + usage（已折算 LLM 口径） */
export interface LoopTurn {
  readonly message: AssistantMessage;
  readonly wire: WireRequest;
  readonly usage: LlmUsage;
}

/** 回合缝（生产实现 = runReviewTurn；测试注入脚本回复） */
export type ReviewTurnRunner = (context: Context) => Promise<LoopTurn>;

export interface ReviewLoopInputs {
  readonly systemPrompt: string;
  /** 初始上下文消息（Zone B → MR user → 预取层；system 走 systemPrompt 通道） */
  readonly initialContextMessages: readonly LlmMessage[];
  /** 预取注入层记账（透传进 audit.prefetch） */
  readonly prefetchRecords?: readonly PrefetchLayerRecord[];
  readonly runTurn: ReviewTurnRunner;
  /**
   * 运行进度投影（ADR-0016）：缺省不注入 = 零输出。零工具配置每阶段恰好一次
   * 请求，故只有 `phase` 与 `request` 两种事件（没有工具面可投影）。
   */
  readonly onProgress?: RunProgressSink;
}

export interface ReviewLoopOutcome {
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

export async function runReviewLoop(inputs: ReviewLoopInputs): Promise<ReviewLoopOutcome> {
  const requests: WireRequest[] = [];
  const phaseLog: PhaseRecord[] = [];
  const findings: Finding[] = [];
  const rejections: CandidateRejection[] = [];
  let usage: LlmUsage = ZERO_USAGE;
  let messages = inputs.initialContextMessages.map(toUserMessage);
  let rounds = 0;
  let complete = false;
  let truncated = false;
  let emittedIds: ReadonlySet<string> = new Set();
  const truncationReasons: string[] = [];
  const emitProgress = inputs.onProgress ?? NO_OP_PROGRESS_SINK;
  const requestProgress = createRequestProgress(emitProgress);

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    rounds = round;
    let candidates: readonly unknown[] = [];
    let verificationComplete = false;
    let verdicts: ReadonlyMap<string, VerificationVerdict> = new Map();

    for (let phaseIndex = 0; phaseIndex < PHASE_COUNT; phaseIndex++) {
      const instruction = PHASE_INSTRUCTIONS[phaseIndex];
      if (instruction === undefined) {
        throw new Error(`missing phase instruction at index ${phaseIndex}`);
      }
      emitProgress({
        kind: "phase",
        round,
        phase: phaseNameOf(phaseIndex),
        index: phaseIndex + 1,
        total: PHASE_COUNT,
      });
      messages = [...messages, { role: "user", content: instruction, timestamp: 0 }];
      requestProgress.start();
      const turn = await inputs.runTurn({ systemPrompt: inputs.systemPrompt, messages });
      requestProgress.end(turn.usage);
      messages = [...messages, turn.message];
      usage = addUsage(usage, turn.usage);
      requests.push(turn.wire);

      let note: string | undefined;
      const replyText = assistantText(turn.message);
      if (phaseIndex === CANDIDATES_PHASE_INDEX) {
        const parsed = parseCandidatesReply(replyText);
        candidates = parsed.candidates;
        note = parsed.note;
      } else if (phaseIndex === VERIFICATION_PHASE_INDEX) {
        const parsed = parseVerificationReply(replyText);
        verdicts = parsed.verdicts;
        verificationComplete = parsed.complete;
        note = parsed.note;
      }
      phaseLog.push({
        round,
        phase: phaseNameOf(phaseIndex),
        requestCount: 1,
        ...(note !== undefined ? { note } : {}),
      });
    }

    const gate = applyCandidateGate({ candidates, verdicts, emittedIds, round });
    findings.push(...gate.findings);
    rejections.push(...gate.rejections);
    emittedIds = gate.emittedIds;
    complete = verificationComplete;
    if (complete) {
      break;
    }
  }

  if (!complete) {
    truncated = true;
    truncationReasons.push(TRUNCATION_MAX_ROUNDS);
  }

  const audit: RunAudit = {
    requests,
    toolCallLog: [],
    phaseLog,
    rejections,
    cacheBreaks: classifyCacheBreaks(requests),
    truncated,
    truncationReasons,
    ...(inputs.prefetchRecords !== undefined ? { prefetch: inputs.prefetchRecords } : {}),
  };
  return { findings, usage, rounds, toolCalls: 0, complete, audit };
}

function phaseNameOf(phaseIndex: number): PhaseRecord["phase"] {
  const name = PHASE_ORDER[phaseIndex];
  if (name === undefined) {
    throw new Error(`missing phase name at index ${phaseIndex}`);
  }
  return name as PhaseRecord["phase"];
}

/** LlmMessage → pi-ai UserMessage（timestamp 为内核内部字段，不参与序列化） */
function toUserMessage(message: LlmMessage): Context["messages"][number] {
  if (message.role !== "user") {
    throw new Error(`initial context message must have role "user", got "${message.role}"`);
  }
  return { role: "user", content: message.content, timestamp: 0 };
}
