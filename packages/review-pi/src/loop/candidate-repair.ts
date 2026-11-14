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
  "你负责修复格式不合法的代码检视候选意见，使其通过严格的 schema 校验。",
  "候选正文已是中文。不要翻译、不要改写实质内容。",
  "只回一个 JSON 对象，不附带任何其他文本：",
  '{"candidates":[{"id":"…","severity":"P0|P1|P2|P3","category":"可维护|安全|可靠性|可测试性|性能|可移植|可读性","file":"…","line":1,"title":"…","description":"…","evidence":["…"],"rule":"…","confidence":0.0,"tips":{"review":"…","suggestion":"…","subcategory":"…"}}]}',
  "每条输入候选恰好返回一条，顺序不变。",
  "字段规则：",
  "- id: 原样保留输入 id，绝不修改。",
  "- severity: P0 / P1 / P2 / P3 之一。",
  "- category: 七个中文类别之一（可维护、安全、可靠性、可测试性、性能、可移植、可读性）。",
  "- file: 仓库相对路径（正斜杠）。",
  "- line: 正整数。",
  "- title: 非空中文一行结论。",
  "- description: 非空中文问题与影响说明。",
  "- evidence: 非空中文字符串数组。",
  "- rule: 非空规则 / 模式标识。",
  "- confidence: 0 到 1 之间的数字。",
  "- tips: {review, suggestion, subcategory} 三个非空中文字符串；缺失时从 description 派生 review。",
  "硬性约束：",
  "- 绝不编造输入中不存在的 evidence、行号、文件路径、代码摘录或符号。",
  "- 输入缺可用值时，保留最接近的输入值，而不是虚构。",
  "- 只输出 JSON 对象。",
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
      purpose: "candidate-repair",
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
    `第 ${String(request.round)} 轮未通过 schema 校验的候选：`,
    JSON.stringify(payload, null, 2),
  ].join("\n");
}
