import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import type { TaskCallTrace } from "../contracts/mcp-task.js";
import type { OneShotLifecycleEvent } from "../shared/one-shot-llm.js";
import {
  OPENCODE_DIR,
  writeOpenCodeSession,
  type OpenCodeAssistantMessage,
  type OpenCodeInfo,
  type OpenCodeMessage,
  type OpenCodeSession,
  type OpenCodeSubagentRef,
  type OpenCodeToolPart,
} from "./opencode-compat.js";

/**
 * 会话生命周期留痕（ADR-0073）：把「startTask → 检视对话 → 候选修复 → tips →
 * 总结 → MCP 上报 → endTask」拼成一条 OpenCode 时间线。外部步骤（one-shot 三目的
 * + MCP 四工具）在进程级按发生顺序收集成 `LifecycleEvent[]`，末尾由
 * `writeLifecycleSessions` 追加进主会话（单遍）或另写聚合 lifecycle 会话（分片）。
 *
 * 纪律：
 * - 只写 OpenCode 兼容版，原生 `{info,messages,view}` 一字不动；
 * - 生命周期消息 id 用独立盐 `:lc:<seq>`（`msg_m` + sha1 前 19 hex），与 agent
 *   对话的 `:index` 盐不碰撞、确定性；
 * - 失败照记：one-shot 失败 → assistant `finish:"error"`；MCP tool 失败 →
 *   tool part `state.status="error"`；`endTask` 缺席即「未收尾」。
 */

export interface LifecycleOneShot {
  readonly kind: "one-shot";
  readonly seq: number;
  readonly event: OneShotLifecycleEvent;
}

export interface LifecycleTask {
  readonly kind: "task";
  readonly seq: number;
  readonly trace: TaskCallTrace;
}

export type LifecycleEvent = LifecycleOneShot | LifecycleTask;

/** 进程级有序收集器（全程串行 await，seq 单调递增 = 发生顺序） */
export class LifecycleCollector {
  private readonly events: LifecycleEvent[] = [];

  private seq = 0;

  recordOneShot(event: OneShotLifecycleEvent): void {
    this.events.push({ kind: "one-shot", seq: this.seq, event });
    this.seq += 1;
  }

  recordTask(trace: TaskCallTrace): void {
    this.events.push({ kind: "task", seq: this.seq, trace });
    this.seq += 1;
  }

  snapshot(): readonly LifecycleEvent[] {
    return [...this.events];
  }
}

export interface BuildLifecycleSessionInput {
  readonly info: OpenCodeInfo;
  /** agent 对话消息（单遍 = 主会话 messages；分片聚合 = []） */
  readonly baseMessages: readonly OpenCodeMessage[];
  readonly events: readonly LifecycleEvent[];
  /** 子会话引用（分片聚合 = 各 shard 主会话；单遍 = []） */
  readonly subagents: readonly OpenCodeSubagentRef[];
}

/** 纯组装：leading(system) + agent 对话 + 外部步骤 + 子会话引用 + trailing(system) */
export function buildLifecycleSession(input: BuildLifecycleSessionInput): OpenCodeSession {
  const leading: OpenCodeMessage[] = [];
  const middle: OpenCodeMessage[] = [];
  const trailing: OpenCodeMessage[] = [];
  let idSeq = 0;
  const nextId = (): string => lifecycleMessageId(input.info.id, idSeq++);
  for (const item of input.events) {
    if (item.kind === "one-shot") {
      middle.push(oneShotUser(input.info, nextId(), item.event));
      middle.push(oneShotAssistant(input.info, nextId(), item.event));
    } else if (item.trace.tool === "startTask") {
      leading.push(taskSystem(input.info, nextId(), item.trace, "startTask"));
    } else if (item.trace.tool === "endTask") {
      trailing.push(taskSystem(input.info, nextId(), item.trace, "endTask"));
    } else {
      middle.push(taskToolMessage(input.info, nextId(), item.trace));
    }
  }
  const messages: OpenCodeMessage[] = [...leading, ...input.baseMessages, ...middle];
  if (input.subagents.length > 0) {
    messages.push(subagentCarrier(input.info, nextId(), input.subagents));
  }
  messages.push(...trailing);
  return { info: input.info, messages };
}

/**
 * 落盘全生命周期会话（由 `main.ts` 在收尾调用）：
 * - 单遍（`transcriptPaths.length === 1`）：读已写的主会话兼容版，追加生命周期
 *   步骤后原地覆盖 `opencode/session-<runId>.json`；
 * - 分片（>1）：另写聚合 `opencode/lifecycle-<runId>.json`（顶层，subagent part
 *   指向各 shard 主会话），并把各 shard 主会话的 `info.parentID` 重写指向它。
 */
export async function writeLifecycleSessions(input: {
  readonly runsDir: string;
  readonly runId: string;
  /** 主转录原生路径（单遍 = 1 条；分片 = 各 shard，按片序） */
  readonly transcriptPaths: readonly string[];
  readonly events: readonly LifecycleEvent[];
  readonly title: string;
  readonly finishedAt: number;
}): Promise<void> {
  if (input.transcriptPaths.length === 0) {
    return;
  }
  if (input.transcriptPaths.length === 1) {
    const baseFile = compatFileOf(input.transcriptPaths[0]!);
    const base = await readOpenCodeSession(baseFile);
    const wrapped = buildLifecycleSession({
      info: base.info,
      baseMessages: base.messages,
      events: input.events,
      subagents: [],
    });
    await writeOpenCodeSession(input.runsDir, wrapped);
    return;
  }

  // 分片：聚合 lifecycle 会话 + 各 shard 主会话挂 parentID
  const shardMains = await Promise.all(
    input.transcriptPaths.map((file) => readOpenCodeSession(compatFileOf(file))),
  );
  // OpenCode 会话 id 必须 `ses_` / `session-` 前缀（实测其它前缀 import → 400），
  // 故聚合生命周期会话用 `session-<runId>-lifecycle`（与各 shard 主会话同族、不撞名）。
  const aggregateId = `session-${input.runId}-lifecycle`;
  const first = shardMains[0]?.info;
  const info: OpenCodeInfo = {
    id: aggregateId,
    projectID: first?.projectID ?? "review-pi",
    agent: first?.agent ?? "review",
    model: first?.model ?? { id: "review", providerID: "custom", variant: "default" },
    cost: sum(shardMains.map((session) => session.info.cost)),
    tokens: sumTokens(shardMains.map((session) => session.info.tokens)),
    outcome: "succeeded",
    time: { created: first?.time.created ?? input.finishedAt, updated: input.finishedAt },
    title: input.title,
    location: { directory: first?.location.directory ?? "" },
  };
  const aggregate = buildLifecycleSession({
    info,
    baseMessages: [],
    events: input.events,
    subagents: shardMains.map((session, index) => ({
      sessionID: session.info.id,
      description: `shard s${String(index + 1).padStart(2, "0")} (${session.info.id})`,
    })),
  });
  await writeOpenCodeSession(input.runsDir, aggregate);

  // 各 shard 主会话成为聚合 lifecycle 会话的子会话（重写 parentID 回原片目录）
  for (const [index, session] of shardMains.entries()) {
    const nativePath = input.transcriptPaths[index];
    if (nativePath === undefined) {
      continue;
    }
    await writeOpenCodeSession(dirname(resolve(nativePath)), {
      info: { ...session.info, parentID: aggregateId },
      messages: session.messages,
    });
  }
}

/** 原生转录路径 → 同目录 `opencode/` 兼容版路径 */
function compatFileOf(nativePath: string): string {
  const resolved = resolve(nativePath);
  return join(dirname(resolved), OPENCODE_DIR, basename(resolved));
}

async function readOpenCodeSession(file: string): Promise<OpenCodeSession> {
  const raw = await readFile(file, "utf8");
  return JSON.parse(raw) as OpenCodeSession;
}

/** 生命周期消息 id：`msg_m` + sha1(`${sessionId}:lc:${seq}`) 前 19 hex（独立盐不撞 agent 对话 id） */
function lifecycleMessageId(sessionId: string, seq: number): string {
  const digest = createHash("sha1").update(`${sessionId}:lc:${seq}`).digest("hex");
  return `msg_m${digest.slice(0, 19)}`;
}

function oneShotUser(info: OpenCodeInfo, id: string, event: OneShotLifecycleEvent): OpenCodeMessage {
  const label = event.purpose ?? "one-shot";
  return {
    id,
    type: "user",
    text: `[${label}]\n\n${event.system}\n\n=====\n\n${event.user}`,
    files: [],
    agents: [],
    time: { created: event.startedAt },
  };
}

function oneShotAssistant(info: OpenCodeInfo, id: string, event: OneShotLifecycleEvent): OpenCodeMessage {
  const created = event.startedAt + 1;
  const ok = event.response !== undefined;
  const withUsage = event.usage !== undefined;
  return {
    id,
    type: "assistant",
    agent: info.agent,
    model: info.model,
    content: [{ type: "text", text: event.response ?? event.error ?? "" }],
    finish: ok ? "stop" : "error",
    cost: 0,
    tokens: withUsage
      ? {
          input: event.usage.inputTokens,
          output: event.usage.outputTokens,
          reasoning: 0,
          cache: {
            read: event.usage.cacheReadTokens ?? 0,
            write: event.usage.cacheWriteTokens ?? 0,
          },
        }
      : { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created, streamed: created + 1, completed: created + 2 },
  };
}

function taskSystem(
  info: OpenCodeInfo,
  id: string,
  trace: TaskCallTrace,
  label: string,
): OpenCodeMessage {
  return {
    id,
    type: "system",
    text: `[task] ${label}${summaryOf(trace.arguments)}`,
    time: { created: trace.startedAt },
  };
}

function taskToolMessage(info: OpenCodeInfo, id: string, trace: TaskCallTrace): OpenCodeMessage {
  const created = trace.startedAt;
  const ended = created + Math.max(1, trace.durationMs);
  const responseText = trace.responseText ?? "";
  const part: OpenCodeToolPart = {
    type: "tool",
    id: `call_${createHash("sha1").update(`${info.id}:${trace.tool}:${trace.startedAt}`).digest("hex").slice(0, 16)}`,
    name: trace.tool,
    executed: false,
    state: {
      status: trace.ok ? "completed" : "error",
      input: argumentRecord(trace.arguments),
      content: [{ type: "text", text: responseText }],
      metadata: {},
      ...(trace.ok
        ? {}
        : { error: { type: "tool.execution", message: trace.reason ?? "unknown error" } }),
    },
    time: { created, ran: created + 1, completed: ended },
  };
  const assistant: OpenCodeAssistantMessage = {
    id,
    type: "assistant",
    agent: info.agent,
    model: info.model,
    content: [part],
    finish: trace.ok ? "stop" : "error",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created, streamed: created + 1, completed: ended },
  };
  return assistant;
}

/** 父会话末尾的子会话引用 carrier（一条合成 assistant + 逐个子会话 tool part） */
function subagentCarrier(
  info: OpenCodeInfo,
  id: string,
  subagents: readonly OpenCodeSubagentRef[],
): OpenCodeMessage {
  const created = info.time.updated;
  const parts: OpenCodeToolPart[] = subagents.map((subagent, index) => {
    const partCreated = created + 1 + index * 3;
    return {
      type: "tool",
      id: `call_subagent_${createHash("sha1").update(subagent.sessionID).digest("hex").slice(0, 16)}`,
      name: "subagent",
      executed: false,
      state: {
        status: "completed",
        input: { description: subagent.description, subagent_type: "review" },
        content: [{ type: "text", text: `<subagent sessionID="${subagent.sessionID}" state="completed">` }],
        metadata: { sessionID: subagent.sessionID },
      },
      time: { created: partCreated, ran: partCreated + 1, completed: partCreated + 2 },
    };
  });
  return {
    id,
    type: "assistant",
    agent: info.agent,
    model: info.model,
    content: parts,
    finish: "stop",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created, streamed: created + 1, completed: created + 2 },
  };
}

/** MCP tool 参数 → `Record<string,unknown>`（非对象兜成 `{value}`） */
function argumentRecord(args: unknown): Record<string, unknown> {
  if (typeof args === "object" && args !== null && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return { value: args };
}

/** startTask/endTask 的 system 文本摘要（arguments 很小，原样拼 JSON） */
function summaryOf(args: unknown): string {
  if (args === undefined || args === null) {
    return "";
  }
  try {
    const text = JSON.stringify(args);
    return text === undefined ? "" : ` ${text}`;
  } catch {
    return "";
  }
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function sumTokens(
  values: readonly OpenCodeInfo["tokens"][],
): OpenCodeInfo["tokens"] {
  let input = 0;
  let output = 0;
  let reasoning = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const tokens of values) {
    input += tokens.input;
    output += tokens.output;
    reasoning += tokens.reasoning;
    cacheRead += tokens.cache.read;
    cacheWrite += tokens.cache.write;
  }
  return { input, output, reasoning, cache: { read: cacheRead, write: cacheWrite } };
}