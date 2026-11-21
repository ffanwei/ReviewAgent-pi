// 覆盖缺口补漏（F-01b）：只对账本里未覆盖的 hunk 发独立一次性请求，
// 让模型逐 hunk 回执 `no-issue` 或 `candidate`。
//
// 纪律：
// - 分母仍只来自 diff；补漏只能回填 / 声明，不能扩大账本；
// - 只对 `not-reached(no-signal)` 的 hunk 发请求；truncated / 已有现场原因不重发；
// - 每个 pass 的请求数、字符数、hunk 数都有硬上限；超出的保持
//   `not-reached(cause=budget)`；
// - 补漏候选仍走现有候选门（schema / evidence / scope / 去重）；
// - `no-issue` 只来自本模块的结构化回执，不来自提示词自报。

import type { FetchFunction } from "@earendil-works/pi-ai";

import type {
  CoverageHunkRef,
  CoverageLedger,
  CoverageLineRange,
  NoIssueClaim,
} from "../contracts/coverage.js";
import type { Finding } from "../contracts/finding.js";
import type { LlmUsage } from "../contracts/llm.js";
import type { CoverageRepairAudit } from "../contracts/run.js";
import { splitDiffIntoFileBlocks } from "./mr-input.js";
import { parseHunkHeader, type HunkHeader } from "../diff/hunk.js";
import { addRootCauseKey, findingContentKey } from "../finding/finding-key.js";
import { applyCandidateGate } from "../gate/candidate-gate.js";
import { normalizeCandidates } from "../gate/candidate-normalize.js";
import type { DiffScope } from "../gate/diff-scope.js";
import { completeOneShot, extractJsonObject } from "../provider/one-shot-llm.js";
import { addUsage, ZERO_USAGE } from "../provider/usage-map.js";
import type { RetryPolicy } from "../shared/llm-retry.js";
import type { VerificationVerdict } from "../shared/parse.js";
import type { CoverageRepairLimits } from "../shared/config-limits.js";
import { backfillCandidates, markNoIssue, markNotReached } from "./coverage-ledger.js";

/** 补漏调用所需的接入点（由 run 层从配置解析后传入） */
export interface CoverageRepairLlm {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly modelId: string;
  readonly timeoutMs: number;
  readonly retry?: RetryPolicy;
  readonly fetch?: FetchFunction;
  readonly maxTokens?: number;
}

export interface CoverageRepairInput {
  readonly diff: string;
  readonly ledger: CoverageLedger;
  /** 主检视已产出的 findings（用于提示词里的“勿重复”清单与候选门去重） */
  readonly findings: readonly Finding[];
  readonly limits: CoverageRepairLimits;
  readonly llm: CoverageRepairLlm;
  /** 与主检视同一套 findingScope；缺省 = 不过滤 */
  readonly scope?: DiffScope;
}

export interface CoverageRepairResult {
  readonly ledger: CoverageLedger;
  readonly findings: readonly Finding[];
  readonly audit: CoverageRepairAudit;
  readonly usage: LlmUsage;
}

/** 一个可补漏 hunk 的正文 + 定位 */
export interface CoverageRepairHunk {
  readonly file: string;
  readonly index: number;
  readonly header: HunkHeader;
  readonly old: CoverageLineRange;
  readonly new: CoverageLineRange;
  /** 含 `@@` 头与 hunk 体的原文 */
  readonly text: string;
}

/** 一次请求携带的缺口单元（一个文件 + 若干未覆盖 hunk） */
export interface CoverageRepairUnit {
  readonly file: string;
  readonly wholeFile: boolean;
  readonly hunks: readonly CoverageRepairHunk[];
  readonly chars: number;
}

export interface CoverageRepairPlan {
  readonly units: readonly CoverageRepairUnit[];
  /** 因 maxRequests / maxChars / 缺少 hunk 正文而未发出的缺口 */
  readonly skipped: readonly CoverageHunkRef[];
}

const REPAIR_MAX_TOKENS = 8_192;
const EXISTING_FINDINGS_LIMIT = 20;

const REPAIR_SYSTEM_PROMPT = [
  "你负责对代码检视后仍未覆盖的 diff hunk 做定向补漏。",
  "只根据给出的 hunk 正文判断，不读仓库、不调用工具、不推测未给出的文件。",
  "对每个 hunk 只能二选一：",
  "1) 发现真实缺陷：输出 candidate（与主检视相同的字段 schema）；",
  "2) 确认真实没有问题：输出 no-issue，并给出非空中文 reason。",
  "不确定的 hunk 不要输出回执；不要把没看懂的 hunk 标成 no-issue。",
  "只输出一个 JSON 对象，不附带其他文本：",
  '{"receipts":[{"kind":"no-issue","hunk":1,"reason":"…"},{"kind":"candidate","candidate":{"id":"F9001","severity":"P1","category":"可靠性","file":"…","line":123,"title":"…","description":"…","evidence":["…"],"rule":"…","confidence":0.8,"tips":{"review":"…","suggestion":"…","subcategory":"…"}}}]}',
  "候选字段规则：",
  "- id：本次请求内唯一，建议 CR001 开始；",
  "- severity：P0 / P1 / P2 / P3 之一；",
  "- category：可维护 / 安全 / 可靠性 / 可测试性 / 性能 / 可移植 / 可读性 之一；",
  "- file：必须等于本次请求的文件路径；",
  "- line：必须落在本次给出的某个 hunk 新侧行区间内；",
  "- title / description / evidence / rule：非空；evidence 必须引用 hunk 里的真实代码或行号；",
  "- confidence：0–1；tips 三个中文非空字符串。",
  "硬性约束：绝不编造文件、行号、代码摘录或符号；只输出 JSON。",
].join("\n");

/** 从 diff 提取每个文件内的 hunk 正文；hunk 序号与账本一致（1-based，含多块累计） */
export function extractDiffHunks(diff: string): ReadonlyMap<string, readonly CoverageRepairHunk[]> {
  const byFile = new Map<string, CoverageRepairHunk[]>();
  for (const block of splitDiffIntoFileBlocks(diff)) {
    if (block.path === "") {
      continue;
    }
    const lines = block.text.split("\n");
    const starts: number[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      if ((lines[index] ?? "").startsWith("@@ ")) {
        starts.push(index);
      }
    }
    const existing = byFile.get(normalizePath(block.path)) ?? [];
    for (let offset = 0; offset < starts.length; offset += 1) {
      const start = starts[offset] as number;
      const end = starts[offset + 1] ?? lines.length;
      const header = parseHunkHeader(lines[start] ?? "");
      if (header === null) {
        continue;
      }
      existing.push({
        file: block.path,
        index: existing.length + 1,
        header,
        old: { start: header.oldStart, count: header.oldCount },
        new: { start: header.newStart, count: header.newCount },
        text: lines.slice(start, end).join("\n"),
      });
    }
    byFile.set(normalizePath(block.path), existing);
  }
  return byFile;
}

/**
 * 把账本里的 `not-reached(no-signal)` 缺口按文件装箱。
 *
 * - 文件全空 → `wholeFile=true`（提示词按整文件补漏）；
 * - 部分空 → 只带未覆盖 hunk；
 * - 单请求受 `maxHunksPerRequest` / `maxChars` 约束；单个超大 hunk 独占一个请求；
 * - 总请求数受 `maxRequests` 约束；超出与缺失正文的 hunk 进 `skipped`。
 */
export function planCoverageRepairUnits(input: {
  readonly diff: string;
  readonly ledger: CoverageLedger;
  readonly limits: CoverageRepairLimits;
}): CoverageRepairPlan {
  const hunksByFile = extractDiffHunks(input.diff);
  const units: CoverageRepairUnit[] = [];
  const skipped: CoverageHunkRef[] = [];

  for (const file of input.ledger.files) {
    const gaps = file.hunks.filter(
      (hunk) =>
        hunk.status === "not-reached" &&
        (hunk.cause === undefined || hunk.cause === "no-signal"),
    );
    if (gaps.length === 0) {
      continue;
    }
    const texts = hunksByFile.get(normalizePath(file.file));
    if (texts === undefined) {
      skipped.push(...gaps.map((hunk) => ({ file: file.file, hunkIndex: hunk.index })));
      continue;
    }
    const byIndex = new Map(texts.map((hunk) => [hunk.index, hunk]));
    const wholeFile = file.hunks.every((hunk) => hunk.status === "not-reached");
    let current: CoverageRepairHunk[] = [];
    let currentChars = 0;

    const flush = (): void => {
      if (current.length === 0) {
        return;
      }
      units.push({
        file: file.file,
        wholeFile,
        hunks: current,
        chars: currentChars + file.file.length,
      });
      current = [];
      currentChars = 0;
    };

    for (const gap of gaps) {
      const hunk = byIndex.get(gap.index);
      if (hunk === undefined) {
        skipped.push({ file: file.file, hunkIndex: gap.index });
        continue;
      }
      const nextCount = current.length + 1;
      const nextChars = currentChars + hunk.text.length + 1;
      if (
        current.length > 0 &&
        (nextCount > input.limits.maxHunksPerRequest || nextChars > input.limits.maxChars)
      ) {
        flush();
      }
      current.push(hunk);
      currentChars += hunk.text.length + 1;
      if (current.length >= input.limits.maxHunksPerRequest) {
        flush();
      }
    }
    flush();
  }

  // 预算优先给「整文件一条意见都没有」的缺口：历史漏报中 56.8% 落在这种文件。
  // 同优先级内先小后大（用更少请求覆盖更多文件），最后按路径保证确定性。
  const ordered = [...units].sort((left, right) => {
    if (left.wholeFile !== right.wholeFile) {
      return left.wholeFile ? -1 : 1;
    }
    if (left.hunks.length !== right.hunks.length) {
      return left.hunks.length - right.hunks.length;
    }
    return left.file.localeCompare(right.file);
  });
  const capped = ordered.slice(0, input.limits.maxRequests);
  for (const unit of ordered.slice(input.limits.maxRequests)) {
    skipped.push(...unit.hunks.map((hunk) => ({ file: unit.file, hunkIndex: hunk.index })));
  }
  return { units: capped, skipped };
}

export interface ParsedCoverageRepair {
  readonly noIssue: readonly NoIssueClaim[];
  readonly candidates: readonly unknown[];
  readonly coveredHunks: readonly CoverageHunkRef[];
  readonly invalid: number;
}

/**
 * 解析一次补漏回执。结构非法 / hunk 不在本次单元 / 候选行号不在缺口内
 * 一律计入 `invalid`，不进入后续候选门。
 */
export function parseCoverageRepairReply(
  text: string,
  unit: CoverageRepairUnit,
): ParsedCoverageRepair {
  const parsed = extractJsonObject(text, { preferKey: "receipts" });
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { noIssue: [], candidates: [], coveredHunks: [], invalid: 1 };
  }
  const receipts = (parsed as { receipts?: unknown }).receipts;
  if (!Array.isArray(receipts)) {
    return { noIssue: [], candidates: [], coveredHunks: [], invalid: 1 };
  }

  const hunks = new Map(unit.hunks.map((hunk) => [hunk.index, hunk]));
  const noIssue: NoIssueClaim[] = [];
  const candidates: unknown[] = [];
  const covered = new Map<number, CoverageHunkRef>();
  let invalid = 0;

  for (const receipt of receipts) {
    if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) {
      invalid += 1;
      continue;
    }
    const record = receipt as Record<string, unknown>;
    const hunkIndex = record.hunk;
    if (typeof hunkIndex !== "number" || !Number.isInteger(hunkIndex) || !hunks.has(hunkIndex)) {
      invalid += 1;
      continue;
    }
    if (record.kind === "no-issue") {
      const reason = record.reason;
      if (typeof reason !== "string" || reason.trim() === "") {
        invalid += 1;
        continue;
      }
      noIssue.push({ file: unit.file, hunkIndex, reason: reason.trim() });
      covered.set(hunkIndex, { file: unit.file, hunkIndex });
      continue;
    }
    if (record.kind === "candidate") {
      const candidate = record.candidate;
      const target = candidateTargetHunk(candidate, unit);
      if (target === undefined) {
        invalid += 1;
        continue;
      }
      candidates.push(candidate);
      covered.set(target.index, { file: unit.file, hunkIndex: target.index });
      continue;
    }
    invalid += 1;
  }

  return { noIssue, candidates, coveredHunks: [...covered.values()], invalid };
}

function candidateTargetHunk(
  candidate: unknown,
  unit: CoverageRepairUnit,
): CoverageRepairHunk | undefined {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return undefined;
  }
  const record = candidate as Record<string, unknown>;
  if (typeof record.file !== "string" || normalizePath(record.file) !== normalizePath(unit.file)) {
    return undefined;
  }
  if (typeof record.line !== "number" || !Number.isInteger(record.line)) {
    return undefined;
  }
  return unit.hunks.find((hunk) => lineInRange(record.line as number, hunk.new));
}

/**
 * 执行缺口补漏。调用方只在 `enabled=true` 时调用；未启用时本函数原样返回。
 */
export async function repairCoverageGaps(input: CoverageRepairInput): Promise<CoverageRepairResult> {
  if (!input.limits.enabled) {
    return {
      ledger: input.ledger,
      findings: [],
      audit: emptyCoverageRepairAudit(false),
      usage: ZERO_USAGE,
    };
  }

  const plan = planCoverageRepairUnits({
    diff: input.diff,
    ledger: input.ledger,
    limits: input.limits,
  });
  let ledger = input.ledger;
  let usage: LlmUsage = ZERO_USAGE;
  const claims: NoIssueClaim[] = [];
  const rawCandidates: unknown[] = [];
  let requests = 0;
  let failedRequests = 0;
  let hunksSent = 0;
  let invalid = 0;

  for (const unit of plan.units) {
    requests += 1;
    hunksSent += unit.hunks.length;
    const completion = await completeOneShot({
      baseUrl: input.llm.baseUrl,
      apiKey: input.llm.apiKey,
      modelId: input.llm.modelId,
      system: REPAIR_SYSTEM_PROMPT,
      user: buildCoverageRepairUserMessage(unit, input.findings),
      timeoutMs: input.llm.timeoutMs,
      ...(input.llm.retry !== undefined ? { retry: input.llm.retry } : {}),
      maxTokens: input.llm.maxTokens ?? REPAIR_MAX_TOKENS,
      responseFormat: "json_object",
      purpose: "coverage-repair",
      ...(input.llm.fetch !== undefined ? { fetch: input.llm.fetch } : {}),
    });
    if (!completion.ok) {
      failedRequests += 1;
      continue;
    }
    if (completion.usage !== undefined) {
      usage = addUsage(usage, completion.usage);
    }
    const parsed = parseCoverageRepairReply(completion.text, unit);
    invalid += parsed.invalid;
    claims.push(...parsed.noIssue);
    rawCandidates.push(...parsed.candidates);
  }

  const normalized = normalizeCandidates({
    candidates: rawCandidates,
    round: 0,
    idPrefix: "coverage-repair-candidate-",
  });
  // 补漏候选与主检视的 id 空间隔离：模型可能复用 F001，统一重编号为 CR001…
  // 避免 reviews_all / tips 出现重复 id；补漏候选不参与 Phase 6 裁决对齐。
  const candidates = normalized.candidates.map((candidate, index) =>
    isRecord(candidate)
      ? { ...candidate, id: `CR${String(index + 1).padStart(3, "0")}` }
      : candidate,
  );
  const verdicts = new Map<string, VerificationVerdict>();
  for (const candidate of candidates) {
    const id = readId(candidate);
    if (id !== undefined) {
      verdicts.set(id, { pass: true, reason: "coverage-repair receipt" });
    }
  }
  const emittedIds = new Set(input.findings.map((finding) => finding.id));
  const emittedContentKeys = new Set(input.findings.map((finding) => findingContentKey(finding)));
  const emittedRootKeys = new Set<string>();
  for (const finding of input.findings) {
    addRootCauseKey(emittedRootKeys, finding);
  }
  const gate = applyCandidateGate({
    candidates,
    verdicts,
    emittedIds,
    emittedContentKeys,
    emittedRootKeys,
    round: 0,
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
  });
  const findings = gate.findings;
  ledger = backfillCandidates(ledger, findings, "repair");

  const applicableClaims = claims.filter(
    (claim) => hunkStatus(ledger, claim.file, claim.hunkIndex) === "not-reached",
  );
  ledger = markNoIssue(ledger, applicableClaims);
  if (plan.skipped.length > 0) {
    ledger = markNotReached(
      ledger,
      plan.skipped,
      "budget",
      "coverage repair request cap",
    );
  }

  const unitHunks = plan.units.flatMap((unit) =>
    unit.hunks.map((hunk) => ({ file: unit.file, hunkIndex: hunk.index })),
  );
  const hunksCovered = unitHunks.filter(
    (target) => hunkStatus(ledger, target.file, target.hunkIndex) !== "not-reached",
  ).length;

  return {
    ledger,
    findings,
    usage,
    audit: {
      enabled: true,
      requests,
      failedRequests,
      hunksSent,
      hunksCovered,
      noIssue: applicableClaims.length,
      candidates: rawCandidates.length,
      acceptedFindings: findings.length,
      rejectedCandidates: rawCandidates.length - findings.length + invalid,
      skippedByBudget: plan.skipped.length,
      usage,
    },
  };
}

function emptyCoverageRepairAudit(enabled: boolean): CoverageRepairAudit {
  return {
    enabled,
    requests: 0,
    failedRequests: 0,
    hunksSent: 0,
    hunksCovered: 0,
    noIssue: 0,
    candidates: 0,
    acceptedFindings: 0,
    rejectedCandidates: 0,
    skippedByBudget: 0,
    usage: ZERO_USAGE,
  };
}

function buildCoverageRepairUserMessage(
  unit: CoverageRepairUnit,
  findings: readonly Finding[],
): string {
  const existing = findings
    .filter((finding) => normalizePath(finding.file) === normalizePath(unit.file))
    .slice(0, EXISTING_FINDINGS_LIMIT)
    .map((finding) => ({
      id: finding.id,
      line: finding.line,
      severity: finding.severity,
      title: finding.title,
    }));
  return [
    `文件：${unit.file}`,
    `范围：${unit.wholeFile ? "整文件未覆盖 hunk" : "部分未覆盖 hunk"}（只审下面列出的 hunk）`,
    `已有意见（勿重复）：${JSON.stringify(existing)}`,
    "",
    ...unit.hunks.map((hunk) =>
      [`### Hunk ${String(hunk.index)}（新侧 ${rangeLabel(hunk.new)}）`, hunk.text].join("\n"),
    ),
    "",
    "请输出 receipts；每个 hunk 至多一条回执，不确定就省略。",
  ].join("\n");
}

function rangeLabel(range: CoverageLineRange): string {
  return range.count > 0 ? `${String(range.start)}-${String(range.start + range.count - 1)}` : "0";
}

function lineInRange(line: number, range: CoverageLineRange): boolean {
  return range.count > 0 && line >= range.start && line < range.start + range.count;
}

function hunkStatus(ledger: CoverageLedger, file: string, hunkIndex: number) {
  const target = ledger.files.find(
    (entry) => normalizePath(entry.file) === normalizePath(file),
  );
  return target?.hunks.find((hunk) => hunk.index === hunkIndex)?.status;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readId(candidate: unknown): string | undefined {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return undefined;
  }
  const id = (candidate as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

/** 分片聚合：补漏审计按片求和；任一片启用即 `enabled=true` */
export function mergeCoverageRepairAudits(
  audits: readonly CoverageRepairAudit[],
): CoverageRepairAudit {
  if (audits.length === 0) {
    return emptyCoverageRepairAudit(false);
  }
  let usage: LlmUsage = ZERO_USAGE;
  let requests = 0;
  let failedRequests = 0;
  let hunksSent = 0;
  let hunksCovered = 0;
  let noIssue = 0;
  let candidates = 0;
  let acceptedFindings = 0;
  let rejectedCandidates = 0;
  let skippedByBudget = 0;
  let enabled = false;
  for (const audit of audits) {
    enabled = enabled || audit.enabled;
    requests += audit.requests;
    failedRequests += audit.failedRequests;
    hunksSent += audit.hunksSent;
    hunksCovered += audit.hunksCovered;
    noIssue += audit.noIssue;
    candidates += audit.candidates;
    acceptedFindings += audit.acceptedFindings;
    rejectedCandidates += audit.rejectedCandidates;
    skippedByBudget += audit.skippedByBudget;
    usage = addUsage(usage, audit.usage);
  }
  return {
    enabled,
    requests,
    failedRequests,
    hunksSent,
    hunksCovered,
    noIssue,
    candidates,
    acceptedFindings,
    rejectedCandidates,
    skippedByBudget,
    usage,
  };
}
