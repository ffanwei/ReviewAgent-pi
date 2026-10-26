import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  ImageContent,
  TextContent,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { buildRunId } from "../audit/audit-writer.js";
import type { ConfigId } from "../contracts/config.js";

// 检视转录（ADR-0013 / CONTEXT.md「检视转录」）：把一次检视中**进入 pi Agent
// 的全部交互**留档为 `{ info, messages, view }`：
// - `messages` = pi 原生真源（省键纪律）；
// - `view` = OpenCode 风格**定形投影**（Step B；无源字段一律 `null` 占位）。
//
// 纪律：
// - `messages` = `agent.state.messages` **原样**（省键真源：缺键即"源里没有"）
//   + 合成的 `messages[0]` system（Zone A 系统提示词不在 state.messages 里，
//   而是 `state.systemPrompt` 独立字段）；
// - `info` = **精确键表**（省键纪律：无 `kind`/`version`/`projectID`/
//   `info.time.durationMs`/`info.systemPrompt`——最后一项已在 messages[0]）；
// - `view` 与 `messages`/`info` **纪律相反**：形状固定，凡无源的键一律 `null`
//   占位（工具耗时、snapshot、message id/time 等）——供与 OpenCode 会话
//   导出并排阅读（ADR-0013：转录是 crime scene，不是指标源）；
// - usage 口径 = pi-ai `Usage` **全量**（含 `cost`/`reasoning`）——与审计 /
//   `rep-N.json` 的内核 `LlmUsage` **有意不等**（ADR-0013 后果清单）；
// - 命名时间 = **首次模型请求时刻**（`firstRequestAt`，非 runReview 入口
//   `startedAt`）；文件名含该时刻 ⇒ **每 run 独立留档、不覆盖**；
// - 不截断、不脱敏：这是有意的"完整现场"（`runs/**` 已 gitignore）。

/** loop 捕获的 Agent 侧现场（转录原料；不含 system——systemPrompt 是独立字段） */
export interface AgentTranscriptCapture {
  /** `agent.state.messages` 原样快照（含初始上下文与后续 follow-up 注入） */
  readonly messages: readonly AgentMessage[];
  /** 首次模型请求时刻（onPayload 首次触发；唯一新增内核仪器） */
  readonly firstRequestAt: Date;
  /** Agent 实例的模型身份（pi `AgentState.model` 的窄投影） */
  readonly model: { readonly id: string; readonly baseUrl: string };
}

/**
 * 转录结局：`truncated`（命中 MAX_ROUNDS）/ `succeeded` / `failed`。
 * `failed` 在当前接线中**不可达**——loop 的 `complete === !truncated`
 * （advancePhase 只有"complete 为真"与"round >= MAX_ROUNDS"两个停止点；
 * provider 错误在返回前抛错、不产转录文件），唯一可达路径是被 abort 的回合，
 * 而当前无任何调用方传 AbortSignal。保留三值仅为防御式映射。
 */
export type TranscriptOutcome = "succeeded" | "truncated" | "failed";

/** 转录消息：合成的 system + pi 原生 AgentMessage 原样 */
export type TranscriptMessage =
  | { readonly role: "system"; readonly content: string }
  | AgentMessage;

/** 转录元数据（精确键表；键序即此处声明序） */
export interface TranscriptInfo {
  /** 文件名 stem（含首次模型请求时刻）——与磁盘文件一一对应 */
  readonly id: string;
  /** 审计 `runId`（本仓扩展键）：与审计 / `reviews_*.runId` / `rep-N.json` 的**配对键** */
  readonly runId: string;
  readonly agent: "review";
  readonly configId: ConfigId;
  readonly model: { readonly id: string; readonly baseUrl: string };
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly reasoning: number;
    readonly cache: { readonly read: number; readonly write: number };
  };
  readonly cost: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
  readonly outcome: TranscriptOutcome;
  readonly time: { readonly created: string; readonly completed: string };
  readonly title: string;
  readonly location: { readonly directory: string };
  /** 逐消息时间戳不可用（pi 循环构造的 user/assistant 恒 `timestamp: 0`） */
  readonly perMessageTimestamps: "unavailable";
}

/** 检视转录文档（`{ info, messages, view }`：原生真源 + 定形投影） */
export interface ReviewTranscript {
  readonly info: TranscriptInfo;
  readonly messages: readonly TranscriptMessage[];
  readonly view: TranscriptView;
}

// ---- OpenCode 风格定形投影（`view`；Step B） ----
//
// 形状对齐 OpenCode 会话导出的 `messages[]`（参考物
// `D:\Project\tmp\session-*.json`），但只保留 spec 映射表点名的字段：
// 无源字段（工具耗时、snapshot、逐消息 id/time、`model.variant`、`state.metadata`）
// 一律 `null`／空数组占位——与 `messages` 的省键纪律相反，这里是**定形**。
// toolResult 不另立 view 消息：并入对应 assistant 的 `tool` part（按
// `toolCall.id ↔ toolResult.toolCallId` 合并）。

/** `view` 内容分块：文本 / 思考 / 工具（合并 call+result） */
export interface ViewTextPart {
  readonly type: "text";
  readonly text: string;
}

/** 思考块（pi `thinking` → `reasoning`）；`time` 无源恒 `null` */
export interface ViewReasoningPart {
  readonly type: "reasoning";
  readonly text: string;
  readonly time: { readonly created: null; readonly completed: null };
}

/** 工具 part（合并一条 `toolCall` 与紧随的 `toolResult`） */
export interface ViewToolPart {
  readonly type: "tool";
  readonly id: string;
  readonly name: string;
  readonly state: {
    /** 有结果 = completed/error；无结果（截断/中止）= pending */
    readonly status: "completed" | "error" | "pending";
    readonly input: Record<string, unknown>;
    /** `toolResult.content`（无结果时 `null`） */
    readonly content: readonly (TextContent | ImageContent)[] | null;
    /** 无源恒 `null`（本仓工具结果 details 恒 `{}`，也不投到这里） */
    readonly metadata: null;
    /** 仅 `status === "error"`（`message` = 结果文本） */
    readonly error?: { readonly message: string };
  };
  /** 逐工具耗时未仪器化（ADR-0013 明确不做）⇒ 三个字段恒 `null` */
  readonly time: { readonly created: null; readonly ran: null; readonly completed: null };
}

export type ViewContentPart = ViewTextPart | ViewReasoningPart | ViewToolPart;

/** 合成 system 消息（spec 记为 `type:"system"`；OpenCode 参考导出不含 system） */
export interface ViewSystemMessage {
  readonly type: "system";
  readonly text: string;
}

export interface ViewUserMessage {
  readonly type: "user";
  readonly id: null;
  readonly time: { readonly created: null };
  readonly text: string;
  /** 无源（本仓检视不带附件）⇒ 恒空数组 */
  readonly files: readonly never[];
  readonly agents: readonly never[];
}

export interface ViewAssistantMessage {
  readonly type: "assistant";
  /** pi `responseId`（本仓循环构造的 assistant 多为 undefined ⇒ `null`） */
  readonly id: string | null;
  readonly time: { readonly created: null; readonly streamed: null; readonly completed: null };
  readonly agent: "review";
  readonly model: { readonly id: string; readonly providerID: string; readonly variant: null };
  readonly content: readonly ViewContentPart[];
  readonly snapshot: null;
  /** pi `stopReason` / `rawStopReason`（raw 缺省 ⇒ `null`） */
  readonly finish: string;
  readonly rawFinish: string | null;
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly reasoning: number;
    readonly cache: { readonly read: number; readonly write: number };
  };
  /** pi-ai `usage.cost.total`（单条 assistant 的总花费） */
  readonly cost: number;
}

export type ViewMessage = ViewSystemMessage | ViewUserMessage | ViewAssistantMessage;

/** OpenCode 风格定形投影（形状固定，无源字段 `null` 占位） */
export interface TranscriptView {
  readonly messages: readonly ViewMessage[];
}

/**
 * 定形投影（纯函数，零网络/零密钥）：把合成的 system + pi 原生 `AgentMessage`
 * 序列投成 OpenCode 风格的 `view.messages`。`toolResult` 不另立消息——按
 * `toolCall.id ↔ toolResult.toolCallId` 合并进前一条 assistant 的 `tool` part。
 */
export function buildView(
  systemPrompt: string,
  messages: readonly AgentMessage[],
): TranscriptView {
  const toolResults = collectToolResults(messages);
  const view: ViewMessage[] = [{ type: "system", text: systemPrompt }];
  for (const message of messages) {
    if (message.role === "user") {
      view.push({
        type: "user",
        id: null,
        time: { created: null },
        text: userMessageText(message),
        files: [],
        agents: [],
      });
    } else if (message.role === "assistant") {
      view.push(buildViewAssistant(message, toolResults));
    }
    // toolResult：已并入对应 assistant 的 tool part，不另立 view 消息
  }
  return { messages: view };
}

function collectToolResults(
  messages: readonly AgentMessage[],
): ReadonlyMap<string, ToolResultMessage<unknown>> {
  const byId = new Map<string, ToolResultMessage<unknown>>();
  for (const message of messages) {
    if (message.role === "toolResult") {
      byId.set(message.toolCallId, message);
    }
  }
  return byId;
}

function buildViewAssistant(
  message: AssistantMessage,
  toolResults: ReadonlyMap<string, ToolResultMessage<unknown>>,
): ViewAssistantMessage {
  const content: ViewContentPart[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      content.push({ type: "text", text: block.text });
    } else if (block.type === "thinking") {
      content.push({ type: "reasoning", text: block.thinking, time: { created: null, completed: null } });
    } else if (block.type === "toolCall") {
      content.push(buildViewToolPart(block, toolResults.get(block.id)));
    }
  }
  return {
    type: "assistant",
    id: message.responseId ?? null,
    time: { created: null, streamed: null, completed: null },
    agent: "review",
    model: { id: message.model, providerID: message.provider, variant: null },
    content,
    snapshot: null,
    finish: message.stopReason,
    rawFinish: message.rawStopReason ?? null,
    tokens: {
      input: message.usage.input,
      output: message.usage.output,
      reasoning: message.usage.reasoning ?? 0,
      cache: { read: message.usage.cacheRead, write: message.usage.cacheWrite },
    },
    cost: message.usage.cost.total,
  };
}

function buildViewToolPart(
  toolCall: ToolCall,
  result: ToolResultMessage<unknown> | undefined,
): ViewToolPart {
  const base = {
    type: "tool" as const,
    id: toolCall.id,
    name: toolCall.name,
    time: { created: null, ran: null, completed: null },
  };
  if (result === undefined) {
    return {
      ...base,
      state: { status: "pending", input: toolCall.arguments, content: null, metadata: null },
    };
  }
  if (result.isError) {
    return {
      ...base,
      state: {
        status: "error",
        input: toolCall.arguments,
        content: result.content,
        metadata: null,
        error: { message: textOf(result.content) },
      },
    };
  }
  return {
    ...base,
    state: { status: "completed", input: toolCall.arguments, content: result.content, metadata: null },
  };
}

function userMessageText(message: UserMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  return textOf(message.content);
}

/** 拼接分块里的文本内容（非文本块忽略；无源分块不投） */
function textOf(content: readonly (TextContent | ImageContent)[]): string {
  return content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export interface BuildTranscriptInput {
  /** 审计 `runId`（配对键；与转录命名时间不同源） */
  readonly runId: string;
  readonly caseId: string;
  readonly configId: ConfigId;
  /** 被检视仓库绝对路径（`location.directory`） */
  readonly repoPath: string;
  /** Zone A 系统提示词（合成 `messages[0]`） */
  readonly systemPrompt: string;
  readonly capture: AgentTranscriptCapture;
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly finishedAt: Date;
}

/**
 * 转录文件名 stem = `session-` + 首次模型请求时刻的 runId 形态
 * （时间戳写法 / caseId 净化与审计文件同源——单点复用 `buildRunId`）。
 */
export function transcriptStem(configId: ConfigId, caseId: string, firstRequestAt: Date): string {
  return `session-${buildRunId(firstRequestAt, configId, caseId)}`;
}

export function buildTranscript(input: BuildTranscriptInput): ReviewTranscript {
  const firstRequestAt = input.capture.firstRequestAt;
  const totals = sumAssistantUsage(input.capture.messages);
  return {
    info: {
      id: transcriptStem(input.configId, input.caseId, firstRequestAt),
      runId: input.runId,
      agent: "review",
      configId: input.configId,
      model: { id: input.capture.model.id, baseUrl: input.capture.model.baseUrl },
      tokens: totals.tokens,
      cost: totals.cost,
      outcome: transcriptOutcome(input.truncated, input.complete),
      time: {
        created: firstRequestAt.toISOString(),
        completed: input.finishedAt.toISOString(),
      },
      title: input.caseId,
      location: { directory: input.repoPath },
      perMessageTimestamps: "unavailable",
    },
    messages: [{ role: "system", content: input.systemPrompt }, ...input.capture.messages],
    view: buildView(input.systemPrompt, input.capture.messages),
  };
}

/** 落盘转录（`<dir>/<info.id>.json`，2 空格缩进 + 尾换行）；失败显式抛错 */
export async function writeTranscript(
  dir: string,
  content: ReviewTranscript,
): Promise<string> {
  const resolved = path.resolve(dir);
  const filePath = path.join(resolved, `${content.info.id}.json`);
  try {
    await mkdir(resolved, { recursive: true });
    await writeFile(filePath, `${JSON.stringify(content, null, 2)}\n`, "utf8");
    return filePath;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to persist review transcript ${content.info.id}: ${message}`, {
      cause: error,
    });
  }
}

function transcriptOutcome(truncated: boolean, complete: boolean): TranscriptOutcome {
  if (truncated) {
    return "truncated";
  }
  return complete ? "succeeded" : "failed";
}

interface UsageTotals {
  readonly tokens: TranscriptInfo["tokens"];
  readonly cost: TranscriptInfo["cost"];
}

/** 逐条 assistant `usage` 求和（缺 reason 报 0；口径与 messages 里的原样 usage 不同层） */
function sumAssistantUsage(messages: readonly AgentMessage[]): UsageTotals {
  let input = 0;
  let output = 0;
  let reasoning = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let costInput = 0;
  let costOutput = 0;
  let costCacheRead = 0;
  let costCacheWrite = 0;
  let costTotal = 0;
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    const usage: Usage = message.usage;
    input += usage.input;
    output += usage.output;
    reasoning += usage.reasoning ?? 0;
    cacheRead += usage.cacheRead;
    cacheWrite += usage.cacheWrite;
    costInput += usage.cost.input;
    costOutput += usage.cost.output;
    costCacheRead += usage.cost.cacheRead;
    costCacheWrite += usage.cost.cacheWrite;
    costTotal += usage.cost.total;
  }
  return {
    tokens: { input, output, reasoning, cache: { read: cacheRead, write: cacheWrite } },
    cost: {
      input: costInput,
      output: costOutput,
      cacheRead: costCacheRead,
      cacheWrite: costCacheWrite,
      total: costTotal,
    },
  };
}
