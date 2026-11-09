import type { FetchFunction } from "@earendil-works/pi-ai";

import type { LlmUsage } from "../contracts/llm.js";
import {
  classifyHttpFailure,
  classifyThrownFailure,
  DEFAULT_RETRY_POLICY,
  malformedFailure,
  runWithRetry,
  type RetryAttempt,
  type RetryFailure,
  type RetryPolicy,
} from "./llm-retry.js";
import { extractModelJson } from "./model-json.js";
import { extractChatUsage, type RawWireUsage } from "./wire-usage.js";

/**
 * 一次性模型调用缝（ADR-0045）：报文 / 总结 / 候选修复生成用的最小 chat completion。
 *
 * 不走 pi-ai 序列化缝（那是检视会话的七工具循环）也不走呈现引擎（那是可注入
 * 的核外模块）——这里是核外自有的一次性请求：system + user 两条消息、非流式、
 * 期望纯文本或 JSON 回包。与 `provider/gateway-probe.ts` 同款裸 fetch 形态
 * （OpenAI 兼容：`<baseUrl>/chat/completions`，baseUrl 需自带 `/v1`）。
 *
 * 重试（ADR-0051）：每次尝试独立 `AbortSignal.timeout(timeoutMs)`，只有传输
 * 失败 / 408 / 409 / 429 / 5xx / `x-should-retry: true` 才重试；4xx（除上述）、
 * 配额类 429、非 JSON / 缺 content 的确定性非法输出不重试。次数与退避来自
 * `limits.retry.oneShotAttempts` / `limits.retry.*`（经 `ReportLlmRuntime`）。
 *
 * 结构化输出（P1 步骤 4）：可选 `responseFormat: "json_object"`，只在**一次性**
 * 调用（tips / 候选修复）上使用；不碰检视会话的 wire 字节。供应商不支持时
 * （HTTP 400/422）自动**无 response_format 重试一次**，不让结构化选项把调用打死。
 *
 * 纪律：**绝不抛错**（失败收敛为 `{ok:false, reason}`，调用方决定降级）；
 * key 只进 Authorization 头，绝不进 reason / 任何留痕。
 */

export interface OneShotLlmInput {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly modelId: string;
  readonly system: string;
  readonly user: string;
  /** 单次尝试超时（每次重试重新计时） */
  readonly timeoutMs: number;
  /** 重试策略（缺省 = 全局 default：3 次尝试） */
  readonly retry?: RetryPolicy;
  /** 输出预算（生成 Markdown / JSON 的上限；缺席 = 服务端缺省） */
  readonly maxTokens?: number;
  /** 结构化输出请求（仅 `json_object`；供应商不支持时自动降级） */
  readonly responseFormat?: "json_object";
  /** 调用用途（进程级 usage 观测用；缺席 = 不分类） */
  readonly purpose?: OneShotPurpose;
  /** 传输层注入（测试确定性）；缺省 globalThis.fetch */
  readonly fetch?: FetchFunction;
}

/** 一次性调用的用途分类（只用于日志账本，不改变任何请求字节） */
export type OneShotPurpose = "tips" | "summary" | "candidate-repair";

/**
 * 一次成功的一次性调用样本（进程级 usage 观测）。
 *
 * - 只有「HTTP 2xx + 可读出文本」才记样本；失败尝试没有可用 usage；
 * - `usage` 缺席 = 响应未带 usage（调用次数仍计入，token 记 0）；
 * - 绝不携带 apiKey / 请求正文，只记模型 id、用途与用量。
 */
export interface OneShotCallSample {
  readonly modelId: string;
  readonly purpose?: OneShotPurpose;
  readonly usage?: LlmUsage;
}

/** 进程级 usage 观测缝（CLI 安装；缺省 null = 零行为变化） */
export type OneShotUsageSink = (sample: OneShotCallSample) => void;

let usageSink: OneShotUsageSink | null = null;

/** 安装 / 清除进程级 usage 观测器（只影响样本采集，不改变调用结果） */
export function setOneShotUsageSink(sink: OneShotUsageSink | null): void {
  usageSink = sink;
}

export type OneShotLlmResult =
  | { readonly ok: true; readonly text: string; readonly usage?: LlmUsage }
  | { readonly ok: false; readonly reason: string; readonly status?: number };

export async function completeOneShot(input: OneShotLlmInput): Promise<OneShotLlmResult> {
  const policy = input.retry ?? DEFAULT_RETRY_POLICY;
  const first = await runAttempts(input, policy);
  if (first.ok) {
    return toResult(first);
  }
  // 结构化输出不被供应商支持：去掉 response_format 再走一轮（同样有界）
  if (input.responseFormat !== undefined && (first.failure.status === 400 || first.failure.status === 422)) {
    const { responseFormat: _omit, ...withoutFormat } = input;
    const fallback = await runAttempts(withoutFormat, policy);
    return toResult(fallback, "after retrying without response_format");
  }
  return toResult(first);
}

/** 一次成功回包的文本 + 可选 usage（重试只保留最终成功的那次） */
interface OneShotCompletion {
  readonly text: string;
  readonly usage?: LlmUsage;
}

async function runAttempts(
  input: OneShotLlmInput,
  policy: RetryPolicy,
): Promise<Awaited<ReturnType<typeof runWithRetry<OneShotCompletion>>>> {
  return runWithRetry(policy, (): Promise<RetryAttempt<OneShotCompletion>> =>
    attemptOneShot(input, policy),
  );
}

function toResult(
  outcome: Awaited<ReturnType<typeof runWithRetry<OneShotCompletion>>>,
  suffix?: string,
): OneShotLlmResult {
  if (outcome.ok) {
    return {
      ok: true,
      text: outcome.value.text,
      ...(outcome.value.usage !== undefined ? { usage: outcome.value.usage } : {}),
    };
  }
  const attemptsSuffix = outcome.attempts > 1 ? ` (after ${String(outcome.attempts)} attempts)` : "";
  const fallbackSuffix = suffix !== undefined ? ` (${suffix})` : "";
  return {
    ok: false,
    reason: `${outcome.failure.reason}${attemptsSuffix}${fallbackSuffix}`,
    ...(outcome.failure.status !== undefined ? { status: outcome.failure.status } : {}),
  };
}

async function attemptOneShot(
  input: OneShotLlmInput,
  policy: RetryPolicy,
): Promise<RetryAttempt<OneShotCompletion>> {
  const fetch = input.fetch ?? globalThis.fetch;
  const body = JSON.stringify({
    model: input.modelId,
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ],
    ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
    ...(input.responseFormat !== undefined
      ? { response_format: { type: input.responseFormat } }
      : {}),
    stream: false,
  });
  let response: Response;
  try {
    response = await fetch(`${input.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${input.apiKey}` },
      body,
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch (error) {
    return { ok: false, failure: classifyThrownFailure(error, "request failed") };
  }
  if (response.status < 200 || response.status >= 300) {
    const detail = await response.text().catch(() => "");
    return {
      ok: false,
      failure: classifyHttpFailure(response.status, response.headers, detail, policy),
    };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(await response.text()) as unknown;
  } catch {
    return { ok: false, failure: malformedFailure("response is not valid JSON") };
  }
  const text = readContentText(payload);
  if (text === undefined) {
    return { ok: false, failure: malformedFailure("response has no message content text") };
  }
  const usage = wireUsageToLlmUsage(extractChatUsage(payload));
  emitOneShotSample(input, usage);
  return {
    ok: true,
    value: usage === undefined ? { text } : { text, usage },
  };
}

/**
 * 原始 usage → DSH 口径：`inputTokens` 是**未命中**输入（与 pi-ai
 * openai-completions 的折算一致：`max(0, prompt − cacheRead − cacheWrite)`）。
 * 响应未带 usage 时返回 undefined（调用次数仍由 sink 计入）。
 */
function wireUsageToLlmUsage(raw: RawWireUsage | null): LlmUsage | undefined {
  if (raw === null) {
    return undefined;
  }
  const cacheRead = raw.cacheReadTokens;
  const cacheWrite = raw.cacheWriteTokens ?? 0;
  return {
    inputTokens: Math.max(0, raw.promptTokens - cacheRead - cacheWrite),
    outputTokens: raw.completionTokens,
    cacheReadTokens: cacheRead,
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
  };
}

function emitOneShotSample(input: OneShotLlmInput, usage: LlmUsage | undefined): void {
  const sink = usageSink;
  if (sink === null) {
    return;
  }
  sink({
    modelId: input.modelId,
    ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
    ...(usage !== undefined ? { usage } : {}),
  });
}

/**
 * 从回包挑文本：`choices[0].message.content`（string 或分段数组取 text 拼接）。
 * 思维链（`reasoning_content`）不计入。
 */
function readContentText(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return undefined;
  }
  const message = (choices[0] as Record<string, unknown> | null)?.message;
  if (typeof message !== "object" || message === null) {
    return undefined;
  }
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as Record<string, unknown>).type === "text" &&
        typeof (block as Record<string, unknown>).text === "string"
      ) {
        parts.push((block as Record<string, unknown>).text as string);
      }
    }
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }
  return undefined;
}

/**
 * 宽松 JSON 提取（模型常把 JSON 包进 ```json 代码栅栏或前后白话）。
 * 与阶段解析共用 `shared/model-json`：整串 → 剥围栏 → 花括号配平扫描；
 * `preferKey` 让多对象场景取「含目标键的最后一个对象」（避开示例对象陷阱）。
 * 解析失败返回 null（调用方按「报文调用失败」处理）。
 */
export function extractJsonObject(
  text: string,
  options: { readonly preferKey?: string } = {},
): unknown | null {
  return extractModelJson(text, options).value ?? null;
}

/** 失败归因的类型别名（调用方需要时可直接 import） */
export type OneShotFailure = RetryFailure;
