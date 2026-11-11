import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

import { buildView } from "./transcript.js";
import type { TranscriptInfo, TranscriptOutcome, ViewMessage } from "./transcript.js";

/**
 * OpenCode 兼容会话导出（ADR-0072）：把 pi 原生转录**在 run 时**投成一份
 * 可被 `opencode session import` 直接接收、被任何 OpenCode 兼容 viewer 消费的
 * `{ info, messages }` 文档，另存于 `<runDir>/opencode/<sessionId>.json`。
 *
 * 与 `view`（ADR-0015 的定形投影，刻意保留 `null` 作「无源」信号）相反，这里
 * 是**归一化**：无源字段合成最小合法值或整键省略，**永不输出 `null`**。规则
 * 全部经过本机 OpenCode v2.2.0 `session import` 实测（见 ADR-0072 实施记录）。
 *
 * 纪律：
 * - `info` 恰好 OpenCode 10 键（子会话多 `parentID`），`runId` / `view` 等
 *   pi 扩展键全部剥除（多一个键 import 即 500）；
 * - 消息 id 必须 `msg_` 前缀且含非数字字符、跨会话唯一：确定性派生
 *   `msg_m` + sha1(`${sessionId}:${index}`) 前 19 hex；
 * - `finish` 归一为 `stop | tool-calls | error`（pi `toolUse` → `tool-calls`）；
 * - `outcome` 归一为 `succeeded | failed`（pi `truncated` → `succeeded`；
 *   OpenCode 枚举无 `truncated`，实测 `truncated`/`errored`/`aborted` → 400）；
 * - `model.variant` 恒 `"default"`；`info.model.providerID` 取首条 assistant 的
 *   provider，缺省回落 `baseUrl` host 映射，再兜底 `custom`；
 * - 工具 part `executed` 恒 `false`（OpenCode 导出语义：不是「没执行」，
 *   而是「导入时不重放」）；`state.status` 归一为 `completed | error`（pi 的
 *   `pending` → `completed`）；`state.error` 补 `type: "tool.execution"`。
 */

/** OpenCode 会话文档（`session import` / `session export` 的同形真源） */
export interface OpenCodeSession {
  readonly info: OpenCodeInfo;
  readonly messages: readonly OpenCodeMessage[];
}

export interface OpenCodeInfo {
  readonly id: string;
  readonly projectID: string;
  readonly agent: string;
  readonly model: { readonly id: string; readonly providerID: string; readonly variant: string };
  readonly cost: number;
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly reasoning: number;
    readonly cache: { readonly read: number; readonly write: number };
  };
  readonly outcome: "succeeded" | "failed";
  readonly time: { readonly created: number; readonly updated: number };
  readonly title: string;
  readonly location: { readonly directory: string };
  readonly parentID?: string;
}

export interface OpenCodeSystemMessage {
  readonly id: string;
  readonly type: "system";
  readonly text: string;
  readonly time: { readonly created: number };
}

export interface OpenCodeUserMessage {
  readonly id: string;
  readonly type: "user";
  readonly text: string;
  readonly files: readonly never[];
  readonly agents: readonly never[];
  readonly time: { readonly created: number };
}

export interface OpenCodeAssistantMessage {
  readonly id: string;
  readonly type: "assistant";
  readonly agent: string;
  readonly model: { readonly id: string; readonly providerID: string; readonly variant: string };
  readonly content: readonly OpenCodePart[];
  readonly finish: "stop" | "tool-calls" | "error";
  readonly rawFinish?: string;
  readonly cost: number;
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly reasoning: number;
    readonly cache: { readonly read: number; readonly write: number };
  };
  readonly time: { readonly created: number; readonly streamed: number; readonly completed: number };
}

export type OpenCodeMessage =
  | OpenCodeSystemMessage
  | OpenCodeUserMessage
  | OpenCodeAssistantMessage;

export type OpenCodePart = OpenCodeTextPart | OpenCodeReasoningPart | OpenCodeToolPart;

export interface OpenCodeTextPart {
  readonly type: "text";
  readonly text: string;
}

export interface OpenCodeReasoningPart {
  readonly type: "reasoning";
  readonly text: string;
  readonly time: { readonly created: number; readonly completed: number };
}

export interface OpenCodeToolPart {
  readonly type: "tool";
  readonly id: string;
  readonly name: string;
  readonly executed: false;
  readonly state: {
    readonly status: "completed" | "error";
    readonly input: Record<string, unknown>;
    readonly content: readonly { readonly type: "text"; readonly text: string }[];
    readonly metadata: Record<string, unknown>;
    readonly error?: { readonly type: string; readonly message: string };
  };
  readonly time: { readonly created: number; readonly ran: number; readonly completed: number };
}

/** 父会话末尾要追加的子会话 `subagent` 工具 part 原料 */
export interface OpenCodeSubagentRef {
  readonly sessionID: string;
  readonly description: string;
}

export interface BuildOpenCodeSessionInput {
  /** 原生转录 `info`（id / 模型 / 用量 / 时刻 / 标题 / 位置 / 结局） */
  readonly info: TranscriptInfo;
  /** Zone A 系统提示词（`buildView` 的 system 原料） */
  readonly systemPrompt: string;
  /** 原生 `capture.messages`（不含合成 system） */
  readonly messages: readonly AgentMessage[];
  /** 子会话：父会话 id（顶层会话缺席） */
  readonly parentID?: string;
  /**
   * 子会话：种子消息条数（fork 切点）。只写增量 = 丢弃前 `seedCount` 条，
   * 使子文件仅含 fork 之后的新消息（与 OpenCode 真实子会话语义一致）。
   */
  readonly seedCount?: number;
  /** 父会话：追加到末条 assistant 的 `subagent` 工具 part（指向各子会话） */
  readonly subagents?: readonly OpenCodeSubagentRef[];
}

/** OpenCode 兼容文件所在子目录（相对 runDir；与原生转录隔离，避免文件名误匹配） */
export const OPENCODE_DIR = "opencode";

/** 兼容文件名（`opencode/<sessionId>.json`） */
export function openCodeSessionFile(runDir: string, sessionId: string): string {
  return path.join(path.resolve(runDir), OPENCODE_DIR, `${sessionId}.json`);
}

/**
 * 落盘 OpenCode 兼容会话（`<runDir>/opencode/<info.id>.json`，2 空格缩进 +
 * 尾换行）。返回绝对路径；失败显式抛错（与 `writeTranscript` 同纪律）。
 */
export async function writeOpenCodeSession(
  runDir: string,
  content: OpenCodeSession,
): Promise<string> {
  const filePath = openCodeSessionFile(runDir, content.info.id);
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(content, null, 2)}\n`, "utf8");
    return filePath;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to persist opencode session ${content.info.id}: ${message}`, {
      cause: error,
    });
  }
}

/** 消息 id：`msg_` + 保证含非数字字符（`m`）+ 确定性 hash 前 19 hex */
function openCodeMessageId(sessionId: string, index: number): string {
  const digest = createHash("sha1").update(`${sessionId}:${index}`).digest("hex");
  return `msg_m${digest.slice(0, 19)}`;
}

/** `baseUrl` host → provider slug（认不出回 `custom`；OpenCode 合法 provider id） */
export function providerIdFromBaseUrl(baseUrl: string): string {
  let host = "";
  try {
    host = new URL(baseUrl).host.toLowerCase();
  } catch {
    host = baseUrl.toLowerCase();
  }
  for (const slug of ["deepseek", "openai", "anthropic", "huawei", "modelarts", "alibaba", "zhipu", "moonshot"]) {
    if (host.includes(slug)) {
      return slug;
    }
  }
  return "custom";
}

/**
 * 归一化投影（纯函数，零网络/零密钥）。从原生 `info` + 原生 `messages` 出发，
 * 内部经 `buildView` 定形后逐条填齐 OpenCode 事件流；子会话按 `seedCount` 只留
 * 增量；父会话按 `subagents` 在末条 assistant 追加可跳转的 `subagent` part。
 */
export function buildOpenCodeSession(input: BuildOpenCodeSessionInput): OpenCodeSession {
  const sessionId = input.info.id;
  const sliceFrom = input.seedCount ?? 0;
  const view = buildView(input.systemPrompt, input.messages.slice(sliceFrom)).messages;
  const providerID = resolveProviderId(input);
  const messages = normalizeMessages(sessionId, view, providerID, input.info.time.created);
  if (input.subagents !== undefined && input.subagents.length > 0) {
    appendSubagentParts(messages, input.subagents);
  }
  return {
    info: {
      id: sessionId,
      projectID: projectIdOf(input.info.location.directory),
      agent: input.info.agent,
      model: { id: input.info.model.id, providerID, variant: "default" },
      cost: input.info.cost.total,
      tokens: input.info.tokens,
      outcome: normalizeOutcome(input.info.outcome),
      time: { created: input.info.time.created, updated: input.info.time.updated },
      title: input.info.title,
      location: { directory: input.info.location.directory },
      ...(input.parentID !== undefined ? { parentID: input.parentID } : {}),
    },
    messages,
  };
}

/** 会话级 provider：首条 assistant 的 provider → baseUrl 映射 → `custom` */
function resolveProviderId(input: BuildOpenCodeSessionInput): string {
  const first = input.messages.find(
    (message): message is Extract<AgentMessage, { role: "assistant" }> =>
      message.role === "assistant",
  );
  if (first !== undefined && first.provider.length > 0) {
    return first.provider;
  }
  return providerIdFromBaseUrl(input.info.model.baseUrl);
}

/** projectID = 被检视仓库绝对路径的 sha1（与 OpenCode 按 worktree 分组同语义） */
function projectIdOf(directory: string): string {
  return createHash("sha1").update(directory).digest("hex");
}

/**
 * `info.outcome` 归一：OpenCode 枚举只有 `succeeded | failed`（实测 `truncated` /
 * `errored` / `aborted` 一律 400）。pi 的 `truncated` 是「诚实截断 = 完成的一种」
 * （exit 0，非失败）⇒ 归 `succeeded`；截断信号本就由 assistant `finish` / 原生
 * `view` 里的 `truncated` 留痕携带。
 */
function normalizeOutcome(outcome: TranscriptOutcome): "succeeded" | "failed" {
  return outcome === "failed" ? "failed" : "succeeded";
}

function normalizeMessages(
  sessionId: string,
  view: readonly ViewMessage[],
  providerID: string,
  systemCreated: number,
): OpenCodeMessage[] {
  const out: OpenCodeMessage[] = [];
  for (const message of view) {
    const id = openCodeMessageId(sessionId, out.length);
    out.push(normalizeMessage(message, id, providerID, systemCreated));
  }
  return out;
}

function normalizeMessage(
  message: ViewMessage,
  id: string,
  providerID: string,
  systemCreated: number,
): OpenCodeMessage {
  if (message.type === "system") {
    return { id, type: "system", text: message.text, time: { created: systemCreated } };
  }
  if (message.type === "user") {
    return {
      id,
      type: "user",
      text: message.text,
      files: [],
      agents: [],
      time: { created: message.time.created },
    };
  }
  return normalizeAssistant(message, id, providerID);
}

function normalizeAssistant(
  message: Extract<ViewMessage, { type: "assistant" }>,
  id: string,
  providerID: string,
): OpenCodeAssistantMessage {
  const created = message.time.created;
  const finish = normalizeFinish(message.finish);
  const content = message.content.map((part) => normalizePart(part, created));
  return {
    id,
    type: "assistant",
    agent: message.agent,
    model: {
      id: message.model.id,
      providerID: message.model.providerID ?? providerID,
      variant: "default",
    },
    content,
    finish,
    ...(message.rawFinish !== null && message.rawFinish !== undefined && message.rawFinish !== ""
      ? { rawFinish: message.rawFinish }
      : {}),
    cost: message.cost,
    tokens: message.tokens,
    time: { created, streamed: created + 1, completed: created + 2 },
  };
}

function normalizeFinish(finish: string): "stop" | "tool-calls" | "error" {
  if (finish === "toolUse") {
    return "tool-calls";
  }
  if (finish === "stop" || finish === "error") {
    return finish;
  }
  // 未知 stopReason（如 length）：归一为 `stop` 保 import-clean，原始值仍走 rawFinish
  return "stop";
}

function normalizePart(
  part: Extract<ViewMessage, { type: "assistant" }>["content"][number],
  assistantCreated: number,
): OpenCodePart {
  if (part.type === "text") {
    return { type: "text", text: part.text };
  }
  if (part.type === "reasoning") {
    return {
      type: "reasoning",
      text: part.text,
      time: { created: assistantCreated, completed: assistantCreated + 1 },
    };
  }
  // tool
  const status = part.state.status === "pending" ? "completed" : part.state.status;
  const created = assistantCreated + 1;
  const ran = created + 1;
  const completed = part.time.completed ?? ran + 1;
  return {
    type: "tool",
    id: part.id,
    name: part.name,
    executed: false,
    state: {
      status,
      input: part.state.input,
      content: (part.state.content ?? []).map((block) => ({
        type: "text" as const,
        text: textOfBlock(block),
      })),
      metadata: {},
      ...(status === "error"
        ? { error: { type: "tool.execution", message: textOfBlockList(part.state.content ?? []) } }
        : {}),
    },
    time: { created, ran, completed: Math.max(ran, completed) },
  };
}

function textOfBlock(block: TextContent | ImageContent): string {
  return block.type === "text" ? block.text : "";
}

function textOfBlockList(blocks: readonly (TextContent | ImageContent)[]): string {
  return blocks.filter((block): block is TextContent => block.type === "text").map((block) => block.text).join("\n");
}

/** 父会话：把子会话引用追加到末条 assistant 的 `content`（viewer 据此渲染跳转） */
function appendSubagentParts(messages: OpenCodeMessage[], subagents: readonly OpenCodeSubagentRef[]): void {
  let targetIndex = -1;
  let target: OpenCodeAssistantMessage | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && message.type === "assistant") {
      target = message;
      targetIndex = index;
      break;
    }
  }
  if (target === undefined) {
    return;
  }
  const base = target.time.completed;
  const parts: OpenCodeToolPart[] = subagents.map((subagent, index) => {
    const created = base + 1 + index * 3;
    return {
      type: "tool",
      id: `call_subagent_${createHash("sha1").update(subagent.sessionID).digest("hex").slice(0, 16)}`,
      name: "subagent",
      executed: false,
      state: {
        status: "completed",
        input: { description: subagent.description, prompt: subagent.description, subagent_type: "review" },
        content: [{ type: "text", text: `<subagent sessionID="${subagent.sessionID}" state="completed">` }],
        metadata: { sessionID: subagent.sessionID },
      },
      time: { created, ran: created + 1, completed: created + 2 },
    };
  });
  // `content` 是 readonly 投影，这里重建一份（同一份文档内，不污染 `view`）
  const withParts = { ...target, content: [...target.content, ...parts] };
  messages[targetIndex] = withParts;
}
