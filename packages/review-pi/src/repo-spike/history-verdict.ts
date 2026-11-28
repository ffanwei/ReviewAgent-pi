// 历史意见失效的 LLM 语义裁决（R-21）。
//
// 「必要情况」= 锚点有变更信号（edited / gone）或存在配对疑问——确定性规则
// 给不出答案、但存在失效信号的地带。一次 one-shot 结构化调用（无会话 / 无
// 工具 / 不多轮），接 `invokeStructured`（Structured Output 统一入口：
// json_schema 约束解码 → json_object 有界降级 → 解析失败重发一次）。
//
// 读文件的是装配方（编排层注入整份行数组，本模块只切窗口）；模型拿不到
// 旧文件快照与上游代码——`persist` / `unclear` 兜底，这是有意的视野边界。
//
// 失败语义：调用失败 / 解析失败（重发后）→ fail-open（该批 unresolved，
// 编排层保守保留），绝不抛错、绝不影响收尾链。
//
// 保守偏置进提示词：宁可 persist / unclear 也不误 fixed；fixed 需要窗口内
// 明确可见的修复证据；duplicate 必须是同一问题（不是同一行）。

import type { LlmUsage } from "../contracts/llm.js";
import type { StructuredResponseFormat } from "../contracts/structured.js";
import { invokeStructured, type StructuredParse, type StructuredLlm } from "../provider/structured-reply.js";
import { extractJsonObject } from "../provider/one-shot-llm.js";
import { addUsage } from "../provider/usage-map.js";
import {
  HISTORY_VERDICTS,
  parseVerdictValue,
  type FindingForMatch,
  type HistoryTipEntry,
  type HistoryVerdict,
  type LlmCandidateSignal,
} from "./history-tips.js";

// ---------------------------------------------------------------------------
// 常量（不进配置面；sidecar 记观测数据供回校）
// ---------------------------------------------------------------------------

/** 代码窗口半宽（行） */
export const VERDICT_WINDOW_LINES = 30;
/** 单窗口字符上限（防长行撑爆上下文） */
export const VERDICT_WINDOW_CHARS = 4_000;
/** 小文件整读阈值（≤ 此字符数的文件不切窗口，判定质量更好） */
export const VERDICT_WHOLE_FILE_CHARS = 6_000;
/** 单次调用候选条目上限（溢出拆批，不是跳过——每条都要判） */
export const VERDICT_BATCH_ENTRIES = 30;
/** 单次调用上下文字符上限（溢出拆批） */
export const VERDICT_BATCH_CHARS = 24_000;
/** 输出预算 */
const VERDICT_MAX_TOKENS = 4_096;
/** 提示词里 review / note 的截断长度 */
const PROMPT_TEXT_CHARS = 400;

// ---------------------------------------------------------------------------
// 输入 / 输出形状
// ---------------------------------------------------------------------------

/** 一条 LLM 候选（矩阵结果为 `llm` 的历史意见 + 其确定性信号） */
export interface VerdictCandidate {
  readonly entry: HistoryTipEntry;
  readonly signal: LlmCandidateSignal;
}

/** 一个文件的裁决批（按文件分批；fileLines 由编排层读盘注入） */
export interface VerdictFileBatch {
  readonly filePath: string;
  readonly fileLines: readonly string[];
  readonly candidates: readonly VerdictCandidate[];
  /** 该文件本次已上报的 findings（配对上下文） */
  readonly findings: readonly FindingForMatch[];
}

export interface VerdictEntryOutcome {
  readonly tipsId: number;
  readonly verdict: HistoryVerdict;
  readonly matchedFindingId?: string;
  readonly note?: string;
}

export interface VerdictBatchOutcome {
  /** 成功解析出的裁决（漏答的候选不在这里——编排层按 unclear 保留） */
  readonly outcomes: readonly VerdictEntryOutcome[];
  /** 整批失败（传输 / 解析，重试后）：全部候选保守保留 */
  readonly failed: boolean;
  /** 出现候选清单外 tipsId（幻觉条目）的计数 */
  readonly hallucinated: number;
  readonly attempts: number;
  readonly usage?: LlmUsage;
}

// ---------------------------------------------------------------------------
// schema 与解析
// ---------------------------------------------------------------------------

const VERDICT_RESPONSE_FORMAT: StructuredResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "history_tips_verdicts",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["verdicts"],
      properties: {
        verdicts: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["tipsId", "verdict", "matchedFindingId", "note"],
            properties: {
              tipsId: { type: "integer" },
              verdict: {
                type: "string",
                enum: ["fixed", "persist", "duplicate", "unclear"],
              },
              // strict 模式要求全部键 required：非 duplicate 时模型输出 null。
              matchedFindingId: { type: ["string", "null"] },
              note: { type: "string" },
            },
          },
        },
      },
    },
  },
};

const VERDICT_SYSTEM_PROMPT = [
  "你是历史检视意见的失效裁决者。输入是：若干条历史检视意见（上次检视时对某文件的意见，附当时引用的代码行）、本次检视对同一文件产出的意见、以及该文件当前代码的片段。",
  "你逐条判断历史意见现在的状态，四值裁决：",
  "- fixed：当前代码已明确解决该意见针对的问题（修复必须在给出的代码片段里可见）；",
  "- persist：该意见针对的问题在当前代码中仍然存在；",
  "- duplicate：该意见已被本次检视的某条意见覆盖（描述的是同一个问题，不是仅仅位于同一行）；",
  "- unclear：给出的材料不足以判断。",
  "保守纪律（最重要）：",
  "- 宁可 persist / unclear，绝不轻易 fixed——把仍成立的问题误判为已修复会把它从平台抹掉；",
  "- fixed 只在代码片段里能明确看到修复手段（如参数化、校验、删除拼接）时使用；",
  "- duplicate 必须给出 matchedFindingId（本次意见的 id），且语义上是同一问题；同一行上的不同问题不是 duplicate；",
  "- 上游 / 片段之外的修复不可见时，若该行代码原样保留，判 persist。",
  "只输出一个 JSON 对象，不附带其他文本：",
  '{"verdicts":[{"tipsId":12,"verdict":"fixed","matchedFindingId":null,"note":"拼接已改为参数化查询"},{"tipsId":34,"verdict":"duplicate","matchedFindingId":"F002","note":"与本次 F002 同一注入问题"}]}',
  "每条候选 tipsId 必须且只能有一条 verdict；不要遗漏，不要编造 tipsId 或 finding id。",
].join("\n");

/** 校验后的裁决条目（parseVerdictReply 的输出形状） */
interface ParsedVerdictItem {
  readonly tipsId: number;
  readonly verdict: HistoryVerdict;
  readonly matchedFindingId?: string;
  readonly note: string;
}

interface VerdictReply {
  readonly verdicts: readonly ParsedVerdictItem[];
}

/** 语法提取 + 逐条校验（枚举 / tipsId 覆盖集 / matchedFindingId 归属）。
 * 幻觉条目（候选清单外的 tipsId）忽略不计——合法条目照常应用。 */
function parseVerdictReply(
  text: string,
  candidateIds: ReadonlySet<number>,
  findingIds: ReadonlySet<string>,
): StructuredParse<VerdictReply> {
  const parsed = extractJsonObject(text);
  if (parsed === undefined || typeof parsed !== "object" || parsed === null) {
    return { ok: false, failure: { kind: "schema", note: "裁决回包不是 JSON 对象" } };
  }
  const verdicts = (parsed as { verdicts?: unknown }).verdicts;
  if (!Array.isArray(verdicts)) {
    return { ok: false, failure: { kind: "schema", note: "裁决回包缺 verdicts 数组" } };
  }
  const seen = new Set<number>();
  const out: ParsedVerdictItem[] = [];
  for (const item of verdicts) {
    if (typeof item !== "object" || item === null) {
      return { ok: false, failure: { kind: "schema", note: "verdicts 含非对象条目" } };
    }
    const record = item as Record<string, unknown>;
    const tipsId =
      typeof record.tipsId === "number" && Number.isInteger(record.tipsId)
        ? record.tipsId
        : undefined;
    if (tipsId === undefined) {
      return { ok: false, failure: { kind: "schema", note: "verdict 条目缺合法 tipsId" } };
    }
    if (!candidateIds.has(tipsId)) {
      continue;
    }
    if (seen.has(tipsId)) {
      return { ok: false, failure: { kind: "schema", note: `tipsId ${String(tipsId)} 重复出现` } };
    }
    const verdict = parseVerdictValue(record.verdict);
    if (verdict === undefined) {
      return {
        ok: false,
        failure: {
          kind: "schema",
          note: `tipsId ${String(tipsId)} 的 verdict 不在 ${HISTORY_VERDICTS.join("/")}`,
        },
      };
    }
    const matchedRaw = record.matchedFindingId;
    const matchedFindingId =
      typeof matchedRaw === "string" && matchedRaw.trim() !== "" ? matchedRaw.trim() : undefined;
    if (
      verdict === "duplicate" &&
      (matchedFindingId === undefined || !findingIds.has(matchedFindingId))
    ) {
      return {
        ok: false,
        failure: {
          kind: "schema",
          note: `tipsId ${String(tipsId)} 判 duplicate 但 matchedFindingId 缺失或不属于本次意见`,
        },
      };
    }
    const note = typeof record.note === "string" ? record.note : "";
    seen.add(tipsId);
    out.push({
      tipsId,
      verdict,
      ...(matchedFindingId !== undefined ? { matchedFindingId } : {}),
      note,
    });
  }
  return { ok: true, value: { verdicts: out } };
}

// ---------------------------------------------------------------------------
// 提示词装配（窗口切取）
// ---------------------------------------------------------------------------

/** 窗口中心集合：edited→模糊行、gone→老行号现位置；配对候选的 finding 行
 * 在 mergedWindows 里补充。 */
function windowCenters(candidate: VerdictCandidate): number[] {
  const centers = new Set<number>();
  if (candidate.signal.anchor === "edited" && candidate.signal.anchorLine !== undefined) {
    centers.add(candidate.signal.anchorLine);
  } else {
    centers.add(candidate.entry.lineNum);
  }
  return [...centers];
}

/** 候选 + findings → 合并后的窗口区间（1-based，含端点） */
function mergedWindows(
  candidates: readonly VerdictCandidate[],
  findings: readonly FindingForMatch[],
): { start: number; end: number }[] {
  const centers: number[] = [];
  for (const candidate of candidates) {
    centers.push(...windowCenters(candidate));
    const { pair } = candidate.signal;
    if (pair.kind === "pair-question" || pair.kind === "soft-candidate") {
      const ids = new Set(pair.findingIds);
      for (const finding of findings) {
        if (ids.has(finding.id)) {
          centers.push(finding.line);
        }
      }
    }
  }
  const ranges = centers
    .map((center) => ({
      start: Math.max(1, center - VERDICT_WINDOW_LINES),
      end: center + VERDICT_WINDOW_LINES,
    }))
    .sort((left, right) => left.start - right.start);
  const merged: { start: number; end: number }[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/** 单文件（或拆批后的小批）的 user 消息 */
function buildVerdictUserMessage(batch: {
  readonly filePath: string;
  readonly fileLines: readonly string[];
  readonly candidates: readonly VerdictCandidate[];
  readonly findings: readonly FindingForMatch[];
}): string {
  const lines: string[] = [];
  lines.push(`文件：${batch.filePath}`);
  lines.push("");
  lines.push("## 本次检视意见（该文件，已上报）");
  if (batch.findings.length === 0) {
    lines.push("（无）");
  }
  for (const finding of batch.findings) {
    lines.push(
      `- ${finding.id}（第 ${String(finding.line)} 行）${finding.title}` +
        (finding.reviewText !== undefined
          ? `｜${truncate(finding.reviewText, PROMPT_TEXT_CHARS)}`
          : ""),
    );
  }
  lines.push("");
  lines.push("## 历史意见（待裁决）");
  const anchorLabels: Record<string, string> = {
    exact: "行未变",
    edited: "行被修改但仍近似",
    gone: "行已不存在",
    unknown: "无法评估",
  };
  const pairLabels: Record<string, string> = {
    "hard-duplicate": "",
    "pair-question": "位置命中但文本不相似（可能是同一行的另一个问题）",
    "soft-candidate": "文本相似但位置不同",
    none: "",
  };
  for (const candidate of batch.candidates) {
    const { entry, signal } = candidate;
    const signalParts = [
      `锚点：${anchorLabels[signal.anchor] ?? signal.anchor}`,
      ...(signal.pair.kind === "pair-question" || signal.pair.kind === "soft-candidate"
        ? [
            `${pairLabels[signal.pair.kind] ?? ""}（相关本次意见：${signal.pair.findingIds.join("、")}）`,
          ]
        : []),
    ];
    lines.push(
      `- tipsId ${String(entry.tipsId)}（${entry.status}，第 ${String(entry.lineNum)} 行）：${truncate(entry.reviewMsg, PROMPT_TEXT_CHARS)}`,
    );
    lines.push(
      `  当时引用的代码：${entry.patchLine === "" ? "（缺失）" : truncate(entry.patchLine, 200)}`,
    );
    if (signalParts.some((part) => part.length > 0)) {
      lines.push(`  确定性信号：${signalParts.filter((part) => part.length > 0).join("；")}`);
    }
  }
  lines.push("");
  lines.push("## 当前代码窗口（行号为当前文件行号）");
  const total = batch.fileLines.join("\n").length;
  if (total <= VERDICT_WHOLE_FILE_CHARS) {
    lines.push("（整文件）");
    appendWindow(lines, batch.fileLines, 1, batch.fileLines.length);
  } else {
    for (const range of mergedWindows(batch.candidates, batch.findings)) {
      const start = Math.max(1, range.start);
      const end = Math.min(batch.fileLines.length, range.end);
      lines.push(`（第 ${String(start)}–${String(end)} 行）`);
      appendWindow(lines, batch.fileLines, start, end);
    }
  }
  lines.push("");
  lines.push(
    "请对上面每条「历史意见」输出一条 verdict（fixed / persist / duplicate / unclear），",
  );
  lines.push("duplicate 必须带 matchedFindingId。");
  return lines.join("\n");
}

function appendWindow(
  target: string[],
  fileLines: readonly string[],
  start: number,
  end: number,
): void {
  let budget = VERDICT_WINDOW_CHARS;
  for (let index = start; index <= end && budget > 0; index += 1) {
    const line = fileLines[index - 1] ?? "";
    const clipped = line.length > budget ? line.slice(0, budget) : line;
    budget -= clipped.length;
    target.push(`${String(index).padStart(5, " ")}|${clipped}`);
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 对一个文件的候选批发裁决。条目 / 上下文超上限时**拆批**（每条都要判，
 * 不存在预算跳过）。失败 fail-open：`failed: true` + 空结果。
 */
export async function judgeFileVerdicts(input: {
  readonly llm: StructuredLlm;
  readonly batch: VerdictFileBatch;
}): Promise<VerdictBatchOutcome> {
  const batches = splitBatch(input.batch);
  const outcomes: VerdictEntryOutcome[] = [];
  let failed = false;
  let hallucinated = 0;
  let attempts = 0;
  let usage: LlmUsage | undefined;
  for (const part of batches) {
    const candidateIds = new Set(part.candidates.map((candidate) => candidate.entry.tipsId));
    const findingIds = new Set(part.findings.map((finding) => finding.id));
    const outcome = await invokeStructured({
      llm: input.llm,
      purpose: "history-verdict",
      system: VERDICT_SYSTEM_PROMPT,
      user: buildVerdictUserMessage(part),
      responseFormat: VERDICT_RESPONSE_FORMAT,
      maxTokens: VERDICT_MAX_TOKENS,
      call: {
        parse: (text) => parseVerdictReply(text, candidateIds, findingIds),
        maxRepairAttempts: 1,
      },
    });
    attempts += outcome.attempts;
    if (outcome.usage !== undefined) {
      usage = usage === undefined ? outcome.usage : addUsage(usage, outcome.usage);
    }
    if (!outcome.ok) {
      failed = true;
      continue;
    }
    hallucinated += countHallucinated(outcome.value, candidateIds);
    outcomes.push(...outcome.value.verdicts);
  }
  return { outcomes, failed, hallucinated, attempts, ...(usage !== undefined ? { usage } : {}) };
}

function countHallucinated(reply: VerdictReply, candidateIds: ReadonlySet<number>): number {
  let count = 0;
  for (const verdict of reply.verdicts) {
    if (!candidateIds.has(verdict.tipsId)) {
      count += 1;
    }
  }
  return count;
}

/** 拆批：条目数 / 上下文体积双上限（顺序保持，不丢条目） */
function splitBatch(batch: VerdictFileBatch): VerdictFileBatch[] {
  if (batch.candidates.length <= VERDICT_BATCH_ENTRIES && promptSizeOf(batch) <= VERDICT_BATCH_CHARS) {
    return [batch];
  }
  const parts: VerdictFileBatch[] = [];
  let current: VerdictCandidate[] = [];
  for (const candidate of batch.candidates) {
    const next = [...current, candidate];
    const probe: VerdictFileBatch = { ...batch, candidates: next };
    if (next.length > VERDICT_BATCH_ENTRIES || promptSizeOf(probe) > VERDICT_BATCH_CHARS) {
      if (current.length > 0) {
        parts.push({ ...batch, candidates: current });
      }
      current = [candidate];
    } else {
      current = next;
    }
  }
  if (current.length > 0) {
    parts.push({ ...batch, candidates: current });
  }
  return parts;
}

function promptSizeOf(batch: VerdictFileBatch): number {
  return buildVerdictUserMessage(batch).length;
}
