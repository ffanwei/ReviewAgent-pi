// 阶段回复解析（测量常量面语义：容错、有界、可审计——解析失败不抛异常，
// 记入 note，loop 以空结果继续）。
//
// P0：宽松提取统一走 `shared/model-json`（整串 → 剥围栏 → 花括号配平扫描；
// 多对象优先取「含目标键的最后一个对象」）。失败保留分级原因，供审计与
// stderr 可见性使用；「不重试 / 有界推进」语义不变。

import type { ModelJsonFailureKind } from "../contracts/run.js";
import { extractModelJson } from "./model-json.js";

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
  /**
   * Evidence Verification 回复的 complete 信号：**只有显式布尔 `false` 才要求再跑一轮**；
   * 字段缺失 / 非布尔值一律按 `true`（ADR-0105）。结构不可用（连 `verdicts` 数组都没有）
   * 或整段不可解析时仍按 `false` 处理，让已有的同阶段重试 / 短修复链有机会恢复
   * （有界推进）。
   */
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
  // 重复键防御：JSON.parse 对同名键保留最后一个值，会把多条候选折叠成一条。
  // 这里按原文最后一个 candidates 块统计 id 键；多于解析结果即判重复键，
  // 交给主 loop / Skill 的同会话重试，绝不静默接受被折叠的候选。
  const idCount = countCandidateIds(content);
  if (idCount > candidates.length) {
    return {
      candidates: [],
      note:
        `深度推理回复把多条候选写成了重复键对象` +
        `（原文 ${String(idCount)} 个 id，仅解析出 ${String(candidates.length)} 条）`,
      failure: "duplicate-key",
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
  // 结构完整（有 verdicts 数组）时：只有显式 false 才请求下一轮；缺失 / "true" /
  // null / 其它值都按完成处理（ADR-0105：模型漏字段不应放大成一次完整六阶段重跑）。
  // 结构不完整（连 verdicts 数组都没有）时保守：只有显式 true 才停，其余按续轮，
  // 保留既有的轮级恢复机会。
  const complete = failure === undefined ? record.complete !== false : record.complete === true;
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
    case "duplicate-key":
      return "深度推理回复把多条候选写成了重复键对象";
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
    case "duplicate-key":
      return "证据核验回复含重复键";
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

/**
 * 统计原文最后一个 `candidates` 键之后出现的 `id` 键数量。
 *
 * 只扫字符串外的 `"key":`，因此 evidence / tips 文本里的 `"id":` 不计入。
 * 取最后一个 `candidates` 块，避免把模型先给的格式示例算进本次结果。
 * JSON.parse 会折叠同名键；调用方用本函数与解析条数对账，检测静默丢候选。
 */
export function countCandidateIds(content: string): number {
  const keys = scanKeyPositions(content);
  let lastCandidates = -1;
  for (const entry of keys) {
    if (entry.key === "candidates") {
      lastCandidates = entry.index;
    }
  }
  if (lastCandidates < 0) {
    return 0;
  }
  let count = 0;
  for (const entry of keys) {
    if (entry.index > lastCandidates && entry.key === "id") {
      count += 1;
    }
  }
  return count;
}

/** 扫描 JSON 文本中所有字符串键（仅 `"key":` 形态），忽略字符串值内部内容。 */
function scanKeyPositions(content: string): readonly { readonly key: string; readonly index: number }[] {
  const keys: { key: string; index: number }[] = [];
  let index = 0;
  while (index < content.length) {
    if (content[index] !== '"') {
      index += 1;
      continue;
    }
    const start = index + 1;
    let cursor = start;
    let escaped = false;
    for (; cursor < content.length; cursor += 1) {
      const char = content[cursor];
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        break;
      }
    }
    if (cursor >= content.length) {
      break;
    }
    let next = cursor + 1;
    while (next < content.length && /\s/.test(content[next] ?? "")) {
      next += 1;
    }
    if (content[next] === ":") {
      keys.push({ key: content.slice(start, cursor), index });
    }
    index = cursor + 1;
  }
  return keys;
}
