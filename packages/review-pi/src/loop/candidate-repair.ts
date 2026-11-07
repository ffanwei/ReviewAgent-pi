import type { FetchFunction } from "@earendil-works/pi-ai";

import type { RetryPolicy } from "../shared/llm-retry.js";
import { completeOneShot, extractJsonObject } from "../shared/one-shot-llm.js";

/**
 * 有界一次性候选修复（P1 步骤 3）：只针对**确定性归一化后仍 schema 非法**的
 * 少数候选，发起至多一次模型调用，请模型把信封 / 格式字段补成合法形态。
 *
 * 边界纪律：
 * - **不造证据**：提示词明确禁止编造 `evidence` / `line` / `file` / 代码片段；
 *   模型只能从候选自身的文本里整理，不能读取仓库（本调用没有工具）；
 * - **不改 id**：id 是 Phase 6 裁决的对齐键，改动会让裁决错配；
 * - **调用次数有界**：由 loop 侧控制（每轮最多一次、整个 run 有上限）；
 * - **绝不抛错**：调用失败 / 解析失败一律返回空数组，原候选继续走拦截链。
 */

/** 修复调用所需的接入点与策略（由 run 层从配置解析后传入） */
export interface CandidateRepairLlm {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly modelId: string;
  readonly timeoutMs: number;
  readonly retry?: RetryPolicy;
  readonly fetch?: FetchFunction;
}

export interface CandidateRepairRequest {
  readonly round: number;
  readonly candidates: readonly unknown[];
}

/** 返回与入参**同序**的候选；某一位缺席表示该候选未修复 */
export type CandidateRepairFn = (request: CandidateRepairRequest) => Promise<readonly unknown[]>;

const REPAIR_MAX_TOKENS = 4_096;

const REPAIR_SYSTEM_PROMPT = [
  "You repair malformed code-review candidate findings so they pass a strict schema check.",
  "The candidates are in English. Do not translate them.",
  "Reply with a single JSON object and nothing else:",
  '{"candidates":[{"id":"…","severity":"P0|P1|P2|P3","category":"…","file":"…","line":1,"title":"…","description":"…","evidence":["…"],"rule":"…","confidence":0.0}]}',
  "Return exactly one entry per input candidate, in the same order.",
  "Field rules:",
  "- id: preserve the input id exactly; never change it.",
  "- severity: one of P0, P1, P2, P3.",
  "- category: non-empty UPPER_SNAKE_CASE string (e.g. CORRECTNESS, SECURITY).",
  "- file: repository-relative path with forward slashes.",
  "- line: positive integer.",
  "- title: non-empty one-line English summary.",
  "- description: non-empty English description of the issue and impact.",
  "- evidence: non-empty array of English strings.",
  "- rule: non-empty rule/pattern identifier.",
  "- confidence: number between 0 and 1.",
  "Hard constraints:",
  "- Do NOT invent evidence, line numbers, file paths, code excerpts, or symbols that are absent from the input.",
  "- If the input lacks a usable value, keep the closest input value rather than fabricating one.",
  "- Output only the JSON object.",
].join("\n");

export function createCandidateRepair(llm: CandidateRepairLlm): CandidateRepairFn {
  return async (request) => {
    if (request.candidates.length === 0) {
      return [];
    }
    const completion = await completeOneShot({
      baseUrl: llm.baseUrl,
      apiKey: llm.apiKey,
      modelId: llm.modelId,
      system: REPAIR_SYSTEM_PROMPT,
      user: buildRepairUserMessage(request),
      timeoutMs: llm.timeoutMs,
      ...(llm.retry !== undefined ? { retry: llm.retry } : {}),
      maxTokens: REPAIR_MAX_TOKENS,
      responseFormat: "json_object",
      ...(llm.fetch !== undefined ? { fetch: llm.fetch } : {}),
    });
    if (!completion.ok) {
      return [];
    }
    const parsed = extractJsonObject(completion.text, { preferKey: "candidates" });
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [];
    }
    const candidates = (parsed as { candidates?: unknown }).candidates;
    if (!Array.isArray(candidates)) {
      return [];
    }
    return candidates;
  };
}

function buildRepairUserMessage(request: CandidateRepairRequest): string {
  const payload = request.candidates.map((candidate, index) => ({
    index,
    candidate,
  }));
  return [
    `Round ${String(request.round)} candidates that failed schema validation:`,
    JSON.stringify(payload, null, 2),
  ].join("\n");
}
