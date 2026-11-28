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
import { extractJsonObject } from "../provider/one-shot-llm.js";
import { invokeStructured, type StructuredParse } from "../provider/structured-reply.js";
import { addUsage, ZERO_USAGE } from "../provider/usage-map.js";
import type { UsageScope } from "../observability/usage-ledger.js";
import type { RetryPolicy } from "../shared/llm-retry.js";
import type { VerificationVerdict } from "../shared/parse.js";
import { countItemKeys } from "../shared/parse.js";
import type { CoverageRepairLimits } from "../shared/config-limits.js";
import { backfillCandidates, markNoIssue, markNotReached } from "./coverage-ledger.js";
import { verifyRepairCandidates, type PendingRepairCandidate } from "./coverage-repair-verify.js";

/** 补漏调用所需的接入点（由 run 层从配置解析后传入） */
export interface CoverageRepairLlm {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly modelId: string;
  readonly timeoutMs: number;
  readonly retry?: RetryPolicy;
  readonly fetch?: FetchFunction;
  readonly maxTokens?: number;
  /** 用量账本作用域（由 pass 注入；缺省不写账） */
  readonly usageScope?: UsageScope;
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
  "目标：宁可多报一个可验证的真实缺陷，也不要把有行为变化的 hunk 轻率判成 no-issue。",
  "对每个 hunk 只能二选一；拿不准就省略该 hunk 的回执，保持未覆盖：",
  "1) 发现真实缺陷：输出 candidate（与主检视相同的字段 schema）；",
  "2) 确认 hunk 确实安全：输出 no-issue，并给出非空中文 reason + evidence。",
  "no-issue 的硬条件（缺一不可）：",
  "- hunk 是纯格式 / 注释 / 重命名 / 等价重构，或你能正面证明所有新增路径都安全；",
  "- evidence 至少一条，必须引用 hunk 里的真实代码或行号；",
  "- “没看出问题”“与改动无关”都不是理由；无法正面证明时不要输出 no-issue。",
  "优先检查：空值 / 边界 / 错误处理 / 资源释放 / 并发 / 权限 / 输入校验 / 类型转换 / 兼容性 / 数据一致性。",
  "只输出一个 JSON 对象，不附带其他文本：",
  '{"receipts":[{"kind":"no-issue","hunk":1,"reason":"纯格式化，行为不变","evidence":["仅调整缩进，无 token 变化"]},{"kind":"candidate","candidate":{"id":"F9001","severity":"P1","category":"可靠性","file":"…","line":123,"title":"…","description":"…","evidence":["…"],"rule":"…","confidence":0.8,"tips":{"review":"…","suggestion":"…","subcategory":"…"}}}]}',
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
  // 同优先级内先代码文件、再头文件、最后文档/资源（v2：避免预算被 .rst/.xml 吃掉）；
  // 再按 hunk 数从小到大（用更少请求覆盖更多文件），最后按路径保证确定性。
  const ordered = [...units].sort((left, right) => {
    if (left.wholeFile !== right.wholeFile) {
      return left.wholeFile ? -1 : 1;
    }
    const rank = filePriority(left.file) - filePriority(right.file);
    if (rank !== 0) {
      return rank;
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
  /** 与 `candidates` 等长：每条候选落在哪个缺口 hunk（验证器需要） */
  readonly candidateHunks: readonly number[];
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
    return { noIssue: [], candidates: [], candidateHunks: [], coveredHunks: [], invalid: 1 };
  }
  const receipts = (parsed as { receipts?: unknown }).receipts;
  if (!Array.isArray(receipts)) {
    return { noIssue: [], candidates: [], candidateHunks: [], coveredHunks: [], invalid: 1 };
  }
  // 重复键防御：{"kind":"no-issue","kind":"candidate"} 会把两条回执折叠成一条。
  // 整批拒绝（invalid=1）交给统一层重发，不静默接受少掉的 hunk 回执。
  if (countItemKeys(text, "receipts", "kind") > receipts.length) {
    return { noIssue: [], candidates: [], candidateHunks: [], coveredHunks: [], invalid: 1 };
  }

  const hunks = new Map(unit.hunks.map((hunk) => [hunk.index, hunk]));
  const noIssue: NoIssueClaim[] = [];
  const candidates: unknown[] = [];
  const candidateHunks: number[] = [];
  const covered = new Map<number, CoverageHunkRef>();
  let invalid = 0;

  for (const receipt of receipts) {
    if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) {
      invalid += 1;
      continue;
    }
    const record = receipt as Record<string, unknown>;
    if (record.kind === "no-issue") {
      const hunkIndex = record.hunk;
      if (
        typeof hunkIndex !== "number" ||
        !Number.isInteger(hunkIndex) ||
        !hunks.has(hunkIndex)
      ) {
        invalid += 1;
        continue;
      }
      const reason = record.reason;
      if (typeof reason !== "string" || reason.trim() === "") {
        invalid += 1;
        continue;
      }
      // no-issue 必须有正面证据（F-01b v2）：只给 reason 的“没看出问题”不算数。
      const evidence = record.evidence;
      if (
        !Array.isArray(evidence) ||
        evidence.length === 0 ||
        evidence.some((item) => typeof item !== "string" || item.trim() === "")
      ) {
        invalid += 1;
        continue;
      }
      noIssue.push({ file: unit.file, hunkIndex, reason: reason.trim() });
      covered.set(hunkIndex, { file: unit.file, hunkIndex });
      continue;
    }
    if (record.kind === "candidate") {
      // candidate 回执不要求 hunk 字段：以 candidate.line 落在哪个缺口 hunk
      // 为准（提示词示例也只在 no-issue 回执里要求 hunk）。
      const candidate = record.candidate;
      const target = candidateTargetHunk(candidate, unit);
      if (target === undefined) {
        invalid += 1;
        continue;
      }
      candidates.push(candidate);
      candidateHunks.push(target.index);
      covered.set(target.index, { file: unit.file, hunkIndex: target.index });
      continue;
    }
    invalid += 1;
  }

  return { noIssue, candidates, candidateHunks, coveredHunks: [...covered.values()], invalid };
}

/**
 * 单次补漏回执的 Structured Output 契约：
 * - 有至少一条有效 no-issue / candidate 时按部分成功返回（坏条目只计 invalid）；
 * - 整条回执不可解析、或所有回执都非法时返回失败，交给统一层做一次有界重发；
 * - 合法但显式空的 `{"receipts":[]}` 视为模型主动省略，不重发。
 */
function parseCoverageUnitReply(
  text: string,
  unit: CoverageRepairUnit,
): StructuredParse<ParsedCoverageRepair> {
  const parsed = parseCoverageRepairReply(text, unit);
  if (parsed.noIssue.length === 0 && parsed.candidates.length === 0 && parsed.invalid > 0) {
    return {
      ok: false,
      failure: { kind: "schema", note: "补漏回执没有可用的 no-issue/candidate" },
    };
  }
  return { ok: true, value: parsed };
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
  const candidateContexts: { unit: CoverageRepairUnit; hunkIndex: number }[] = [];
  let requests = 0;
  let failedRequests = 0;
  let hunksSent = 0;
  let invalid = 0;

  for (const unit of plan.units) {
    hunksSent += unit.hunks.length;
    const outcome = await invokeStructured({
      llm: input.llm,
      purpose: "coverage-repair",
      system: REPAIR_SYSTEM_PROMPT,
      user: buildCoverageRepairUserMessage(unit, input.findings),
      responseFormat: "json_object",
      maxTokens: input.llm.maxTokens ?? REPAIR_MAX_TOKENS,
      call: {
        parse: (text) => parseCoverageUnitReply(text, unit),
        maxRepairAttempts: 1,
      },
    });
    requests += outcome.attempts;
    if (outcome.usage !== undefined) {
      usage = addUsage(usage, outcome.usage);
    }
    if (!outcome.ok) {
      failedRequests += 1;
      // 重试后仍不可解析计入 invalid；传输失败只由 failedRequests 表达。
      if (outcome.failure.kind !== "transport") {
        invalid += 1;
      }
      continue;
    }
    const parsed = outcome.value;
    invalid += parsed.invalid;
    claims.push(...parsed.noIssue);
    parsed.candidates.forEach((candidate, index) => {
      rawCandidates.push(candidate);
      candidateContexts.push({
        unit,
        hunkIndex: parsed.candidateHunks[index] ?? unit.hunks[0]?.index ?? 0,
      });
    });
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
  // v3：补漏候选不再伪造 pass 裁决；交给独立验证器逐条证伪。
  const pending: PendingRepairCandidate[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const context = candidateContexts[index];
    if (isRecord(candidate) && context !== undefined) {
      pending.push({ unit: context.unit, candidate });
    }
  }
  const verification =
    pending.length > 0
      ? await verifyRepairCandidates({
          candidates: pending,
          llm: input.llm,
          ...(input.llm.maxTokens !== undefined ? { maxTokens: input.llm.maxTokens } : {}),
        })
      : undefined;
  if (verification !== undefined) {
    usage = addUsage(usage, verification.usage);
  }
  const verdicts: ReadonlyMap<string, VerificationVerdict> =
    verification?.verdicts ?? new Map<string, VerificationVerdict>();
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
      ...(verification !== undefined
        ? {
            verification: {
              requests: verification.requests,
              failedRequests: verification.failedRequests,
              accepted: verification.accepted,
              rejected: verification.rejected,
              unverified: verification.unverified,
              usage: verification.usage,
            },
          }
        : {}),
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

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

const SOURCE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".cs",
  ".go",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".m",
  ".mm",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".scala",
  ".sh",
  ".swift",
  ".ts",
  ".tsx",
  ".vue",
]);
const HEADER_EXTENSIONS = new Set([".h", ".hh", ".hpp", ".hxx", ".inl"]);

/** 补漏预算优先级：0=源码，1=头文件/未知，2=文档/资源 */
function filePriority(file: string): number {
  const base = file.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot < 0) {
    return 1;
  }
  const extension = base.slice(dot).toLowerCase();
  if (SOURCE_EXTENSIONS.has(extension)) {
    return 0;
  }
  if (HEADER_EXTENSIONS.has(extension)) {
    return 1;
  }
  return 2;
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
  let verifierUsage: LlmUsage = ZERO_USAGE;
  let verifierRequests = 0;
  let verifierFailedRequests = 0;
  let verifierAccepted = 0;
  let verifierRejected = 0;
  let verifierUnverified = 0;
  let hasVerification = false;
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
    if (audit.verification !== undefined) {
      hasVerification = true;
      verifierRequests += audit.verification.requests;
      verifierFailedRequests += audit.verification.failedRequests;
      verifierAccepted += audit.verification.accepted;
      verifierRejected += audit.verification.rejected;
      verifierUnverified += audit.verification.unverified;
      verifierUsage = addUsage(verifierUsage, audit.verification.usage);
    }
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
    ...(hasVerification
      ? {
          verification: {
            requests: verifierRequests,
            failedRequests: verifierFailedRequests,
            accepted: verifierAccepted,
            rejected: verifierRejected,
            unverified: verifierUnverified,
            usage: verifierUsage,
          },
        }
      : {}),
  };
}
