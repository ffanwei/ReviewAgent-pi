import { extractModelJson } from "../shared/model-json.js";

/**
 * 阶段回复的离线 JSON salvage（ADR-0096 第 2 层）。
 *
 * 只修 JSON 语法，不改字段内容；修复后必须通过严格验收（条目数不少于原文
 * `"id":` 出现次数、字段齐全、无未知字段），否则返回 undefined，交由
 * 同会话重试或短窗口 LLM 修复。零模型调用。
 */

const KNOWN_CANDIDATE_FIELDS = new Set([
  "id",
  "severity",
  "category",
  "file",
  "line",
  "title",
  "description",
  "evidence",
  "rule",
  "confidence",
  "confidence_note",
  "tips",
  "tips_placeholder",
]);

const KNOWN_VERDICT_FIELDS = new Set(["id", "pass", "reason"]);

export interface SalvagedVerification {
  readonly entries: readonly unknown[];
  /** 与 ADR-0105 同口径：只有显式布尔 false 才续轮，缺失 / 非布尔值按 true */
  readonly complete: boolean;
}

export function salvageCandidatesReply(text: string): readonly unknown[] | undefined {
  const parsed = parseRepaired(text, "candidates");
  if (parsed === undefined) {
    return undefined;
  }
  const candidates = (parsed as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) {
    return undefined;
  }
  const idCount = countIds(text);
  if (idCount === 0 || candidates.length < idCount) {
    return undefined;
  }
  for (const entry of candidates) {
    if (!isRecord(entry)) {
      return undefined;
    }
    if (!hasString(entry, "id") || !hasString(entry, "file") || !hasString(entry, "title")) {
      return undefined;
    }
    if (!hasString(entry, "description")) {
      return undefined;
    }
    if (!isLineLike(entry.line)) {
      return undefined;
    }
    for (const key of Object.keys(entry)) {
      if (!KNOWN_CANDIDATE_FIELDS.has(key)) {
        return undefined;
      }
    }
  }
  return candidates;
}

export function salvageVerificationReply(text: string): SalvagedVerification | undefined {
  const parsed = parseRepaired(text, "verdicts");
  if (parsed === undefined) {
    return undefined;
  }
  const record = parsed as { verdicts?: unknown; complete?: unknown };
  // complete 不再属于 salvage 的验收字段（ADR-0105）：缺失或非布尔值按 true，
  // 只有显式 false 才保留续轮意图；裁决条目本身仍需完整可修。
  if (!Array.isArray(record.verdicts)) {
    return undefined;
  }
  const idCount = countIds(text);
  if (idCount === 0 || record.verdicts.length < idCount) {
    return undefined;
  }
  for (const entry of record.verdicts) {
    if (!isRecord(entry)) {
      return undefined;
    }
    if (!hasString(entry, "id") || typeof entry.pass !== "boolean" || !hasString(entry, "reason")) {
      return undefined;
    }
    for (const key of Object.keys(entry)) {
      if (!KNOWN_VERDICT_FIELDS.has(key)) {
        return undefined;
      }
    }
  }
  return { entries: record.verdicts, complete: record.complete !== false };
}

function parseRepaired(text: string, preferKey: string): unknown | undefined {
  // 原文已是合法 JSON 就不属于 salvage（调用方只在解析失败后进入本模块）。
  try {
    JSON.parse(text);
    return undefined;
  } catch {
    // fall through
  }
  const repaired = repairJsonText(text);
  for (const variant of repairVariants(repaired)) {
    const extracted = extractModelJson(variant, { preferKey });
    if (extracted.failure === undefined) {
      return extracted.value;
    }
  }
  return undefined;
}

/** 小而有界的结构修复：插缺失的 `{`、补末尾 `}`；有损恢复由条目数验收拦截。 */
function repairVariants(repaired: string): readonly string[] {
  const variants = new Set<string>();
  variants.add(repaired);
  variants.add(repaired.replaceAll('},"id":', '},{"id":'));
  variants.add(repaired.replaceAll('},"{"id"', '},{"id"'));
  const lastArrayClose = repaired.lastIndexOf("]");
  if (lastArrayClose >= 0) {
    variants.add(`${repaired.slice(0, lastArrayClose)}}${repaired.slice(lastArrayClose)}`);
  }
  variants.add(`${repaired}}`);
  variants.add(`${repaired}}}`);
  return [...variants];
}

/** OCR 式引号/控制字符/非法反斜杠修复；无字符需要修时原样返回。 */
function repairJsonText(text: string): string {
  const out: string[] = [];
  let escaped = 0;
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (!inString) {
      if (char === '"') {
        inString = true;
      }
      out.push(char);
      continue;
    }
    if (char === "\\") {
      if (isLegalEscape(text, index + 1)) {
        out.push(char, text[index + 1]!);
        index += 1;
      } else {
        out.push("\\\\");
        escaped += 1;
      }
      continue;
    }
    if (char === '"') {
      const next = nextSignificant(text, index + 1);
      if (next < 0 || isStructural(text[next]!)) {
        inString = false;
        out.push(char);
      } else {
        out.push('\\"');
        escaped += 1;
      }
      continue;
    }
    if (char.codePointAt(0)! < 0x20) {
      out.push(escapeControl(char));
      escaped += 1;
      continue;
    }
    out.push(char);
  }
  return out.join("");
}

function isLegalEscape(text: string, index: number): boolean {
  const char = text[index];
  if (char === undefined) {
    return false;
  }
  if ('"\\/bfnrt'.includes(char)) {
    return true;
  }
  if (char === "u") {
    return /^[0-9a-fA-F]{4}$/.test(text.slice(index + 1, index + 5));
  }
  return false;
}

function nextSignificant(text: string, index: number): number {
  for (let cursor = index; cursor < text.length; cursor += 1) {
    if (!" \t\r\n".includes(text[cursor]!)) {
      return cursor;
    }
  }
  return -1;
}

function isStructural(char: string): boolean {
  return char === "," || char === "}" || char === "]" || char === ":";
}

function escapeControl(char: string): string {
  switch (char) {
    case "\n":
      return "\\n";
    case "\r":
      return "\\r";
    case "\t":
      return "\\t";
    case "\b":
      return "\\b";
    case "\f":
      return "\\f";
    default: {
      const hex = char.codePointAt(0)!.toString(16).padStart(4, "0");
      return `\\u${hex}`;
    }
  }
}

function countIds(text: string): number {
  return (text.match(/"id"\s*:/g) ?? []).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasString(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return typeof value === "string" && value.trim() !== "";
}

function isLineLike(value: unknown): boolean {
  return typeof value === "number" || (typeof value === "string" && /^\s*L?\d+\s*$/i.test(value));
}

/** 短窗口修复调用的输入上限；超长回复不尝试（截断风险高）。 */
export const MAX_SALVAGE_INPUT_CHARS = 32_000;
