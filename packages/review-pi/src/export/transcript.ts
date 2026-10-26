import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { buildRunId } from "../audit/audit-writer.js";
import type { ConfigId } from "../contracts/config.js";

// 检视转录（ADR-0013 / CONTEXT.md「检视转录」）：把一次检视中**进入 pi Agent
// 的全部交互**留档为 `{ info, messages }`（Step A；OpenCode 风格的 `view`
// 定形投影属 Step B）。
//
// 纪律：
// - `messages` = `agent.state.messages` **原样**（省键真源：缺键即"源里没有"）
//   + 合成的 `messages[0]` system（Zone A 系统提示词不在 state.messages 里，
//   而是 `state.systemPrompt` 独立字段）；
// - `info` = **精确键表**（省键纪律：无 `kind`/`version`/`projectID`/
//   `info.time.durationMs`/`info.systemPrompt`——最后一项已在 messages[0]）；
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

/** 检视转录文档（Step A：`{ info, messages }`；Step B 追加 `view`） */
export interface ReviewTranscript {
  readonly info: TranscriptInfo;
  readonly messages: readonly TranscriptMessage[];
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
