import path from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, FetchFunction } from "@earendil-works/pi-ai";
import type { LlmUsage } from "../contracts/llm.js";
import type { RuleSkillPassRecord } from "../contracts/run.js";
import type { AgentTranscriptCapture } from "../export/transcript.js";
import {
  assistantText,
  reviewModelOf,
  reviewStreamFn,
} from "../provider/pi-client.js";
import { addUsage, piUsageToLlmUsage, ZERO_USAGE } from "../provider/usage-map.js";
import { toWireToolName } from "../tools/registry.js";
import { buildSkillBashTool } from "../tools/skill-bash.js";
import { knownArgumentKeys, stripUnknownArguments } from "../tools/tool-arguments.js";
import type { ReviewToolkit } from "../tools/toolkit.js";
import { parseCandidatesReply } from "../loop/parse.js";
import type { RuleSkill } from "./rule-skill.js";
import { buildSkillPassInvocation } from "./skill-pass-brief.js";

/**
 * 单个 skill 检视会话（ADR-0014 决策 3/4/9/11/13）。
 *
 * 形态：**独立 `Agent`**，种子 = 主 Agent 在 Phase 5 结束时的 messages 快照；
 * 首条 user 消息 = `formatSkillInvocation(skill)` + 输出契约。skill 之间、
 * skill 与主会话之间互不可见（同一快照各自分叉）。
 *
 * 工具面：七检视工具 + `bash`（八只；bash 边界见 `tools/skill-bash.ts`）。
 * 七工具跑在**按 Phase-5 ledger 快照分叉**的 toolkit 上——直接共享主实例会
 * 让后跑的 skill 拿到它没经历过的 "Already loaded" 引用。
 *
 * 失败语义：会话异常 / provider 错误 / 解析失败 ⇒ `failed`（带
 * `failureStage`）；跑通 0 候选 ⇒ `empty`（合法）。单会话 5 min 上界。
 */

/** 单 skill 会话超时（ADR-0014 决策 11：5 min） */
export const SKILL_PASS_TIMEOUT_MS = 5 * 60_000;

export interface SkillPassOptions {
  readonly round: number;
  readonly skill: RuleSkill;
  /** Zone A 复用主检视 system prompt（跨会话缓存命中） */
  readonly systemPrompt: string;
  /** Phase 5 结束时的 messages 快照（原样作为会话历史） */
  readonly seedMessages: readonly AgentMessage[];
  /** 七工具执行面（ledger 已按快照分叉） */
  readonly toolkit: ReviewToolkit;
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly modelId?: string;
  readonly fetch?: FetchFunction;
  readonly timeoutMs?: number;
  readonly resultBudgetChars?: number;
}

/** 独立落盘的 skill 转录原料（写盘由 run 层负责——runId/输出目录在那边） */
export interface SkillPassTranscript {
  readonly round: number;
  readonly skill: string;
  readonly capture: AgentTranscriptCapture;
  readonly complete: boolean;
  readonly truncated: boolean;
}

export interface SkillPassOutcome {
  readonly record: RuleSkillPassRecord;
  /** 原始候选（未去重；合并由 gate/candidate-merge 负责） */
  readonly candidates: readonly unknown[];
  readonly usage: LlmUsage;
  readonly transcript?: SkillPassTranscript;
}

export async function runSkillPass(options: SkillPassOptions): Promise<SkillPassOutcome> {
  const { skill, round } = options;
  let requestCount = 0;
  let toolCallCount = 0;
  let usage: LlmUsage = ZERO_USAGE;
  let firstRequestAt: Date | undefined;

  const tools: AgentTool[] = [
    ...reviewAgentTools(options.toolkit, () => {
      toolCallCount += 1;
    }),
    buildSkillBashTool({
      packRoot: packRootOf(skill),
      ...(options.resultBudgetChars !== undefined
        ? { resultBudgetChars: options.resultBudgetChars }
        : {}),
    }),
  ];

  const model = reviewModelOf(options.modelId, options.baseUrl);
  const agent = new Agent({
    initialState: {
      systemPrompt: options.systemPrompt,
      model,
      messages: [...options.seedMessages],
      tools,
    },
    streamFn: reviewStreamFn({
      apiKey: options.apiKey,
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    }),
    toolExecution: "sequential",
    // 会话自身的请求捕获点（ADR-0014「每个 skill 会话独立的 onPayload 捕获」）：
    // 只记计数与首请求时刻——skill 会话属非测量档，其 wire 字节不并入主审计
    // `requests[]`（独立转录才是它的记录），F↔E 的逐字节对照因此仍只看主链。
    onPayload: () => {
      if (firstRequestAt === undefined) {
        firstRequestAt = new Date();
      }
      requestCount += 1;
    },
    shouldStopAfterTurn: (context): boolean => {
      usage = addUsage(usage, piUsageToLlmUsage(context.message.usage));
      // 文本回合 = 会话结束（skill 只跑一趟，无相位推进）
      return !context.message.content.some((block) => block.type === "toolCall");
    },
  });

  const timeoutMs = options.timeoutMs ?? SKILL_PASS_TIMEOUT_MS;
  let session: "done" | "timeout";
  let sessionError: unknown;
  try {
    session = await runWithTimeout(agent, buildSkillPassInvocation(skill), timeoutMs);
  } catch (error) {
    session = "done";
    sessionError = error;
  }

  const capture: AgentTranscriptCapture | undefined =
    firstRequestAt === undefined
      ? undefined
      : {
          messages: [...agent.state.messages],
          firstRequestAt,
          model: { id: model.id, baseUrl: model.baseUrl },
        };

  const failure = (reason: string, stage: RuleSkillPassRecord["failureStage"]): SkillPassOutcome => ({
    record: {
      round,
      skill: skill.name,
      status: "failed",
      requestCount,
      toolCallCount,
      candidateCount: 0,
      mergedCount: 0,
      degradedReason: reason,
      ...(stage !== undefined ? { failureStage: stage } : {}),
    },
    candidates: [],
    usage,
    ...(capture !== undefined
      ? {
          transcript: {
            round,
            skill: skill.name,
            capture,
            complete: false,
            truncated: false,
          },
        }
      : {}),
  });

  if (sessionError !== undefined) {
    return failure(errorMessage(sessionError), "session");
  }
  if (session === "timeout") {
    return failure(`rule-skill session timed out after ${timeoutMs}ms`, "session");
  }

  // provider 错误不 reject（pi-ai 语义）：显式扫描错误回合，错误永不静默成成功
  const errored = agent.state.messages.find(
    (message): message is AssistantMessage =>
      message.role === "assistant" && message.stopReason === "error",
  );
  if (errored !== undefined) {
    return failure(
      errored.errorMessage ?? "provider returned an error stop reason",
      "session",
    );
  }

  const reply = lastAssistantText(agent.state.messages);
  const parsed = parseCandidatesReply(reply);
  if (parsed.note !== undefined) {
    return failure(parsed.note, "parse");
  }

  // 路径洁净副本（ADR-0014 验收 6：主会话请求不得含宿主绝对路径——skill
  // 会话里可以有，它的产出不行）。原始措辞留在本会话的独立转录里。
  const packRoot = packRootOf(skill);
  const candidates = parsed.candidates.map((candidate) => sanitizePackPaths(candidate, packRoot));
  const ruleIds = collectRuleIds(candidates);
  return {
    record: {
      round,
      skill: skill.name,
      status: candidates.length > 0 ? "ok" : "empty",
      requestCount,
      toolCallCount,
      candidateCount: candidates.length,
      mergedCount: 0,
      ...(ruleIds.length > 0 ? { ruleIds } : {}),
    },
    candidates,
    usage,
    ...(capture !== undefined
      ? {
          transcript: {
            round,
            skill: skill.name,
            capture,
            complete: true,
            truncated: false,
          },
        }
      : {}),
  };
}

/** 会话首条消息执行 + 超时上界（超时先 abort 再等 prompt 落定，防悬挂） */
async function runWithTimeout(
  agent: Agent,
  prompt: string,
  timeoutMs: number,
): Promise<"done" | "timeout"> {
  // 会话异常按 reject 原样上抛（调用方转成 failed/session），不在这里吞掉
  const running = agent.prompt(prompt).then(() => "done" as const);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const settled = await Promise.race([running, timeout]);
    if (settled === "timeout") {
      agent.abort();
      await running.catch(() => undefined);
    }
    return settled;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 会话最后一条 assistant 文本（无 assistant 回合按空串处理 → 解析失败） */
function lastAssistantText(messages: readonly AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && message.role === "assistant") {
      return assistantText(message);
    }
  }
  return "";
}

/** 候选引用的规则 id（首见序、去重；非字符串/空串忽略） */
function collectRuleIds(candidates: readonly unknown[]): readonly string[] {
  const ids: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "object" || candidate === null) {
      continue;
    }
    const rule = (candidate as { rule?: unknown }).rule;
    if (typeof rule === "string" && rule.length > 0 && !ids.includes(rule)) {
      ids.push(rule);
    }
  }
  return ids;
}

/** 净化后替身（ADR-0012 沿用的占位符：skill 会话的产出不得回执宿主绝对路径） */
const RULE_SKILL_PATH_PLACEHOLDER = "<rule-skill>";

/**
 * pack 根路径净化（ADR-0014 验收 6）：skill 候选流会连同 `evidence.snippet`
 * 一起被塞进**主会话**的 Phase 6 请求，而 skill 会话读的是真实解压目录——
 * 一旦模型把 `C:\...\.cache\rule-skills\<sha>\...` 抄进证据，主会话请求就会
 * 出现宿主绝对路径。这里把 pack 根的各种写法统一换成 `<rule-skill>`。
 *
 * 原始措辞不丢：本会话的独立转录里是未净化的原文（决策 13），按证据追溯
 * 去读转录即可。净化只作用于「要进另一条测量会话」的候选对象。
 */
function sanitizePackPaths(value: unknown, packRoot: string): unknown {
  if (typeof value === "string") {
    // 各种写法都换：Windows 原样、正斜杠形态（模型常把 `\` 写成 `/`）
    let text = value;
    for (const form of pathForms(packRoot)) {
      text = text.split(form).join(RULE_SKILL_PATH_PLACEHOLDER);
    }
    return text;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePackPaths(item, packRoot));
  }
  if (typeof value === "object" && value !== null) {
    const scrubbed: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      scrubbed[key] = sanitizePackPaths(item, packRoot);
    }
    return scrubbed;
  }
  // 数字 / 布尔 / null 原样
  return value;
}

/** pack 根的等价写法（去重、长度降序：先换长的，避免前缀截断后留下残片） */
function pathForms(packRoot: string): readonly string[] {
  const forms = new Set<string>([
    packRoot,
    packRoot.replaceAll("\\", "/"),
    packRoot.replaceAll("/", "\\"),
  ]);
  forms.delete("");
  return [...forms].sort((a, b) => b.length - a.length);
}

/** pack 根 = SKILL.md 所在目录（bash cwd；SKILL.md 里的相对路径基准） */
function packRootOf(skill: RuleSkill): string {
  if (skill.filePath.length === 0) {
    // 降级包在 loop 侧已被跳过；走到这里说明上游漏判（绝不能退回宿主 cwd，
    // 那会把检视运行目录暴露成 bash 的 cwd）
    throw new Error(`internal error: skill "${skill.name}" has no loaded SKILL.md path`);
  }
  return path.dirname(skill.filePath);
}

/**
 * 七工具 → AgentTool（skill 会话版）：无审计留痕、无预算截断——只计调用数，
 * 与 loop 侧包装保持同一 wire 名、同一入参投影、同一 "Error: " 失败文本口径
 * （入参投影见 `tools/tool-arguments.ts`）。
 */
function reviewAgentTools(
  toolkit: ReviewToolkit,
  onToolCall: () => void,
): readonly AgentTool[] {
  return toolkit.schemas.map((schema) => {
    const parameters = JSON.parse(schema.parametersJson) as Record<string, unknown>;
    const knownKeys = knownArgumentKeys(parameters);
    return {
      name: toWireToolName(schema.name),
      label: schema.name,
      description: schema.description,
      parameters,
      prepareArguments: (args) => stripUnknownArguments(args, knownKeys),
      execute: async (_toolCallId, params) => {
        onToolCall();
        const args = params as Record<string, unknown>;
        try {
          const text = await toolkit.executeTool(schema.name, args);
          return { content: [{ type: "text", text }], details: {} };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { content: [{ type: "text", text: `Error: ${message}` }], details: {} };
        }
      },
    } satisfies AgentTool;
  });
}
