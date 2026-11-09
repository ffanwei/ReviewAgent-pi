import type { CandidateNormalizationRecord } from "../contracts/run.js";

/**
 * 候选确定性归一化（P1 字段合规修复）：只修**信封 / 格式**字段，不造证据。
 *
 * 纪律：
 * - 不改写实质内容：`evidence` 只做「字符串化 / 单值包数组」这类形态修复，
 *   **绝不补写**新的证据文本；`line` 只解析模型已经写出的数字（`L147` /
 *   `147-150` 取首行），**绝不推断**行号；
 * - 不可用的定位字段（无法解析的 `line`、空 `file`）原样保留，交给候选拦截链
 *   以 `SCHEMA_INVALID` 留痕——这里不假装能修；
 * - `id` 缺失时用与候选门一致的位置兜底 id（`round-N-candidate-I`），让跨轮
 *   去重不被「模型每轮从 F001 重编」误伤；
 * - 每条修复都产生一条 `CandidateNormalizationRecord`（字段名，不记录值）。
 */

export interface NormalizeCandidatesInput {
  readonly candidates: readonly unknown[];
  readonly round: number;
  /** id 兜底前缀；缺省 `round-<round>-candidate-` */
  readonly idPrefix?: string;
}

export interface NormalizeCandidatesOutput {
  readonly candidates: readonly unknown[];
  readonly records: readonly CandidateNormalizationRecord[];
}

const SEVERITY_ALIASES: Readonly<Record<string, "P0" | "P1" | "P2" | "P3">> = {
  p0: "P0",
  critical: "P0",
  blocker: "P0",
  p1: "P1",
  high: "P1",
  major: "P1",
  error: "P1",
  p2: "P2",
  medium: "P2",
  minor: "P2",
  warning: "P2",
  p3: "P3",
  low: "P3",
  info: "P3",
  suggestion: "P3",
  trivial: "P3",
};

const DEFAULT_CATEGORY = "UNCATEGORIZED";
const DEFAULT_RULE = "GENERAL";
const DEFAULT_CONFIDENCE = 0.5;

/**
 * 分类语义桶（档 B）：规则包的 `category` 是小写细分类，主会话习惯用大写
 * 大类；这里把它们收敛到同一套 canonical 词表，避免同一条缺陷因分类写法
 * 不同而绕过 `(file, line, category)` 去重。
 *
 * 只收规则包实际使用的细分类 + 与既有 canonical 名一一对应的别名；不做
 * 更激进的同义词聚类（那会改变去重语义，需单独 ADR）。
 */
const CATEGORY_ALIASES: Readonly<Record<string, string>> = {
  SECRETS: "SECURITY",
  PRIVACY: "SECURITY",
  INJECTION: "SECURITY",
  INPUT_VALIDATION: "SECURITY",
  RESOURCE_MANAGEMENT: "RESOURCE",
  RESOURCE_EXHAUSTION: "RESOURCE",
  NULL_SAFETY: "CORRECTNESS",
  ERROR_HANDLING: "CORRECTNESS",
  RELIABILITY: "CORRECTNESS",
};

export function normalizeCandidates(input: NormalizeCandidatesInput): NormalizeCandidatesOutput {
  const idPrefix = input.idPrefix ?? `round-${String(input.round)}-candidate-`;
  const candidates: unknown[] = [];
  const records: CandidateNormalizationRecord[] = [];

  input.candidates.forEach((candidate, index) => {
    if (!isRecord(candidate)) {
      // 非对象无法归一化：原样交给 SCHEMA_INVALID，不伪造一个对象
      candidates.push(candidate);
      return;
    }
    const record: Record<string, unknown> = { ...candidate };
    const repaired = new Set<string>();

    normalizeId(record, `${idPrefix}${String(index)}`, repaired);
    normalizeSeverity(record, repaired);
    normalizeConfidence(record, repaired);
    normalizeLine(record, repaired);
    normalizeEvidence(record, repaired);
    normalizeFile(record, repaired);
    normalizeCategory(record, repaired);
    normalizeRule(record, repaired);
    normalizeTitleAndDescription(record, repaired);

    candidates.push(record);
    if (repaired.size > 0) {
      records.push({
        round: input.round,
        candidateId: typeof record.id === "string" ? record.id : `${idPrefix}${String(index)}`,
        fields: [...repaired],
        source: "deterministic",
      });
    }
  });

  return { candidates, records };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeId(record: Record<string, unknown>, fallback: string, repaired: Set<string>): void {
  if (typeof record.id === "string" && record.id.trim() !== "") {
    const trimmed = record.id.trim();
    if (trimmed !== record.id) {
      record.id = trimmed;
      repaired.add("id");
    }
    return;
  }
  record.id = fallback;
  repaired.add("id");
}

function normalizeSeverity(record: Record<string, unknown>, repaired: Set<string>): void {
  const value = record.severity;
  if (typeof value !== "string") {
    return;
  }
  const trimmed = value.trim();
  const direct = trimmed.toUpperCase();
  if (direct === "P0" || direct === "P1" || direct === "P2" || direct === "P3") {
    if (record.severity !== direct) {
      record.severity = direct;
      repaired.add("severity");
    }
    return;
  }
  const alias = SEVERITY_ALIASES[trimmed.toLowerCase()];
  if (alias !== undefined && record.severity !== alias) {
    record.severity = alias;
    repaired.add("severity");
  }
}

function normalizeConfidence(record: Record<string, unknown>, repaired: Set<string>): void {
  const parsed = parseConfidence(record.confidence);
  if (parsed === undefined) {
    record.confidence = DEFAULT_CONFIDENCE;
    repaired.add("confidence");
    return;
  }
  if (record.confidence !== parsed) {
    record.confidence = parsed;
    repaired.add("confidence");
  }
}

/** confidence 解析：0–1 数字、百分数字符串、"80" 这类 0–100 数字字符串；clamp 到 [0,1] */
function parseConfidence(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return clampUnit(value);
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  const percent = /^(\d+(?:\.\d+)?)\s*%$/.exec(trimmed);
  if (percent !== null) {
    return clampUnit(Number(percent[1]) / 100);
  }
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric)) {
    return undefined;
  }
  return clampUnit(numeric > 1 && numeric <= 100 ? numeric / 100 : numeric);
}

function clampUnit(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function normalizeLine(record: Record<string, unknown>, repaired: Set<string>): void {
  const parsed = parseLine(record.line);
  if (parsed === undefined) {
    return; // 解析不了的行号不编，交给 SCHEMA_INVALID
  }
  if (record.line !== parsed) {
    record.line = parsed;
    repaired.add("line");
  }
}

/** 行号解析：整数 / "147" / "L147" / "line 147" / "147-150"（取首行） */
function parseLine(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const match = /(\d+)/.exec(value.trim());
  if (match === null) {
    return undefined;
  }
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

function normalizeEvidence(record: Record<string, unknown>, repaired: Set<string>): void {
  const value = record.evidence;
  if (typeof value === "string") {
    const trimmed = value.trim();
    record.evidence = trimmed === "" ? [] : [trimmed];
    repaired.add("evidence");
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    record.evidence = [String(value)];
    repaired.add("evidence");
    return;
  }
  if (!Array.isArray(value)) {
    return; // 形态不可识别：交给 SCHEMA_INVALID
  }
  const entries: string[] = [];
  let changed = false;
  for (const entry of value) {
    if (typeof entry === "string") {
      entries.push(entry);
      continue;
    }
    if (typeof entry === "number" || typeof entry === "boolean") {
      entries.push(String(entry));
      changed = true;
      continue;
    }
    // 对象 / 数组：可序列化就转文本，否则丢弃（不编造证据）
    changed = true;
    const serialized = safeJson(entry);
    if (serialized !== undefined) {
      entries.push(serialized);
    }
  }
  if (changed) {
    record.evidence = entries;
    repaired.add("evidence");
  }
}

function safeJson(value: unknown): string | undefined {
  try {
    const text = JSON.stringify(value);
    if (typeof text !== "string" || text === "{}" || text === "[]") {
      return undefined;
    }
    return text;
  } catch {
    return undefined;
  }
}

function normalizeFile(record: Record<string, unknown>, repaired: Set<string>): void {
  if (typeof record.file !== "string") {
    return;
  }
  const normalized = normalizeFilePath(record.file);
  if (normalized !== record.file) {
    record.file = normalized;
    repaired.add("file");
  }
}

/** 路径归一化：反斜杠 → 正斜杠；剥 `./` / `a/` / `b/` 前缀（diff 形态） */
export function normalizeFilePath(value: string): string {
  let file = value.trim().replace(/\\/g, "/");
  file = file.replace(/^(?:\.\/)+/, "");
  file = file.replace(/^[ab]\//, "");
  return file;
}

/**
 * 分类归一化（档 B）：`trim` → 大写 → 连字符 / 空白 → 下划线 → 语义桶。
 *
 * `candidate-merge.ts` 也调用本函数，保证「候选归一入口」与「去重键」使用
 * 完全相同的词表（绕过归一入口的调用方也不会漏合并）。
 */
export function normalizeCategoryValue(value: string): string {
  const token = value.trim().toUpperCase().replace(/[\s-]+/g, "_");
  return CATEGORY_ALIASES[token] ?? token;
}

function normalizeCategory(record: Record<string, unknown>, repaired: Set<string>): void {
  if (typeof record.category === "string" && record.category.trim() !== "") {
    const normalized = normalizeCategoryValue(record.category);
    if (normalized !== record.category) {
      record.category = normalized;
      repaired.add("category");
    }
    return;
  }
  record.category = DEFAULT_CATEGORY;
  repaired.add("category");
}

function normalizeRule(record: Record<string, unknown>, repaired: Set<string>): void {
  if (typeof record.rule === "string" && record.rule.trim() !== "") {
    const trimmed = record.rule.trim();
    if (trimmed !== record.rule) {
      record.rule = trimmed;
      repaired.add("rule");
    }
    return;
  }
  record.rule = DEFAULT_RULE;
  repaired.add("rule");
}

function normalizeTitleAndDescription(record: Record<string, unknown>, repaired: Set<string>): void {
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";

  if (title !== record.title && typeof record.title === "string") {
    record.title = title;
    repaired.add("title");
  }
  if (description !== record.description && typeof record.description === "string") {
    record.description = description;
    repaired.add("description");
  }

  if (title === "" && description !== "") {
    record.title = firstLine(description);
    repaired.add("title");
  }
  if (description === "" && title !== "") {
    record.description = title;
    repaired.add("description");
  }
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/, 1)[0] ?? "";
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}
