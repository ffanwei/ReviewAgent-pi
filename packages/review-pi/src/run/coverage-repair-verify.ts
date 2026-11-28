// 补漏候选的独立证伪门（F-01b v3）。
//
// 现有候选门只做 schema / evidence 非空 / scope / 去重；补漏候选此前被直接
// 合成 `pass:true` 裁决。本模块补一次独立模型判断：只根据补漏时给出的 hunk
// 正文，判断候选是否真的被改动行里的证据支持；不通过就不进入 findings。
//
// 纪律：
// - 验证器只读 hunk + 候选，不读仓库、不调用工具；
// - 验证请求失败 / 回包不可解析时 fail-open（候选保留并计入 unverified），
//   避免验证器故障直接吞掉 recall；
// - 回包可解析但某候选没有裁决时，按 reject 处理并留痕。

import type { LlmUsage } from "../contracts/llm.js";
import type { VerificationVerdict } from "../shared/parse.js";
import { countItemKeys } from "../shared/parse.js";
import { extractJsonObject } from "../provider/one-shot-llm.js";
import { invokeStructured, type StructuredParse } from "../provider/structured-reply.js";
import { addUsage, ZERO_USAGE } from "../provider/usage-map.js";
import type { CoverageRepairLlm, CoverageRepairUnit } from "./coverage-repair.js";

export interface PendingRepairCandidate {
  readonly unit: CoverageRepairUnit;
  readonly candidate: Record<string, unknown>;
}

export interface RepairVerificationResult {
  readonly verdicts: ReadonlyMap<string, VerificationVerdict>;
  readonly requests: number;
  readonly failedRequests: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly unverified: number;
  readonly usage: LlmUsage;
}

const VERIFY_MAX_TOKENS = 4_096;

const VERIFIER_SYSTEM_PROMPT = [
  "你是独立的代码检视证伪者。输入是补漏请求的 diff hunk 正文和若干候选意见。",
  "你只判断候选是否被给出的 hunk 证据支持；不评价风格，不因为候选的 confidence / severity 高就接受。",
  "只有同时满足以下条件才 pass：",
  "1) candidate.file 与本次文件一致，candidate.line 落在给出的 hunk 新侧行区间；",
  "2) candidate.evidence 至少一条能在 hunk 原文中核对到；",
  "3) 候选描述的缺陷与 hunk 代码一致，且不需要未给出的上下文就能成立。",
  "以下情况一律 reject：",
  "- 证据与 hunk 不匹配、行号不在改动行、描述与代码矛盾；",
  "- 依赖猜测、依赖仓库其他位置、或只是“可能”、“建议检查”；",
  "- 候选把正常行为/风格偏好当成缺陷；",
  "- 证据不足以证明缺陷成立。",
  "不确定时 reject（本门优先保护 precision）。",
  "只输出一个 JSON 对象，不附带其他文本：",
  '{"verdicts":[{"id":"CR001","pass":true,"reason":"hunk 第 42 行新增分支未处理 null，证据成立"},{"id":"CR002","pass":false,"reason":"证据引用的行不在本 hunk"}]}',
  "每个候选必须且只能有一条 verdict；不要遗漏候选，不要编造 id。",
].join("\n");

/** 执行独立验证；按补漏单元批量，一个单元一次请求 */
export async function verifyRepairCandidates(input: {
  readonly candidates: readonly PendingRepairCandidate[];
  readonly llm: CoverageRepairLlm;
  readonly maxTokens?: number;
}): Promise<RepairVerificationResult> {
  const groups = new Map<CoverageRepairUnit, PendingRepairCandidate[]>();
  for (const pending of input.candidates) {
    const group = groups.get(pending.unit) ?? [];
    group.push(pending);
    groups.set(pending.unit, group);
  }

  const verdicts = new Map<string, VerificationVerdict>();
  let requests = 0;
  let failedRequests = 0;
  let accepted = 0;
  let rejected = 0;
  let unverified = 0;
  let usage: LlmUsage = ZERO_USAGE;

  for (const [unit, group] of groups) {
    const outcome = await invokeStructured({
      llm: input.llm,
      purpose: "coverage-repair",
      system: VERIFIER_SYSTEM_PROMPT,
      user: buildVerifierUserMessage(unit, group),
      responseFormat: "json_object",
      maxTokens: input.maxTokens ?? VERIFY_MAX_TOKENS,
      call: {
        parse: parseVerifierStructured,
        maxRepairAttempts: 1,
      },
    });
    requests += outcome.attempts;
    if (outcome.usage !== undefined) {
      usage = addUsage(usage, outcome.usage);
    }
    if (!outcome.ok) {
      failedRequests += 1;
      if (outcome.failure.kind === "transport") {
        // 请求失败仍 fail-open：验证器不可用不吞 recall，但显式计 unverified。
        unverified += group.length;
        markFailOpen(verdicts, group, "verifier request failed");
      } else {
        // 回包不可解析（重试后）fail-closed：验证门不能把坏 JSON 当成“通过”。
        rejected += group.length;
        markRejected(verdicts, group, "verifier reply unparseable");
      }
      continue;
    }
    const parsed = outcome.value;
    for (const pending of group) {
      const id = readId(pending.candidate);
      const verdict = id === undefined ? undefined : parsed.get(id.toLowerCase());
      if (verdict === undefined) {
        rejected += 1;
        if (id !== undefined) {
          verdicts.set(id, { pass: false, reason: "验证器未给出该候选的裁决" });
        }
        continue;
      }
      if (verdict.pass) {
        accepted += 1;
      } else {
        rejected += 1;
      }
      if (id !== undefined) {
        verdicts.set(id, verdict);
      }
    }
  }

  return { verdicts, requests, failedRequests, accepted, rejected, unverified, usage };
}

function markFailOpen(
  verdicts: Map<string, VerificationVerdict>,
  group: readonly PendingRepairCandidate[],
  reason: string,
): void {
  for (const pending of group) {
    const id = readId(pending.candidate);
    if (id !== undefined) {
      verdicts.set(id, { pass: true, reason });
    }
  }
}

/** 回包不可解析（重试后）的 fail-closed：整组候选按 reject 记，不冒充通过 */
function markRejected(
  verdicts: Map<string, VerificationVerdict>,
  group: readonly PendingRepairCandidate[],
  reason: string,
): void {
  for (const pending of group) {
    const id = readId(pending.candidate);
    if (id !== undefined) {
      verdicts.set(id, { pass: false, reason });
    }
  }
}

function buildVerifierUserMessage(
  unit: CoverageRepairUnit,
  group: readonly PendingRepairCandidate[],
): string {
  const candidates = group.map((pending) => pending.candidate);
  return [
    `文件：${unit.file}`,
    `只审下面列出的 hunk；候选必须落在这些 hunk 的新侧行区间。`,
    "",
    ...unit.hunks.map((hunk) =>
      [`### Hunk ${String(hunk.index)}（新侧 ${rangeLabel(hunk.new)}）`, hunk.text].join("\n"),
    ),
    "",
    `候选：${JSON.stringify(candidates)}`,
    "请输出 verdicts；每个候选一条，pass 只在证据成立时为 true。",
  ].join("\n");
}

/** 解析验证回执；无 JSON / 无 verdicts 数组时返回 null（由 Structured 层重发后 fail-closed） */
export function parseVerifierReply(text: string): ReadonlyMap<string, VerificationVerdict> | null {
  const parsed = extractJsonObject(text, { preferKey: "verdicts" });
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const verdicts = (parsed as { verdicts?: unknown }).verdicts;
  if (!Array.isArray(verdicts)) {
    return null;
  }
  // 重复键折叠会让一部分候选“没有裁决”而被误 reject；整批判不可解析并重发。
  if (countItemKeys(text, "verdicts", "id") > verdicts.length) {
    return null;
  }
  const byId = new Map<string, VerificationVerdict>();
  for (const item of verdicts) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const id = record.id;
    const pass = record.pass;
    const reason = record.reason;
    if (typeof id !== "string" || id.trim() === "" || typeof pass !== "boolean") {
      continue;
    }
    byId.set(id.trim().toLowerCase(), {
      pass,
      reason: typeof reason === "string" ? reason.trim() : "",
    });
  }
  return byId;
}

/** Structured Output 契约：null = 不可解析，交给统一层做一次有界重发 */
function parseVerifierStructured(
  text: string,
): StructuredParse<ReadonlyMap<string, VerificationVerdict>> {
  const parsed = parseVerifierReply(text);
  return parsed === null
    ? { ok: false, failure: { kind: "schema", note: "验证器回执不可解析" } }
    : { ok: true, value: parsed };
}

function readId(candidate: Record<string, unknown>): string | undefined {
  const id = candidate.id;
  return typeof id === "string" && id.trim() !== "" ? id.trim() : undefined;
}

function rangeLabel(range: { start: number; count: number }): string {
  return range.count > 0 ? `${String(range.start)}-${String(range.start + range.count - 1)}` : "0";
}
