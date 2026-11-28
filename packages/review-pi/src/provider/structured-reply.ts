// Structured Output 统一入口（迁移第 1 步）。
//
// 目标：把「调用模型 → 取文本 → 解析 JSON → 校验 schema → 解析失败修复」收口到
// 一处，调用方只声明 contract 与失败策略，不再各自复制 parse / retry。
//
// 分层：
// 1. `completeOneShot` 负责传输 / 空回包 / 截断重试（已有能力，不重复实现）；
// 2. `StructuredCall.parse` 负责语法提取 + schema / 逐 item 校验；
// 3. 本模块负责**有界解析失败修复**（重新发一次，只带原请求 + 畸形回包 + 错误）；
// 4. 失败结果显式返回，调用方按用途决定 fail-open / fail-closed / 保留缺口。
//
// 纪律：
// - 只做 JSON 契约层，不改变任何业务语义；
// - 修复次数由 contract 显式限制（缺省 1 次），绝不无限重试；
// - truncated 不在本层修复：上游 `completeOneShot` 已做一次预算翻倍重发；
// - usage 由 `completeOneShot` 写账；本模块只把各次尝试的 usage 汇总返回。

import type { FetchFunction } from "@earendil-works/pi-ai";

import type { LlmUsage } from "../contracts/llm.js";
import type {
  StructuredFailure,
  StructuredParse,
  StructuredResponseFormat,
} from "../contracts/structured.js";
import type { UsageScope } from "../observability/usage-ledger.js";
import type { RetryPolicy } from "../shared/llm-retry.js";
import { addUsage } from "./usage-map.js";
import { completeOneShot, type OneShotPurpose } from "./one-shot-llm.js";

export type {
  StructuredFailure,
  StructuredFailureKind,
  StructuredParse,
  StructuredResponseFormat,
} from "../contracts/structured.js";

/** 单个 JSON 契约：解析 + 可选修复提示 */
export interface StructuredCall<T> {
  /** 语法提取 + schema / item 校验；失败返回分级原因 */
  readonly parse: (text: string) => StructuredParse<T>;
  /**
   * 解析失败后重新请求时使用的 user 消息。缺省 = 原请求 + 错误 + 畸形回包。
   * 需要保留原 hunk / 候选上下文时，由 contract 自己拼。
   */
  readonly repairUser?: (raw: string, failure: StructuredFailure) => string;
  /** 解析失败后重新请求时使用的 system 消息；缺省沿用原 system */
  readonly repairSystem?: string;
  /** 解析失败后的修复请求次数；缺省 1，0 = 不修复 */
  readonly maxRepairAttempts?: number;
}

export interface StructuredLlm {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly modelId: string;
  readonly timeoutMs: number;
  readonly retry?: RetryPolicy;
  readonly fetch?: FetchFunction;
  readonly usageScope?: UsageScope;
}

export interface StructuredInvokeInput<T> {
  readonly llm: StructuredLlm;
  readonly purpose: OneShotPurpose;
  readonly system: string;
  readonly user: string;
  readonly responseFormat?: StructuredResponseFormat;
  readonly maxTokens?: number;
  readonly retryOnTruncation?: boolean;
  readonly call: StructuredCall<T>;
}

export type StructuredOutcome<T> =
  | {
      readonly ok: true;
      readonly value: T;
      /** 逻辑调用次数（初始 1 + 修复次数；不含传输层内部重试） */
      readonly attempts: number;
      readonly recoveries: readonly "repair"[];
      readonly usage?: LlmUsage;
    }
  | {
      readonly ok: false;
      readonly failure: StructuredFailure;
      readonly attempts: number;
      readonly recoveries: readonly "repair"[];
      readonly usage?: LlmUsage;
    };

/** 修复提示里回放畸形回包的最大字符数，避免把一次坏输出放大成上下文炸弹 */
const MAX_REPAIR_RAW_CHARS = 32_000;

export async function invokeStructured<T>(
  input: StructuredInvokeInput<T>,
): Promise<StructuredOutcome<T>> {
  const maxRepairAttempts = Math.max(0, input.call.maxRepairAttempts ?? 1);
  const recoveries: "repair"[] = [];
  let attempts = 0;
  let usage: LlmUsage | undefined;
  let user = input.user;
  let system = input.system;
  let lastRaw = "";

  for (let attempt = 0; attempt <= maxRepairAttempts; attempt += 1) {
    attempts += 1;
    const completion = await completeOneShot({
      baseUrl: input.llm.baseUrl,
      apiKey: input.llm.apiKey,
      modelId: input.llm.modelId,
      system,
      user,
      timeoutMs: input.llm.timeoutMs,
      ...(input.llm.retry !== undefined ? { retry: input.llm.retry } : {}),
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
      ...(input.responseFormat !== undefined ? { responseFormat: input.responseFormat } : {}),
      ...(input.retryOnTruncation !== undefined
        ? { retryOnTruncation: input.retryOnTruncation }
        : {}),
      purpose: input.purpose,
      ...(input.llm.usageScope !== undefined ? { usageScope: input.llm.usageScope } : {}),
      ...(input.llm.fetch !== undefined ? { fetch: input.llm.fetch } : {}),
    });
    if (!completion.ok) {
      return {
        ok: false,
        failure: { kind: "transport", note: completion.reason },
        attempts,
        recoveries,
        ...(usage !== undefined ? { usage } : {}),
      };
    }
    if (completion.usage !== undefined) {
      usage = usage === undefined ? completion.usage : addUsage(usage, completion.usage);
    }

    lastRaw = completion.text;
    const parsed = input.call.parse(completion.text);
    if (parsed.ok) {
      return {
        ok: true,
        value: parsed.value,
        attempts,
        recoveries,
        ...(usage !== undefined ? { usage } : {}),
      };
    }
    const failure = parsed.failure;
    if (attempt === maxRepairAttempts || failure.kind === "truncated") {
      return {
        ok: false,
        failure: { ...failure, raw: lastRaw },
        attempts,
        recoveries,
        ...(usage !== undefined ? { usage } : {}),
      };
    }

    recoveries.push("repair");
    system = input.call.repairSystem ?? input.system;
    user = input.call.repairUser?.(lastRaw, failure) ?? defaultRepairUser(input.user, lastRaw, failure);
  }

  // 循环上界保证不可达；保留显式失败，避免类型上出现 undefined 返回。
  return {
    ok: false,
    failure: { kind: "schema", note: "structured reply exhausted", raw: lastRaw },
    attempts,
    recoveries,
    ...(usage !== undefined ? { usage } : {}),
  };
}

function defaultRepairUser(originalUser: string, raw: string, failure: StructuredFailure): string {
  return [
    originalUser,
    "",
    `上一次回复无法解析为要求的 JSON（${failure.note}）。`,
    "请只重新输出完整 JSON，不要解释，不要 Markdown 围栏。",
    "",
    "上一次回复：",
    raw.slice(0, MAX_REPAIR_RAW_CHARS),
  ].join("\n");
}
