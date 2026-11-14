// 阶段回复解析（测量常量面语义：容错、有界、可审计——解析失败不抛异常，
// 记入 note，loop 以空结果继续）。
//
// P0：宽松提取统一走 `shared/model-json`（整串 → 剥围栏 → 花括号配平扫描；
// 多对象优先取「含目标键的最后一个对象」）。失败保留分级原因，供审计与
// stderr 可见性使用；「不重试 / 有界推进」语义不变。

import type { ModelJsonFailureKind } from "../contracts/run.js";
import { extractModelJson } from "../shared/model-json.js";

export type { ModelJsonFailureKind };

export interface CandidatesParseResult {
  /** 原始候选对象列表（未经 Schema 校验） */
  readonly candidates: readonly unknown[];
  readonly note?: string;
  /** 解析失败的分级原因（成功时缺席） */
  readonly failure?: ModelJsonFailureKind;
}

export interface VerificationVerdict {
  readonly pass: boolean;
  readonly reason: string;
}

export interface VerificationParseResult {
  readonly verdicts: ReadonlyMap<string, VerificationVerdict>;
  /** Evidence Verification 回复的 complete 信号；解析失败按 false 处理（有界推进） */
  readonly complete: boolean;
  readonly note?: string;
  /** 解析失败的分级原因（成功时缺席） */
  readonly failure?: ModelJsonFailureKind;
}

/**
 * 尝试解析 JSON 回复；宽松提取失败返回 undefined。
 * `preferKey` 只在多对象场景生效（取含该键的最后一个对象）。
 */
export function parseJsonReply(content: string, preferKey?: string): unknown {
  return extractModelJson(content, preferKey !== undefined ? { preferKey } : {}).value;
}

/** 解析 Deep Reasoning 回复的 candidates 数组 */
export function parseCandidatesReply(content: string): CandidatesParseResult {
  const extraction = extractModelJson(content, { preferKey: "candidates" });
  if (extraction.failure !== undefined && extraction.failure !== "missing-key") {
    return { candidates: [], note: candidatesNote(extraction.failure), failure: extraction.failure };
  }
  const parsed = extraction.value;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { candidates: [], note: "深度推理回复不是合法 JSON", failure: "not-json" };
  }
  const candidates = (parsed as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) {
    return {
      candidates: [],
      note: "深度推理回复没有 candidates 数组",
      failure: "missing-key",
    };
  }
  return { candidates };
}

/** 解析 Evidence Verification 回复的 verdicts + complete */
export function parseVerificationReply(content: string): VerificationParseResult {
  const extraction = extractModelJson(content, { preferKey: "verdicts" });
  if (extraction.failure !== undefined && extraction.failure !== "missing-key") {
    return {
      verdicts: new Map(),
      complete: false,
      note: verificationNote(extraction.failure),
      failure: extraction.failure,
    };
  }
  const parsed = extraction.value;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      verdicts: new Map(),
      complete: false,
      note: "证据核验回复不是合法 JSON",
      failure: "not-json",
    };
  }
  const record = parsed as { verdicts?: unknown; complete?: unknown };
  const verdicts = new Map<string, VerificationVerdict>();
  let note: string | undefined;
  let failure: ModelJsonFailureKind | undefined;
  if (Array.isArray(record.verdicts)) {
    for (const entry of record.verdicts) {
      const mapped = mapVerdict(entry);
      if (mapped !== undefined) {
        verdicts.set(mapped.id, mapped.verdict);
      } else {
        note = "证据核验回复含非法裁决条目";
      }
    }
  } else {
    note = "证据核验回复没有 verdicts 数组";
    failure = "missing-key";
  }
  const complete = record.complete === true;
  return {
    verdicts,
    complete,
    ...(note !== undefined ? { note } : {}),
    ...(failure !== undefined ? { failure } : {}),
  };
}

/** 分级原因 → 英文诊断（保留 "JSON" 字样：审计/降级原因按它 grep） */
function candidatesNote(kind: ModelJsonFailureKind): string {
  switch (kind) {
    case "empty":
      return "深度推理回复为空";
    case "truncated":
      return "深度推理回复是被截断的 JSON 对象";
    case "not-json":
      return "深度推理回复不是合法 JSON";
    case "missing-key":
      return "深度推理回复没有 candidates 数组";
  }
}

function verificationNote(kind: ModelJsonFailureKind): string {
  switch (kind) {
    case "empty":
      return "证据核验回复为空";
    case "truncated":
      return "证据核验回复是被截断的 JSON 对象";
    case "not-json":
      return "证据核验回复不是合法 JSON";
    case "missing-key":
      return "证据核验回复没有 verdicts 数组";
  }
}

function mapVerdict(entry: unknown): { id: string; verdict: VerificationVerdict } | undefined {
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  const record = entry as { id?: unknown; pass?: unknown; reason?: unknown };
  if (typeof record.id !== "string" || record.id.length === 0) {
    return undefined;
  }
  return {
    id: record.id,
    verdict: {
      pass: record.pass === true,
      reason: typeof record.reason === "string" ? record.reason : "",
    },
  };
}
